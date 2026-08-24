import type { ChargeBlocker, EnrollmentDogResultWire } from '../contracts/wire.js';
import { updateStoredResponse } from '../db/idempotency.js';
import { bookingsRepository } from '../db/repositories/bookingsRepository.js';
import { chargesRepository } from '../db/repositories/chargesRepository.js';
import { dogCompletedClassesRepository } from '../db/repositories/dogCompletedClassesRepository.js';
import { dogVaccinesRepository } from '../db/repositories/dogVaccinesRepository.js';
import { dogsRepository } from '../db/repositories/dogsRepository.js';
import type { GroupClassKey } from '../db/repositories/groupClassesRepository.js';
import { withActor, type Tx } from '../db/tx.js';
import {
  dogAlreadyEnrolledResult,
  dogChargeFailedResult,
  dogChargeUnverifiedResult,
  dogEligibilityMissingResult,
  dogNotFoundResult,
  dogVaccineMissingResult,
  type VaccineGap,
} from './bookingErrors.js';
import { ApiError } from './errors.js';
import {
  chargeBlockerForConfirm,
  stripeIdempotencyErrorKind,
  type ChargeBlockerLogger,
  type StripeClient,
  type StripePaymentIntentResult,
  type StripePaymentIntentStatus,
} from './stripe.js';

/**
 * The manual-capture money layer for `POST /enrollments`, plus the per-dog
 * checks partial success reports on — `designs/partial-success-enrollment.md`
 * §3, the enrollments slice of `designs/money-safety-rollback-and-replay.md`.
 *
 * **Why this exists at all.** Under automatic capture, "charge only dogs that
 * will enroll" and "enroll only dogs whose money is settled" cannot both be
 * true: one has to go first, and whichever goes second inherits an unwind. The
 * old protocol chose charge-then-enroll and paid for it with
 * `unwindCapturedIntents` — refund what succeeded, cancel what didn't, and
 * `log.fatal('STRANDED MONEY')` for the `processing` intent that can be
 * neither. Under authorize → enroll → capture both statements are true at
 * once, and every failure path releases a HOLD instead of refunding a
 * PAYMENT.
 *
 * **Three money invariants. They are enforced here and asserted in
 * `test/contracts/enrollment-partial.test.ts`, never merely described:**
 *
 *   1. **Capture only an intent whose RETRIEVED status is `requires_capture`.**
 *      Not the status the confirm returned — that snapshot can be a Stripe
 *      idempotency replay of a state that has since moved. Capturing is the
 *      irreversible direction; a fresh read is cheap.
 *   2. **Cancel only holds this request created or adopted, and never a
 *      captured one.** A cancel is how a hold is released; a captured intent
 *      is money that moved, and giving it back is a REFUND, which on this
 *      surface belongs exclusively to the withdraw arm (R35).
 *   3. **`createRefund` is never called from any enrollment failure path.**
 *      Structurally, not by discipline: this module does not import it, and
 *      the route's failure paths route through here.
 *
 * Enrollments-scoped today. When B&T and memberships convert, this generalizes
 * into the shared `grantSiteCapture.ts` the money-safety design names — noted
 * so a single-site helper isn't read as drift from it.
 */

/** Stripe's idempotency key for one dog's AUTHORIZATION. */
export function dogAuthorizeKey(idempotencyKey: string, dogId: string): string {
  return `${idempotencyKey}:dog:${dogId}`;
}

/**
 * Stripe's idempotency key for one dog's CAPTURE. Derived from the authorize
 * key rather than minted fresh, so a retry of the capture step replays instead
 * of moving a second amount of money. Counted in
 * `STRIPE_DERIVED_KEY_SUFFIXES` (`db/mutation.ts`) — that list is load-bearing
 * for the 255-char Stripe cap and a suffix missing from it is an unsendable
 * key on a money path.
 */
export function dogCaptureKey(idempotencyKey: string, dogId: string): string {
  return `${dogAuthorizeKey(idempotencyKey, dogId)}:capture`;
}

/**
 * The capture-reconciler's key for a charge row. Derived from OUR row id, not
 * from the client's request key: by the time the reconciler runs, the request
 * key may be swept (24h TTL) and its Stripe window closed, and a fresh-minted
 * key on a money path is how a replay becomes a second movement. Same rule,
 * and same reason, as `duplicateRefundIdempotencyKey`.
 */
export function reconcileCaptureKey(chargeId: string): string {
  return `reconcile:charge:${chargeId}:capture`;
}

/**
 * One dog's authorization, as this request holds it.
 *
 * `state` is the money question and the reason this is not just an id:
 *   - `'held'` — funds are on hold, nothing has moved. Capturable; cancellable.
 *   - `'captured'` — this key's logical work already captured, discovered by
 *     retrieving a Stripe replay. **Never capture it again and never cancel
 *     it**; the tx's own idempotency claim replays the response that describes
 *     it (design §4 row 3).
 */
export interface DogAuthorization {
  dogId: string;
  intentId: string;
  amountCents: number;
  state: 'held' | 'captured';
  /**
   * False when Stripe REPLAYED an intent an earlier request created — i.e. we
   * adopted someone else's hold. Kept because "who created this" decides who
   * may release it when two requests share one Idempotency-Key.
   */
  createdByThisRequest: boolean;
}

