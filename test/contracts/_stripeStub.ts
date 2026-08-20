import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import { ApiError } from '../../src/lib/errors.js';
import { normalizeRetrievedIntent, normalizeThrownConfirmError } from '../../src/lib/stripe.js';
import {
  rebuildRecordedCardError,
  type RecordedScenarioKey,
} from '../fixtures/recordedStripeErrors.js';
import type {
  StripeClient,
  StripePaymentIntentResult,
  StripePaymentIntentStatus,
  StripePaymentMethodSnapshot,
  StripeRefundResult,
  StripeSetupIntentSnapshot,
  StripeWebhookEvent,
} from '../../src/lib/stripe.js';

/**
 * In-memory `StripeClient` for contract tests. Lets the suite assert
 * Stripe-side side-effects (which API was called, with what args, how
 * many times) without hitting the network. Each test that touches a
 * Stripe-aware route constructs its own stub and passes it to the
 * route registration's `stripe` opt — no global mutable state.
 *
 * Default behavior mirrors test-mode happy paths:
 *   - `createCustomer` → returns `cus_test_<random>`
 *   - `createSetupIntent` → returns `seti_test_*` + a stable client_secret
 *   - `createAndConfirmPaymentIntent` → returns `pi_test_*` at
 *     status='succeeded' UNLESS overridden via `setNextIntentStatus`
 *   - `createRefund` → returns `re_test_*` at status='pending'
 *
 * Override knobs:
 *   - `setNextIntentStatus(status)` — next `createAndConfirmPaymentIntent`
 *     returns that status (and clientSecret = `pi_test_*_secret_xyz`)
 *   - `setNextIntentThrowsCardError(status, code?)` — next confirm simulates
 *     Stripe's OTHER failure fork (a thrown card error carrying the failed
 *     intent), HAND-BUILT. It runs the simulated throw through the PRODUCTION
 *     normalizer, so a route test driving this lever exercises the real seam
 *     rather than a lookalike. Use it for status/code combinations Stripe has
 *     never been observed to send (a `processing` intent under a card error);
 *     for the shapes Stripe DOES send, prefer the recorded lever below.
 *   - `setNextIntentThrowsRecorded(scenario)` — next confirm throws the error
 *     Stripe ACTUALLY threw, rebuilt from `test/fixtures/stripe-thrown-confirm.json`
 *     (recorded live by `npm run probe:stripe -- --record`). This is the lever
 *     that would have caught the 2026-08-11 defect: hand-built errors could
 *     only ever contain shapes someone imagined, and nobody imagined
 *     `code=authentication_required` on an intent resting at
 *     `requires_payment_method`.
 *   - `setNextIntentThrowsTransport(err)` — next confirm throws a NON-card
 *     Stripe error (connection/API/rate-limit). The seam rethrows those
 *     untouched, so this is how a test pins "an outage is not a decline".
 *   - `throwOnDetach()` — next `detachPaymentMethod` rejects
 *   - `throwOnRefund()` — next `createRefund` rejects
 *   - `throwOnCancel()` — next `cancelPaymentIntent` rejects
 *
 * All Stripe-facing calls are recorded as discriminated-union entries in
 * `calls`; tests can `.filter(c => c.method === 'createRefund')` to assert
 * that a route fired the expected post-commit call AND get type-safe
 * access to `.args` (the args type narrows on the discriminant).
 */

/** Discriminated-union over StripeClient method args. The `method` tag
 *  narrows `args` so tests can read typed fields without an `as` cast. */
export type StripeStubCall =
  | {
      method: 'createCustomer';
      args: Parameters<StripeClient['createCustomer']>[0];
      idempotencyKey: string;
    }
  | {
      method: 'createSetupIntent';
      args: Parameters<StripeClient['createSetupIntent']>[0];
      idempotencyKey: string;
    }
  | {
      method: 'retrieveSetupIntent';
      args: { setupIntentId: string };
      idempotencyKey: null;
    }
  | {
      method: 'createAndConfirmPaymentIntent';
      args: Parameters<StripeClient['createAndConfirmPaymentIntent']>[0];
      idempotencyKey: string;
    }
  | {
      method: 'detachPaymentMethod';
      args: { paymentMethodId: string };
      idempotencyKey: null;
    }
  | {
      method: 'cancelPaymentIntent';
      args: { paymentIntentId: string };
      idempotencyKey: null;
    }
  | {
      method: 'retrievePaymentIntent';
      args: { paymentIntentId: string };
      idempotencyKey: null;
    }
  | {
      method: 'createRefund';
      args: Parameters<StripeClient['createRefund']>[0];
      idempotencyKey: string;
    }
  | {
      method: 'retrievePaymentMethod';
      args: { paymentMethodId: string };
      idempotencyKey: null;
    }
  | {
      method: 'constructWebhookEvent';
      args: { rawBody: string; signature: string | undefined };
      idempotencyKey: null;
    };

