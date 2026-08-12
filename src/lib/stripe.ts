import Stripe from 'stripe';
import { env } from '../env.js';
import type { ChargeBlocker } from '../contracts/wire.js';
import type { ChargeStatus } from '../db/repositories/chargesRepository.js';
import { ApiError } from './errors.js';

/**
 * Stripe seam (Day 14). All Stripe API calls flow through `StripeClient`;
 * routes consume it via DI (`registerXxxRoute(app, { stripe })`) so contract
 * tests substitute an in-memory stub and the suite stays offline.
 *
 * Design choices:
 *   - **Test mode in dev/staging, live in prod** — the secret in env decides;
 *     `payments_enabled` (Day-20 launch gate) is the operator kill switch, not
 *     a code branch here.
 *   - **Idempotency keys flow through** the same way Stripe wants them:
 *     `idempotencyKey` is passed on every write call so a client retry with
 *     the same `Idempotency-Key` header dedupes on Stripe's side AND the DB
 *     side (`withMutation` + `withIdempotency`).
 *   - **API version is left at the SDK default** so it aligns with the
 *     Stripe Dashboard account-level pin — flipping the dashboard upgrades
 *     both at once without a redeploy.
 *   - **No PCI** crosses this boundary: PAN/CVC are collected client-side by
 *     Stripe Elements; we only see the resulting `payment_method` token +
 *     the displayable bits (brand/last4/exp).
 *
 * The interface is narrow — only the 5 verbs Day-14 actually calls. Adding a
 * method here when Day-15 wires webhooks is the rule-of-two trigger; new
 * verbs land alongside their first caller.
 */

const stripeSingleton = new Stripe(env.STRIPE_SECRET_KEY);

/**
 * The logger {@link chargeBlockerForConfirm} needs — the two levels it actually
 * calls, structurally. Widened from `FastifyBaseLogger` on 2026-08-12 so the
 * auto-charge worker and the verify lane (which carry their own three-method
 * `WorkerLogger`, not a Fastify request logger) can reach the ONE blocker
 * derivation instead of growing a second one. `FastifyBaseLogger` satisfies
 * this structurally, so every existing route call site is unchanged.
 */
