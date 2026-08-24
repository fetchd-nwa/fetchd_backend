import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import { actorOf, type Principal } from '../auth/principal.js';
import type {
  ChargeBlocker,
  EnrollmentDogResultWire,
  EnrollmentResultWire,
  EnrollmentWithdrawResultWire,
  WithdrawMoneyOutcome,
} from '../contracts/wire.js';
// NOT `updateStoredResponse`: the post-capture amend goes through
// `amendStoredEnvelopeAfterCapture` below, which cannot throw into the
// post-commit path. Importing the raw statement here again would put the 500
// back within reach of one call site.
import { peekCompletedIdempotency } from '../db/idempotency.js';
import {
  hashRequestBody,
  requireIdempotencyKey,
  withMutation,
  IDEMPOTENCY_KEY_MAX_LEN,
} from '../db/mutation.js';
import { lockCohort } from '../db/locks.js';
import { agreementSignaturesRepository } from '../db/repositories/agreementSignaturesRepository.js';
import { bookingsRepository } from '../db/repositories/bookingsRepository.js';
import { chargesRepository } from '../db/repositories/chargesRepository.js';
import { cohortsRepository } from '../db/repositories/cohortsRepository.js';
import { dogCompletedClassesRepository } from '../db/repositories/dogCompletedClassesRepository.js';
import { dogsRepository } from '../db/repositories/dogsRepository.js';
import {
  enrollmentsRepository,
  type EnrollmentPaymentStatus,
} from '../db/repositories/enrollmentsRepository.js';
import {
  groupClassesRepository,
  type GroupClassKey,
} from '../db/repositories/groupClassesRepository.js';
import { invoicesRepository } from '../db/repositories/invoicesRepository.js';
import { paymentMethodsRepository } from '../db/repositories/paymentMethodsRepository.js';
import { refundsRepository } from '../db/repositories/refundsRepository.js';
import { withActor } from '../db/tx.js';
import {
  agreementUnsignedError,
  alreadyEnrolledError,
  cohortFullError,
  dogChargeFailedResult,
  dogEnrolledResult,
  dogSeatShortfallResult,
  eligibilityMissingError,
  paymentRequiredError,
  type EligibilityGap,
} from '../lib/bookingErrors.js';
import { checkBookingGates } from '../lib/bookingGatePreCheck.js';
import { enrollmentIdentityOf } from '../lib/enrollmentIdentity.js';
import {
  amendStoredEnvelopeAfterCapture,
  authorizeDogsForEnrollment,
  captureHeldDogs,
  checkDogsForEnrollment,
  createHoldRegistry,
  releaseRegistry,
  resolveAllIntents,
  resolveIntentsForDogs,
  settleRefusedAuthorizations,
  type CaptureOutcome,
  type DogAuthorization,
} from '../lib/enrollmentPartial.js';
import { enqueueBookingReminders } from '../lib/enqueueBookingReminders.js';
import { insertBookingWithGateMapping } from '../lib/insertBookingWithGateMapping.js';
import { computeCohortSessionDates } from '../lib/cohortSchedule.js';
import { toBookingWire, type BookingWire } from '../lib/bookingWire.js';
import { cancelWindowSettingsRepository } from '../db/repositories/cancelWindowSettingsRepository.js';
import { computeCancelDeadlineFromHours } from '../lib/cancelWindow.js';
import { ApiError, isIdempotencyInflight } from '../lib/errors.js';
import { loadStripePaymentContext } from '../lib/loadStripePaymentContext.js';
import {
  firePendingRefundPostCommit,
  type PendingStripeRefund,
} from '../lib/pendingRefund.js';
import { pgTimestampToDate } from '../lib/pgTimestamp.js';
import { requireOwner } from '../lib/principalNarrows.js';
import {
  defaultStripeClient,
  stripeIntentStatusToChargeStatus,
  type StripeClient,
} from '../lib/stripe.js';
import {
  settleCapturePendingHold,
  type WithdrawSettleVerdict,
} from '../lib/withdrawSettlement.js';
import { parseOrThrow } from '../lib/zodIssues.js';

/**
 * `POST /enrollments` `[auth]` — Day 11 cohort enrollment.
 *
 * Group-class enrollment is structurally distinct from day-program
 * booking (POST /bookings) and lives in its own route file per §C.1
 * Model 2 ("Never POST /bookings" for group-class). One transaction
 * materializes `len(dog_ids) × cohort.weeks` booking rows under a
 * cohort row lock + bumps `cohorts.filled` atomically.
 *
 * The transaction protocol (matches schema.sql ~line 1298):
 *   1. Ownership gate per dog (`dogsRepository.findOwnedExists`).
 *   2. `lockCohort(tx, cohort_id)` — `SELECT ... FOR UPDATE` on the
 *      cohort row. All concurrent enrollments to this cohort
 *      serialize here.
 *   3. Liveness check — `expiredAt !== null` → 404 (soft-expired
 *      cohort = "no such cohort" for enrollment purposes).
 *   4. Capacity assertion — `filled + |dog_ids| > capacity` → 422
 *      `cohort_full` with structured details.
 *   5. R7 eligibility — per dog, check OR-prereq options (Day-6a's
 *      `class_prereq_options`). Any dog missing a satisfier → 422
 *      `eligibility_missing` with per-dog gap detail.
 *   6. Gate pre-check above the trigger floor — payment (owner once)
 *      → vaccine (per dog, since each dog will be a lead in its own
 *      bookings) → agreement (owner once, against `group-class`).
 *      Same priority order as Day-10 (rule-of-two; extract at
 *      rule-of-three on Day 12).
 *   7. Materialize per-week scheduled_at via `computeCohortSessionDates`
 *      (DST-preserving Chicago wall-time cadence). For each dog × week,
 *      INSERT a single-dog booking + booking_dogs. Trigger fallback maps
 *      race-induced gate violations via `gateTriggerErrorToApiError`.
 *   8. `cohortsRepository.bumpFilled(tx, cohort_id, +|dog_ids|)` under
 *      the held row lock.
 *   9. Payment (Δ 2026-06-09; **manual capture since 2026-08-20, wire
 *      1.11.0**), per dog — group-class is money-paid, not credit-paid.
 *      Pay-now: one PaymentIntent per dog is AUTHORIZED before this tx
 *      (`capture_method: 'manual'` — funds held, nothing moved); this step
 *      writes the `charges` row at `'requires_payment'`, the honest status for
 *      a hold, and the post-commit capture flips it to `'succeeded'`. A
 *      declined card blocks enrollment on this response shape and blocks only
 *      THAT DOG on the `allow_partial` one. Pay-later: a card-backed open
 *      `invoices` row per dog due 24h before the first session — the
 *      auto-charge worker bills it then. Withdrawing before the first session
 *      refunds the charge / voids the open invoice.
 *  10. Post-commit: capture each enrolled dog's hold, flip its charge row, and
 *      amend the stored idempotency response so a replay tells post-capture
 *      truth. Release every hold that did NOT enroll — cancel, never refund;
 *      nothing is captured before the commit. No cache invalidation today (the
 *      cohort catalog cache is keyed by class_key, not cohort id, and a
 *      `filled` bump doesn't change the catalog wire shape). Day-19 staff
 *      cohort edits will add `cohorts:*` patterns.
 *
 * Body: `{ cohort_id: uuid, dog_ids: uuid[], payment_method_id: uuid,
 *   pay_later?: boolean, allow_partial?: boolean }`.
 *   **Without `allow_partial`:** 201 + `BookingWire[]` length =
 *   `|dog_ids| × cohort.weeks`, ASC by scheduled_at then dog_id — byte-for-byte
 *   what it always was. **With it:** `EnrollmentResultWire`, one row per
 *   requested dog, 201 when at least one enrolled and 200 when none did (never
 *   an error status — see DATA-CONTRACT §L.1). The field is the degrade
 *   boundary: an old client never sends it and is therefore never handed an
 *   envelope it would `raw.map(toBooking)` into a TypeError.
 *
 * Owner-only. Staff principals get 403 — the Day-19 staff portal will
 * surface cohort enrollments via the cohort detail screen but never
 * via this endpoint.
 *
 * Duplicate-enrollment guard (Day-19d, step 3b): a `(cohort_id,
 * lead_dog_id)` live-bookings check runs under the cohort lock — a dog
 * already enrolled (non-cancelled bookings in this cohort) is rejected
 * with `already_enrolled` 422. Cancelled bookings are excluded, so
 * "re-enroll after cancel" works. Idempotency still replays the exact
 * retry; the guard catches two distinct enroll attempts.
 */

/**
 * Body cap on dogs per enrollment request. Matches Day-10's same-named
 * limit on POST /bookings — a hostile body bounded BEFORE we touch the
 * DB. Five is the realistic ceiling (NWA's three-dog households
 * dominate; 5 covers every plausible household).
 */
const MAX_DOGS_PER_REQUEST = 5;

/**
 * Pay-later auto-charge lead time (Δ 2026-06-09): a card-backed open invoice
 * is created with `due_at = cohort_start − 24h`, and the existing invoice
 * auto-charge worker charges it then. Unenrolling before that voids the
 * invoice, so a pay-later that's withdrawn early is never charged.
 */
const GROUP_CLASS_AUTOCHARGE_LEAD_MS = 24 * 60 * 60 * 1000;

const postEnrollmentBodySchema = z
  .object({
    cohort_id: z.string().uuid(),
    dog_ids: z.array(z.string().uuid()).min(1).max(MAX_DOGS_PER_REQUEST),
    payment_method_id: z.string().uuid('payment_method_id must be a UUID'),
    // pay-now (the default) authorizes each dog's card immediately; pay-later
    // defers to the auto-charge worker 24h before the first session.
    pay_later: z.boolean().optional(),
    /**
     * Wire 1.11.0 — per-dog partial success. Named for the SEMANTICS it
     * changes, not the shape: with it, this route enrolls every dog that
     * passes its checks and reports every dog that doesn't, per dog, with the
     * exact reason (Allison 2026-08-12: "not transactional where we fail the
     * entire ting"). Without it, the route keeps today's all-or-nothing
     * behavior and today's `BookingWire[]` response byte-for-byte.
     *
     * **The field is the degrade boundary, not the version.** An old app does
     * `raw.map(toBooking)` on this response; handed an envelope it would
     * TypeError into its submit catch and render "something went wrong" while
     * dogs were actually enrolled and charged — the worst degrade available.
     * Old clients never send this field, so they are never handed one.
     *
     * Omitting it hashes identically to a pre-1.11.0 body (`mutation.ts`
     * canonical-JSON hash), so no in-flight Idempotency-Key changes meaning.
     */
    allow_partial: z.boolean().optional(),
    /**
     * Wire 1.12.0 — the client `Idempotency-Key` under which this dog's latest
     * EXECUTED payment attempt ran, sent by mobile on an AUTOMATIC retry
     * (ADDENDUM 3 §A3.13, amended by §A3.14; Allison's Q-D ruling: *"retry 3
     * times before settling for yes or no"*).
     *
     * It exists because the server keeps NO record of a refused dog's intent —
     * no charge row is minted for a dog that never enrolled — so the live
     * attempt is reachable only through its derived Stripe key. With it, the
     * authorize step RE-VERIFIES that attempt before it is allowed to mint a
     * new one, which is what stops a `charge_unverified` retry from putting a
     * second hold on a card whose first one is still verifying.
     *
     * **Not "the original request's key" (§A3.14 supersedes §A3.13 here).** A
     * chain that always names the FIRST attempt re-verifies a dead intent once
     * any attempt mints a fresh one, and mints a third beside the live second —
     * the double-hold the rule exists to prevent. The client does not infer
     * which key that is: the server names it per dog as
     * `EnrollmentDogResultWire.verify_key`, and the client echoes that value
     * here, omitting the field when it is absent. This route reads whatever
     * arrives and never assumes which attempt it names.
     *
     * Bounded by {@link IDEMPOTENCY_KEY_MAX_LEN} for the same reason the header
     * is: `${retry_of}:dog:${dogId}` goes to Stripe, and Stripe caps keys at
     * 255. A body-supplied key that skipped this bound would mint an unsendable
     * derived key on a money path.
     *
     * Omitting it hashes identically to a pre-1.12.0 body (`mutation.ts`
     * canonical-JSON hash — an absent optional field is absent from the parsed
     * object), so no in-flight Idempotency-Key changes meaning. A body that
     * CARRIES it is a new logical mutation under its own fresh key.
     */
    retry_of: z.string().min(1).max(IDEMPOTENCY_KEY_MAX_LEN).optional(),
  })
  .strict();