/**
 * One confirm's outcome, for {@link StripeStub.queueIntentOutcomes} — the
 * multi-dog case the single-shot levers cannot express, since each of those
 * resets itself after one call.
 */
export type QueuedIntentOutcome =
  | { kind: 'status'; status: StripePaymentIntentStatus }
  | { kind: 'cardError'; status: StripePaymentIntentStatus; code?: string }
  | { kind: 'recorded'; scenario: RecordedScenarioKey };

export interface StripeStub extends StripeClient {
  /** Every Stripe call this stub received, in order. */
  readonly calls: StripeStubCall[];
  /**
   * Queue an outcome per confirm, in call order — the only way to give the N
   * confirms of a multi-dog enroll DIFFERENT outcomes. A queued outcome wins
   * over the single-shot levers for that call; once the queue drains, the
   * single-shot levers (and the `succeeded` default) apply again.
   *
   * Exists because "one dog declined, one dog still processing" is a real
   * multi-dog shape and the response can carry only one blocker — see
   * `mostHazardousUnsettledIntent` in `src/routes/enrollments.ts`.
   */
  queueIntentOutcomes(outcomes: readonly QueuedIntentOutcome[]): void;
  /** Force the next PaymentIntent confirm to return this status. */
  setNextIntentStatus(status: StripePaymentIntentStatus): void;
  /**
   * Force the next PaymentIntent confirm to take Stripe's THROWN fork: a
   * HAND-BUILT `StripeCardError` carrying a failed PaymentIntent at `status`
   * with the given `code`, run through the production normalizer. Per the
   * `StripeClient` contract the call still RESOLVES — a card-level failure is a
   * result, not an exception.
   *
   * **The equivalence doctrine, amended 2026-08-11.** This used to say a route
   * driving this lever "must produce byte-identical behavior to the same status
   * set via `setNextIntentStatus`", and that instruction was wrong: it demanded
   * the forks agree on a field the thrown fork knows more about. Stripe's
   * thrown error carries `err.code`, which names WHICH failure happened; the
   * attached intent's status reads `requires_payment_method` for a decline and
   * for an authentication failure alike. The amended invariant:
   *
   *   > The forks agree on everything that MOVES or RECORDS money — the status
   *   > body, the charges row, the cancel rule, the obligation outcome — and on
   *   > the blocker WHENEVER `code` maps to what `status` implies. The thrown
   *   > fork may make `charge_blocker` more specific; it may never contradict a
   *   > `processing` status.
   *
   * So a test comparing the two forks must pass a `code` consistent with
   * `status`, or expect (and assert) the more specific blocker.
   */
  setNextIntentThrowsCardError(status: StripePaymentIntentStatus, code?: string): void;
  /**
   * Force the next PaymentIntent confirm to throw the error live Stripe
   * ACTUALLY threw for this scenario, rebuilt from the committed recording and
   * run through the production normalizer. The recorded intent's `id`,
   * `amount` and `client_secret` are adjusted to this call; its `status`,
   * `code` and `decline_code` — the evidence — are replayed verbatim.
   */
  setNextIntentThrowsRecorded(scenario: RecordedScenarioKey): void;
  /**
   * Force the next PaymentIntent confirm to throw a NON-card Stripe error.
   * Defaults to a `StripeConnectionError` — "we could not reach Stripe", which
   * must never render as a decline.
   */
  setNextIntentThrowsTransport(err?: Error): void;
  /**
   * The dangerous half of a transport failure, and the one the old stub could
   * not express: the request REACHED Stripe (the intent exists, the
   * idempotency key is now live, the money may be moving) and only the
   * RESPONSE was lost. The caller sees the same thrown transport error as
   * `setNextIntentThrowsTransport`, but a later re-issue under the same key
   * REPLAYS this outcome instead of executing fresh — which is precisely the
   * property the auto-charge design rests on, and precisely what a stub that
   * minted a new `pi_test_*` per call made untestable.
   *
   * `status` is what Stripe recorded (default `succeeded` — the case where the
   * owner's money moved and nothing here knew).
   */
  setNextIntentLandsThenThrowsTransport(status?: StripePaymentIntentStatus, err?: Error): void;
  /**
   * Force a live PaymentIntent's state, as if Stripe had moved it on its own
   * (an async settle, a bank decline arriving late). Read back by
   * `retrievePaymentIntent`; this is how a test simulates "it succeeded at
   * Stripe while we were still in doubt".
   *
   * `failureCode` is the `last_payment_error.code` Stripe attaches to an intent
   * that has already failed — the ONLY field distinguishing a decline from an
   * authentication failure (both rest at `requires_payment_method`). Without it
   * the retrieve fork can only ever produce the status-derived blocker, so the
   * verify lane's blocker-aware copy would look tested while nothing had
   * exercised the code path that makes it specific.
   */
  setIntentState(
    paymentIntentId: string,
    status: StripePaymentIntentStatus,
    opts?: { failureCode?: string },
  ): void;
  /** Make the next `detachPaymentMethod` throw. */
  throwOnDetach(): void;
  /**
   * Make the next `createRefund` throw BEFORE anything is recorded — the
   * request never reached Stripe. A same-key retry afterwards therefore
   * EXECUTES (correctly: it is the one and only refund).
   */
  throwOnRefund(): void;
  /**
   * The dangerous half of a failed refund, and the one the stub could not
   * express until 2026-08-19: the `createRefund` REACHED Stripe (the refund
   * exists, the idempotency key is now live, the money is on its way back) and
   * only the RESPONSE was lost. The caller sees a thrown transport error, our
   * row stays `'pending'` with no `re_*`, and the retry sweep will try again —
   * which is safe if and only if it sends the SAME key, because a same-key call
   * REPLAYS this refund instead of executing a second one.
   *
   * This is THE case the stored-key design exists for. Before this knob,
   * `createRefund` minted a fresh `re_*` on every call regardless of key, so a
   * sweep that re-executed instead of replaying — an unattended double refund —
   * passed the suite exactly as a correct one did.
   */
  refundLandsThenThrows(err?: Error): void;
  /**
   * Make the next `createRefund` fail the way Stripe fails a key that is
   * ALREADY IN FLIGHT: HTTP 409 `idempotency_key_in_use`. This is design §3
   * arm 3 — the sweep firing while the original post-commit call is still
   * running, because a slow Stripe round-trip outlasted the 5-minute grace.
   *
   * Nothing is recorded and no money moves: Stripe is the arbiter, our side
   * needs no interlock, and the correct response is to leave the row pending
   * and let the next tick resolve it. The design promised this arm would be
   * "unit-covered, stated not skipped" and it was neither until 2026-08-20.
   */
  refundConcurrentKeyInUse(): void;
  /**
   * Declare how many cents a PaymentIntent can still have refunded against it,
   * so the arms where a refund must be REFUSED are assertable: the charge was
   * already refunded out of band (design §3 arm 7), or an expired-key retry
   * executed fresh against a charge that already came back (arm 5). Past the
   * declared balance the stub throws a `charge_already_refunded`-coded error
   * and moves no money.
   *
   * Only needed for PaymentIntents the stub did not mint itself — for its own
   * `pi_test_*` intents the confirmed amount IS the balance.
   */
  setRefundableBalance(paymentIntentId: string, amountCents: number): void;
  /**
   * Every refund Stripe actually EXECUTED, in order. A replay is not an
   * execution and does not appear twice — which is what makes "exactly one
   * refund exists for this money" an assertion rather than a hope. Compare with
   * `calls`, which counts attempts including replays.
   */
  executedRefunds(): readonly StripeRefundResult[];
  /**
   * Make the next `cancelPaymentIntent` throw — the "Stripe won't let us cancel
   * this one" case every caller of it swallows. The call is still recorded, so a
   * test can assert both that the cancel was attempted and that the route
   * carried on.
   */
  throwOnCancel(): void;
  /** Replace what `retrievePaymentMethod` returns next. */
  setPaymentMethodSnapshot(snapshot: Partial<StripePaymentMethodSnapshot>): void;
  /**
   * Override what `retrieveSetupIntent` returns next. Defaults to a succeeded
   * SetupIntent with a `pm_test_*` payment method; tests exercising the
   * confirm route's tenancy gate set `customerId` to the fixture's Stripe
   * customer id (or a mismatch to assert the 404 path).
   */
  setSetupIntentSnapshot(snapshot: Partial<StripeSetupIntentSnapshot>): void;
  /**
   * Queue the next webhook event the dispatch loop should receive.
   * `constructWebhookEvent` returns this event regardless of signature
   * (test stubs verify nothing). Pass `null` to make the next call throw
   * a `bad_request` ApiError (simulating a bogus signature).
   */
  setNextEvent(event: StripeWebhookEvent | null): void;
}