export interface ChargeBlockerLogger {
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

export type StripeCustomerId = string;
export type StripePaymentMethodId = string;
export type StripePaymentIntentId = string;
export type StripeRefundId = string;

export interface StripePaymentMethodSnapshot {
  id: StripePaymentMethodId;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  cardholderName: string;
}

export type StripeSetupIntentStatus =
  | 'requires_payment_method'
  | 'requires_confirmation'
  | 'requires_action'
  | 'processing'
  | 'canceled'
  | 'succeeded';

export interface StripeSetupIntentSnapshot {
  id: string;
  status: StripeSetupIntentStatus;
  /** Attached customer — null until the SetupIntent is associated with one. */
  customerId: StripeCustomerId | null;
  /** Attached payment method — populated once the FE confirms the SetupIntent. */
  paymentMethodId: StripePaymentMethodId | null;
}

export type StripePaymentIntentStatus =
  | 'requires_payment_method'
  | 'requires_confirmation'
  | 'requires_action'
  | 'processing'
  | 'requires_capture'
  | 'canceled'
  | 'succeeded';

export interface StripePaymentIntentResult {
  id: StripePaymentIntentId;
  status: StripePaymentIntentStatus;
  clientSecret: string | null;
  amountCents: number;
  /**
   * Domain blocker derived from the THROWN card error's `err.code`, mapped at
   * the seam ({@link THROWN_CARD_CODE_TO_BLOCKER}). Absent on the returning
   * fork — which has no code to read — and absent for codes the map doesn't
   * cover. Strictly MORE specific than {@link status}: the probe of 2026-08-11
   * showed a decline and an authentication failure resting at the identical
   * status (`requires_payment_method`), with only the code telling them apart.
   * Never wire-emitted raw; {@link chargeBlockerForConfirm} is the one reader.
   */
  blocker?: ChargeBlocker;
  /**
   * The raw `err.code` string off a thrown card error — informational only,
   * for the unmapped-code log line and support forensics. Never persisted,
   * never on the wire (raw Stripe vocabulary would couple two clients to it).
   */
  failureCode?: string;
  /**
   * Set ONLY when Stripe returned a `payment_intent.status` this codebase does
   * not know. {@link status} is then read as `processing` — the money-safe
   * reading, since an unrecognized status does not tell us the money stopped,
   * and `processing` is the one blocker that refuses a retry. This field
   * carries the raw value so {@link chargeBlockerForConfirm}, which has a
   * logger, can say what arrived and what it was read as. Informational only:
   * never persisted, never on the wire.
   */
  unknownStatus?: string;
  /**
   * The PaymentIntent's `created` instant (2026-08-12), carried through the
   * seam because it is one of only two signals that can tell a REPLAY from a
   * FRESH EXECUTION — and the whole double-charge defence of the verify lane's
   * re-issue arm rests on that distinction. An intent created back when the
   * attempt row was minted is the ORIGINAL being replayed; one created now was
   * executed now, which means Stripe no longer holds the key
   * (`invoiceAttemptVerify.reissueLooksReplayed`).
   *
   * `undefined` only when the source object carried no readable `created` (the
   * thrown fork's attached intent may not).
   */
  createdAt?: Date;
  /**
   * `true` when Stripe answered this confirm from its idempotency record
   * (`Idempotency-Replayed: true`), `false` when it executed the request, and
   * `undefined` when the header could not be read at all — the three states are
   * NOT interchangeable. Only the confirm verb stamps it: a retrieve is a GET
   * with no idempotency key, so "replayed" has no meaning there.
   */
  replayed?: boolean;
}

/**
 * Map a Stripe `payment_intent.status` to our `charge_status` enum. Used at
 * both ends of the PI lifecycle:
 *   - **Day-14 sync confirm path** (`POST /credit-packages/:key/purchase`):
 *     a fresh PI returned by `paymentIntents.create + confirm` maps to the
 *     `charges` row status we INSERT.
 *   - **Day-15 webhook path** (`POST /webhooks/stripe`): a terminal
 *     `payment_intent.succeeded`/`.payment_failed` event maps to the
 *     `markStatus` update we apply to the existing `charges` row.
 *
 * The schema enum (`charge_status`) doesn't have a 1:1 match for Stripe's
 * `requires_payment_method` / `requires_confirmation` / `processing` /
 * `requires_action` / `requires_capture` — they all collapse to
 * `'requires_payment'` (a slight rename mismatch with the leading Stripe
 * status; the wire status stays honest: not-yet-succeeded, not-yet-failed).
 * Exhaustive `switch` so a future Stripe status surfaces as a TS error
 * rather than silently mapping to a fallback.
 */
export function stripeIntentStatusToChargeStatus(status: StripePaymentIntentStatus): ChargeStatus {
  switch (status) {
    case 'succeeded':
      return 'succeeded';
    case 'canceled':
      return 'failed';
    case 'requires_payment_method':
    case 'requires_confirmation':
    case 'requires_action':
    case 'processing':
    case 'requires_capture':
      return 'requires_payment';
  }
}

/**
 * Every raw PaymentIntent status EXCEPT `succeeded` — the domain of
 * {@link stripeIntentStatusToChargeBlocker}, since a confirm that reached
 * `succeeded` has nothing blocking it. Derived from
 * {@link StripePaymentIntentStatus} rather than re-listed, so a future Stripe
 * status lands in the blocker switch as a TS error too.
 */
export type UnsettledPaymentIntentStatus = Exclude<StripePaymentIntentStatus, 'succeeded'>;

/**
 * Map a non-succeeded Stripe `payment_intent.status` to the DOMAIN reason the
 * confirm stopped short — precisely the information
 * {@link stripeIntentStatusToChargeStatus} above destroys, which is why this
 * lives beside it. Five Stripe statuses collapse into `'requires_payment'`
 * there, but "the card needs verification we cannot complete", "the card was
 * declined" and "the money is still in flight, do NOT retry" are three
 * different true sentences with three different next actions for the owner.
 * The wire (1.8.0 `ChargeBlocker`) carries this BESIDE the collapsed status,
 * never instead of it — `charge_status` is pinned to the `charge_status`
 * pgEnum and widening it would be DDL.
 *
 * Two statuses are anomalous after a `confirm: true, off_session: true` create
 * and so warn rather than map silently — reaching them means Stripe's
 * lifecycle no longer matches the one modelled here:
 *
 *   - `requires_confirmation` — we confirmed; Stripe handing it back
 *     unconfirmed shouldn't happen. Read as `authentication_required`, the
 *     closest still-live state, so the copy asks for another card instead of
 *     asserting a decline that didn't happen.
 *   - `requires_capture` — nothing in this system authorizes without
 *     capturing. Read as `processing` because the money may be authorized and
 *     in flight; calling that "declined" would be flatly false.
 *
 * Exhaustive `switch` on the RAW status, same discipline as its neighbour: a
 * future Stripe status surfaces as a TS error rather than a silent fallback.
 *
 * **MODULE-PRIVATE since 2026-08-11, deliberately.** A status alone cannot say
 * why a confirm stopped — Stripe parks a PaymentIntent at
 * `requires_payment_method` after ANY terminally failed attempt, so a decline
 * and an authentication failure read identically here (probe, 2026-08-11:
 * cards `4000000000000341` and `4000002500003155` both rested there). Deriving
 * the owner-facing blocker from this function alone is exactly the defect
 * `designs/charge-blocker-lost-at-the-seam.md` fixes, so the export was
 * removed and every call site goes through {@link chargeBlockerForConfirm}.
 *
 * Un-exporting alone does NOT prevent the drift — it blocks the import, not
 * the derivation, and a caller could still hand `chargeBlockerForConfirm` a
 * hand-built `{ status }`. That is why its parameter is the WHOLE
 * {@link StripePaymentIntentResult} rather than a `Pick`: the only way to
 * obtain one is from the seam, which always stamps the code when there was
 * one. The compiler carries the invariant instead of a comment asking for it.
 */
function stripeIntentStatusToChargeBlocker(
  status: UnsettledPaymentIntentStatus,
  log: ChargeBlockerLogger,
): ChargeBlocker {
  switch (status) {
    case 'requires_action':
      return 'authentication_required';
    case 'requires_payment_method':
      // Stripe resets a PI to this after an attempt that FAILED but returned a
      // status rather than throwing a card error.
      return 'declined';
    case 'processing':
      return 'processing';
    case 'canceled':
      // Defensive: `charge_status` is already 'failed' on this status and the
      // client's pessimistic arm covers it. 'declined' is the honest domain
      // reading of an intent that ended with no money moved.
      return 'declined';
    case 'requires_confirmation':
      log.warn(
        { stripeIntentStatus: status },
        'off-session confirm returned requires_confirmation — anomalous after confirm:true; reporting authentication_required',
      );
      return 'authentication_required';
    case 'requires_capture':
      log.warn(
        { stripeIntentStatus: status },
        'off-session confirm returned requires_capture — anomalous (nothing here authorizes without capturing); reporting processing',
      );
      return 'processing';
  }
}

/**
 * THE one derivation point for `charge_blocker` — every confirm site in this
 * system calls this and nothing else (`designs/charge-blocker-lost-at-the-seam.md`).
 *
 * Two sources of truth arrive here and they can disagree:
 *
 *   - `intent.blocker` — mapped at the seam from the THROWN card error's
 *     `err.code`. Attempt-scoped: it names what happened on THIS confirm.
 *   - `intent.status` — where the PaymentIntent now rests. Intent-scoped, and
 *     NOT a diagnosis: Stripe parks a PI at `requires_payment_method` after any
 *     terminally failed attempt, so it reads the same for a decline and for an
 *     authentication failure.
 *
 * **The precedence rule: the code wins — except when the status says money may
 * be in motion.** `charge_blocker` answers an attempt-scoped question
 * (`wire.ts` `ChargeBlocker`), the code is the only field that answers it, and
 * choosing between `declined` and `authentication_required` selects COPY, not
 * behavior — `charge_status`, the charges row, the 1.7.1 cancel rule, refunds
 * and idempotency all still derive from `status` alone.
 *
 * **The `processing` carve-out** is the exception, and the only arm where the
 * wrong pick costs real money: `processing` copy says "don't retry", and
 * telling an owner "try a different card" while a charge is in flight is the
 * reachable double charge. A thrown card error carrying a `processing` intent
 * is self-contradictory evidence (a card error means the attempt failed;
 * `processing` means it may not have) — unobserved, and when evidence
 * contradicts itself on a money path we take the money-safe reading. So a
 * status mapping to `processing` is never overridden by a code; the
 * contradiction is logged instead.
 *
 * Returns `undefined` for exactly one input — a confirm that reached
 * `succeeded`, which has nothing blocking it.
 */
export function chargeBlockerForConfirm(
  // The whole result, deliberately — NOT a `Pick`. With a Pick of optional
  // members, `chargeBlockerForConfirm({ status: 'requires_payment_method' })`
  // type-checks, which is the status-only derivation this design exists to
  // make impossible. Requiring the full result means the argument can only
  // have come from the seam.
  intent: StripePaymentIntentResult,
  log: ChargeBlockerLogger,
): ChargeBlocker | undefined {
  // Reported here rather than at the seam, which has no logger. Loud on
  // purpose: a status we don't model on a money path means the taxonomy has
  // drifted from Stripe's lifecycle, and every reading below it is a guess.
  if (intent.unknownStatus !== undefined) {
    log.error(
      { stripeIntentStatus: intent.unknownStatus, paymentIntentId: intent.id },
      'off-session confirm returned an UNKNOWN PaymentIntent status — read as processing (money may be in flight, retry refused); the status union needs updating',
    );
  }
  if (intent.status === 'succeeded') return undefined;
  const fromStatus = stripeIntentStatusToChargeBlocker(intent.status, log);

  if (fromStatus === 'processing') {
    if (intent.blocker !== undefined && intent.blocker !== 'processing') {
      log.warn(
        { stripeIntentStatus: intent.status, code: intent.failureCode },
        'thrown card error code contradicts an in-flight status — status wins (money-safety carve-out)',
      );
    }
    return fromStatus;
  }

  if (intent.blocker !== undefined) return intent.blocker;

  if (intent.failureCode !== undefined) {
    // The map is grown from THIS log line plus probe runs, never from Stripe's
    // documentation alone — a speculative row in a money-path map is how a
    // wrong observation gets invented, which is the class of defect this
    // derivation exists to undo.
    log.warn(
      { code: intent.failureCode, stripeIntentStatus: intent.status },
      'thrown card error carried an unmapped code — blocker derived from status',
    );
  }
  return fromStatus;
}

export type StripeRefundStatus =
  | 'pending'
  | 'requires_action'
  | 'succeeded'
  | 'failed'
  | 'canceled';

export interface StripeRefundResult {
  id: StripeRefundId;
  status: StripeRefundStatus;
  amountCents: number;
}

/**
 * Day-15 narrow webhook event type — the discriminated union the dispatch
 * loop in `routes/stripeWebhook.ts` switches on. Built by the seam's
 * `constructWebhookEvent` so the rest of the codebase never imports the
 * wide `Stripe.Event` type (which carries dozens of optional shapes per
 * event type and would leak Stripe SDK details across the dependency
 * rule's "domain knows nothing about Stripe" boundary).
 *
 * Each arm carries only the fields the matching handler uses; new event
 * types arrive as new arms — the `'unhandled'` catch-all keeps the
 * receiver from 5xx-ing on a Stripe-side product release we haven't
 * wired yet.
 *
 * The mapping from Stripe's wire shapes lives in `defaultStripeClient.
 * constructWebhookEvent` (real impl) and in the test stub's
 * `setNextEvent` (test impl) — both produce this same narrow union.
 */
export type StripeWebhookEvent =
  | {
      id: string;
      type: 'payment_intent.succeeded';
      paymentIntentId: StripePaymentIntentId;
      amountCents: number;
      metadata: Record<string, string>;
    }
  | {
      id: string;
      type: 'payment_intent.payment_failed';
      paymentIntentId: StripePaymentIntentId;
      amountCents: number;
      metadata: Record<string, string>;
    }
  | {
      id: string;
      type: 'setup_intent.succeeded';
      setupIntentId: string;
      paymentMethodId: StripePaymentMethodId;
      customerId: StripeCustomerId;
    }
  | {
      id: string;
      type: 'charge.refund.updated';
      refundId: StripeRefundId;
      paymentIntentId: StripePaymentIntentId | null;
      amountCents: number;
      status: StripeRefundStatus;
    }
  | {
      id: string;
      type: 'unhandled';
      rawType: string;
    };

export interface StripeClient {
  /**
   * Create a Stripe customer for an owner — once per owner. Idempotency key
   * is required so a retried POST /payment-methods/setup-intent doesn't
   * create duplicate customers in Stripe. Returns the new customer id; the
   * caller is responsible for persisting it in `stripe_customers`.
   */
  createCustomer(
    args: { email: string; name: string; ownerId: string },
    idempotencyKey: string,
  ): Promise<{ id: StripeCustomerId }>;