type PostEnrollmentBody = z.infer<typeof postEnrollmentBodySchema>;

export interface EnrollmentsRouteOptions extends AuthRouteOptions {
  /** Stripe seam (Δ 2026-06-09 pay-now / withdraw refund). Tests inject a stub. */
  stripe?: StripeClient;
  /**
   * Injectable clock for the withdraw "class hasn't started yet" guard, so a
   * contract test gets a deterministic now vs the fixture cohort start dates.
   * Default = `new Date()`.
   */
  now?: () => Date;
}

const cohortIdParamSchema = z.object({ cohortId: z.string().uuid('cohortId must be a UUID') });
const withdrawBodySchema = z.object({ dog_id: z.string().uuid('dog_id must be a UUID') }).strict();

export function registerEnrollmentsRoute(
  app: FastifyInstance,
  opts: EnrollmentsRouteOptions = {},
): void {
  const authHook = resolveAuthHook(opts);
  const stripe = opts.stripe ?? defaultStripeClient;
  const nowFactory = opts.now ?? ((): Date => new Date());

  app.post(
    '/enrollments',
    { preHandler: [authHook] },
    async (request, reply): Promise<BookingWire[] | EnrollmentResultWire> => {
      const principal = requirePrincipal(request);
      requireOwner(principal, 'enroll dogs in a cohort');
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
      const body = parseOrThrow(postEnrollmentBodySchema, request.body, 'body');
      const parsed = validateEnrollmentBody(body);
      const requestHash = hashRequestBody(body);
      const actor = actorOf(principal);
      // Deterministic dog order: the authorize loop and the in-tx booking
      // inserts walk the same sorted list, so each dog's hold pairs with its
      // own bookings. The RESPONSE envelope is in REQUEST order — the order the
      // owner picked their dogs — which is why the two are tracked separately.
      const sortedDogIds = [...parsed.dogIds].sort();

      // ── §3.1 Step 0: peek, BEFORE any Stripe call ──────────────────────
      // A retry that arrives after this key completed must replay the stored
      // response with ZERO Stripe traffic. Without this, the retry re-enters
      // the advisory phase, and a dog whose failure has since cleared would be
      // authorized — minting a hold the stored response never mentions and
      // nothing ever captures or releases. `withIdempotency`'s own claim
      // replays too, but only AFTER the pre-tx money work has already run.
      const peeked = await peekCompletedIdempotency<BookingWire[] | EnrollmentResultWire>(
        idempotencyKey,
        'POST /enrollments',
        requestHash,
      );
      if (peeked !== undefined) {
        reply.code(peeked.status);
        return peeked.body;
      }

      const cohort = await resolveCohortForEnrollment(parsed.cohortId);
      const shared: EnrollmentRunContext = {
        stripe,
        principal,
        actor,
        parsed,
        sortedDogIds,
        cohort,
        idempotencyKey,
        requestHash,
        log: request.log,
      };

      const outcome = parsed.allowPartial
        ? await runPartialEnrollment(shared)
        : await runAllOrNothingEnrollment(shared);
      reply.code(outcome.status);
      return outcome.body;
    },
  );

  // --- GET /enrollments -------------------------------------------------
  //
  // The owner's current group-class enrollments — one row per live (cohort,
  // dog) pairing, for the mobile "Currently enrolled" section. `can_withdraw`
  // mirrors the withdraw verb's guard (self-serve withdraw is allowed until the
  // first session starts); the verb re-checks it authoritatively under the lock.
  app.get(
    '/enrollments',
    { preHandler: [authHook] },
    async (request): Promise<EnrollmentWire[]> => {
      const principal = requirePrincipal(request);
      requireOwner(principal, 'list enrollments');
      const rows = await enrollmentsRepository.listForOwner(principal.ownerId);
      const nowMs = nowFactory().getTime();
      return rows.map((row) => toEnrollmentWire(row, nowMs));
    },
  );

  // --- POST /enrollments/:cohortId/withdraw -----------------------------
  //
  // Per-dog unenroll (Δ 2026-06-09; **money settlement respecified 2026-08-21,
  // wire 1.12.0**, `designs/partial-success-enrollment.md` ADDENDUM 3 §A3.2).
  //
  // Under the cohort lock: guard the class hasn't started, soft-cancel that
  // dog's weekly bookings, decrement `cohorts.filled`, then settle the money —
  // EXHAUSTIVELY, over every state a group-class charge row can be in. An
  // unpaid pay-later open invoice is VOIDED; a succeeded charge is REFUNDED; a
  // LIVE AUTHORIZATION (manual capture, row still `'requires_payment'`) is
  // RELEASED — and the response names which of those happened.
  //
  // The last arm is the round-3 blocker: manual capture changed what a
  // `'requires_payment'` row means, this arm was never respecified for it, and
  // a withdraw during the capture-pending window therefore released nothing,
  // stopped nothing, and let the reconciler capture money for a class with zero
  // live bookings. Allison, 2026-08-21: *"as a user it should be very clear
  // what is happening with my money. no uncertains"*.
  app.post(
    '/enrollments/:cohortId/withdraw',
    { preHandler: [authHook] },
    async (request, reply): Promise<EnrollmentWithdrawResultWire> => {
      const principal = requirePrincipal(request);
      requireOwner(principal, 'withdraw from a cohort');
      const { cohortId } = parseOrThrow(cohortIdParamSchema, request.params, 'path');
      const { dog_id: dogId } = parseOrThrow(withdrawBodySchema, request.body, 'body');
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
      const requestHash = hashRequestBody({ cohortId, dogId });

      // ── Step 1: peek, BEFORE any Stripe call ────────────────────────────
      // A retry that arrives after this key completed must replay its stored
      // answer with ZERO Stripe traffic (the class rule,
      // `designs/money-safety-rollback-and-replay.md` §6; the same reason POST
      // /enrollments peeks). Without it, a retry re-enters the settle phase
      // against state its own first attempt already moved: it would retrieve a
      // now-`canceled` intent and re-derive a verdict for money that is
      // already settled. `withMutation`'s own claim replays too — but only
      // AFTER the pre-tx money work has run, which is too late to be a defence.
      const peeked = await peekCompletedIdempotency<EnrollmentWithdrawResultWire>(
        idempotencyKey,
        WITHDRAW_ENDPOINT,
        requestHash,
      );
      if (peeked !== undefined) {
        reply.code(peeked.status);
        return peeked.body;
      }

      // ── Steps 2–4: advisory guards, money-state read, pre-tx Stripe settle ─
      const preTx = await settleWithdrawMoneyBeforeTx({
        stripe,
        principal,
        actor: actorOf(principal),
        cohortId,
        dogId,
        nowFactory,
      });

      // Closure handles for the post-commit Stripe refunds (money-back
      // branches); EMPTY for the void / release / free paths (postCommit
      // no-ops). A LIST since §A2.1: the invoice lane settles every unsettled
      // pay attempt, and two taps that both captured are two charges owed two
      // refunds. Each carries its own stored key, so the fan-out below is a
      // loop over commitments, not a fan-out of one.
      const pendingStripeRefunds: PendingStripeRefund[] = [];
      // Computed ONCE, here, so the row stores the same string the fire sends.
      const refundIdempotencyKey = `${idempotencyKey}:refund`;

      const outcome = await withMutation<EnrollmentWithdrawResultWire>(
        {
          principal,
          idempotencyKey,
          endpoint: WITHDRAW_ENDPOINT,
          requestHash,
          keysToInvalidate: () => [],
          postCommit: async () => {
            // Sequential, and every one is attempted: each refund row is an
            // independent R35 commitment with its own stored key, so one
            // failing fire must not swallow its siblings. The helper already
            // logs-and-swallows per refund, and the duplicate-refund sweep
            // re-fires anything whose response was lost.
            for (const pending of pendingStripeRefunds) {
              await firePendingRefundPostCommit({
                pending,
                stripe,
                log: request.log,
                context: { cohortId, dogId, refundPath: 'cohort-withdraw' },
              });
            }
          },
        },
        async (tx) => {
          // 1. Lock the cohort — serialize against concurrent enroll/withdraw
          //    so the `filled` decrement is race-free. 404 collapses gone +
          //    soft-expired.
          const cohortRow = await lockCohort(tx, cohortId);
          if (cohortRow === undefined || cohortRow.expiredAt !== null) {
            throw new ApiError('not_found', `cohort ${cohortId} not found`);
          }

          // 2. Ownership — the dog must belong to the principal (same 404 for
          //    "not owned" vs "doesn't exist").
          const owned = await dogsRepository.findOwnedExists(dogId, principal.ownerId, tx);
          if (!owned) {
            throw new ApiError('not_found', `dog ${dogId} not found`);
          }

          // 3. The dog's live weekly bookings in this cohort. None → not enrolled.
          const enrolledBookings = await bookingsRepository.findLiveBookingsForCohortDog(
            tx,
            cohortId,
            dogId,
          );
          if (enrolledBookings.length === 0) {
            throw new ApiError('conflict', `dog ${dogId} is not enrolled in cohort ${cohortId}`);
          }

          // 4. Pre-start guard — self-serve withdraw closes once the first
          //    session has started (staff can still cancel via the portal).
          const firstSessionMs = new Date(enrolledBookings[0]!.scheduledAt).getTime();
          if (nowFactory().getTime() >= firstSessionMs) {
            throw new ApiError(
              'conflict',
              'this class has already started — contact us to withdraw',
            );
          }

          // 5. Soft-cancel every weekly booking + release the cohort seat.
          //    Owner self-serve withdraw → cancelledBy 'owner' (R5).
          for (const booking of enrolledBookings) {
            await bookingsRepository.markCancelled(tx, {
              id: booking.id,
              cancelledBy: 'owner',
              // Same clock the pre-start guard above read — a withdraw that
              // passed "the class hasn't started" must not stamp its rows
              // from a second, later instant.
              now: nowFactory(),
            });
          }
          await cohortsRepository.bumpFilled(tx, cohortId, -1);

          // 6. Settle the money — §A3.2's table, exhaustive over the states a
          //    group-class charge row can be in, in priority order. AT MOST ONE
          //    arm fires per request. There are THREE mint sites below in two
          //    key spellings — the multi-row settle arm's per-charge
          //    `${K}:refund:${chargeId}` and the two single-charge arms' bare
          //    `${K}:refund` — and they cannot collide: one arm per request,
          //    and a bare key can never equal a per-charge key (charge ids are
          //    UUID suffixes).
          //
          //    The authoritative rows are re-read HERE; the pre-tx verdict is
          //    Stripe's post-race truth and is not re-derivable from the DB, so
          //    the two are combined rather than one being trusted alone.
          let refundedCents = 0;
          let moneyOutcome: WithdrawMoneyOutcome = 'none';
          let releasedCents: number | undefined;
          let owedCents: number | undefined;

          /** The refund mint, identical for every arm that reaches it (R35
           *  pending-row-as-commitment, the client-keyed recovery machinery).
           *  Returns the cents ACTUALLY put on their way back — 0 when there
           *  was nothing left to return, which is what the callers read the
           *  outcome off (§A3.15 finding 2, the structural half).
           *
           *  **The R9 cap is computed under the charge row's LOCK** (§A3.18
           *  D2), inside the shared helper, because it is a read-modify-write:
           *  this leg and the scheduler's `settlePostWithdrawRefund` were
           *  measured overlapping, both reading `sumNonFailed = 0` for one
           *  charge and both committing a full refund under different Stripe
           *  keys — which Stripe would have executed twice.
           *
           *  **The key is the caller's** (§A2.1/5). The pay-now lane passes the
           *  landed `${K}:refund`; the invoice lane passes
           *  `${K}:refund:${charge.id}`, because it can mint for SEVERAL rows in
           *  one request (two taps can both capture) and one key across two
           *  refunds is how one debt becomes one refund. Both spellings are
           *  deterministic per request, which is what makes a retry replay. */
          const mintRefund = async (charge: { id: string }, stripeKey: string): Promise<number> => {
            const minted = await refundsRepository.mintCappedPendingRefund(tx, {
              chargeId: charge.id,
              ownerId: principal.ownerId,
              bookingId: null,
              reason: 'cancel',
              // Stored in the SAME tx as the row: without it a failed
              // post-commit `createRefund` was unretryable by anything,
              // because this key lives only in this request's closure.
              stripeIdempotencyKey: () => stripeKey,
            });
            if (minted.kind !== 'minted') return 0;
            pendingStripeRefunds.push({
              refundId: minted.refundId,
              paymentIntentId: minted.paymentIntentId,
              amountCents: minted.amountCents,
              stripeIdempotencyKey: minted.stripeIdempotencyKey,
            });
            return minted.amountCents;
          };

          /**
           * Apply §A2.1's PER-ROW actions for everything the pre-tx phase
           * settled, and hand back the facts each arm composes its sentence
           * from. Actions are per row; the SENTENCE is by precedence, and the
           * precedence lives at the call sites because the two arms disagree
           * about what "all dead" means.
           *
           * Every `released` row flips `'failed'` — the established
           * `canceled → failed` mapping, asserted through the mapper so the
           * compiler checks the citation. That flip is also what ends the
           * reconciler's claim on the row (its worklist predicate is
           * `status='requires_payment'`). Every `refunded` row flips
           * `'succeeded'` FIRST — ledger honesty is independent of the
           * envelope (§A3.15 finding 2): the money moved, so the row says so
           * even when the cap leaves nothing to return — and then mints its
           * capped refund. Every `release_pending` row is left at
           * `'requires_payment'` DELIBERATELY, because the reconciler is the
           * executor of the promise that word makes (§A3.3).
           */
          const applySettledRows = async (
            settlement: WithdrawPreTxSettlement,
          ): Promise<{
            mintedCents: number;
            anyRefunded: boolean;
            livePending: { amountCents: number } | undefined;
            settledIds: string[];
          }> => {
            let mintedCents = 0;
            let anyRefunded = false;
            let livePending: { amountCents: number } | undefined;
            for (const row of settlement.rows) {
              switch (row.verdict) {
                case 'released':
                  await chargesRepository.markStatus(tx, {
                    id: row.charge.id,
                    status: stripeIntentStatusToChargeStatus('canceled'),
                  });
                  break;
                case 'refunded':
                  await chargesRepository.markStatus(tx, {
                    id: row.charge.id,
                    status: 'succeeded',
                  });
                  anyRefunded = true;
                  mintedCents += await mintRefund(
                    row.charge,
                    settlement.lane === 'invoice'
                      ? `${refundIdempotencyKey}:${row.charge.id}`
                      : refundIdempotencyKey,
                  );
                  break;
                case 'release_pending':
                  livePending ??= { amountCents: row.charge.amountCents };
                  break;
              }
            }
            return {
              mintedCents,
              anyRefunded,
              livePending,
              settledIds: settlement.rows.map((row) => row.charge.id),
            };
          };

          /**
           * §A2.6a — the pre-tx/in-tx race, closed as far as R5 permits.
           *
           * The pre-tx phase resolves what it can SEE. A pay attempt landing
           * between that read and this transaction leaves a live PI this
           * request never examined, and `'voided'` spoken over it is the same
           * falsehood one window later. So after the void and the per-row
           * actions, re-read the pending set IN-TX — DB only, no Stripe call,
           * R5 intact — and subtract the ids we settled. (`released` and
           * `refunded` rows have already dropped out via their own flips; the
           * subtraction is what keeps a `release_pending` survivor from being
           * double-counted as a newcomer.)
           *
           * A non-empty remainder raises the sentence FLOOR to
           * `'release_pending'`: no in-tx Stripe verdict is possible, and
           * "automatic release-or-full-refund committed" is the definite-outcome
           * truth for a row the reconciler now owns. It never overrides
           * `'refunded'` — moved money outranks everything (§A2.1/4).
           *
           * **What this does NOT close, stated rather than implied:** a row
           * committed AFTER our transaction. That remainder is seconds-wide,
           * money-safe (a settle against a voided invoice lands in the
           * dead-money machinery), sentence-only, and provably unreachable by
           * any R5-conformant design. Disclosed and queued beside the
           * webhook-flip door.
           */
          const pendingSurvivesCommit = async (settledIds: string[]): Promise<boolean> => {
            const remaining = await chargesRepository.findAllPendingCaptureForCohortDog(tx, {
              cohortId,
              dogId,
              enrollment: enrollmentIdentityOf(enrolledBookings),
            });
            return remaining.some((row) => !settledIds.includes(row.id));
          };

          const openInvoice = await invoicesRepository.findOpenForCohortDog(tx, {
            cohortId,
            dogId,
          });
          // markVoid only touches rows still 'open' and returns the count. If
          // the auto-charge worker settled the invoice between findOpen and
          // here (0 voided), fall through to the refund path — otherwise a
          // now-CHARGED invoice would be left un-refunded (the #2 race bug).
          const voidedCount =
            openInvoice !== undefined
              ? await invoicesRepository.markVoid(tx, { id: openInvoice.id })
              : 0;
          if (voidedCount > 0) {
            // The debt is cancelled. WHAT TO SAY ABOUT IT depends on what the
            // owner's pay attempts — if any — left resting at Stripe, and those
            // verdicts were decided pre-tx (§A1.1, corrected by §A2.1).
            //
            // `markVoid` above ran FIRST and unchanged, so R10 (void, never
            // refund, for an unpaid invoice) and R11 (the void/refund race) are
            // exactly as they were; only the report and the row actions are new.
            const settled =
              preTx === undefined ? undefined : await applySettledRows(preTx);
            const lateRow = await pendingSurvivesCommit(settled?.settledIds ?? []);

            if (settled?.anyRefunded === true) {
              // A capture outranks every other sentence: money moved, and the
              // owner needs to hear that before anything else (§A2.1/4). The
              // figure is Σ minted THIS REQUEST — the wire's own semantics for
              // the field, "cents on their way back".
              refundedCents = settled.mintedCents;
              moneyOutcome = refundedCents > 0 ? 'refunded' : 'none';
            } else if (settled?.livePending !== undefined || lateRow) {
              // At least one payment is genuinely still settling — either one
              // Stripe told us about, or one that appeared after the pre-tx
              // pass (§A2.6a). `'voided'` over it would be the falsehood this
              // machinery exists to remove: the money may still land, and the
              // owner told "never charged" would watch a charge appear and
              // reverse.
              moneyOutcome = 'release_pending';
              // `released_cents` is AUTHORIZED-HOLD cents (`wire.ts:875-877`).
              // An automatic-capture invoice-lane intent authorized NOTHING, so
              // naming a figure here would invent a hold — the same refusal the
              // dead-row arm below makes (§A2.3). The pay-now lane really did
              // hold the money and keeps saying so.
              releasedCents =
                preTx?.lane === 'auth-hold' ? settled?.livePending?.amountCents : undefined;
            } else {
              // Every row this request resolved is dead, and none appeared
              // behind it. Nothing was ever captured and nothing can be, so the
              // voided invoice IS the complete story — for every row this
              // request resolved, which is what §A2.6a's re-check above makes
              // an honest claim at commit time rather than a hopeful one.
              //
              // **Deliberately NOT `'released'`** on the invoice lane: that
              // word renders "the $X hold has been released", and an
              // automatic-capture pay attempt never held anything. `'voided'` —
              // "you were never charged" — is the truth here, and the dead rows
              // were already flipped `'failed'` by the per-row actions.
              moneyOutcome = 'voided';
            }
          } else {
            // A succeeded charge whose non-failed refunds already COVER it is
            // ALREADY SETTLED and is not this withdraw's business — skip it and
            // continue the priority order (§A3.15 finding 2). Without the skip,
            // a re-enrolled dog's withdraw matched the old fully-refunded
            // charge, minted nothing, announced `'refunded'` with 0, and never
            // reached the live hold sitting on the owner's card.
            //
            // **And it is asked of THIS withdraw's enrollment** (§A3.17): the
            // PRE-CANCEL live set read at step 3, already in closure. Without
            // the identity the read reached back into a PREVIOUS enrollment's
            // money — re-answering `'refund_manual'` for a refund already being
            // arranged by hand, re-firing its ERROR page, and leaving this
            // withdraw's live hold both unmentioned and uncancelled.
            //
            // On THIS arm the pre-tx settled rows are deliberately NOT applied:
            // a sibling that captured at Stripe stays un-flipped, which is
            // exactly the shape the reconciler's post-withdraw arm scans for —
            // its money completes on the next tick (executed 2026-08-24:
            // 24000c captured, 24000c returned).
            const charge = await chargesRepository.findUnsettledSucceededCharge(tx, {
              cohortId,
              dogId,
              enrollment: enrollmentIdentityOf(enrolledBookings),
            });
            if (charge !== undefined && charge.stripePaymentIntentId !== null) {
              // The landed `${K}:refund` spelling, deliberately. §A2.1/5's
              // per-charge key belongs to the multi-row settle arm; this arm
              // mints for exactly one already-succeeded charge and its key is
              // pinned by tests on both lanes.
              refundedCents = await mintRefund({ id: charge.id }, refundIdempotencyKey);
              // Asserted iff THIS request minted. The skip above makes the
              // zero branch unreachable here; the guard stays because the
              // invariant is the wire's, not this arm's.
              moneyOutcome = refundedCents > 0 ? 'refunded' : 'none';
            } else if (charge !== undefined) {
              // Succeeded charge, NULL PaymentIntent — pre-Stripe-wire money
              // with no route home. The queued withdraw-NULL-PI design owns
              // the real fix (§A3.11) and this arm STILL MINTS NOTHING; what
              // changed on 2026-08-21 (§A3.15 finding 1) is only the sentence.
              // `'none'` renders "There's no charge on file to return." — to an
              // owner who IS owed money, that is affirmatively false and the
              // one sentence that would make them stop asking. `'refund_manual'`
              // commits to the refund and is honest about the mechanism: a
              // human makes it.
              moneyOutcome = 'refund_manual';
              owedCents = charge.remainingCents;
              // The tripwire stays exactly as it was — this is still a gap, and
              // the ERROR is the human's page (logged in-tx at the moment it
              // becomes true, the `logUnroutableRefundMint` placement rule).
              request.log.error(
                {
                  cohortId,
                  dogId,
                  ownerId: principal.ownerId,
                  chargeId: charge.id,
                  amountCents: charge.amountCents,
                },
                'group-class withdraw: this enrollment was PAID on a charge with no PaymentIntent, so there is no automatic route to return it — a human must refund this money out of band',
              );
            } else if (preTx !== undefined) {
              // **The fall-through speaks the LANE's sentences, not the pay-now
              // lane's** (§A2.2). A1 routed invoice-lane verdicts here, where
              // `'released'` renders "the $X hold on your card has been
              // released" — for an automatic-capture intent that never held
              // anything. The void arm refuses that exact word for that exact
              // row; this arm was still saying it one branch over.
              const settled = await applySettledRows(preTx);
              if (settled.anyRefunded) {
                // Unchanged machinery either way: a capture won, the row says
                // so, and the capped refund is on its way.
                refundedCents = settled.mintedCents;
                moneyOutcome = refundedCents > 0 ? 'refunded' : 'none';
              } else if (settled.livePending !== undefined) {
                moneyOutcome = 'release_pending';
                // Hold cents only where a hold existed (§A2.3).
                releasedCents =
                  preTx.lane === 'auth-hold' ? settled.livePending.amountCents : undefined;
              } else if (preTx.lane === 'auth-hold') {
                // A manual-capture authorization really was holding this
                // owner's money and is now dead at Stripe. `'released'` is a
                // fact about it, and the figure is the amount that was
                // authorized. Byte-identical to the landed behaviour.
                moneyOutcome = 'released';
                releasedCents = preTx.rows[0]?.charge.amountCents;
              } else {
                // Invoice lane, every row dead, and no open invoice was found
                // to void — so the debt went somewhere between the pre-tx read
                // and here. WHERE decides the sentence, and only the invoice
                // itself knows: re-read it regardless of status.
                //
                //   `'void'`  ⇒ cancelled by an ops void or a prior crashed
                //               withdraw. Never charged: `'voided'` is true.
                //   anything ⇒ `'none'` — "There's no charge on file to
                //   else       return." The ordinary covered settler never
                //              reaches here: `findUnsettledSucceededCharge`
                //              above intercepts it and answers `'refunded'`
                //              with real money. What reaches here is the
                //              leftovers — a settler whose refunds already
                //              cover it — where "nothing left to return" is
                //              exactly right.
                //
                // Either way the dead rows were already retired by the per-row
                // actions, and neither answer invents a hold.
                const invoice = await invoicesRepository.findLatestForCohortDog(tx, {
                  cohortId,
                  dogId,
                });
                moneyOutcome = invoice?.status === 'void' ? 'voided' : 'none';
              }
            }
          }

          return {
            status: 200,
            body: {
              withdrawn: true,
              refunded_cents: refundedCents,
              money_outcome: moneyOutcome,
              ...(releasedCents !== undefined ? { released_cents: releasedCents } : {}),
              ...(owedCents !== undefined ? { owed_cents: owedCents } : {}),
            },
          };
        },
      );

      reply.code(outcome.status);
      return outcome.body;
    },
  );
}