/**
 * The fingerprint Stripe hashes an idempotency key against — the request body.
 * Modelled here as a stable serialization of every confirm parameter, metadata
 * included, because metadata IS part of that hash: the pre-2026-08-12 worker
 * stamped a mutable counter into `auto_charge_attempt`, so even a correct
 * same-key retry would have been rejected live. A stub that ignored metadata
 * would have kept that defect invisible.
 */
function paramsFingerprint(args: Parameters<StripeClient['createAndConfirmPaymentIntent']>[0]): string {
  const metadata = Object.keys(args.metadata)
    .sort()
    .map((k) => [k, args.metadata[k]] as const);
  return JSON.stringify([
    args.customerId,
    args.paymentMethodId,
    args.amountCents,
    args.currency,
    metadata,
  ]);
}

/**
 * The fingerprint Stripe hashes a refund idempotency key against. Every field
 * the production `refundCreateParams` sends, in the order it sends them —
 * because a same-key call whose params differ in ANY of them is an
 * `idempotency_error`, and the sweep re-building these params differently from
 * the post-commit fire is exactly the regression the byte-equality pin watches.
 */
function refundParamsFingerprint(
  args: Parameters<StripeClient['createRefund']>[0],
): string {
  return JSON.stringify([args.paymentIntentId, args.amountCents, args.reason ?? null]);
}