  /**
   * Create a SetupIntent for adding a future-use payment method. Returns
   * the `client_secret` the FE confirms via Stripe Elements; on success
   * Stripe fires `setup_intent.succeeded` → Day-15 webhook writes the
   * `payment_methods` row with the attached `payment_method` id.
   */
  createSetupIntent(
    args: { customerId: StripeCustomerId },
    idempotencyKey: string,
  ): Promise<{ id: string; clientSecret: string }>;

  /**
   * Retrieve a SetupIntent's terminal state — the synchronous counterpart to
   * the `setup_intent.succeeded` webhook. After the FE confirms the SetupIntent
   * client-side, `POST /payment-methods/confirm` retrieves it to (a) verify
   * `status === 'succeeded'` and (b) read back the attached `customer` +
   * `payment_method` so the `payment_methods` row is written from Stripe's
   * source of truth, never a client-supplied id. The webhook remains the async
   * backstop for the identical write (idempotent by stripe_payment_method_id).
   * A GET in Stripe's API — no idempotency key needed.
   */
  retrieveSetupIntent(setupIntentId: string): Promise<StripeSetupIntentSnapshot>;

  /**
   * Create + confirm a PaymentIntent in one round-trip — the "synchronous
   * confirmation" path the credit-purchase route uses (DATA-CONTRACT §G,
   * HANDOFF Day-14). With a stored card + test mode, this returns
   * `status='succeeded'` immediately; in production a 3DS card returns
   * `'requires_action'` and the FE finishes via the returned client_secret.
   *
   * **The contract (wire 1.9.0): card-level failures RETURN a non-succeeded
   * result; only transport, configuration, and idempotency errors THROW.**
   * Stripe itself reports a failed off-session confirm two ways — by returning
   * a non-succeeded PaymentIntent, or by throwing a card error that carries
   * that same PaymentIntent — and every caller here has exactly one correct,
   * tested non-succeeded arm. So the fork is erased at THIS seam
   * ({@link normalizeThrownConfirmError}) rather than bet on, or re-handled at
   * each of the six confirm sites. Implementations of this interface — the SDK
   * one below AND the contract-test stub — owe that same guarantee, or a route
   * test proves nothing about the fork it didn't simulate.
   *
   * **Erasing the fork is not the same as erasing its evidence (2026-08-11).**
   * The thrown fork carries strictly MORE information than the returning one —
   * `err.code` names the failure where the attached status cannot — so the
   * result it produces may carry `blocker` / `failureCode`, and an
   * implementation that drops them re-creates the defect this seam was
   * repaired for. What implementations owe each other is the amended
   * invariant on {@link normalizeThrownConfirmError}: identical money
   * behavior, a blocker that may be more specific, and never a contradiction
   * of the `processing` reading.
   */
  createAndConfirmPaymentIntent(
    args: {
      customerId: StripeCustomerId;
      paymentMethodId: StripePaymentMethodId;
      amountCents: number;
      currency: string;
      metadata: Record<string, string>;
    },
    idempotencyKey: string,
  ): Promise<StripePaymentIntentResult>;