// ---- helpers ---------------------------------------------------------

/**
 * Remember the earliest-scheduled booking row inserted for one dog — the
 * enrollment's ANCHOR (ADDENDUM 3 §A3.17).
 *
 * `scheduled_at` decides it, not insertion order: an enrollment is its weekly
 * rows and its first session is the one that identifies it, so the rule holds
 * even if a future edit reorders these loops or inserts a week out of sequence.
 */
function rememberAnchor(
  anchorByDog: Map<string, { id: string; scheduledAt: string }>,
  dogId: string,
  inserted: { id: string; scheduledAt: string },
): void {
  const current = anchorByDog.get(dogId);
  if (current === undefined || inserted.scheduledAt < current.scheduledAt) {
    anchorByDog.set(dogId, { id: inserted.id, scheduledAt: inserted.scheduledAt });
  }
}

/**
 * The anchor to stamp on this dog's charge, or a THROW.
 *
 * Unreachable — `cohorts.weeks` is `CHECK (weeks > 0)`, so every dog reaching a
 * mint site has at least one booking row from a few lines above. It throws
 * rather than falling back to NULL because a NULL anchor means "legacy row" to
 * every reader, and a legacy row minted TODAY would be attributed by timestamp
 * to whatever enrollment happens to surround it. Same posture, and the same
 * reason, as the missing-authorization assert beside it: a money row we cannot
 * file correctly must not be written at all.
 */