/**
 * Where an intent this request is holding CAME FROM — the only question that
 * decides who may release it (ADDENDUM 1 R1, 2026-08-20).
 *
 *   - `'fresh'`    — Stripe reported `Idempotency-Replayed: false`: this
 *     request's confirm EXECUTED and minted this intent.
 *   - `'replayed'` — Stripe reported the header TRUE: an earlier request under
 *     this same `<K>:dog:<id>` created it and may still be capturing it.
 *     **Never cancelled by us.** Cancelling a hold the winner of an
 *     idempotency race is about to capture leaves its dog enrolled and never
 *     charged, which is the half of Allison's rule a hold-based protocol does
 *     not fix on its own (adjudication A1).
 *   - `'adopted'`  — we could not tell (`replayed` absent). Reachable from the
 *     THROWN card fork alone: `normalizeThrownConfirmError` builds its result
 *     from the error's attached PaymentIntent, which carries no response
 *     headers. A thrown card error means the card was REFUSED, so such an
 *     intent is never a live hold and releasing it is 1.7.1 hygiene, not a
 *     money operation. Treated as cancellable for exactly that reason.
 *
 * The whole per-intent carve-out therefore rests on `Idempotency-Replayed`,
 * whose real spelling was MEASURED against live Stripe on 2026-08-13
 * (`REPLAYED_HEADER_NAMES` in `stripe.ts`). If that header ever regresses to
 * unread, a losing request would read a replay as `fresh`; the release path is
 * still gated on the arms below, which is why the inflight/replayed arms
 * release nothing at all rather than trusting provenance alone.
 */
export type IntentProvenance = 'fresh' | 'adopted' | 'replayed';

/**
 * One intent this request learned the id of, and what this request has decided
 * about it. Appended BEFORE the confirm's result is interpreted, so a throw
 * between the confirm and the interpretation still leaves the id somewhere the
 * release path can find it — the whole point of the registry (R1).
 *
 * `resolved` means "this request has already decided this intent's fate":
 * captured, deliberately kept, deliberately left alone, or already released.
 * The outermost `finally` releases everything still UNRESOLVED, which makes it
 * a safety net rather than a second actor.
 */
export interface RegisteredIntent {
  dogId: string;
  intentId: string;
  provenance: IntentProvenance;
  resolved: boolean;
}

/** Request-scoped. One per `POST /enrollments` execution, never shared. */
export interface HoldRegistry {
  readonly entries: RegisteredIntent[];
}

export function createHoldRegistry(): HoldRegistry {
  return { entries: [] };
}

/** Provenance from the confirm's own response. See {@link IntentProvenance}. */
export function intentProvenance(intent: StripePaymentIntentResult): IntentProvenance {
  if (intent.replayed === true) return 'replayed';
  if (intent.replayed === false) return 'fresh';
  return 'adopted';
}

export function registerIntent(
  registry: HoldRegistry,
  args: { dogId: string; intentId: string; provenance: IntentProvenance },
): void {
  registry.entries.push({ ...args, resolved: false });
}

/** Mark every registered intent as this request's decided business. */
export function resolveAllIntents(registry: HoldRegistry): void {
  for (const entry of registry.entries) entry.resolved = true;
}

/** Mark the intents belonging to these dogs decided — used for dogs that
 *  ENROLLED (their holds are being captured) and for refusals the caller has
 *  already enumerated per R2. */
export function resolveIntentsForDogs(
  registry: HoldRegistry,
  dogIds: ReadonlySet<string>,
): void {
  for (const entry of registry.entries) {
    if (dogIds.has(entry.dogId)) entry.resolved = true;
  }
}

/**
 * The statuses a PaymentIntent can still be cancelled from. `succeeded` is
 * money that MOVED (undoing it is a refund, which this surface never issues —
 * invariant 3); `canceled` is already released; `processing` is precisely the
 * status Stripe refuses to cancel, and attempting it is what used to require a
 * `log.fatal('STRANDED MONEY')`.
 */
export const CANCELLABLE_STATUSES: ReadonlySet<StripePaymentIntentStatus> = new Set([
  'requires_capture',
  'requires_action',
  'requires_payment_method',
  'requires_confirmation',
]);

export interface RefusedAuthorization {
  dogId: string;
  intentId: string;
  /** The status the RETRIEVE reported at the moment of refusal. */
  liveStatus: StripePaymentIntentStatus;
  provenance: IntentProvenance;
}

export interface AuthorizeResult {
  holds: DogAuthorization[];
  /** Dogs whose authorization refused. Keyed by dog id, request order applied
   *  by the caller — a Map preserves insertion order but the envelope's order
   *  is the caller's contract, not this map's. */
  failures: Map<string, EnrollmentDogResultWire>;
  /**
   * The intents behind those failures, with the status that refused them. The
   * partial path enumerates these per R2 (cancel a `requires_action` intent,
   * leave `processing` alone, and leave a decline alone because nothing is
   * held); the all-or-nothing path leaves them UNRESOLVED so its outermost
   * release cancels every one that is still cancellable — it is failing whole,
   * so every intent it minted is garbage (the 1.7.1 rule, unchanged).
   */
  refusals: RefusedAuthorization[];
}

export interface EnrollmentDogCheckArgs {
  ownerId: string;
  cohortId: string;
  classKey: GroupClassKey;
  dogIds: readonly string[];
  /** R7 OR-alternatives for the cohort's class; empty = no prereqs. */
  prereqOptions: readonly GroupClassKey[];
}

/**
 * The per-dog checks, run against whatever runner it is handed — the pool (as
 * the advisory pre-flight, §3.3) or the request tx under the cohort lock (as
 * the authoritative re-check, §3.5.1). ONE implementation for both, because
 * two would drift and the advisory phase's whole justification is that it
 * predicts the authoritative one.
 *
 * Order per dog: ownership → duplicate → eligibility → vaccine. The first
 * failing check for a dog is the one reported — a dog that is both
 * already-enrolled and vaccine-gapped should be told the thing that is
 * actually stopping it, and there is nothing to fix about a dog that is
 * already in the class.
 *
 * Owner-level gates (payment method on file, agreements) are NOT here: no dog
 * can enroll without a card on file, so there is no per-dog story to tell and
 * they stay whole-request failures (design §3.2, R14 amendment).
 *
 * Returns only the FAILURES; a dog absent from the map passed every check.
 */