/** One live PaymentIntent, as Stripe would hold it. */
interface StubIntentState {
  status: StripePaymentIntentStatus;
  amountCents: number;
  clientSecret: string | null;
  /** Unix seconds, like Stripe's `created`. Stamped when the intent is minted
   *  and NEVER moved afterwards — a replay of a day-old intent must report the
   *  day-old creation time, which is the whole point of carrying it. */
  createdSeconds: number;
  /** `last_payment_error.code` once the intent has failed. */
  failureCode?: string;
}

export function makeStripeStub(): StripeStub {
  const calls: StripeStubCall[] = [];
  let nextIntentStatus: StripePaymentIntentStatus = 'succeeded';
  let nextIntentThrowsCard = false;
  let nextIntentThrowsCardCode = 'card_declined';
  let nextIntentThrowsRecorded: RecordedScenarioKey | undefined;
  let nextIntentTransportError: Error | undefined;
  let nextIntentLandsThenThrows: { status: StripePaymentIntentStatus; err: Error } | undefined;
  const outcomeQueue: QueuedIntentOutcome[] = [];
  // Stripe's idempotency layer, modelled: key → (request fingerprint, the
  // response Stripe recorded). Same key + same params replays that response;
  // same key + DIFFERENT params is an `idempotency_error`. The old stub minted
  // a fresh `pi_test_*` on every confirm regardless of key, so "same key ⇒ same
  // outcome" — the mechanism the auto-charge worker's safety rests on — was
  // simply untestable, and a same-key retry modelled as two captures.
  const replays = new Map<string, { fingerprint: string; result: StripePaymentIntentResult }>();
  // Live PaymentIntent state, so `retrievePaymentIntent` answers what Stripe
  // would and `cancelPaymentIntent` actually changes something.
  const intents = new Map<string, StubIntentState>();
  // Stripe's idempotency layer for REFUNDS, modelled exactly as the confirm
  // verb's above. The confirm verb got its replay store on 2026-08-12;
  // `createRefund` did not, so until 2026-08-19 a broken sweep that
  // re-EXECUTED a refund instead of replaying it passed the suite identically
  // to a correct one — a counterfeit for the one mechanism that keeps a retry
  // from becoming a second refund of somebody's money.
  const refundReplays = new Map<string, { fingerprint: string; result: StripeRefundResult }>();
  /** Refunds Stripe EXECUTED. A replay adds nothing here; that is the point. */
  const executedRefundLog: StripeRefundResult[] = [];
  /** Cumulative executed refund cents per PaymentIntent. */
  const refundedByPi = new Map<string, number>();
  /** Declared refundable balance per PI (see `setRefundableBalance`). */
  const declaredRefundable = new Map<string, number>();
  let detachShouldThrow = false;
  let refundShouldThrow = false;
  let refundLandsThenThrowsErr: Error | undefined;
  let refundKeyInUse = false;
  let cancelShouldThrow = false;
  let pmSnapshotOverride: Partial<StripePaymentMethodSnapshot> = {};
  let setupIntentOverride: Partial<StripeSetupIntentSnapshot> = {};
  // `undefined` = no event queued; `null` = next call throws (bad signature);
  // an event = next call returns it. Distinguishing null from undefined lets
  // tests assert "no signature verification ran" vs "explicit bad signature".
  let nextEvent: StripeWebhookEvent | null | undefined;

  const testIdPrefix = (kind: string): string => `${kind}_test_${randomUUID().slice(0, 8)}`;
  const nowSeconds = (): number => Math.floor(Date.now() / 1000);

  const stub: StripeStub = {
    calls,
    setNextIntentStatus(status) {
      nextIntentStatus = status;
    },
    setNextIntentThrowsCardError(status, code = 'card_declined') {
      nextIntentStatus = status;
      nextIntentThrowsCardCode = code;
      nextIntentThrowsCard = true;
    },
    setNextIntentThrowsRecorded(scenario) {
      nextIntentThrowsRecorded = scenario;
    },
    queueIntentOutcomes(outcomes) {
      outcomeQueue.push(...outcomes);
    },
    setNextIntentThrowsTransport(err) {
      nextIntentTransportError =
        err ?? new Stripe.errors.StripeConnectionError({ message: 'stub: cannot reach Stripe' });
    },
    setNextIntentLandsThenThrowsTransport(status = 'succeeded', err) {
      nextIntentLandsThenThrows = {
        status,
        err:
          err ??
          new Stripe.errors.StripeConnectionError({
            message: 'stub: request reached Stripe, response lost',
          }),
      };
    },
    setIntentState(paymentIntentId, status, opts) {
      const existing = intents.get(paymentIntentId);
      intents.set(paymentIntentId, {
        amountCents: existing?.amountCents ?? 0,
        clientSecret: existing?.clientSecret ?? null,
        createdSeconds: existing?.createdSeconds ?? nowSeconds(),
        status,
        ...(opts?.failureCode !== undefined
          ? { failureCode: opts.failureCode }
          : existing?.failureCode !== undefined
            ? { failureCode: existing.failureCode }
            : {}),
      });
    },
    throwOnDetach() {
      detachShouldThrow = true;
    },
    throwOnRefund() {
      refundShouldThrow = true;
    },
    refundLandsThenThrows(err) {
      refundLandsThenThrowsErr =
        err ??
        new Stripe.errors.StripeConnectionError({
          message: 'stub: refund reached Stripe, response lost',
        });
    },
    refundConcurrentKeyInUse() {
      refundKeyInUse = true;
    },
    setRefundableBalance(paymentIntentId, amountCents) {
      declaredRefundable.set(paymentIntentId, amountCents);
    },
    executedRefunds() {
      return executedRefundLog;
    },
    throwOnCancel() {
      cancelShouldThrow = true;
    },
    setPaymentMethodSnapshot(snapshot) {
      pmSnapshotOverride = snapshot;
    },
    setSetupIntentSnapshot(snapshot) {
      setupIntentOverride = snapshot;
    },
    setNextEvent(event) {
      nextEvent = event;
    },

    async createCustomer(args, idempotencyKey) {
      const id = testIdPrefix('cus');
      calls.push({ method: 'createCustomer', args, idempotencyKey });
      return { id };
    },

    async createSetupIntent(args, idempotencyKey) {
      const id = testIdPrefix('seti');
      calls.push({ method: 'createSetupIntent', args, idempotencyKey });
      return { id, clientSecret: `${id}_secret_${randomUUID().slice(0, 8)}` };
    },

    async retrieveSetupIntent(setupIntentId): Promise<StripeSetupIntentSnapshot> {
      calls.push({ method: 'retrieveSetupIntent', args: { setupIntentId }, idempotencyKey: null });
      return {
        id: setupIntentId,
        status: 'succeeded',
        customerId: `cus_test_${randomUUID().slice(0, 8)}`,
        paymentMethodId: `pm_test_${randomUUID().slice(0, 8)}`,
        ...setupIntentOverride,
      };
    },

    async createAndConfirmPaymentIntent(args, idempotencyKey): Promise<StripePaymentIntentResult> {
      const id = testIdPrefix('pi');
      // ── Stripe's idempotency layer, BEFORE anything else ──────────────────
      // Checked before the levers are consumed, deliberately: a replay is not
      // a new execution, so it must not eat a queued outcome either.
      const recorded = replays.get(idempotencyKey);
      if (recorded !== undefined) {
        calls.push({ method: 'createAndConfirmPaymentIntent', args, idempotencyKey });
        if (recorded.fingerprint !== paramsFingerprint(args)) {
          // The loud failure the design WANTS: our records and Stripe's
          // disagree about what this attempt was, and failing beats charging
          // twice. Callers must never answer this with a fresh key.
          throw new Stripe.errors.StripeIdempotencyError({
            type: 'idempotency_error',
            code: 'idempotency_error',
            message:
              'Keys for idempotent requests can only be used with the same parameters they were first used with.',
            statusCode: 400,
          } as never);
        }
        // The ORIGINAL response snapshot — not current state, which is what
        // Stripe documents and why the verify lane still retrieves when it can.
        //
        // `replayed: true` is the `Idempotency-Replayed` header, modelled. It
        // is the reason a caller can tell this branch from the one below at
        // all: until 2026-08-12 the stub returned a replay and a fresh
        // execution as the same shape, so "the key window held" and "the key
        // expired and we just charged the card a second time" were
        // indistinguishable to every test that could have caught it.
        return { ...recorded.result, replayed: true };
      }
      // A queued outcome (multi-dog enroll) overrides the single-shot levers
      // for THIS call by setting them, so everything below stays one code path.
      const queuedOutcome = outcomeQueue.shift();
      if (queuedOutcome !== undefined) {
        switch (queuedOutcome.kind) {
          case 'status':
            nextIntentStatus = queuedOutcome.status;
            break;
          case 'cardError':
            nextIntentStatus = queuedOutcome.status;
            nextIntentThrowsCardCode = queuedOutcome.code ?? 'card_declined';
            nextIntentThrowsCard = true;
            break;
          case 'recorded':
            nextIntentThrowsRecorded = queuedOutcome.scenario;
            break;
        }
      }
      const status = nextIntentStatus;
      const throwsCard = nextIntentThrowsCard;
      const throwsCardCode = nextIntentThrowsCardCode;
      const throwsRecorded = nextIntentThrowsRecorded;
      const transportError = nextIntentTransportError;
      const landsThenThrows = nextIntentLandsThenThrows;
      // Reset every lever for the next call — a stale one bleeding into a
      // route's SECOND confirm (multi-dog enroll, replay) would be a lie.
      nextIntentStatus = 'succeeded';
      nextIntentThrowsCard = false;
      nextIntentThrowsCardCode = 'card_declined';
      nextIntentThrowsRecorded = undefined;
      nextIntentTransportError = undefined;
      nextIntentLandsThenThrows = undefined;
      calls.push({ method: 'createAndConfirmPaymentIntent', args, idempotencyKey });

      const fingerprint = paramsFingerprint(args);
      const createdSeconds = nowSeconds();
      /**
       * Record what Stripe now holds: the replayable response + live state.
       * The response carries `createdAt` (Stripe's `created`) and
       * `replayed: false` — this request EXECUTED. A later same-key call
       * returns this same snapshot with `replayed: true`, and its `createdAt`
       * still names the moment below, not the moment of the replay.
       */
      const remember = (result: StripePaymentIntentResult): StripePaymentIntentResult => {
        const executed: StripePaymentIntentResult = {
          ...result,
          createdAt: new Date(createdSeconds * 1000),
          replayed: false,
        };
        replays.set(idempotencyKey, { fingerprint, result: executed });
        intents.set(executed.id, {
          status: executed.status,
          amountCents: executed.amountCents,
          clientSecret: executed.clientSecret,
          createdSeconds,
          ...(executed.failureCode !== undefined ? { failureCode: executed.failureCode } : {}),
        });
        return executed;
      };

      if (landsThenThrows !== undefined) {
        // The request LANDED: Stripe holds the intent and the key is live. Only
        // the response was lost, so the caller sees a transport throw while a
        // same-key re-issue will replay this outcome.
        remember({
          id,
          status: landsThenThrows.status,
          clientSecret:
            landsThenThrows.status === 'succeeded'
              ? null
              : `${id}_secret_${randomUUID().slice(0, 8)}`,
          amountCents: args.amountCents,
        });
        throw landsThenThrows.err;
      }
      if (transportError !== undefined) {
        // Non-card errors are rethrown by the seam untouched; the stub models
        // that by simply throwing. NOTHING is remembered — this is the "the
        // request never reached Stripe" half, where a same-key re-issue
        // legitimately executes for the first time.
        throw transportError;
      }
      const clientSecret = status === 'succeeded' ? null : `${id}_secret_${randomUUID().slice(0, 8)}`;
      if (throwsRecorded !== undefined) {
        // The error Stripe REALLY threw, replayed through the REAL normalizer.
        // Only the call-scoped identifiers are re-pointed; the recorded status
        // and code are the evidence and are never edited here.
        return remember(
          normalizeThrownConfirmError(
            rebuildRecordedCardError(throwsRecorded, {
              id,
              amount: args.amountCents,
              client_secret: `${id}_secret_${randomUUID().slice(0, 8)}`,
            }),
          ),
        );
      }
      if (throwsCard) {
        // Build the raw error the way Stripe does on a declined off-session
        // confirm and hand it to the REAL normalizer — the stub must not carry
        // its own copy of the mapping it exists to prove.
        return remember(
          normalizeThrownConfirmError(
            new Stripe.errors.StripeCardError({
              type: 'card_error',
              code: throwsCardCode,
              decline_code: 'generic_decline',
              message: 'Your card was declined.',
              statusCode: 402,
              payment_intent: {
                id,
                status,
                client_secret: clientSecret,
                amount: args.amountCents,
              },
            } as never),
          ),
        );
      }
      return remember({
        id,
        status,
        clientSecret,
        amountCents: args.amountCents,
      });
    },

    async retrievePaymentIntent(paymentIntentId): Promise<StripePaymentIntentResult> {
      calls.push({
        method: 'retrievePaymentIntent',
        args: { paymentIntentId },
        idempotencyKey: null,
      });
      const state = intents.get(paymentIntentId);
      if (state === undefined) {
        // Stripe 404s an unknown PaymentIntent; a test that reaches here has
        // asked about money the stub never minted, which is a test bug worth
        // failing loudly rather than answering with a fiction.
        throw new Stripe.errors.StripeInvalidRequestError({
          type: 'invalid_request_error',
          message: `stub: no such PaymentIntent ${paymentIntentId}`,
          statusCode: 404,
        } as never);
      }
      // Through the PRODUCTION normalizer, exactly as the confirm forks are —
      // so `last_payment_error.code` reaches the blocker map by the real route
      // rather than by a lookalike the stub invented. A retrieve is a GET, so
      // no `Idempotency-Replayed` is modelled here: `replayed` has no meaning
      // for it, and the verify lane must not read one.
      return normalizeRetrievedIntent({
        id: paymentIntentId,
        status: state.status,
        client_secret: state.clientSecret,
        amount: state.amountCents,
        created: state.createdSeconds,
        ...(state.failureCode !== undefined
          ? { last_payment_error: { code: state.failureCode } }
          : {}),
      } as unknown as Stripe.PaymentIntent);
    },

    async detachPaymentMethod(paymentMethodId) {
      calls.push({
        method: 'detachPaymentMethod',
        args: { paymentMethodId },
        idempotencyKey: null,
      });
      if (detachShouldThrow) {
        detachShouldThrow = false;
        throw new Error('stub: detach failed');
      }
    },

    async cancelPaymentIntent(paymentIntentId) {
      calls.push({
        method: 'cancelPaymentIntent',
        args: { paymentIntentId },
        idempotencyKey: null,
      });
      if (cancelShouldThrow) {
        cancelShouldThrow = false;
        throw new Error('stub: cancel failed');
      }
      // A cancel that RETURNS moved the money-safety needle: the intent is dead
      // and a later retrieve must say so. (A cancel that throws leaves the
      // state alone, which is the whole reason callers treat its success as
      // evidence and its failure as none.)
      const state = intents.get(paymentIntentId);
      if (state !== undefined && state.status !== 'succeeded') {
        intents.set(paymentIntentId, { ...state, status: 'canceled' });
      }
    },

    async createRefund(args, idempotencyKey): Promise<StripeRefundResult> {
      calls.push({ method: 'createRefund', args, idempotencyKey });

      // ── Stripe's idempotency layer, BEFORE anything else ──────────────────
      // Checked before the levers, deliberately: a replay is not a new
      // execution, so it must not consume a single-shot failure knob either.
      const recorded = refundReplays.get(idempotencyKey);
      if (recorded !== undefined) {
        if (recorded.fingerprint !== refundParamsFingerprint(args)) {
          // Same key, drifted params. Stripe 400s and NO money moves — loud and
          // safe, but the refund also never lands, which is why both the
          // post-commit fire and the sweep build these params in one place.
          throw new Stripe.errors.StripeIdempotencyError({
            type: 'idempotency_error',
            code: 'idempotency_error',
            message:
              'Keys for idempotent requests can only be used with the same parameters they were first used with.',
            statusCode: 400,
          } as never);
        }
        // The ORIGINAL refund object — same `re_*`. Exactly one refund exists
        // for this money no matter how many times the sweep re-fires.
        return recorded.result;
      }

      if (refundShouldThrow) {
        // Never reached Stripe: nothing recorded, no key burned, no money.
        refundShouldThrow = false;
        throw new Error('stub: refund failed');
      }

      if (refundKeyInUse) {
        // The key is live on a request Stripe is still working. Nothing is
        // recorded here BECAUSE nothing is decided yet — the in-flight call
        // owns the outcome, and this attempt simply loses the race.
        refundKeyInUse = false;
        throw new Stripe.errors.StripeIdempotencyError({
          type: 'idempotency_error',
          code: 'idempotency_key_in_use',
          message:
            'There is currently another in-progress request using this Idempotent Key.',
          statusCode: 409,
        } as never);
      }

      // ── The cumulative refundable cap ─────────────────────────────────────
      // Stripe will not return more than a charge holds. For intents this stub
      // minted, the confirmed amount IS the balance; otherwise a test declares
      // it. Unknown means unmodelled, and an unmodelled cap is stated here
      // rather than silently enforced as "infinite is fine".
      const cap =
        declaredRefundable.get(args.paymentIntentId) ??
        intents.get(args.paymentIntentId)?.amountCents;
      const already = refundedByPi.get(args.paymentIntentId) ?? 0;
      if (cap !== undefined && already + args.amountCents > cap) {
        throw new Stripe.errors.StripeInvalidRequestError({
          type: 'invalid_request_error',
          code: already >= cap ? 'charge_already_refunded' : 'amount_too_large',
          message:
            already >= cap
              ? 'Charge has already been refunded.'
              : `Refund amount ($${args.amountCents / 100}) is greater than the remaining unrefunded amount.`,
          statusCode: 400,
        } as never);
      }

      const executed: StripeRefundResult = {
        id: testIdPrefix('re'),
        status: 'pending',
        amountCents: args.amountCents,
      };
      refundReplays.set(idempotencyKey, {
        fingerprint: refundParamsFingerprint(args),
        result: executed,
      });
      executedRefundLog.push(executed);
      refundedByPi.set(args.paymentIntentId, already + args.amountCents);

      if (refundLandsThenThrowsErr !== undefined) {
        // Recorded FIRST, then thrown: the request reached Stripe and only the
        // response was lost. Everything above is now true at Stripe and false
        // in our database — which is precisely the state the retry sweep, and
        // the same-key rule it rests on, exist to resolve.
        const err = refundLandsThenThrowsErr;
        refundLandsThenThrowsErr = undefined;
        throw err;
      }
      return executed;
    },

    async retrievePaymentMethod(paymentMethodId): Promise<StripePaymentMethodSnapshot> {
      calls.push({
        method: 'retrievePaymentMethod',
        args: { paymentMethodId },
        idempotencyKey: null,
      });
      return {
        id: paymentMethodId,
        brand: 'visa',
        last4: '4242',
        expMonth: 12,
        expYear: 2030,
        cardholderName: 'Test Cardholder',
        ...pmSnapshotOverride,
      };
    },

    constructWebhookEvent(rawBody, signature) {
      calls.push({
        method: 'constructWebhookEvent',
        args: { rawBody, signature },
        idempotencyKey: null,
      });
      if (nextEvent === undefined) {
        throw new Error(
          'stub: constructWebhookEvent called with no event queued — call setNextEvent first',
        );
      }
      const queued = nextEvent;
      nextEvent = undefined; // reset so a stale event can't bleed across requests
      if (queued === null) {
        // Mirror the real impl's failure shape — ApiError(bad_request)
        // bubbles through the route's existing ApiError→HTTP mapper as 400.
        throw new ApiError('bad_request', 'stub: simulated Stripe-Signature failure');
      }
      return queued;
    },
  };

  return stub;
}