function requireAnchor(
  anchorByDog: Map<string, { id: string; scheduledAt: string }>,
  dogId: string,
): string {
  const anchor = anchorByDog.get(dogId);
  if (anchor === undefined) {
    throw new Error(`unreachable: dog ${dogId} reached the charge mint with no booking rows`);
  }
  return anchor.id;
}

/** The canonical endpoint string for the withdraw verb's idempotency record.
 *  One spelling, because the peek and the claim MUST agree — a mismatch would
 *  make the peek miss forever and re-enter the settle phase on every retry. */
const WITHDRAW_ENDPOINT = 'POST /enrollments/:cohortId/withdraw';

/** One charge row this withdraw settled at Stripe, plus what Stripe's answer
 *  means for the owner's money (§A3.2 step 4). */
interface WithdrawSettledRow {
  charge: { id: string; amountCents: number; stripePaymentIntentId: string };
  verdict: WithdrawSettleVerdict;
}

/**
 * Everything the pre-tx phase resolved, and — load-bearing since §A2.2 —
 * WHICH LANE it came from.
 *
 * The lane is not bookkeeping: it decides which sentences are true. An
 * `'auth-hold'` row is a manual-capture authorization that really held the
 * owner's money, so "the $X hold has been released" is a fact about it. An
 * `'invoice'` row is an automatic-capture pay attempt that authorized NOTHING,
 * so the same words would invent a hold — the exact refusal the void arm makes
 * and the fall-through used to violate one branch over.
 *
 * `rows` is newest-first. The pay-now lane always carries exactly one (§A3.14:
 * at most one live hold per dog); the invoice lane carries every unsettled pay
 * attempt, because the pay route lets an owner tap again while a prior PI is
 * still processing (§A2.1).
 */
interface WithdrawPreTxSettlement {
  lane: 'auth-hold' | 'invoice';
  rows: WithdrawSettledRow[];
}

/**
 * Steps 2–4 of the withdraw protocol (ADDENDUM 3 §A3.2): advisory guards, the
 * advisory money-state read, and — only for a live authorization — the Stripe
 * settle, all BEFORE the transaction opens.
 *
 * **Why the guards run twice.** These four (cohort live, dog owned, live
 * bookings exist, pre-start window open) are the same four the transaction
 * re-checks authoritatively under the cohort lock (R22). Running them here
 * first is not redundancy, it is the money rule: **no Stripe verb ever fires
 * for a request the transaction would refuse.** They hold no locks and decide
 * nothing — divergence is settled by the tx, whose verdict wins.
 *
 * **Why the Stripe call is here and not in the transaction.** R5
 * (`BUSINESS-LOGIC/payments-invoices.md:52`) — no Stripe call inside a DB
 * transaction, the invariant every money route in this system obeys. Making the
 * cancel and the row flip atomic would need the call under a held cohort lock;
 * Stripe's own cancel/capture mutual exclusion already buys the
 * exactly-one-of-two the atomicity was wanted for (§A3.10 alternative 3).
 *
 * Returns `undefined` when there is no live authorization to settle — an open
 * invoice, an already-succeeded charge, or nothing at all. Those arms are
 * decided entirely by the in-tx table.
 */
async function settleWithdrawMoneyBeforeTx(args: {
  stripe: StripeClient;
  principal: Extract<Principal, { kind: 'owner' }>;
  actor: string;
  cohortId: string;
  dogId: string;
  nowFactory: () => Date;
}): Promise<WithdrawPreTxSettlement | undefined> {
  const cohort = await cohortsRepository.findById(args.cohortId);
  if (cohort === undefined) {
    throw new ApiError('not_found', `cohort ${args.cohortId} not found`);
  }

  const capturePending = await withActor(args.actor, async (tx) => {
    const owned = await dogsRepository.findOwnedExists(args.dogId, args.principal.ownerId, tx);
    if (!owned) {
      throw new ApiError('not_found', `dog ${args.dogId} not found`);
    }
    const enrolledBookings = await bookingsRepository.findLiveBookingsForCohortDog(
      tx,
      args.cohortId,
      args.dogId,
    );
    if (enrolledBookings.length === 0) {
      throw new ApiError(
        'conflict',
        `dog ${args.dogId} is not enrolled in cohort ${args.cohortId}`,
      );
    }
    const firstSessionMs = new Date(enrolledBookings[0]!.scheduledAt).getTime();
    if (args.nowFactory().getTime() >= firstSessionMs) {
      throw new ApiError('conflict', 'this class has already started — contact us to withdraw');
    }

    // The money-state read, in the priority order the in-tx table uses. Only
    // a charge row resting `'requires_payment'` with a PI needs anything from
    // Stripe — and that read is what GATES the call, in both branches below.
    //
    // Same enrollment identity as the in-tx table (§A3.17), derived from the
    // same pre-cancel live set, so the advisory verdict and the authoritative
    // one cannot diverge on WHICH enrollment they are settling.
    const enrollment = enrollmentIdentityOf(enrolledBookings);

    const openInvoice = await invoicesRepository.findOpenForCohortDog(tx, {
      cohortId: args.cohortId,
      dogId: args.dogId,
    });
    if (openInvoice !== undefined) {
      // **The invoice lane consults Stripe, and about EVERY unsettled attempt**
      // (§A1.1, corrected by §A2.1 — 2026-08-24,
      // `designs/enrollment-followup-copy-flow.md`).
      //
      // Two rows this lane can leave are INDISTINGUISHABLE in the database.
      // One arm mints both (`invoices.ts:304-316`) after one best-effort
      // cancel (`:239-248`): a DECLINE's cancel lands, leaving dead money for
      // which "never charged" is true; a `processing` one's is refused,
      // leaving live money for which it is a lie. The difference exists only
      // at Stripe, so only Stripe can decide the sentence.
      //
      // And it must be asked about ALL of them, not the newest. The pay route
      // has no guard against re-attempting while a prior PI is processing, so
      // {processing, then declined} is ordinary use — and there the newest row
      // is the DEAD one. Sampling it answered `'voided'` over money still in
      // motion, which is the very falsehood this machinery exists to remove
      // (§A2.1, executed).
      //
      // The DB read still GATES the Stripe traffic, which is the whole cost
      // argument: a pay-later withdraw with no attempt row — the bulk of them
      // — returns an empty list here and touches Stripe zero times. The bound
      // is ≤1 retrieve + ≤1 cancel PER PENDING ROW, and the pay-ATTEMPTED
      // subset inherits §A3.2's abort-on-unreadable posture with it (A1.6).
      return {
        lane: 'invoice' as const,
        pending: await chargesRepository.findAllPendingCaptureForCohortDog(tx, {
          cohortId: args.cohortId,
          dogId: args.dogId,
          enrollment,
        }),
      };
    }
    // The SKIP rule, on the advisory side too (§A3.15 finding 2): an
    // already-covered succeeded charge is not a reason to stop looking. Reading
    // it as one is what let a live hold go unexamined — and no Stripe call
    // would have been made for it, so the response could only ever have been
    // about the old money.
    const succeeded = await chargesRepository.findUnsettledSucceededCharge(tx, {
      cohortId: args.cohortId,
      dogId: args.dogId,
      enrollment,
    });
    if (succeeded !== undefined) return undefined;
    // The pay-now lane keeps the SINGLE-row read, licensed by §A3.14's echo
    // chain: at most one live hold per dog exists here (a refused dog mints no
    // charge row at all, §A3.13), so "newest" and "all" coincide and sampling
    // is exact. Multi-row is an invoice-lane fact.
    const hold = await chargesRepository.findPendingCaptureForCohortDog(tx, {
      cohortId: args.cohortId,
      dogId: args.dogId,
      enrollment,
    });
    return hold === undefined
      ? undefined
      : { lane: 'auth-hold' as const, pending: [hold] };
  });

  if (capturePending === undefined || capturePending.pending.length === 0) return undefined;

  // Newest→oldest, one settle per row. `settleCapturePendingHold` spends at
  // most one retrieve and one cancel each, and THROWS on anything it cannot
  // read — which aborts the whole withdraw here, before the transaction opens,
  // with zero DB changes (§A3.2's no-uncertains rule applied to ourselves).
  //
  // Cancels that already landed when a later row aborts are reconciler-safe:
  // that is the established "cancel landed, response lost" residual
  // (`withdrawSettlement.ts:74-83`) — the reconciler pages or answers
  // `canceled`, and the owner's retry re-reads `canceled` and completes.
  const rows: WithdrawSettledRow[] = [];
  for (const charge of capturePending.pending) {
    rows.push({
      charge,
      verdict: await settleCapturePendingHold({
        stripe: args.stripe,
        paymentIntentId: charge.stripePaymentIntentId,
      }),
    });
  }
  return { lane: capturePending.lane, rows };
}