export async function checkDogsForEnrollment(
  tx: Tx,
  args: EnrollmentDogCheckArgs,
): Promise<Map<string, EnrollmentDogResultWire>> {
  const failures = new Map<string, EnrollmentDogResultWire>();

  const enrolled = new Set(
    await bookingsRepository.findEnrolledDogsInCohort(tx, args.cohortId, [...args.dogIds]),
  );

  for (const dogId of args.dogIds) {
    const owned = await dogsRepository.findOwnedExists(dogId, args.ownerId, tx);
    if (!owned) {
      failures.set(dogId, dogNotFoundResult(dogId));
      continue;
    }
    if (enrolled.has(dogId)) {
      failures.set(dogId, dogAlreadyEnrolledResult(dogId));
      continue;
    }
    if (args.prereqOptions.length > 0) {
      const completed = new Set(
        await dogCompletedClassesRepository.findCompletedKeysForDogInTx(tx, dogId),
      );
      if (!args.prereqOptions.some((opt) => completed.has(opt))) {
        failures.set(dogId, dogEligibilityMissingResult(dogId, args.prereqOptions));
        continue;
      }
    }
    const missing = await dogVaccinesRepository.findMissingForCategory(
      tx,
      dogId,
      'group-class',
      args.classKey,
    );
    if (missing.length > 0) {
      const gaps: VaccineGap[] = missing.map((m) => ({
        dog_id: dogId,
        requirement_key: m.requirement_key,
        label: m.label,
      }));
      failures.set(dogId, dogVaccineMissingResult(dogId, gaps));
    }
  }

  return failures;
}

/**
 * The advisory pre-flight (§3.3): the same checks, on the pool, before any
 * Stripe call. Advisory by construction — no lock is held, so a dog that
 * passes here can still fail under the lock, and the tx re-check is the
 * authority.
 *
 * Its whole purpose is money: **no hold is ever placed for a dog we already
 * know cannot enroll**, so a failed check never touches the owner's card
 * statement. Opening one short read transaction is what buys that, and it
 * holds no locks and writes nothing.
 */
export async function advisoryPreflight(
  actor: string,
  args: EnrollmentDogCheckArgs,
): Promise<Map<string, EnrollmentDogResultWire>> {
  return withActor(actor, (tx) => checkDogsForEnrollment(tx, args));
}

/**
 * Authorize one PaymentIntent per surviving dog (§3.4). Manual capture: funds
 * are HELD and nothing moves.
 *
 * The arms, and what each costs if read wrong:
 *
 *   - **`requires_capture` on a freshly executed confirm** — the hold exists.
 *   - **Anything else, or a result we cannot prove was freshly executed**
 *     (`replayed !== false`, which includes "the header was unreadable") —
 *     RETRIEVE before believing it. Stripe answers a replay with the ORIGINAL
 *     snapshot, not current state, so a replayed `requires_capture` can name an
 *     intent that has since been captured or cancelled. Acting on the snapshot
 *     is how a capture lands twice or a cancelled hold is treated as money.
 *   - **`processing`** — `charge_unverified`, and **no cancel is attempted**:
 *     a `processing` intent is exactly the one Stripe refuses to cancel, and
 *     it is the arm that used to require a `log.fatal`. Under manual capture
 *     it holds no captured money and cannot capture itself, so leaving it
 *     alone is safe and it expires on its own.
 *   - **declined / authentication_required** — `charge_failed` with that dog's
 *     own blocker. **That dog alone fails; every sibling proceeds and nothing
 *     is unwound** — there is nothing to unwind (the refused authorize held
 *     nothing) and the siblings' holds are still wanted. This is the direct
 *     answer to "does that dog alone fail": yes.
 *
 * Non-card errors (transport, configuration, idempotency-params drift) are NOT
 * outcomes and are not caught here — they mean we do not know whether an
 * authorization exists, and the honest response is to fail the whole request.
 * Relabelling a Stripe outage as one dog's decline would tell an owner their
 * card failed when it never was asked.
 *
 * **Every intent id is written to `registry` the instant Stripe returns one,
 * BEFORE anything interprets it** (ADDENDUM 1 R1). This is the whole fix for
 * the round-1 BLOCKER: the old shape accumulated holds in a local array and
 * returned them only on normal completion, so a transport throw on dog N's
 * confirm discarded dogs 1..N−1's live authorizations with nothing anywhere
 * holding their ids. The route's outermost `finally` releases the registry.
 *
 * **The residual this does NOT close, named rather than implied:** a confirm
 * that LANDS at Stripe and then loses its response (`StripeConnectionError`
 * after the intent exists) never tells us the id, so nothing can release that
 * one dog's hold; it expires on the card network. Recovering it would mean
 * re-issuing the confirm under the same key purely to learn the id, which can
 * CREATE the intent when the first attempt never landed. Not built, not
 * pretended.
 */
export async function authorizeDogsForEnrollment(args: {
  stripe: StripeClient;
  ownerId: string;
  stripeCustomerId: string;
  stripePaymentMethodId: string;
  cohortId: string;
  dogIds: readonly string[];
  amountPerDogCents: number;
  idempotencyKey: string;
  /**
   * The ORIGINAL request's client Idempotency-Key, present only on an
   * automatic retry (ADDENDUM 3 §A3.13). Every dog is RE-VERIFIED against the
   * attempt that key made before this request is allowed to mint anything —
   * see {@link reverifyOriginalAttempt}.
   */
  retryOfKey?: string;
  registry: HoldRegistry;
  log: ChargeBlockerLogger;
}): Promise<AuthorizeResult> {
  const holds: DogAuthorization[] = [];
  const failures = new Map<string, EnrollmentDogResultWire>();
  const refusals: RefusedAuthorization[] = [];

  const retryOfKey = args.retryOfKey;
  for (const dogId of args.dogIds) {
    if (retryOfKey !== undefined) {
      const reverified = await reverifyOriginalAttempt({ ...args, dogId, retryOfKey });
      if (reverified.kind === 'hold') {
        holds.push(reverified.hold);
        continue;
      }
      if (reverified.kind === 'failure') {
        failures.set(dogId, reverified.failure);
        refusals.push(reverified.refusal);
        continue;
      }
      // `kind === 'terminal'` — the prior attempt is dead and cannot come back.
      // ONLY NOW may a fresh attempt be minted, under THIS request's key.
    }
    const intent = await args.stripe.createAndConfirmPaymentIntent(
      {
        customerId: args.stripeCustomerId,
        paymentMethodId: args.stripePaymentMethodId,
        amountCents: args.amountPerDogCents,
        currency: 'usd',
        metadata: {
          owner_id: args.ownerId,
          dog_id: dogId,
          cohort_id: args.cohortId,
          purpose: 'group-class',
        },
        captureMethod: 'manual',
      },
      dogAuthorizeKey(args.idempotencyKey, dogId),
    );

    // FIRST, before any branch reads the result: this id is now this request's
    // responsibility, whatever happens next.
    const provenance = intentProvenance(intent);
    registerIntent(args.registry, { dogId, intentId: intent.id, provenance });

    // The one arm that needs no second opinion: Stripe executed this request
    // just now and parked the funds. Everything else asks again.
    if (intent.status === 'requires_capture' && intent.replayed === false) {
      holds.push({
        dogId,
        intentId: intent.id,
        amountCents: intent.amountCents,
        state: 'held',
        createdByThisRequest: true,
      });
      continue;
    }

    const live = await args.stripe.retrievePaymentIntent(intent.id);
    const resolved = classifyAuthorization(dogId, intent, live, args.idempotencyKey, args.log);
    if (resolved.kind === 'hold') {
      holds.push(resolved.hold);
      continue;
    }
    failures.set(dogId, resolved.failure);
    refusals.push({ dogId, intentId: live.id, liveStatus: live.status, provenance });
  }

  return { holds, failures, refusals };
}