  /**
   * Detach a payment method from a Stripe customer. Used by DELETE
   * /payment-methods/:id post-commit — the DB-side soft-expire is the
   * source of truth; this is best-effort cleanup so the card no longer
   * appears on Stripe's saved-card list. Failures are logged + swallowed
   * by the caller; the Day-15 webhook reconciliation can catch drift.
   */
  detachPaymentMethod(paymentMethodId: StripePaymentMethodId): Promise<void>;

  /**
   * Cancel a PaymentIntent that didn't settle on an off-session confirm
   * (returned `requires_action` / `processing` / `requires_payment_method`
   * rather than `succeeded`), so it can't later auto-succeed and double-charge
   * against the next attempt's fresh PI. Every off-session confirm path owes
   * this call while no client-side 3DS completion flow exists — the auto-charge
   * worker, `POST /invoices/:id/pay`, `POST /credit-packages/:key/purchase`,
   * `POST /memberships`, and the group-class enroll unwind. Best-effort: every
   * caller swallows failures — a PI Stripe refuses to cancel (already settling)
   * is covered by the key-scoped Stripe idempotency on the next attempt.
   */
  cancelPaymentIntent(paymentIntentId: StripePaymentIntentId): Promise<void>;

  /**
   * Read a PaymentIntent's CURRENT state — the verify lane's way of resolving
   * doubt by asking rather than by charging again
   * (`designs/auto-charge-unknown-outcome.md`, Decision 3). A GET in Stripe's
   * API: no idempotency key, no money moved by calling it.
   *
   * Returns the same {@link StripePaymentIntentResult} the confirm verbs
   * produce, with `blocker`/`failureCode` stamped from `last_payment_error.code`
   * through the same observed-code map — so `chargeBlockerForConfirm` reads a
   * retrieved intent exactly as it reads a confirmed one, and its "the argument
   * can only have come from the seam" invariant still holds.
   */
  retrievePaymentIntent(paymentIntentId: StripePaymentIntentId): Promise<StripePaymentIntentResult>;

  /**
   * Refund a portion (or all) of a prior PaymentIntent. Used by POST
   * /bookings/:id/cancel money-back branch post-commit (Day-13 stubbed
   * this; Day-14 wires it). Stripe is asynchronous for refunds — the
   * initial status is usually 'pending'; Day-15 webhook flips the
   * `refunds` row's `status` on `charge.refund.updated`.
   */
  createRefund(
    args: { paymentIntentId: StripePaymentIntentId; amountCents: number; reason?: string },
    idempotencyKey: string,
  ): Promise<StripeRefundResult>;

  /**
   * Fetch a payment method's displayable bits (brand/last4/exp/cardholder).
   * Used by the Day-15 `setup_intent.succeeded` webhook to materialize the
   * `payment_methods` row when the FE confirms a SetupIntent client-side.
   */
  retrievePaymentMethod(
    paymentMethodId: StripePaymentMethodId,
  ): Promise<StripePaymentMethodSnapshot>;