/**
 * The "Currently enrolled" wire row. `payment_status` is `paid` (charged) /
 * `pay-later` (card-backed open invoice, auto-charges before the first session)
 * / `pending` (async charge not yet settled). `can_withdraw` is the self-serve
 * window — true until the first session's instant.
 */
export interface EnrollmentWire {
  cohort_id: string;
  dog_id: string;
  class_key: string;
  class_name: string;
  location: string;
  start_date: string;
  weekly_time: string | null;
  weeks: number;
  first_session_at: string;
  payment_status: EnrollmentPaymentStatus;
  can_withdraw: boolean;
}

function toEnrollmentWire(
  row: Awaited<ReturnType<typeof enrollmentsRepository.listForOwner>>[number],
  nowMs: number,
): EnrollmentWire {
  return {
    cohort_id: row.cohortId,
    dog_id: row.dogId,
    class_key: row.classKey,
    class_name: row.className,
    location: row.location,
    start_date: row.startDate,
    weekly_time: row.weeklyTime,
    weeks: row.weeks,
    first_session_at: row.firstSessionAt,
    payment_status: row.paymentStatus,
    can_withdraw: new Date(row.firstSessionAt).getTime() > nowMs,
  };
}

/**
 * Cross-field invariants Zod doesn't express cleanly: dog_ids must be
 * distinct (the same dog enrolling twice in one body is the same
 * defect from the user's POV as a duplicate in the array). UUID
 * formatting + per-element validation is already handled by the Zod
 * schema; this layer is only the structural assertions.
 */
interface ValidatedEnrollmentBody {
  cohortId: string;
  dogIds: string[];
  paymentMethodId: string;
  payLater: boolean;
  allowPartial: boolean;
  /** Present only on an automatic retry — see the body schema. */
  retryOf?: string;
}

function validateEnrollmentBody(body: PostEnrollmentBody): ValidatedEnrollmentBody {
  const dogIdSet = new Set(body.dog_ids);
  if (dogIdSet.size !== body.dog_ids.length) {
    throw new ApiError('invalid_payload', 'dog_ids must contain distinct values');
  }
  return {
    cohortId: body.cohort_id,
    dogIds: body.dog_ids,
    paymentMethodId: body.payment_method_id,
    payLater: body.pay_later ?? false,
    allowPartial: body.allow_partial ?? false,
    ...(body.retry_of !== undefined ? { retryOf: body.retry_of } : {}),
  };
}

/**
 * Everything both response semantics need, resolved once by the handler. The
 * two run functions below differ ONLY in what they report and in how a failing
 * dog is handled — the money layer under them is the same one.
 */
interface EnrollmentRunContext {
  stripe: StripeClient;
  principal: Extract<Principal, { kind: 'owner' }>;
  actor: string;
  parsed: ValidatedEnrollmentBody;
  /** Sorted dog ids — the ORDER OF WORK (holds ↔ bookings pairing). */
  sortedDogIds: string[];
  cohort: EnrollmentCohortContext;
  idempotencyKey: string;
  requestHash: string;
  log: FastifyBaseLogger;
}

interface EnrollmentCohortContext {
  id: string;
  classKey: GroupClassKey;
  capacity: number;
  filled: number;
  amountPerDogCents: number;
}

/**
 * Server-authoritative per-dog price + the advisory seat snapshot, from one
 * pre-tx read (anti-scam: the FE never passes the amount). 404 if the cohort is
 * gone/soft-expired — the enroll tx re-locks and re-checks authoritatively;
 * this read only needs the amount and a seat count good enough to refuse a
 * hopeless request before it touches Stripe.
 */
async function resolveCohortForEnrollment(cohortId: string): Promise<EnrollmentCohortContext> {
  const cohort = await cohortsRepository.findById(cohortId);
  if (cohort === undefined) {
    throw new ApiError('not_found', `cohort ${cohortId} not found`);
  }
  const groupClass = await groupClassesRepository.findByKey(cohort.classKey);
  if (groupClass === undefined) {
    throw new ApiError('invalid_payload', `cohort ${cohortId} references an unknown class`);
  }
  return {
    id: cohort.id,
    classKey: cohort.classKey,
    capacity: cohort.capacity,
    filled: cohort.filled,
    amountPerDogCents: groupClass.pricePerDogCents,
  };
}

// ---- the all-or-nothing path (`allow_partial` absent) --------------------

/**
 * Today's semantics, unchanged, on the new money layer: any per-dog failure
 * anywhere fails the whole request with ONE typed error, and the response is
 * still `201 BookingWire[]`.
 *
 * **The one behavior that DID move, deliberately, and it is statement-visible:**
 * a failed attempt now releases holds instead of refunding captures. Nothing
 * was ever captured, so there is nothing to give back — an owner who used to
 * see "charged $360" followed by "refunded $360" now sees a pending
 * authorization that quietly disappears. Strictly safer, and flagged to
 * Allison as Q4 of `designs/partial-success-enrollment.md`.
 */