/** What re-verifying the original attempt decided for one dog. */
type ReverifiedAttempt =
  | { kind: 'hold'; hold: DogAuthorization }
  | { kind: 'failure'; failure: EnrollmentDogResultWire; refusal: RefusedAuthorization }
  /** The prior attempt is dead. The caller mints fresh under ITS OWN key. */
  | { kind: 'terminal' };

/**
 * Re-verify one dog's ORIGINAL attempt before this retry is allowed to mint
 * anything (ADDENDUM 3 §A3.13 — Allison's Q-D ruling: *"retry 3 times before
 * settling for yes or no, no need for multiple messages to user about that"*).
 *
 * **The hazard this closes.** Ruling 2 puts `charge_unverified` into the
 * auto-retry family, and a `processing` intent is precisely the one that can
 * still land on its own. A retry that simply re-authorized under a fresh key
 * would mint a SECOND hold while the first was still verifying — money-safe
 * (neither can capture itself) but statement-ugly, and it would charge the
 * owner's card twice the moment both settled and both were captured. So the
 * retry asks about the FIRST attempt before it is allowed to make a second.
 *
 * **This function is KEY-AGNOSTIC and must stay that way** (§A3.14): it
 * re-verifies whatever `retry_of` arrives and never assumes which attempt that
 * key names. The client is told which key to send — `verify_key` on the
 * previous envelope's result row — precisely because the fact ("did that
 * attempt execute a mint, and under which key") is only knowable here. A server
 * that assumed "retry_of is always the FIRST attempt's key" would re-verify a
 * dead intent as soon as any attempt minted a fresh one.
 *
 * The mechanism is Stripe's idempotency window, used for what it is: re-issuing
 * the confirm under the derived key `${retry_of}:dog:${dogId}` REPLAYS
 * that attempt's intent rather than creating one, and the seam's existing
 * replayed-arm machinery then retrieves LIVE truth (invariant 1 — never act on
 * a replay's snapshot). Four arms, and only one of them mints:
 *
 *   - **`requires_capture`** — the verification SETTLED. Adopt the original
 *     hold, enroll on it, capture it. **Zero new intents**: the owner's one
 *     hold is the one charged.
 *   - **`processing`** — still verifying. `charge_unverified` again, nothing
 *     touched, nothing minted; the next attempt asks again.
 *   - **`succeeded`** — this key's logical work already captured (§4 row 3).
 *     Never captured twice, never cancelled.
 *   - **terminal** — `canceled`, or a refusal resting at
 *     `requires_payment_method` / `requires_action` / `requires_confirmation`.
 *     The prior attempt is dead, so the caller mints fresh under `${K2}` and
 *     classifies normally. This also serves the blockerless `charge_failed`
 *     arm unchanged: its old intents are terminal by construction, so a
 *     `retry_of` blockerless retry converges to today's fresh mint.
 *
 * **Cross-owner safety.** A forged `retry_of` naming another owner's key cannot
 * replay their intent: the confirm carries THIS principal's customer and
 * payment-method ids, and Stripe answers same-key-different-params with
 * `idempotency_error` (400, no money moved). The `metadata.owner_id` assertion
 * below is the belt-and-braces second answer, and it is asserted on every arm
 * that ADOPTS an intent — adopting is the arm where somebody else's money would
 * become this owner's enrollment.
 *
 * **The residual, named:** an original `requires_action` intent belongs to the
 * request that created it (provenance `'replayed'`), so this path never cancels
 * it — R1's rule, and the right one, since that request may still be finishing.
 * In practice the original already cancelled its own `requires_action` refusals
 * (`settleRefusedAuthorizations`), so the retry reads `canceled`. The uncovered
 * case is an original that CRASHED before settling: its intent can still
 * advance to a hold nobody owns, and it expires on the card network. Same class
 * as the "confirm landed, response lost" residual in this module's header, and
 * not closed here.
 */