  /**
   * Verify the `Stripe-Signature` header against the raw request body and
   * the configured webhook secret, and return the narrow {@link StripeWebhookEvent}
   * for the dispatch loop. The default impl wraps
   * `stripe.webhooks.constructEvent` and projects Stripe's wide event
   * type onto our narrow union; an invalid signature throws (the route
   * maps to 400). Test stubs verify nothing and return whichever event
   * was queued via the stub's `setNextEvent` knob.
   *
   * `signature` may be undefined when the header is absent — the seam
   * normalizes to "throw with signature_verification" so the route's
   * happy path doesn't need a separate guard.
   */
  constructWebhookEvent(rawBody: string, signature: string | undefined): StripeWebhookEvent;
}

/**
 * Runtime membership test for {@link StripePaymentIntentStatus}, needed because
 * the status on a THROWN card error's attached PaymentIntent arrives across a
 * trust boundary (the SDK types it `any`) and must be validated, not asserted.
 * The record is keyed BY the union, so a status added there without a key here
 * is a compile error — the same "a future Stripe status can never slip through
 * silently" discipline as the two exhaustive switches above.
 */
const PAYMENT_INTENT_STATUSES: Readonly<Record<StripePaymentIntentStatus, true>> = {
  requires_payment_method: true,
  requires_confirmation: true,
  requires_action: true,
  processing: true,
  requires_capture: true,
  canceled: true,
  succeeded: true,
};

function isPaymentIntentStatus(value: unknown): value is StripePaymentIntentStatus {
  return typeof value === 'string' && Object.hasOwn(PAYMENT_INTENT_STATUSES, value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Thrown-card-error `err.code` → domain blocker. **Only rows OBSERVED against
 * live Stripe are here** (`npm run probe:stripe`, test mode, 2026-08-11,
 * recorded in `test/fixtures/stripe-thrown-confirm.json`):
 *
 *   | `err.code`                 | blocker                   | card              |
 *   | -------------------------- | ------------------------- | ----------------- |
 *   | `authentication_required`  | `authentication_required` | 4000002500003155  |
 *   | `card_declined`            | `declined`                | 4000000000000341  |
 *
 * Everything else falls through to status-derived and logs a warning
 * ({@link chargeBlockerForConfirm}) — deliberately, not as an oversight:
 *
 *   - `insufficient_funds` is not a top-level code at all. Stripe reports it as
 *     `code='card_declined'` + `decline_code='insufficient_funds'`, so the
 *     `card_declined` row already covers it; `decline_code` granularity is
 *     below the `ChargeBlocker` vocabulary and stays unread.
 *   - `expired_card`, `processing_error`, `incorrect_cvc`, … all degrade to
 *     `declined` via `requires_payment_method`, which is the right owner
 *     ACTION ("try a different card") even where the tone is imperfect. Mapping
 *     them now would encode an unobserved assumption into a money path — the
 *     exact failure mode this table exists to undo. The warn line is how their
 *     real frequency and shape become known before anything maps them.
 */
const THROWN_CARD_CODE_TO_BLOCKER: Readonly<Record<string, ChargeBlocker>> = {
  authentication_required: 'authentication_required',
  card_declined: 'declined',
};

/**
 * THE thrown-fork normalizer (wire 1.9.0) — the one place in this system that
 * decides whether an error from an off-session confirm is a **payment outcome**
 * or a **failure to find out**.
 *
 * Stripe reports a declined stored card either by returning a non-succeeded
 * PaymentIntent or by throwing a card error; before 1.9.0 only the returning
 * fork was built, so a thrown decline reached the global handler as a 500 and
 * the owner read "We couldn't reach the server." on a card that was simply
 * declined. This function converts the thrown fork into the exact
 * {@link StripePaymentIntentResult} the returning fork produces, so every
 * confirm site travels its already-tested non-succeeded arm either way — the
 * charges audit row is written, the 1.7.1 cancel rule fires, and the
 * `charge_blocker` taxonomy covers both channels because it is one code path,
 * not two mappings that happen to agree.
 *
 * **Amended 2026-08-11 — the two forks are no longer byte-identical, and that
 * is the fix, not a regression.** The 1.9.0 version of this doc claimed they
 * were; erasing the fork also erased `err.code`, the only field naming WHICH
 * failure happened. An off-session 3DS failure throws
 * `code=authentication_required` while its attached intent already rests at
 * `requires_payment_method` (probe, 2026-08-11), so the status-only derivation
 * above it rendered "declined — try a different card" for a card that would
 * work with verification. The result now carries `blocker` + `failureCode`, on
 * the thrown fork only. The amended equivalence invariant:
 *
 *   > The two forks agree on everything that MOVES or RECORDS money —
 *   > obligation semantics (201-open vs 402-refuse), `charge_status`, the
 *   > charges row, the 1.7.1 cancel rule, idempotency — and on the blocker
 *   > whenever the thrown code maps to the same value the status implies. The
 *   > thrown fork may make the blocker MORE SPECIFIC than the status can; it
 *   > may never contradict the `processing` reading
 *   > ({@link chargeBlockerForConfirm}).
 *
 * Either returns a normalized result or throws. The rows, and why each is what
 * it is:
 *
 *   - **Not a `StripeCardError` → rethrow the original, untouched.** Connection,
 *     API, rate-limit, authentication and invalid-request errors all mean *we do
 *     not know whether money moved*. Relabelling one of those a decline would
 *     tell every owner at once that their card failed during a Stripe outage,
 *     and "try a different card" would be actively wrong advice — the reused-key
 *     retry the `network` copy promises is the correct recovery. The
 *     same-key-changed-params rejection (`StripeInvalidRequestError`) is the
 *     loud failure the idempotency-key design WANTS (`invoices.ts` ~:188):
 *     failing beats charging twice.
 *   - **Card error whose attached intent reached `succeeded` → throw.** An error
 *     path must never be allowed to grant, settle, or convert. This is an
 *     anomaly to investigate, not a result to render.
 *   - **Card error with no readable attached intent → throw.** Defensive (not
 *     documented to happen on a confirm): with no intent state in hand, "we
 *     don't know" is the only honest answer, and 500 → `network` says exactly
 *     that.
 *
 * The two throwing anomalies are wrapped in a plain `Error` on purpose: the
 * global handler maps a bare Stripe error to ITS `statusCode` (402/400) with
 * code `internal`, and a 402 that isn't a `payment_failed` envelope is the most
 * confusing shape we could hand a client. A plain Error is an honest 500, and
 * `cause` keeps the original for the log.
 *
 * Discrimination is by Stripe's error CLASS, never by message text. The
 * attached intent is read off `err.payment_intent` — pinned against
 * `stripe@22.1.1`, where `StripeError`'s constructor copies it from the raw
 * error body (`err.raw.payment_intent` is the same object); `test/stripeSeam.
 * test.ts` fails if a future SDK moves it.
 */
/**
 * The RETURNING fork's normalizer — the sibling of
 * {@link normalizeThrownConfirmError}, and exported for the same reason: a
 * money-path trust boundary that only a real test can hold honest.
 *
 * This fork used to assert rather than verify (`intent.status as
 * StripePaymentIntentStatus`), so a status Stripe adds later fell off the end
 * of both exhaustive switches and produced `undefined` at RUNTIME — the
 * wire-required `charge_status` omitted, and `charges.status` silently taking
 * its DDL default. A mis-typed money row that nothing would have flagged.
 * Stripe has added statuses before (`requires_capture`; `requires_source` →
 * `requires_payment_method`).
 *
 * An unrecognized status is read as `processing`, never `declined`: we do not
 * know the money stopped, and `processing` is the one blocker that refuses a
 * retry. Wrongly cautious costs an owner a wait; wrongly confident costs them
 * a second charge. The raw value rides along in `unknownStatus` because this
 * function has no logger — {@link chargeBlockerForConfirm} does, and reports it.
 */
export function normalizeReturnedConfirm(intent: Stripe.PaymentIntent): StripePaymentIntentResult {
  // `created` rides along on both forks (2026-08-12) — see
  // {@link StripePaymentIntentResult.createdAt}. Unix SECONDS at Stripe.
  const created = intentCreatedAt(intent.created);
  if (isPaymentIntentStatus(intent.status)) {
    return {
      id: intent.id,
      status: intent.status,
      clientSecret: intent.client_secret,
      amountCents: intent.amount,
      ...(created !== undefined ? { createdAt: created } : {}),
    };
  }
  return {
    id: intent.id,
    status: 'processing',
    clientSecret: intent.client_secret,
    amountCents: intent.amount,
    unknownStatus: String(intent.status),
    ...(created !== undefined ? { createdAt: created } : {}),
  };
}

/** Stripe's `created` (unix SECONDS) → a Date, or undefined if unreadable. */
function intentCreatedAt(created: unknown): Date | undefined {
  if (typeof created !== 'number' || !Number.isFinite(created)) return undefined;
  return new Date(created * 1000);
}

/**
 * Did Stripe REPLAY this response from its idempotency record, or execute the
 * request? Read off the `Idempotency-Replayed` response header, which Stripe
 * documents on exactly that condition.
 *
 * Returns `undefined` when we could not tell (no `lastResponse` — the object
 * did not come from a live SDK call), which callers must NOT read as `false`:
 * "Stripe executed this fresh" and "we don't know how this got here" have
 * different money consequences.
 */
function replayedFromResponse(intent: Stripe.PaymentIntent): boolean | undefined {
  const headers = (intent as Partial<Stripe.Response<Stripe.PaymentIntent>>).lastResponse?.headers;
  if (headers === undefined) return undefined;
  const raw = headers['idempotency-replayed'] ?? headers['Idempotency-Replayed'];
  return typeof raw === 'string' && raw.toLowerCase() === 'true';
}

/**
 * The RETRIEVE fork's normalizer (2026-08-12) — a GET on a PaymentIntent whose
 * outcome the worker never learned. Structurally the returning fork plus one
 * thing: a retrieved intent that has already failed carries
 * `last_payment_error.code`, the same field the thrown fork reads and the only
 * one that distinguishes a decline from an authentication failure (both rest at
 * `requires_payment_method`). Mapped through the SAME observed-code table, so
 * the verify lane's park copy is derived by the identical rule as the charge
 * lane's — one derivation, not two that happen to agree.
 */
export function normalizeRetrievedIntent(intent: Stripe.PaymentIntent): StripePaymentIntentResult {
  const base = normalizeReturnedConfirm(intent);
  const rawCode: unknown = intent.last_payment_error?.code;
  const code = typeof rawCode === 'string' && rawCode.length > 0 ? rawCode : undefined;
  // `Object.hasOwn` before the lookup — same trust-boundary discipline as the
  // thrown fork: a bare index also finds INHERITED keys.
  const blocker =
    code !== undefined && Object.hasOwn(THROWN_CARD_CODE_TO_BLOCKER, code)
      ? THROWN_CARD_CODE_TO_BLOCKER[code]
      : undefined;
  return {
    ...base,
    ...(blocker !== undefined ? { blocker } : {}),
    ...(code !== undefined ? { failureCode: code } : {}),
  };
}

/**
 * WHICH idempotency error is this? Stripe spends one error type
 * (`idempotency_error`) on two conditions that could not be further apart on a
 * money path, and reading them as one is how a transient blip parked a healthy
 * invoice forever (2026-08-12 adversarial review):
 *
 *   - **`params-mismatch` (HTTP 400)** — the key was first used with DIFFERENT
 *     parameters. On the auto-charge path that can only mean our records and
 *     Stripe's disagree about what attempt N was. The one response that must
 *     never follow is a fresh key, which is how a double charge gets
 *     manufactured out of a bookkeeping disagreement, so the verify lane parks
 *     it for a human and charges nothing (`designs/auto-charge-unknown-
 *     outcome.md`, Decision 1).
 *   - **`concurrent-request` (HTTP 409)** — "another request is currently using
 *     this Idempotency Key". This says NOTHING about our bookkeeping: it is two
 *     of our own workers (or two overlapping `POST /workers/tick` runs, which
 *     pg_cron fires every minute with no overlap guard) racing on the same
 *     attempt. The outcome is still UNKNOWN, exactly as it was a moment ago, so
 *     the honest response is to leave the attempt pending and ask again — never
 *     to park an invoice whose bookkeeping is fine.
 *
 * Returns `undefined` for anything that is not an idempotency error. An
 * idempotency error with an unreadable status code reads as `params-mismatch`:
 * of the two, that is the arm that touches no money.
 *
 * Neither condition has been observed live by this project — UNVERIFIED,
 * stub-modelled, documented.
 */
export type StripeIdempotencyErrorKind = 'params-mismatch' | 'concurrent-request';

export function stripeIdempotencyErrorKind(err: unknown): StripeIdempotencyErrorKind | undefined {
  // Three checks, not one: `StripeIdempotencyError` is the class stripe-node
  // generates for a raw `type: 'idempotency_error'`; `rawType` is that same raw
  // type on a base error; and the `code` check catches the condition arriving
  // as a plain invalid-request error (the shape `stripe.ts`'s own doc at the
  // thrown-fork normalizer describes).
  if (!(err instanceof Stripe.errors.StripeError)) return undefined;
  const isIdempotency =
    err instanceof Stripe.errors.StripeIdempotencyError ||
    err.rawType === 'idempotency_error' ||
    err.code === 'idempotency_error';
  if (!isIdempotency) return undefined;
  return err.statusCode === 409 ? 'concurrent-request' : 'params-mismatch';
}

export function normalizeThrownConfirmError(err: unknown): StripePaymentIntentResult {
  if (!(err instanceof Stripe.errors.StripeCardError)) throw err;

  const attached: unknown = err.payment_intent;
  const id: unknown = isRecord(attached) ? attached.id : undefined;
  const status: unknown = isRecord(attached) ? attached.status : undefined;
  const amount: unknown = isRecord(attached) ? attached.amount : undefined;
  if (typeof id !== 'string' || id.length === 0 || !isPaymentIntentStatus(status)) {
    throw new Error(
      'Stripe card error carried no readable PaymentIntent — cannot report a payment outcome',
      { cause: err },
    );
  }
  if (status === 'succeeded') {
    throw new Error(
      `Stripe card error carried a SUCCEEDED PaymentIntent (${id}) — refusing to treat an error path as a settlement`,
      { cause: err },
    );
  }
  const clientSecret: unknown = isRecord(attached) ? attached.client_secret : undefined;
  // Same `created` the returning fork carries, when the attached intent has one
  // — the verify lane's replay-vs-fresh-execution test must work on both forks.
  const createdAt = intentCreatedAt(isRecord(attached) ? attached.created : undefined);
  // The field the pre-2026-08-11 seam dropped, and the whole reason an owner
  // whose card needed verification was told it had been declined. `err.code` is
  // the ONLY field on this error that names WHICH failure happened — the
  // attached intent's status is the same `requires_payment_method` either way.
  // Carried as a pre-mapped `blocker` (so nothing downstream re-derives a
  // second mapping that can drift) plus the raw string for the log line.
  //
  // `Object.hasOwn` before the lookup, same discipline as `isPaymentIntentStatus`
  // above and for the same reason: `err.code` crosses a trust boundary, and a
  // bare index into an object literal also finds INHERITED keys —
  // `THROWN_CARD_CODE_TO_BLOCKER['toString']` is a function at runtime while
  // TypeScript types it `ChargeBlocker | undefined`. Unreachable in practice
  // (Stripe would have to send `code: 'constructor'`), and one line to make
  // impossible rather than merely unlikely on a money path.
  const code = typeof err.code === 'string' && err.code.length > 0 ? err.code : undefined;
  const blocker =
    code !== undefined && Object.hasOwn(THROWN_CARD_CODE_TO_BLOCKER, code)
      ? THROWN_CARD_CODE_TO_BLOCKER[code]
      : undefined;
  return {
    id,
    status,
    clientSecret: typeof clientSecret === 'string' ? clientSecret : null,
    // Amount is informational on this arm (nothing was captured), so a missing
    // one degrades to 0 rather than costing the owner a real sentence.
    amountCents: typeof amount === 'number' ? amount : 0,
    // Omitted rather than set to `undefined` — the returning fork emits neither
    // key, and "absent both ways" is one less shape for a consumer to model.
    ...(blocker !== undefined ? { blocker } : {}),
    ...(code !== undefined ? { failureCode: code } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
  };
}

/**
 * The default `StripeClient` implementation — direct SDK calls. Routes
 * substitute this for an in-memory stub via DI in contract tests. Errors
 * from Stripe are surfaced as-is (Stripe.errors.* subclasses) on every verb
 * EXCEPT `createAndConfirmPaymentIntent`, where wire 1.9.0 normalizes a thrown
 * CARD error into the non-succeeded result its callers already handle (see
 * `normalizeThrownConfirmError`) — every other error class still bubbles to the
 * error mapper untouched. Callers of the other verbs either swallow + log
 * (post-commit detach/refund) or re-throw.
 */
export const defaultStripeClient: StripeClient = {
  async createCustomer(args, idempotencyKey) {
    const customer = await stripeSingleton.customers.create(
      {
        email: args.email,
        name: args.name,
        metadata: { owner_id: args.ownerId },
      },
      { idempotencyKey },
    );
    return { id: customer.id };
  },

  async createSetupIntent(args, idempotencyKey) {
    const intent = await stripeSingleton.setupIntents.create(
      {
        customer: args.customerId,
        usage: 'off_session',
        payment_method_types: ['card'],
      },
      { idempotencyKey },
    );
    if (intent.client_secret === null) {
      throw new Error(`Stripe SetupIntent ${intent.id} returned null client_secret — unexpected`);
    }
    return { id: intent.id, clientSecret: intent.client_secret };
  },

  async retrieveSetupIntent(setupIntentId) {
    const intent = await stripeSingleton.setupIntents.retrieve(setupIntentId);
    // `customer` / `payment_method` come back as either an id string or an
    // expanded object depending on the SetupIntent — normalize both to the id.
    const customerId =
      typeof intent.customer === 'string' ? intent.customer : (intent.customer?.id ?? null);
    const paymentMethodId =
      typeof intent.payment_method === 'string'
        ? intent.payment_method
        : (intent.payment_method?.id ?? null);
    return {
      id: intent.id,
      status: intent.status,
      customerId,
      paymentMethodId,
    };
  },

  async createAndConfirmPaymentIntent(args, idempotencyKey) {
    let intent: Stripe.PaymentIntent;
    try {
      intent = await stripeSingleton.paymentIntents.create(
        {
          amount: args.amountCents,
          currency: args.currency,
          customer: args.customerId,
          payment_method: args.paymentMethodId,
          confirm: true,
          off_session: true,
          metadata: args.metadata,
        },
        { idempotencyKey },
      );
    } catch (err) {
      // THE seam (wire 1.9.0). A thrown card error is a payment OUTCOME, not a
      // failure to find out, so it becomes the same non-succeeded result the
      // returning fork produces and every confirm site travels one already-
      // tested arm. Everything else rethrows untouched — see
      // `normalizeThrownConfirmError` for why each row is what it is. Only the
      // Stripe call is inside the `try`: our own mapping below must never be
      // able to reach a catch whose job is interpreting Stripe.
      return normalizeThrownConfirmError(err);
    }
    // The returning fork is a trust boundary too, and it used to be the only
    // one that wasn't checked: `as StripePaymentIntentStatus` asserted rather
    // than verified, so a status Stripe adds later would fall off the end of
    // both exhaustive switches and yield `undefined` at RUNTIME — omitting the
    // wire-required `charge_status` and letting `charges.status` fall to its
    // DDL default, a silently mis-typed money row. Stripe has added statuses
    // before (`requires_capture`; `requires_source` → `requires_payment_method`).
    //
    // An unrecognized status is read as `processing`, not `declined`: we do not
    // know that the money stopped, and the whole taxonomy exists because
    // "may be in flight" and "try another card" have opposite next actions.
    // `processing` is the arm that refuses a retry, so it is the safe default
    // — a wrongly-cautious owner is told to wait; a wrongly-confident one pays
    // twice. Same reasoning as the `processing` carve-out in
    // `chargeBlockerForConfirm`.
    //
    // `replayed` is stamped HERE rather than in the normalizer because it is a
    // property of the RESPONSE, not of the PaymentIntent — and only the confirm
    // verb sends an idempotency key at all. Omitted (not `false`) when the
    // header could not be read: see the field's doc.
    const replayed = replayedFromResponse(intent);
    return {
      ...normalizeReturnedConfirm(intent),
      ...(replayed !== undefined ? { replayed } : {}),
    };
  },

  async detachPaymentMethod(paymentMethodId) {
    await stripeSingleton.paymentMethods.detach(paymentMethodId);
  },

  async cancelPaymentIntent(paymentIntentId) {
    await stripeSingleton.paymentIntents.cancel(paymentIntentId);
  },

  async retrievePaymentIntent(paymentIntentId) {
    const intent = await stripeSingleton.paymentIntents.retrieve(paymentIntentId);
    return normalizeRetrievedIntent(intent);
  },

  async createRefund(args, idempotencyKey) {
    const refund = await stripeSingleton.refunds.create(
      {
        payment_intent: args.paymentIntentId,
        amount: args.amountCents,
        ...(args.reason !== undefined
          ? { reason: args.reason as Stripe.RefundCreateParams.Reason }
          : {}),
      },
      { idempotencyKey },
    );
    return {
      id: refund.id,
      status: refund.status as StripeRefundStatus,
      amountCents: refund.amount,
    };
  },

  async retrievePaymentMethod(paymentMethodId) {
    const pm = await stripeSingleton.paymentMethods.retrieve(paymentMethodId);
    if (pm.card === null || pm.card === undefined) {
      throw new Error(
        `Stripe payment_method ${pm.id} has no card details — non-card payment methods are not supported`,
      );
    }
    const card = pm.card;
    return {
      id: pm.id,
      brand: card.brand,
      last4: card.last4,
      expMonth: card.exp_month,
      expYear: card.exp_year,
      cardholderName: pm.billing_details.name ?? '',
    };
  },

  constructWebhookEvent(rawBody, signature) {
    if (signature === undefined) {
      throw new ApiError('bad_request', 'missing Stripe-Signature header');
    }
    let event: Stripe.Event;
    try {
      event = stripeSingleton.webhooks.constructEvent(
        rawBody,
        signature,
        env.STRIPE_WEBHOOK_SECRET,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new ApiError('bad_request', `Stripe-Signature verification failed: ${reason}`);
    }
    return projectStripeEvent(event);
  },
};

/**
 * Pure projection from Stripe's wide `Stripe.Event` (per their SDK type)
 * onto our narrow {@link StripeWebhookEvent} discriminated union. Exported
 * so contract tests can drive the dispatch loop with hand-built
 * `Stripe.Event`-shaped payloads when the in-memory stub isn't used.
 *
 * Each `case` reads only the fields the matching handler needs; the
 * `'unhandled'` arm carries the raw type for log breadcrumbs. Casts are
 * pinned to the SDK's per-event object types — narrowed by the literal
 * `event.type` discriminant.
 */
export function projectStripeEvent(event: Stripe.Event): StripeWebhookEvent {
  switch (event.type) {
    case 'payment_intent.succeeded': {
      const pi = event.data.object as Stripe.PaymentIntent;
      return {
        id: event.id,
        type: 'payment_intent.succeeded',
        paymentIntentId: pi.id,
        amountCents: pi.amount,
        metadata: pi.metadata ?? {},
      };
    }
    case 'payment_intent.payment_failed': {
      const pi = event.data.object as Stripe.PaymentIntent;
      return {
        id: event.id,
        type: 'payment_intent.payment_failed',
        paymentIntentId: pi.id,
        amountCents: pi.amount,
        metadata: pi.metadata ?? {},
      };
    }
    case 'setup_intent.succeeded': {
      const si = event.data.object as Stripe.SetupIntent;
      const paymentMethodId =
        typeof si.payment_method === 'string' ? si.payment_method : (si.payment_method?.id ?? null);
      const customerId = typeof si.customer === 'string' ? si.customer : (si.customer?.id ?? null);
      if (paymentMethodId === null || customerId === null) {
        // Defensive: a setup_intent.succeeded without an attached card or
        // customer would be malformed in test mode and uncommon in prod.
        // Surface as 'unhandled' so the dispatch loop logs + 200s rather
        // than 5xx-ing and triggering retry storms.
        return { id: event.id, type: 'unhandled', rawType: event.type };
      }
      return {
        id: event.id,
        type: 'setup_intent.succeeded',
        setupIntentId: si.id,
        paymentMethodId,
        customerId,
      };
    }
    case 'charge.refund.updated': {
      const refund = event.data.object as Stripe.Refund;
      const piId =
        typeof refund.payment_intent === 'string'
          ? refund.payment_intent
          : (refund.payment_intent?.id ?? null);
      return {
        id: event.id,
        type: 'charge.refund.updated',
        refundId: refund.id,
        paymentIntentId: piId,
        amountCents: refund.amount,
        status: (refund.status ?? 'pending') as StripeRefundStatus,
      };
    }
    default:
      return { id: event.id, type: 'unhandled', rawType: event.type };
  }
}