async function runAllOrNothingEnrollment(
  ctx: EnrollmentRunContext,
): Promise<{ status: number; body: BookingWire[] }> {
  const { stripe, principal, parsed, sortedDogIds, cohort, idempotencyKey, log } = ctx;
  let holds: DogAuthorization[] = [];
  const chargeIdByDog = new Map<string, string>();
  // Every intent this request learns the id of, tagged with where it came
  // from. The `finally` below releases whatever is still undecided when this
  // function exits by ANY route — return, throw, or a Stripe transport failure
  // in the middle of the authorize loop (ADDENDUM 1 R1).
  const registry = createHoldRegistry();
  // Everything after the transaction commits is post-commit work, and post-
  // commit work must NEVER reach the release path: by then the enrollment is
  // real and its holds are either captured or about to be. Without this flag a
  // throw from the capture step or the charge-row flip would cancel
  // authorizations for dogs that are enrolled — turning a recoverable "capture
  // is pending" into "enrolled and never charged".
  let committed = false;
  // A sibling request under this same Idempotency-Key owns these intents. See
  // the `finally`.
  let siblingOwnsTheKey = false;

  try {
    if (!parsed.payLater) {
      // R5: every Stripe call happens OUTSIDE the transaction.
      const stripeCtx = await loadStripePaymentContext({
        ownerId: principal.ownerId,
        paymentMethodId: parsed.paymentMethodId,
      });
      const authorized = await authorizeDogsForEnrollment({
        stripe,
        ownerId: principal.ownerId,
        stripeCustomerId: stripeCtx.stripeCustomerId,
        stripePaymentMethodId: stripeCtx.stripePaymentMethodId,
        cohortId: cohort.id,
        dogIds: sortedDogIds,
        amountPerDogCents: cohort.amountPerDogCents,
        idempotencyKey,
        // An old client never sends `retry_of`, so this path is unchanged in
        // practice. It is threaded anyway because the alternative is a route
        // where the same field means "re-verify first" on one response shape
        // and "mint blindly" on the other.
        ...(parsed.retryOf !== undefined ? { retryOfKey: parsed.retryOf } : {}),
        registry,
        log,
      });
      holds = authorized.holds;
      // On THIS path a refused authorization's intent is released with the
      // rest, so its registry entry is deliberately left UNRESOLVED: the whole
      // request is failing, every intent it minted is garbage, and the 1.7.1
      // cancel rule applies to all of them. (The partial path enumerates them
      // instead — there the siblings still enroll.)

      const report = mostHazardousDogFailure(sortedDogIds, authorized.failures);
      if (report !== undefined) {
        // Wire 1.9.0: `payment_failed` (402), NOT `payment_required` (422).
        // The codes were conflated and the conflation was VISIBLE: mobile's
        // booking gate maps `payment_required` to the buy-credits "payment
        // required" modal, so an enrollment card decline told the owner they
        // needed to pay rather than that their card was declined — a category
        // error. `payment_required` keeps its original booking-gate meaning
        // ("no card on file").
        //
        // `charge_blocker` is OMITTED, not defaulted, when no dog produced one
        // (ADDENDUM 1 R5, applied here as well as on the envelope path). A
        // hold someone else released is a refusal with no cause we know, and
        // `'declined'` renders "Your card was declined. Try a different card."
        // for a card that was never asked. The field is optional on every wire
        // shape carrying it (`wire.ts:723`, `:745`, `:819`) precisely so
        // "we are not going to guess" is expressible.
        throw new ApiError(
          'payment_failed',
          'the card charge did not complete — no dogs were enrolled',
          {
            kind: 'payment_failed',
            ...(report.blocker !== undefined ? { charge_blocker: report.blocker } : {}),
          },
        );
      }
    }

    const holdByDog = new Map(holds.map((h) => [h.dogId, h]));
    const outcome = await withMutation<BookingWire[]>(
      {
        principal,
        idempotencyKey,
        endpoint: 'POST /enrollments',
        requestHash: ctx.requestHash,
        // Day-11 mutations don't touch any cache key in §3 today.
        keysToInvalidate: () => [],
      },
      async (tx) => {
        // 1. Ownership gate — every requested dog must belong to the
        //    principal. Same response for "not owned" vs "doesn't exist"
        //    so dog ids can't enumerate across owners.
        for (const dogId of parsed.dogIds) {
          const exists = await dogsRepository.findOwnedExists(dogId, principal.ownerId, tx);
          if (!exists) {
            throw new ApiError('not_found', `dog ${dogId} not found`);
          }
        }

        // 2. Cohort row lock — all concurrent enrollments to this cohort
        //    serialize here. Lock held until commit/rollback.
        const cohortRow = await lockCohort(tx, parsed.cohortId);

        // 3. Liveness — undefined = id doesn't exist; `expiredAt !== null`
        //    = soft-expired. Both surface as 404.
        if (cohortRow === undefined || cohortRow.expiredAt !== null) {
          throw new ApiError('not_found', `cohort ${parsed.cohortId} not found`);
        }

        // 3b. Duplicate guard (Day-19d) — a dog already enrolled in this
        //     cohort can't re-enroll. Checked under the cohort lock.
        const alreadyEnrolled = await bookingsRepository.findEnrolledDogsInCohort(
          tx,
          parsed.cohortId,
          parsed.dogIds,
        );
        if (alreadyEnrolled.length > 0) {
          throw alreadyEnrolledError({ cohort_id: parsed.cohortId, dog_ids: alreadyEnrolled });
        }

        // 4. Capacity assertion against the LOCKED snapshot. The schema CHECK
        //    `filled <= capacity` is the unbypassable floor; this is the
        //    friendly route-layer surface with structured details.
        const requested = parsed.dogIds.length;
        if (cohortRow.filled + requested > cohortRow.capacity) {
          throw cohortFullError({
            cohort_id: cohortRow.id,
            capacity: cohortRow.capacity,
            filled: cohortRow.filled,
            requested,
          });
        }

        // 5. R7 eligibility — server-derived prereqs.
        const prereqOptions = await groupClassesRepository.findPrereqOptionsForClass(
          cohortRow.classKey,
        );
        if (prereqOptions.length > 0) {
          const eligibilityGaps: EligibilityGap[] = [];
          for (const dogId of parsed.dogIds) {
            const completed = await dogCompletedClassesRepository.findCompletedKeysForDogInTx(
              tx,
              dogId,
            );
            const completedSet = new Set(completed);
            const hasAny = prereqOptions.some((opt) => completedSet.has(opt));
            if (!hasAny) {
              eligibilityGaps.push({ dog_id: dogId, missing_alternatives: prereqOptions });
            }
          }
          if (eligibilityGaps.length > 0) throw eligibilityMissingError(eligibilityGaps);
        }

        // 6. Gate pre-check above the trigger floor, in the Day-10 priority
        //    order (payment → vaccine → agreement). Kept WHOLE here — the
        //    per-dog split (R14 amendment) belongs to `allow_partial` only,
        //    and this path's precedence is what the existing suite pins.
        await checkBookingGates(tx, {
          ownerId: principal.ownerId,
          dogIds: parsed.dogIds,
          category: 'group-class',
          groupClassKey: cohortRow.classKey,
        });

        // 7. Materialize per-week scheduled_at (DST-preserving Chicago
        //    wall-time cadence), one single-dog booking per (dog × week).
        const startInstant = pgTimestampToDate(cohortRow.startDate);
        const sessionDates = computeCohortSessionDates(startInstant, cohortRow.weeks);
        const groupClassHours = await cancelWindowSettingsRepository.resolveHoursFor(
          'group-class',
          tx,
        );
        const insertedWires: BookingWire[] = [];
        // The enrollment ANCHOR per dog (§A3.17): the earliest-scheduled
        // booking row THIS transaction inserted for that dog, stamped onto its
        // charge so every later money read can tell this enrollment's charge
        // from a previous one's. Tracked by comparing `scheduled_at` rather
        // than by trusting the loop order — the anchor is defined by the
        // session, and a future reorder of these loops must not silently
        // re-point the money.
        const anchorByDog = new Map<string, { id: string; scheduledAt: string }>();
        for (const scheduledAt of sessionDates) {
          const cancelDeadlineAt = computeCancelDeadlineFromHours(scheduledAt, groupClassHours);
          for (const dogId of sortedDogIds) {
            const inserted = await insertBookingWithGateMapping(tx, {
              ownerId: principal.ownerId,
              leadDogId: dogId,
              category: 'group-class',
              scheduledAt,
              location: cohortRow.location,
              notes: null,
              cancelDeadlineAt,
              additionalDogIds: [],
              cohortId: cohortRow.id,
              sessionReportId: null,
            });
            rememberAnchor(anchorByDog, dogId, inserted);
            await enqueueBookingReminders(tx, {
              bookingId: inserted.id,
              ownerId: principal.ownerId,
              leadDogId: dogId,
              category: 'group-class',
              scheduledAt,
            });
            insertedWires.push(toBookingWire(inserted, { lead: dogId, additional: [] }, null));
          }
        }

        // 8. `filled` counter bump — atomic under the row lock.
        await cohortsRepository.bumpFilled(tx, cohortRow.id, requested);

        // 9. Money rows, per dog. Pay-later: a card-backed open invoice due
        //    24h before the first session. Pay-now: a charge row at the
        //    HONEST status for a hold — `requires_payment`
        //    (`stripeIntentStatusToChargeStatus('requires_capture')`) — which
        //    the capture step below flips to 'succeeded' once money moves.
        //    Writing 'succeeded' here would be a lie for as long as the
        //    capture takes, on the row the billing ledger reads.
        if (parsed.payLater) {
          const dueAt = new Date(
            pgTimestampToDate(cohortRow.startDate).getTime() - GROUP_CLASS_AUTOCHARGE_LEAD_MS,
          ).toISOString();
          for (const dogId of sortedDogIds) {
            await invoicesRepository.createOpen(tx, {
              ownerId: principal.ownerId,
              amountCents: cohort.amountPerDogCents,
              purpose: 'group-class',
              paymentMethodId: parsed.paymentMethodId,
              dueAt,
              // The enrollment's ANCHOR, stamped at MINT time (§A3.18 D1). An
              // invoice that knows its own enrollment is what lets a LATE
              // settle — the webhook resolving a PI minutes after a withdraw
              // voided this invoice and the owner re-enrolled — file that money
              // under the enrollment it was actually for, instead of under
              // whichever enrollment happens to be live when it lands.
              bookingId: requireAnchor(anchorByDog, dogId),
              cohortId: cohortRow.id,
              dogId,
            });
          }
        } else {
          for (const dogId of sortedDogIds) {
            const hold = holdByDog.get(dogId);
            if (hold === undefined) {
              // Unreachable: every dog authorized above or the request already
              // threw. Asserted rather than skipped — a missing hold here would
              // enroll a dog with no money attached at all.
              throw new Error(
                `unreachable: dog ${dogId} reached the enroll tx with no authorization`,
              );
            }
            const charge = await chargesRepository.create(tx, {
              ownerId: principal.ownerId,
              amountCents: hold.amountCents,
              status: stripeIntentStatusToChargeStatus('requires_capture'),
              purpose: 'group-class',
              stripePaymentIntentId: hold.intentId,
              bookingId: requireAnchor(anchorByDog, dogId),
              cohortId: cohortRow.id,
              dogId,
            });
            chargeIdByDog.set(dogId, charge.id);
          }
        }

        return { status: 201, body: insertedWires };
      },
    );

    committed = true;

    // ── §3.7 capture after commit ────────────────────────────────────────
    // Skipped on a replay: the holds we are looking at are Stripe replays of
    // the ORIGINAL request's, and that request owns their capture.
    if (outcome.replayed) {
      siblingOwnsTheKey = true;
    } else if (!parsed.payLater && holds.length > 0) {
      await captureHeldDogs({
        stripe,
        actor: ctx.actor,
        holds,
        chargeIdByDog,
        idempotencyKey,
        log,
      });
    }

    return { status: outcome.status, body: outcome.body };
  } catch (err) {
    if (isIdempotencyInflight(err)) siblingOwnsTheKey = true;
    throw err;
  } finally {
    // Release whatever is still undecided — CANCEL, never refund; nothing on
    // this path is ever captured before the commit.
    //
    // TWO conditions hand everything back instead:
    //
    //   · `committed` — the enrollment is real. Its holds are captured or are
    //     the reconciler's, and cancelling one now would turn a recoverable
    //     "capture is pending" into "enrolled and never charged".
    //   · `siblingOwnsTheKey` — `idempotency_inflight`, or a claim that
    //     REPLAYED. Another request under this same Idempotency-Key is
    //     enrolling against these intents, and Stripe handed us its
    //     PaymentIntents under `<key>:dog:<dogId>`. A cancelled authorization
    //     cannot be captured under any key, ever, so the owner would end up
    //     ENROLLED AND NEVER CHARGED — the exact half of Allison's rule ("i
    //     dont want money charged on accident or things not getting charged")
    //     that a hold-based protocol does not fix on its own (adjudication
    //     A1). **This stays WHOLESALE, against ADDENDUM 1 R1's narrowing to
    //     "release the fresh ones", and the reason is an interleaving the
    //     narrowing does not survive:** two concurrent same-key requests both
    //     authorize before either claims, so the one that confirmed FIRST
    //     holds a genuinely `fresh` intent that the other has already REPLAYED
    //     and is capturing. "Fresh" proves we minted it; under a shared key it
    //     does not prove nobody else adopted it. Cost of being wrong in this
    //     direction: a hold that expires in ~7 days, nothing charged. Cost in
    //     the other: a dog in class nobody was charged for, needing a human.
    if (committed || siblingOwnsTheKey) {
      resolveAllIntents(registry);
    }
    await releaseRegistry({ stripe, registry, log });
  }
}

/**
 * How much it COSTS to report the wrong blocker, per arm. Higher wins when a
 * multi-dog enroll produces more than one unsettled outcome and the response
 * can carry only one.
 *
 * `processing` means "money may be in flight, do NOT retry"; `declined` and
 * `authentication_required` both render copy that sends the owner to the card
 * picker. Report `declined` for a set that contains a `processing` dog and the
 * owner picks another card, which changes mobile's idempotency-key signature,
 * which produces a FRESH key — while the `processing` intent settles anyway.
 * That is a double charge, reachable from one declined dog plus one in-flight
 * dog in the same request.
 *
 * **Scheduled for removal at the next major.** This whole one-slot report
 * exists because the all-or-nothing response can carry a single blocker;
 * `allow_partial` removes its reason to exist by giving every dog its own
 * reason. It stays only as long as the pre-1.11.0 response shape does.
 */
const ENROLL_BLOCKER_HAZARD_RANK: Readonly<Record<ChargeBlocker, number>> = {
  processing: 2,
  declined: 1,
  authentication_required: 1,
};

/**
 * The all-or-nothing path's one-slot failure report.
 *
 * Two facts, deliberately separated, because they used to be conflated into
 * one nullable and the conflation FABRICATED a cause:
 *
 *   - `undefined` return — no dog failed at all. This is the control-flow
 *     answer, and it is the ONLY thing that decides whether the request
 *     throws. Collapsing "a dog failed for a reason we cannot name" into
 *     `undefined` would skip the throw and send a dog with no hold into the
 *     enroll transaction, straight onto the `unreachable:` guard.
 *   - `blocker` — the cause to REPORT, and `undefined` there means exactly
 *     what it means on the wire: we do not know. `?? 'declined'` used to fill
 *     that slot, which is the invented explanation ADDENDUM 1 R5 forbids; it
 *     survived here because R5 was applied to the envelope path only.
 */
interface EnrollFailureReport {
  /** The most hazardous NAMED blocker, or `undefined` when no failing dog
   *  carried one — omit the field rather than guess (R5). */
  blocker: ChargeBlocker | undefined;
}

/**
 * The ONE blocker a multi-dog all-or-nothing enroll reports — the most
 * hazardous one, not the first. `undefined` when every dog authorized.
 *
 * Walks `order` (the stable sorted dog ids) rather than the map's own
 * iteration, so ties keep the earliest dog and a set with no `processing` dog
 * reports exactly what it always did. A blockerless failure ranks below every
 * named one: it contributes a failure but no cause, so a set holding one
 * blockerless dog and one declined dog still reports `declined`.
 *
 * Removal is dated with {@link ENROLL_BLOCKER_HAZARD_RANK}.
 */
function mostHazardousDogFailure(
  order: readonly string[],
  failures: ReadonlyMap<string, EnrollmentDogResultWire>,
): EnrollFailureReport | undefined {
  let chosen: ChargeBlocker | undefined;
  let chosenRank = -1;
  let anyFailure = false;
  for (const dogId of order) {
    const failure = failures.get(dogId);
    if (failure === undefined) continue;
    anyFailure = true;
    // `charge_unverified` IS the `processing` arm under manual capture: the
    // authorization is still verifying. It must outrank a decline for exactly
    // the reason above — its copy refuses a retry.
    const blocker: ChargeBlocker | undefined =
      failure.reason === 'charge_unverified' ? 'processing' : failure.charge_blocker;
    if (blocker === undefined) continue;
    const rank = ENROLL_BLOCKER_HAZARD_RANK[blocker];
    if (rank > chosenRank) {
      chosen = blocker;
      chosenRank = rank;
    }
  }
  return anyFailure ? { blocker: chosen } : undefined;
}