async function reverifyOriginalAttempt(args: {
  stripe: StripeClient;
  ownerId: string;
  stripeCustomerId: string;
  stripePaymentMethodId: string;
  cohortId: string;
  dogId: string;
  amountPerDogCents: number;
  retryOfKey: string;
  registry: HoldRegistry;
  log: ChargeBlockerLogger;
}): Promise<ReverifiedAttempt> {
  let replayed: StripePaymentIntentResult;
  try {
    replayed = await args.stripe.createAndConfirmPaymentIntent(
      {
        customerId: args.stripeCustomerId,
        paymentMethodId: args.stripePaymentMethodId,
        amountCents: args.amountPerDogCents,
        currency: 'usd',
        metadata: {
          owner_id: args.ownerId,
          dog_id: args.dogId,
          cohort_id: args.cohortId,
          purpose: 'group-class',
        },
        captureMethod: 'manual',
      },
      dogAuthorizeKey(args.retryOfKey, args.dogId),
    );
  } catch (err) {
    const mapped = retryOfIdempotencyApiError(err);
    if (mapped !== undefined) throw mapped;
    // Anything else — transport, configuration — is not an outcome and is not
    // this field's fault. Rethrown untouched, exactly as the fresh-mint path
    // rethrows it: we do not know whether an authorization exists, and the
    // honest answer is to fail the whole request.
    throw err;
  }

  // R1, unchanged and non-negotiable: the id is this request's responsibility
  // from the instant Stripe returns it, before anything interprets it.
  const provenance = intentProvenance(replayed);
  registerIntent(args.registry, { dogId: args.dogId, intentId: replayed.id, provenance });

  // ALWAYS retrieve. The whole point of this arm is live truth: a replay
  // answers with the ORIGINAL snapshot, which is the state we already know is
  // stale — it is why the owner is retrying.
  const live = await args.stripe.retrievePaymentIntent(replayed.id);

  switch (live.status) {
    case 'requires_capture':
      assertIntentBelongsToOwner(live.metadata, args.ownerId, args.dogId);
      return {
        kind: 'hold',
        hold: {
          dogId: args.dogId,
          intentId: live.id,
          amountCents: live.amountCents,
          state: 'held',
          createdByThisRequest: false,
        },
      };
    case 'succeeded':
      assertIntentBelongsToOwner(live.metadata, args.ownerId, args.dogId);
      return {
        kind: 'hold',
        hold: {
          dogId: args.dogId,
          intentId: live.id,
          amountCents: live.amountCents,
          state: 'captured',
          createdByThisRequest: false,
        },
      };
    case 'processing':
      return {
        kind: 'failure',
        // §A3.14: the live intent is the ORIGINAL one, still verifying. The key
        // that names it is the `retry_of` this request was handed — CARRIED, not
        // this request's own key, which minted nothing. Naming this request's
        // key would send the next attempt to confirm under a never-used derived
        // key, which EXECUTES fresh: a second hold beside the live one.
        failure: dogChargeUnverifiedResult(args.dogId, args.retryOfKey),
        refusal: {
          dogId: args.dogId,
          intentId: live.id,
          liveStatus: live.status,
          provenance,
        },
      };
    case 'canceled':
    case 'requires_payment_method':
    case 'requires_action':
    case 'requires_confirmation':
      return { kind: 'terminal' };
  }
}

/**
 * Stripe's answer about the CLIENT'S OWN key, mapped onto this API's existing
 * idempotency vocabulary — or `undefined` when the error is not an idempotency
 * error at all.
 *
 * **Why this mapping and not a new code.** `retry_of` is a client-supplied
 * Idempotency-Key, and the two conditions Stripe reports about it are the same
 * two this API already names for its OWN key store — at Stripe's store instead
 * of ours. Reusing them is not a convenience: a client that already knows what
 * `idempotency_mismatch` means learns nothing new here, and a new code would be
 * a wire change for a failure this contract can already express.
 *
 *   - **params-mismatch → `idempotency_mismatch` (422).** The key was first
 *     used with DIFFERENT parameters, so it is not this request's own earlier
 *     attempt. The one response that must never follow is a fresh key against
 *     the same intent — that is how a double charge is manufactured out of a
 *     bookkeeping disagreement — and a 422 is where the client stops.
 *   - **concurrent-request → `idempotency_inflight` (409).** Two of the
 *     owner's own taps racing on one key. This says NOTHING about anyone's
 *     bookkeeping: the outcome is unknown exactly as it was a moment ago, the
 *     other request owns it, and "ask again" is the honest answer. Telling
 *     that owner their retry was malformed would be a lie about their money.
 *
 * The distinction is `stripeIdempotencyErrorKind`'s, earned on 2026-08-12 when
 * reading the two as one parked a healthy invoice forever.
 *
 * **What this replaced** (round-4 builder finding, fixed 2026-08-21): an
 * unhandled `StripeIdempotencyError` reaching Fastify, which answered with
 * Stripe's own HTTP status (400 or 409) and a body reading
 * `{"error":{"code":"internal","message":"Internal Server Error"}}` — a status
 * and an envelope that contradicted each other, on a field the client supplies.
 *
 * **Known, bounded disclosure:** a `retry_of` naming a key Stripe has never
 * seen executes fresh, while one it HAS seen with other parameters is refused,
 * so the two are distinguishable. Reaching it means guessing a 36-char uuid,
 * and what it reveals is only "some request used this string" — never whose,
 * never what it bought. Unchanged by this mapping: the old behavior
 * distinguished them identically, just less legibly.
 */
function retryOfIdempotencyApiError(err: unknown): ApiError | undefined {
  const kind = stripeIdempotencyErrorKind(err);
  if (kind === undefined) return undefined;
  if (kind === 'concurrent-request') {
    return new ApiError(
      'idempotency_inflight',
      'the payment attempt named by retry_of is still in progress — try again shortly',
    );
  }
  return new ApiError(
    'idempotency_mismatch',
    "retry_of names a payment attempt made with different parameters — it is not this request's own earlier attempt",
  );
}

/**
 * The belt-and-braces half of cross-owner safety (§A3.13): an intent this
 * request is about to ADOPT must carry this principal's `owner_id`, stamped at
 * create. An ABSENT owner_id is not proof of ownership and is refused for the
 * same reason a mismatched one is — the whole point is that adoption requires
 * evidence.
 *
 * A whole-request refusal rather than a per-dog outcome: a `retry_of` that
 * names someone else's attempt is not a card failing, it is a request that
 * should never have been sent, and there is no per-dog sentence that would be
 * true about it.
 */
function assertIntentBelongsToOwner(
  metadata: Record<string, string> | undefined,
  ownerId: string,
  dogId: string,
): void {
  if (metadata?.owner_id === ownerId) return;
  throw new ApiError(
    'invalid_payload',
    `retry_of does not name this request's own earlier attempt for dog ${dogId}`,
  );
}