// ---- the partial-success path (`allow_partial: true`) --------------------

/**
 * Per-dog outcomes (§3). Enrolls every dog that passes and reports every dog
 * that doesn't, each with its own reason — 201 when at least one dog enrolled,
 * 200 when none did. No dog's failure costs another dog its seat, and a
 * declined dog costs nobody an unwind.
 */
async function runPartialEnrollment(
  ctx: EnrollmentRunContext,
): Promise<{ status: number; body: EnrollmentResultWire }> {
  // Every intent this request learns the id of. The `finally` at the bottom is
  // the outermost boundary ADDENDUM 1 R1 names: it releases whatever is still
  // undecided however this function exits, including a Stripe transport
  // failure halfway through the authorize loop — the round-1 BLOCKER, where
  // the authorize block sat outside the try entirely and every hold placed
  // before the throw was left live on the owner's card.
  const registry = createHoldRegistry();
  try {
    return await runPartialEnrollmentInner(ctx, registry);
  } finally {
    await releaseRegistry({ stripe: ctx.stripe, registry, log: ctx.log });
  }
}

async function runPartialEnrollmentInner(
  ctx: EnrollmentRunContext,
  registry: ReturnType<typeof createHoldRegistry>,
): Promise<{ status: number; body: EnrollmentResultWire }> {
  const { stripe, principal, parsed, sortedDogIds, cohort, idempotencyKey, log } = ctx;

  // ── §3.2 owner-level gates + §3.3 advisory per-dog pre-flight ──────────
  // One short read transaction, no locks, no Stripe. The owner-level gates
  // stay WHOLE-request on purpose: no dog can enroll without a card on file,
  // so there is no per-dog story to tell about them (R14 amendment — the
  // per-dog split covers the per-dog gates only).
  const prereqOptions = await groupClassesRepository.findPrereqOptionsForClass(cohort.classKey);
  const advisoryFailures = await withActor(ctx.actor, async (tx) => {
    const hasPayment = await paymentMethodsRepository.hasLiveForOwner(tx, principal.ownerId);
    if (!hasPayment) throw paymentRequiredError();
    const missingAgreements = await agreementSignaturesRepository.findMissingForOwnerCategory(
      tx,
      principal.ownerId,
      'group-class',
    );
    if (missingAgreements.length > 0) throw agreementUnsignedError(missingAgreements);
    return checkDogsForEnrollment(tx, {
      ownerId: principal.ownerId,
      cohortId: cohort.id,
      classKey: cohort.classKey,
      dogIds: sortedDogIds,
      prereqOptions,
    });
  });

  // The pre-transaction verdicts — advisory checks, then Stripe's answers.
  // Stable for the rest of the request: the transaction below re-derives its
  // OWN verdicts on every attempt and layers them on top of a copy of these,
  // so a rollback can never leave a stale decision behind.
  const preTxFailures = new Map<string, EnrollmentDogResultWire>(advisoryFailures);
  const survivors = sortedDogIds.filter((dogId) => !preTxFailures.has(dogId));

  // §3.3 advisory seat check — the refusal that costs nothing. If the healthy
  // dogs already outnumber the seats we can see, no hold is placed at all: the
  // owner is going to have to choose, and choosing does not require their card.
  const advisorySeats = Math.max(0, cohort.capacity - cohort.filled);
  if (survivors.length > advisorySeats) {
    const shortfall = new Map(preTxFailures);
    for (const dogId of survivors) shortfall.set(dogId, dogSeatShortfallResult(dogId, advisorySeats));
    return recordRefusalEnvelope(ctx, buildEnrollmentEnvelope(ctx, shortfall, [], 0));
  }
  if (survivors.length === 0) {
    // Every dog failed a check. Nothing to authorize, nothing to enroll — and
    // this is still a 200 with per-dog reasons, never an error envelope: the
    // owner needs to know WHICH dog failed WHY, which is the whole ask.
    return recordRefusalEnvelope(ctx, buildEnrollmentEnvelope(ctx, preTxFailures, [], 0));
  }

  // ── §3.4 authorize the survivors (pay-now only) ────────────────────────
  let holds: DogAuthorization[] = [];
  if (!parsed.payLater) {
    const stripeCtx = await loadStripePaymentContext({
      ownerId: principal.ownerId,
      paymentMethodId: parsed.paymentMethodId,
    });
    const authorized = await authorizeDogsForEnrollment({
      stripe,
      ownerId: principal.ownerId,
      stripeCustomerId: stripeCtx.stripeCustomerId,
      stripePaymentMethodId: stripeCtx.stripePaymentMethodId,
      cohortId: cohort.id,
      dogIds: survivors,
      amountPerDogCents: cohort.amountPerDogCents,
      idempotencyKey,
      // §A3.13: on an automatic retry, every dog's ORIGINAL attempt is
      // re-verified before this request is allowed to mint anything.
      ...(parsed.retryOf !== undefined ? { retryOfKey: parsed.retryOf } : {}),
      registry,
      log,
    });
    holds = authorized.holds;
    for (const [dogId, failure] of authorized.failures) preTxFailures.set(dogId, failure);
    // Refused authorizations are enumerated by their RETRIEVED status, not by
    // their blocker label (ADDENDUM 1 R2): a decline holds nothing and is left
    // alone, `processing` is the one status Stripe refuses to cancel, and
    // `requires_action` is CANCELLED because an intent left there can still
    // advance on its own — under manual capture that lands it at
    // `requires_capture`, a live hold nobody owns, while the copy has already
    // sent the owner to mint a second one on a fresh key.
    await settleRefusedAuthorizations({
      stripe,
      registry,
      refusals: authorized.refusals,
      log,
    });
  }

  const candidates = survivors.filter((dogId) => !preTxFailures.has(dogId));
  if (candidates.length === 0) {
    // Every survivor's card refused. No hold exists to release (a refused
    // authorize holds nothing) and no transaction is worth opening.
    return recordRefusalEnvelope(ctx, buildEnrollmentEnvelope(ctx, preTxFailures, [], 0));
  }

  const holdByDog = new Map(holds.map((h) => [h.dogId, h]));
  const chargeIdByDog = new Map<string, string>();
  const enrolledDogIds = new Set<string>();
  // See the same flag on the all-or-nothing path: once the transaction has
  // committed, nothing may release a hold for a dog that is enrolled.
  let committed = false;

  try {
    const outcome = await withMutation<EnrollmentResultWire>(
      {
        principal,
        idempotencyKey,
        endpoint: 'POST /enrollments',
        requestHash: ctx.requestHash,
        keysToInvalidate: () => [],
      },
      async (tx) => {
        // A fresh copy per attempt: the pre-tx verdicts (advisory checks and
        // Stripe's answers, neither re-derivable from the DB) plus whatever
        // THIS attempt decides. `withMutation` rolls the transaction back on a
        // throw, and a retained verdict from a rolled-back attempt is how a
        // dog gets reported for a state that never committed.
        const results = new Map<string, EnrollmentDogResultWire>(preTxFailures);
        enrolledDogIds.clear();
        chargeIdByDog.clear();

        const cohortRow = await lockCohort(tx, cohort.id);
        if (cohortRow === undefined || cohortRow.expiredAt !== null) {
          // Whole-request: a cohort that no longer exists has no per-dog story.
          throw new ApiError('not_found', `cohort ${cohort.id} not found`);
        }

        // §3.5.1 — the authoritative re-check, under the lock. Rare by
        // construction (the advisory phase ran seconds ago) and cheap: all DB
        // reads. A dog that NOW fails gets its own result and its hold is
        // released after the transaction.
        const fresh = await checkDogsForEnrollment(tx, {
          ownerId: principal.ownerId,
          cohortId: cohortRow.id,
          classKey: cohortRow.classKey,
          dogIds: candidates,
          prereqOptions,
        });
        for (const [dogId, failure] of fresh) results.set(dogId, failure);
        const seatable = candidates.filter((dogId) => !fresh.has(dogId));

        // §3.5.2 — capacity, authoritative. **The server never auto-picks.**
        // More healthy dogs than seats and NOBODY is seated: "2 seats left —
        // choose which dogs take them" is a sentence an owner can act on;
        // "we alphabetized your dogs by internal id" is not. Returned rather
        // than thrown, deliberately — see the note below.
        const seatsRemaining = Math.max(0, cohortRow.capacity - cohortRow.filled);
        if (seatable.length > seatsRemaining) {
          for (const dogId of seatable) {
            results.set(dogId, dogSeatShortfallResult(dogId, seatsRemaining));
          }
          // A `return` here COMMITS the idempotency claim with this envelope
          // stored, where the design said "throw". Throwing rolls the claim
          // back, so a same-key retry re-runs the whole pre-tx phase, re-asks
          // Stripe under `<K>:dog:<id>` — and meets the holds this request is
          // about to cancel, now `canceled`, reporting every dog
          // `charge_failed` instead of `seat_shortfall`. The retry would be
          // strictly LESS true than the first answer. Nothing is written on
          // this path but the claim itself, so committing costs nothing and
          // makes the answer stable. (Deviation from §3.5.2, reported.)
          return { status: 200, body: buildEnrollmentEnvelope(ctx, results, [], 0) };
        }

        const startInstant = pgTimestampToDate(cohortRow.startDate);
        const sessionDates = computeCohortSessionDates(startInstant, cohortRow.weeks);
        const groupClassHours = await cancelWindowSettingsRepository.resolveHoursFor(
          'group-class',
          tx,
        );
        const dueAt = new Date(
          pgTimestampToDate(cohortRow.startDate).getTime() - GROUP_CLASS_AUTOCHARGE_LEAD_MS,
        ).toISOString();

        const bookingWires: BookingWire[] = [];
        for (const dogId of seatable) {
          try {
            // §3.5.3 — one SAVEPOINT per dog. Drizzle's node-postgres driver
            // implements a nested `.transaction()` as a real
            // `SAVEPOINT`/`ROLLBACK TO SAVEPOINT` pair
            // (`drizzle-orm/node-postgres/session.js`, verified 2026-08-20),
            // which is what makes "this dog fails alone" true at the DB level
            // rather than as a wish: a trigger that fires for THIS dog undoes
            // this dog's rows and leaves every sibling's committed.
            const perDogWires = await tx.transaction(async (sp) => {
              const wires: BookingWire[] = [];
              // This dog's enrollment anchor (§A3.17), scoped to the SAVEPOINT:
              // if this dog rolls back, so does its anchor, and the map is
              // per-dog by construction rather than by convention.
              const anchorByDog = new Map<string, { id: string; scheduledAt: string }>();
              for (const scheduledAt of sessionDates) {
                const cancelDeadlineAt = computeCancelDeadlineFromHours(
                  scheduledAt,
                  groupClassHours,
                );
                const inserted = await insertBookingWithGateMapping(sp, {
                  ownerId: principal.ownerId,
                  leadDogId: dogId,
                  category: 'group-class',
                  scheduledAt,
                  location: cohortRow.location,
                  notes: null,
                  cancelDeadlineAt,
                  additionalDogIds: [],
                  cohortId: cohortRow.id,
                  sessionReportId: null,
                });
                rememberAnchor(anchorByDog, dogId, inserted);
                await enqueueBookingReminders(sp, {
                  bookingId: inserted.id,
                  ownerId: principal.ownerId,
                  leadDogId: dogId,
                  category: 'group-class',
                  scheduledAt,
                });
                wires.push(toBookingWire(inserted, { lead: dogId, additional: [] }, null));
              }

              if (parsed.payLater) {
                await invoicesRepository.createOpen(sp, {
                  ownerId: principal.ownerId,
                  amountCents: cohort.amountPerDogCents,
                  purpose: 'group-class',
                  paymentMethodId: parsed.paymentMethodId,
                  dueAt,
                  // The enrollment's ANCHOR, stamped at MINT time (§A3.18 D1) —
                  // savepoint-scoped, exactly like this dog's charge below.
                  bookingId: requireAnchor(anchorByDog, dogId),
                  cohortId: cohortRow.id,
                  dogId,
                });
              } else {
                const hold = holdByDog.get(dogId);
                if (hold === undefined) {
                  throw new Error(
                    `unreachable: dog ${dogId} reached the enroll tx with no authorization`,
                  );
                }
                const charge = await chargesRepository.create(sp, {
                  ownerId: principal.ownerId,
                  amountCents: hold.amountCents,
                  // The honest status for a hold. Flipped to 'succeeded' by
                  // the capture step, or by the reconciler if that fails.
                  status: stripeIntentStatusToChargeStatus('requires_capture'),
                  purpose: 'group-class',
                  stripePaymentIntentId: hold.intentId,
                  bookingId: requireAnchor(anchorByDog, dogId),
                  cohortId: cohortRow.id,
                  dogId,
                });
                chargeIdByDog.set(dogId, charge.id);
              }
              return wires;
            });
            bookingWires.push(...perDogWires);
            enrolledDogIds.add(dogId);
            results.set(
              dogId,
              dogEnrolledResult(
                dogId,
                parsed.payLater ? 'pay-later' : 'pending',
                // ADDENDUM 1 R7: on a pay-now row the money figure is STRIPE's
                // — the amount actually authorized, which is what the charges
                // row and `total_captured_cents` are both built from. The
                // catalog read is the pay-later truth (an invoice IS catalog),
                // and having the envelope quote one number while the money
                // rows quote another is how a confirmation line and a
                // statement disagree.
                parsed.payLater
                  ? cohort.amountPerDogCents
                  : (holdByDog.get(dogId)?.amountCents ?? cohort.amountPerDogCents),
              ),
            );
          } catch (err) {
            const perDog = perDogGateFlipResult(dogId, err);
            // A condition that isn't per-dog (an owner-level gate flipping
            // mid-request, a DB fault) fails the whole request — handing one
            // dog the blame for the owner's unsigned agreement would be a lie.
            if (perDog === undefined) throw err;
            chargeIdByDog.delete(dogId);
            results.set(dogId, perDog);
          }
        }

        if (enrolledDogIds.size > 0) {
          await cohortsRepository.bumpFilled(tx, cohortRow.id, enrolledDogIds.size);
        }

        return {
          status: enrolledDogIds.size > 0 ? 201 : 200,
          body: buildEnrollmentEnvelope(ctx, results, bookingWires, 0),
        };
      },
    );

    committed = true;

    if (outcome.replayed) {
      // Another request under this key committed while we were working. The
      // holds we obtained are Stripe REPLAYS of its holds — releasing them
      // would cancel authorizations the winner is about to capture, leaving
      // its dogs enrolled and never charged. Touch nothing.
      //
      // Wholesale, deliberately, against ADDENDUM 1 R1's narrowing to
      // "release the fresh ones" — see the identical note on the
      // all-or-nothing path's `finally` for the interleaving that narrowing
      // does not survive (both requests authorize before either claims, so the
      // one that confirmed FIRST holds a `fresh` intent the other has already
      // replayed and is capturing).
      resolveAllIntents(registry);
      return { status: outcome.status, body: outcome.body };
    }

    // ── §3.7 release what didn't enroll, capture what did ────────────────
    // The enrolled dogs' intents are this request's to capture and must never
    // be cancelled; everything still unresolved in the registry is, by
    // definition, an intent nothing is going to enroll against.
    resolveIntentsForDogs(registry, enrolledDogIds);
    await releaseRegistry({ stripe, registry, log });

    if (parsed.payLater || enrolledDogIds.size === 0) {
      return { status: outcome.status, body: outcome.body };
    }

    const captures = await captureHeldDogs({
      stripe,
      actor: ctx.actor,
      holds: holds.filter((h) => enrolledDogIds.has(h.dogId)),
      chargeIdByDog,
      idempotencyKey,
      log,
    });
    const settled = applyCaptureOutcomes(outcome.body, captures);

    // The stored response now says `pending` and `total_captured_cents: 0` for
    // money that has since moved. Amend it, so a client retry replays
    // post-capture truth rather than a snapshot that is now less true than the
    // charge rows. Failure to amend is logged, never fatal: the enrollment
    // committed, the money moved, and `GET /enrollments` reads the rows.
    //
    // That last sentence used to be a claim rather than a fact. The amend was
    // a bare pool-level UPDATE with nothing between it and the `catch` below,
    // which on `committed === true` RETHROWS — so a DB fault here answered a
    // committed, captured enrollment with a 500. The guard now lives with the
    // one R8 already put on the charge-row flip; see
    // `amendStoredEnvelopeAfterCapture`.
    await amendStoredEnvelopeAfterCapture({
      key: idempotencyKey,
      endpoint: 'POST /enrollments',
      requestHash: ctx.requestHash,
      body: settled,
      logContext: { idempotencyKey, cohortId: cohort.id },
      log,
    });

    return { status: outcome.status, body: settled };
  } catch (err) {
    // Once the transaction has committed, nothing may release a hold for a dog
    // that is enrolled; and `idempotency_inflight` means the holds are a
    // sibling request's, which is the A1 carve-out (see the all-or-nothing
    // path's `finally` for why it stays wholesale). Everything else falls
    // through to the caller's `finally`, which releases the registry —
    // including a transport failure mid-authorize, the arm that used to strand
    // every hold placed before it.
    if (committed || isIdempotencyInflight(err)) {
      resolveAllIntents(registry);
    }
    throw err;
  }
}