/**
 * The partial path's answer to "what happens to the intents behind the dogs
 * whose authorization was REFUSED" (ADDENDUM 1 R2), enumerated by the
 * RETRIEVED status rather than by the blocker label:
 *
 *   - `requires_action` — **CANCEL.** This is the arm §3.4 got wrong. "A
 *     refused authorize held nothing" is true at the instant of refusal and
 *     was asserted permanently: an intent left at `requires_action` can still
 *     advance on its own, and under manual capture advancing lands it at
 *     `requires_capture` — a live HOLD nobody owns, for up to ~7 days, while
 *     the copy for `charge_failed` has already sent the owner to mint a second
 *     one on a fresh key.
 *   - `processing` — leave untouched. Stripe refuses to cancel it, it holds no
 *     captured money, and it cannot capture itself (§3.4 stands).
 *   - anything else (a decline resting at `requires_payment_method`, a
 *     `canceled` hold, an adopted `succeeded`) — nothing exists to release, so
 *     nothing is attempted. This is what keeps "a declined dog costs nobody a
 *     cancel" (§9.2) true.
 *
 * Either way the entry is RESOLVED: the outermost release must not revisit a
 * refusal this function has already ruled on.
 */
export async function settleRefusedAuthorizations(args: {
  stripe: StripeClient;
  registry: HoldRegistry;
  refusals: readonly RefusedAuthorization[];
  log: { error(obj: Record<string, unknown>, msg?: string): void };
}): Promise<void> {
  for (const refusal of args.refusals) {
    if (refusal.liveStatus === 'requires_action' && refusal.provenance !== 'replayed') {
      await cancelOne(args.stripe, refusal.intentId, refusal.dogId, args.log);
    }
    resolveIntentsForDogs(args.registry, new Set([refusal.dogId]));
  }
}

type ResolvedAuthorization =
  | { kind: 'hold'; hold: DogAuthorization }
  | { kind: 'failure'; failure: EnrollmentDogResultWire };

/**
 * Read a retrieved PaymentIntent into this dog's outcome. Split out from the
 * loop so the mapping is one screen and every arm is visible at once.
 *
 * `confirmed` is the confirm's own result, needed for nothing but its amount:
 * a retrieved intent carries the same amount, but on the thrown fork the
 * confirm may report 0 (informational there), so the retrieved value wins.
 *
 * `idempotencyKey` is THIS request's client key, and it is only ever read on
 * the `processing` arm: the intent being classified here was minted (or
 * replayed) under this request's own key, so this request's key is the one that
 * names it for the next attempt (§A3.14 `verify_key`).
 */
function classifyAuthorization(
  dogId: string,
  confirmed: StripePaymentIntentResult,
  live: StripePaymentIntentResult,
  idempotencyKey: string,
  log: ChargeBlockerLogger,
): ResolvedAuthorization {
  switch (live.status) {
    case 'requires_capture':
      // A hold that already existed — this request adopted it. Either an
      // earlier attempt under this key created it (the crash-window replay,
      // design §4 row 4) or a sibling request sharing the key did.
      return {
        kind: 'hold',
        hold: {
          dogId,
          intentId: live.id,
          amountCents: live.amountCents,
          state: 'held',
          createdByThisRequest: false,
        },
      };
    case 'succeeded':
      // This key's logical work already CAPTURED. Never capture it again,
      // never cancel it — cancelling captured money is a refund by another
      // name. The tx's claim replays the response that describes it.
      return {
        kind: 'hold',
        hold: {
          dogId,
          intentId: live.id,
          amountCents: live.amountCents,
          state: 'captured',
          createdByThisRequest: false,
        },
      };
    case 'processing':
      // The live intent executed under THIS request's key — either this
      // request's own fresh mint, or a replay of it. That is the key the next
      // attempt must re-verify (§A3.14).
      return { kind: 'failure', failure: dogChargeUnverifiedResult(dogId, idempotencyKey) };
    case 'canceled':
      // The hold is gone. Someone released it (a sibling request's failure
      // path, or Stripe's own expiry). Nothing to adopt and nothing to undo:
      // this dog reports a refused charge and touches nothing.
      //
      // **No blocker** (ADDENDUM 1 R5). This used to report `'declined'`,
      // which mobile renders as "Your card was declined. Try a different
      // card." The card was never asked on this arm — nobody declined
      // anything — and inventing a cause is the same category error wire
      // 1.9.0 was cut to fix. `charge_blocker` is optional on the wire, and an
      // absent one is the honest answer: the charge did not complete, and we
      // are not going to say why it didn't when we don't know.
      return { kind: 'failure', failure: dogChargeFailedResult(dogId) };
    case 'requires_payment_method':
    case 'requires_action':
    case 'requires_confirmation': {
      // The blocker comes from THE one derivation point. Prefer the confirm's
      // evidence when it has any: a thrown card error carries `err.code`,
      // which names WHICH failure happened, while the retrieved intent's
      // status reads the same for a decline and an authentication failure.
      const blocker =
        chargeBlockerForConfirm(confirmed.status === 'succeeded' ? live : confirmed, log) ??
        chargeBlockerForConfirm(live, log);
      return { kind: 'failure', failure: dogChargeFailedResult(dogId, narrowBlocker(blocker)) };
    }
  }
}

/**
 * `charge_failed` carries only the two arms that send an owner to a card.
 * `processing` never reaches it — an in-flight authorization is
 * `charge_unverified`, whose copy says "don't retry", and the whole hazard
 * ranking exists because telling an owner to try another card while money may
 * be moving is the reachable double charge.
 *
 * `undefined` stays `undefined` (ADDENDUM 1 R5): a blocker is a CAUSE, and the
 * one thing worse than an unexplained failure is an invented explanation.
 * `processing` collapses to `declined` because it cannot reach here — the
 * three statuses this is called for are all resting states of a refusal — and
 * because the alternative would put the one blocker whose copy refuses a retry
 * on a dog whose card genuinely stopped.
 */