/**
 * Assemble the envelope. `results` is keyed by dog id; the WIRE order is
 * request order — the order the owner picked their dogs — which is a
 * presentational contract (§1.3), not an implementation detail of whatever
 * order the work happened to run in.
 */
function buildEnrollmentEnvelope(
  ctx: EnrollmentRunContext,
  results: ReadonlyMap<string, EnrollmentDogResultWire>,
  bookings: BookingWire[],
  totalCapturedCents: number,
): EnrollmentResultWire {
  return {
    cohort_id: ctx.cohort.id,
    results: ctx.parsed.dogIds.map((dogId) => {
      const result = results.get(dogId);
      if (result === undefined) {
        // Unreachable: every requested dog either enrolled or has a reason.
        // Asserted rather than defaulted — a dog silently missing from the
        // envelope is the granularity failure this feature exists to fix.
        throw new Error(`unreachable: dog ${dogId} has no enrollment result`);
      }
      return result;
    }),
    bookings,
    total_captured_cents: totalCapturedCents,
    payment: ctx.parsed.payLater ? 'later' : 'now',
  };
}

/**
 * Fold post-capture truth into the committed envelope: each enrolled pay-now
 * dog becomes `'paid'` or stays `'pending'`, and `total_captured_cents` counts
 * ONLY money that actually moved. A `pending` dog contributes zero — the
 * confirmation line must never announce money that has not moved.
 */
function applyCaptureOutcomes(
  envelope: EnrollmentResultWire,
  captures: readonly CaptureOutcome[],
): EnrollmentResultWire {
  const byDog = new Map(captures.map((c) => [c.dogId, c]));
  let total = 0;
  const results = envelope.results.map((result) => {
    const capture = byDog.get(result.dog_id);
    if (capture === undefined || !result.enrolled) return result;
    if (capture.state === 'paid') total += capture.capturedCents;
    return { ...result, payment_state: capture.state };
  });
  return { ...envelope, results, total_captured_cents: total };
}

/**
 * A gate trigger fired for ONE dog between the pre-check and its INSERT.
 * Returns that dog's per-dog result, or `undefined` when the condition is not
 * per-dog and the whole request must fail.
 *
 * Only the vaccine gate is per-dog on this surface (the trigger checks
 * `NEW.lead_dog_id`'s vaccines). Payment and agreement are owner-level: they
 * are true or false for every dog at once, and reporting one dog as the
 * failure would misdirect the fix.
 *
 * The trigger fallback carries no structured detail (`bookingErrors.ts`
 * `gateTriggerErrorToApiError` — the message text is all it has), so
 * `missing_vaccines` is OMITTED rather than sent empty: an empty list reads as
 * "no vaccines missing", which is the opposite of what happened.
 */
function perDogGateFlipResult(dogId: string, err: unknown): EnrollmentDogResultWire | undefined {
  // ADDENDUM 1 R4 — design §4 rows 6 and 9, corrected. `charges
  // .stripe_payment_intent_id` is UNIQUE, so this fires for exactly one
  // reason: we ADOPTED a retrieved `succeeded` intent (a same-key replay past
  // our own 24h idempotency sweep, while Stripe's key window was still open)
  // and an earlier request has already written the row for that money. That
  // money belongs to that request — it may since have been refunded at
  // withdraw — so seating this dog on it would be an enrollment nobody paid
  // for, and the round-1 build's answer, an unactionable 500 for the WHOLE
  // request, told the owner nothing.
  //
  // No blocker: nothing about the card failed (R5). The savepoint has already
  // rolled this dog's bookings back, so "not enrolled" is true at the DB level
  // and not merely reported.
  if (isDuplicatePaymentIntentViolation(err)) {
    return dogChargeFailedResult(dogId);
  }
  if (!(err instanceof ApiError)) return undefined;
  if (err.code === 'vaccine_missing') {
    return { dog_id: dogId, enrolled: false, reason: 'vaccine_missing' };
  }
  return undefined;
}

/**
 * A Postgres unique violation (SQLSTATE 23505) on `charges
 * .stripe_payment_intent_id`. Matched on the constraint name as well as the
 * code, because the per-dog savepoint wraps booking inserts too and a
 * different unique violation there is NOT a per-dog money story — it must keep
 * failing the whole request rather than being reported as a charge failure.
 */
function isDuplicatePaymentIntentViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const record = err as { code?: unknown; constraint?: unknown; detail?: unknown };
  if (record.code !== '23505') return false;
  const constraint = typeof record.constraint === 'string' ? record.constraint : '';
  const detail = typeof record.detail === 'string' ? record.detail : '';
  return (
    constraint.includes('stripe_payment_intent_id') || detail.includes('stripe_payment_intent_id')
  );
}

/**
 * Claim + store a refusal envelope under this request's Idempotency-Key
 * (ADDENDUM 1 R10), without opening the enroll transaction.
 *
 * The three arms that reach here answer 200 with nobody enrolled — an advisory
 * seat shortfall, every dog failing a check, every survivor's card refusing.
 * They used to return before `withMutation` ever ran, so nothing recorded the
 * answer: a same-key duplicate arriving after the state changed (a seat frees,
 * a prereq clears) re-ran the whole pre-tx phase and could DIVERGE into a real
 * enrollment and a real charge — money moving behind a screen that had said
 * nothing was charged. Same key, same answer.
 *
 * No Stripe traffic and no domain writes: the transaction body writes the
 * idempotency row and nothing else. A fixed dog resubmits under a FRESH key,
 * which is what mobile's retry already mints (§4 row 2, unchanged).
 */
async function recordRefusalEnvelope(
  ctx: EnrollmentRunContext,
  body: EnrollmentResultWire,
): Promise<{ status: number; body: EnrollmentResultWire }> {
  const outcome = await withMutation<EnrollmentResultWire>(
    {
      principal: ctx.principal,
      idempotencyKey: ctx.idempotencyKey,
      endpoint: 'POST /enrollments',
      requestHash: ctx.requestHash,
      keysToInvalidate: () => [],
    },
    async () => ({ status: 200, body }),
  );
  return { status: outcome.status, body: outcome.body };
}