function narrowBlocker(
  blocker: ChargeBlocker | undefined,
): Exclude<ChargeBlocker, 'processing'> | undefined {
  if (blocker === undefined) return undefined;
  return blocker === 'authentication_required' ? 'authentication_required' : 'declined';
}

/** One best-effort cancel. Shared so every release site logs the same sentence
 *  and none of them can quietly become a refund. */
async function cancelOne(
  stripe: StripeClient,
  intentId: string,
  dogId: string,
  log: { error(obj: Record<string, unknown>, msg?: string): void },
): Promise<void> {
  try {
    await stripe.cancelPaymentIntent(intentId);
  } catch (err) {
    log.error(
      { err, paymentIntentId: intentId, dogId },
      'group-class enroll: could not release an authorization hold — no money moved (nothing was captured); the hold expires on its own',
    );
  }
}

/**
 * Release every intent this request registered and has not already decided —
 * **cancel, never refund** (invariants 2 and 3). This is the outermost
 * boundary's `finally` on both response paths (ADDENDUM 1 R1), and it is a
 * safety net rather than a second actor: everything the happy path handled is
 * already `resolved`, so this call is a no-op on the paths that succeeded.
 *
 * Two gates, both of which must pass before a cancel is attempted:
 *
 *   1. **Provenance is not `replayed`.** An intent Stripe replayed belongs to
 *      whoever created it, and that request may be capturing it right now.
 *   2. **The RETRIEVED status is cancellable.** Not the status a confirm
 *      returned — the mirror of invariant 1, and for the same reason: a
 *      snapshot can name a state that has since moved. `succeeded` is money
 *      that moved (undoing it is a refund, which belongs to the withdraw arm
 *      alone); `canceled` is already released; `processing` is the status
 *      Stripe refuses to cancel.
 *
 * Every entry is marked resolved whatever happens, including when the retrieve
 * itself throws: a release path that cannot reach Stripe has nothing left to
 * try, and the honest outcome is one log line plus a hold that expires on its
 * own. Failures never mask the error that caused the release.
 */
export async function releaseRegistry(args: {
  stripe: StripeClient;
  registry: HoldRegistry;
  log: { error(obj: Record<string, unknown>, msg?: string): void };
}): Promise<void> {
  // This runs in a `finally` on both paths, and an exception thrown from a
  // `finally` REPLACES the error being propagated. A release that failed in
  // some way its per-intent guards did not anticipate must not turn a 422
  // `cohort_full` into a 500 — the owner's answer is the thing being carried
  // out of that block, and it is more useful than a cleanup's failure.
  try {
    await releaseUnresolved(args);
  } catch (err) {
    args.log.error(
      { err },
      'group-class enroll: releasing authorizations threw at the outermost boundary — no money moved (nothing is ever captured before the commit); any hold left behind expires on its own',
    );
  }
}

async function releaseUnresolved(args: {
  stripe: StripeClient;
  registry: HoldRegistry;
  log: { error(obj: Record<string, unknown>, msg?: string): void };
}): Promise<void> {
  for (const entry of args.registry.entries) {
    if (entry.resolved) continue;
    entry.resolved = true;
    if (entry.provenance === 'replayed') continue;
    let live;
    try {
      live = await args.stripe.retrievePaymentIntent(entry.intentId);
    } catch (err) {
      args.log.error(
        { err, paymentIntentId: entry.intentId, dogId: entry.dogId },
        'group-class enroll: could not read an authorization while releasing it — no money moved (nothing was captured); the hold expires on its own',
      );
      continue;
    }
    if (!CANCELLABLE_STATUSES.has(live.status)) continue;
    await cancelOne(args.stripe, entry.intentId, entry.dogId, args.log);
  }
}

/** One dog's post-capture money truth. */
export interface CaptureOutcome {
  dogId: string;
  /** `'paid'` = captured. `'pending'` = enrolled, capture unfinished — the
   *  reconciler finishes it or pages a human. Never a decline either way. */
  state: 'paid' | 'pending';
  capturedCents: number;
}

/**
 * Capture each enrolled dog's hold AFTER the transaction commits (§3.7), then
 * flip its `charges` row to `'succeeded'`.
 *
 * Not via `withMutation`'s `postCommit`: that seam logs and SWALLOWS, and this
 * route must SEE the result — `total_captured_cents` and each dog's
 * `payment_state` are read off it, and announcing money that did not move is
 * the one thing the envelope must never do.
 *
 * Every capture is preceded by a retrieve, which is invariant 1 and the reason
 * this costs two round-trips per dog. A capture failure is answered with
 * `'pending'` and one immediate retry, never with a decline: the money either
 * already moved or is still held, and both are true statements the owner can
 * live with; "your card was declined" is not.
 */
export async function captureHeldDogs(args: {
  stripe: StripeClient;
  actor: string;
  holds: readonly DogAuthorization[];
  chargeIdByDog: ReadonlyMap<string, string>;
  idempotencyKey: string;
  log: { error(obj: Record<string, unknown>, msg?: string): void };
}): Promise<CaptureOutcome[]> {
  const outcomes: CaptureOutcome[] = [];
  const settledChargeIds: string[] = [];

  for (const hold of args.holds) {
    const chargeId = args.chargeIdByDog.get(hold.dogId);
    if (chargeId === undefined) continue; // dog didn't enroll; its hold is released elsewhere
    const captured = await captureOneHold(args.stripe, hold, args.idempotencyKey, args.log);
    if (captured) {
      settledChargeIds.push(chargeId);
      outcomes.push({ dogId: hold.dogId, state: 'paid', capturedCents: hold.amountCents });
    } else {
      outcomes.push({ dogId: hold.dogId, state: 'pending', capturedCents: 0 });
    }
  }

  if (settledChargeIds.length > 0) {
    // One short transaction for the flips, after every Stripe call — R5 (no
    // Stripe inside a DB transaction) holds in both directions.
    //
    // **And it may not throw** (ADDENDUM 1 R8). This was the one unguarded
    // statement left after the commit: a DB fault here propagated out of a
    // request whose enrollment had COMMITTED and whose money had MOVED, and
    // mobile's submit catch renders a thrown enrollment as "nothing enrolled,
    // nothing charged" — an assertion its own comment makes and that would be
    // false. The captures beside it have swallowed-and-logged since they were
    // written, for the same reason; the flip is no different, and the charge
    // rows are already the reconciler's job.
    try {
      await withActor(args.actor, async (tx) => {
        for (const id of settledChargeIds) {
          await chargesRepository.markStatus(tx, { id, status: 'succeeded' });
        }
      });
    } catch (err) {
      args.log.error(
        { err, chargeIds: settledChargeIds },
        'group-class enroll: money was CAPTURED but the charge row flip failed — the dogs are enrolled and their payment is reported PENDING; the capture reconciler retrieves `succeeded` and writes the flip',
      );
      // Report what we can PROVE is recorded, which is now nothing: the money
      // moved but no row says so, and announcing captured money whose row we
      // could not write is the direction this module never takes. The
      // reconciler's `already-captured` arm heals it within a tick.
      const settled = new Set(settledChargeIds);
      for (const outcome of outcomes) {
        const chargeId = args.chargeIdByDog.get(outcome.dogId);
        if (chargeId !== undefined && settled.has(chargeId)) {
          outcome.state = 'pending';
          outcome.capturedCents = 0;
        }
      }
    }
  }

  return outcomes;
}

/** What became of the post-capture amend of the stored idempotency response. */
export type StoredEnvelopeAmendOutcome =
  /** The stored body now tells post-capture money truth. */
  | 'amended'
  /** No completed row matched (key/endpoint/hash). Nothing was stale to fix. */
  | 'not-found'
  /** The UPDATE itself threw. Swallowed here; see below for why. */
  | 'failed';

/**
 * Amend the stored idempotency response after the post-commit capture, and
 * **never throw doing it** (ADDENDUM 1 R8, second statement).
 *
 * This is the R8 guard applied to the one place it had been left off. The
 * amend is a bare pool-level UPDATE, and it runs AFTER the enroll transaction
 * committed and AFTER Stripe captured. A DB fault raised here used to
 * propagate into the route's `catch`, which — seeing `committed === true` —
 * resolves the registry and RETHROWS, producing a 500 for an enrollment that
 * COMMITTED with money CAPTURED. Mobile's submit catch renders a thrown
 * enrollment as "nothing enrolled, nothing charged": a sentence that would be
 * false in both halves, which is the exact money-lie R8 exists to prevent —
 * one statement after R8's own guard.
 *
 * It also defeated R8 in the case R8 is FOR. A persistent DB fault fails the
 * charge-row flip, {@link captureHeldDogs} downgrades those dogs to `pending`
 * and returns rather than throwing — and then the amend, carrying the
 * downgraded envelope, hit the same fault and 500'd anyway.
 *
 * A failed amend costs a client retry a stale — never a WRONG — reading:
 * `pending` and `total_captured_cents: 0` for money that has since moved. The
 * charge rows and `GET /enrollments` are the durable truth either way, and the
 * stale row is swept at 24h (DATA-CONTRACT §L.8). Losing the enrollment's
 * response entirely costs strictly more.
 */
export async function amendStoredEnvelopeAfterCapture(args: {
  key: string;
  endpoint: string;
  requestHash: string;
  body: unknown;
  logContext: Record<string, unknown>;
  log: {
    warn(obj: Record<string, unknown>, msg?: string): void;
    error(obj: Record<string, unknown>, msg?: string): void;
  };
}): Promise<StoredEnvelopeAmendOutcome> {
  try {
    const amended = await updateStoredResponse({
      key: args.key,
      endpoint: args.endpoint,
      requestHash: args.requestHash,
      body: args.body,
    });
    if (amended) return 'amended';
    args.log.warn(
      args.logContext,
      'group-class enroll: could not amend the stored idempotency response after capture — a retry would replay pre-capture money truth',
    );
    return 'not-found';
  } catch (err) {
    args.log.error(
      { ...args.logContext, err },
      'group-class enroll: the enrollment COMMITTED and the money was CAPTURED, but amending the stored idempotency response THREW — the response being returned is correct; only a same-key retry would replay pre-capture money truth until the 24h sweep. Never fatal: the charge rows and GET /enrollments are the durable truth',
    );
    return 'failed';
  }
}

/**
 * Capture one hold. Returns whether the money is now captured.
 *
 * `true` covers two states that are the same fact: this call captured, or a
 * retrieve found it already captured (our own earlier attempt, or a Stripe
 * replay). `false` means the money is still merely held and the reconciler
 * owns it from here.
 */
async function captureOneHold(
  stripe: StripeClient,
  hold: DogAuthorization,
  idempotencyKey: string,
  log: { error(obj: Record<string, unknown>, msg?: string): void },
): Promise<boolean> {
  if (hold.state === 'captured') return true;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const live = await stripe.retrievePaymentIntent(hold.intentId);
      if (live.status === 'succeeded') return true;
      if (live.status !== 'requires_capture') {
        // Invariant 1: we capture a hold or we capture nothing. A status that
        // is neither succeeded nor capturable is the reconciler's problem —
        // and if the hold was lost, its alarm is the one that reaches a human.
        log.error(
          { paymentIntentId: hold.intentId, dogId: hold.dogId, stripeIntentStatus: live.status },
          'group-class enroll: authorization is not capturable after commit — dog is enrolled and payment is PENDING; the capture reconciler will resolve or alert',
        );
        return false;
      }
      await stripe.capturePaymentIntent(hold.intentId, dogCaptureKey(idempotencyKey, hold.dogId));
      return true;
    } catch (err) {
      if (attempt === 1) {
        log.error(
          { err, paymentIntentId: hold.intentId, dogId: hold.dogId },
          'group-class enroll: capture failed twice — dog is ENROLLED and payment is PENDING; the capture reconciler owns it from here',
        );
        return false;
      }
    }
  }
  return false;
}
