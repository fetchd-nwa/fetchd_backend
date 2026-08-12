import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { FastifyBaseLogger } from 'fastify';
import Stripe from 'stripe';
import {
  chargeBlockerForConfirm,
  defaultStripeClient,
  normalizeReturnedConfirm,
  normalizeThrownConfirmError,
  type StripePaymentIntentResult,
  type StripePaymentIntentStatus,
} from '../src/lib/stripe.js';
import {
  RECORDED_AT,
  rebuildRecordedCardError,
  recordedScenario,
} from './fixtures/recordedStripeErrors.js';

/**
 * Unit coverage for the THROWN-FORK NORMALIZER and the blocker derivation above
 * it — the seam that makes "Stripe returned a non-succeeded intent" and "Stripe
 * threw a card error" behave identically at every confirm site
 * (`designs/payment-failure-channel.md` Part 1), and the derivation that decides
 * WHICH sentence the owner reads (`designs/charge-blocker-lost-at-the-seam.md`).
 * One test per row of those designs' tables, because the rows are not stylistic:
 * getting the non-card rows wrong turns a Stripe outage into "your card was
 * declined" for every owner at once, and getting the blocker rows wrong tells an
 * owner whose card needs verification to go find a different card.
 *
 * Pure — no DB, no network. Two classes of input, labelled everywhere they are
 * used, because the distinction is the whole lesson of 2026-08-11:
 *
 *   - **RECORDED** — rebuilt from `test/fixtures/stripe-thrown-confirm.json`,
 *     which `npm run probe:stripe -- --record` wrote from live Stripe. These
 *     are shapes Stripe demonstrably sends. The old version of this file
 *     hand-built `code: 'card_declined'` and asserted we read it, which proved
 *     only that we can read a field we invented — and it stayed green while
 *     real 3DS failures were being reported to owners as declines.
 *   - **HAND-BUILT** — counterfactuals Stripe should never send (no attached
 *     intent, a succeeded one, an unknown status, a `processing` intent under a
 *     card error). They cannot be recorded because they are refusals, and each
 *     one says so at its use site.
 */

/** A raw Stripe error body for a declined off-session confirm, with the failed
 *  PaymentIntent attached the way Stripe attaches it on a confirm. HAND-BUILT:
 *  used for the counterfactual rows and for status/code combinations Stripe has
 *  never been observed to produce. */
function cardErrorWithIntent(
  intent: Record<string, unknown>,
  code = 'card_declined',
): Stripe.errors.StripeCardError {
  return new Stripe.errors.StripeCardError({
    type: 'card_error',
    code,
    decline_code: 'generic_decline',
    message: 'Your card was declined.',
    statusCode: 402,
    payment_intent: intent,
  } as never);
}

/** A `FastifyBaseLogger` that records what it was told, so a test can assert a
 *  warning FIRED rather than assuming it did. A derivation that silently picks
 *  a fallback and a derivation that picks it while telling us are different
 *  systems: the log line is the only mechanism by which an unmapped Stripe code
 *  ever becomes a mapped one. */
interface CapturedWarn {
  obj: Record<string, unknown>;
  msg: string;
}

function capturingLogger(): {
  log: FastifyBaseLogger;
  warns: CapturedWarn[];
  errors: string[];
} {
  const warns: CapturedWarn[] = [];
  // Captured separately from `warns`: an unmodelled status on a money path is
  // logged at ERROR, and a test that could not tell the two levels apart would
  // pass if the alarm were quietly downgraded to a warn.
  const errors: string[] = [];
  const noop = (): void => {};
  const logger = {
    level: 'warn',
    silent: noop,
    fatal: noop,
    error: (obj: Record<string, unknown>, msg?: string): void => {
      errors.push(msg ?? JSON.stringify(obj));
    },
    info: noop,
    debug: noop,
    trace: noop,
    warn: (obj: Record<string, unknown>, msg?: string): void => {
      warns.push({ obj, msg: msg ?? '' });
    },
    child: (): unknown => logger,
  };
  return { log: logger as unknown as FastifyBaseLogger, warns, errors };
}

function attachedIntent(
  status: StripePaymentIntentStatus,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'pi_thrown_1',
    status,
    client_secret: 'pi_thrown_1_secret_abc',
    amount: 12_500,
    ...over,
  };
}

/** What the RETURNING fork produces for the same intent — no `blocker`, no
 *  `failureCode`, because a returned intent carries no error code to read. */
function returnedForkResult(status: StripePaymentIntentStatus): StripePaymentIntentResult {
  return {
    id: 'pi_thrown_1',
    status,
    clientSecret: 'pi_thrown_1_secret_abc',
    amountCents: 12_500,
  };
}

/** What the THROWN fork produces: the returning fork's shape PLUS the two
 *  fields only a thrown error can carry. Since 2026-08-11 the forks are
 *  deliberately not byte-identical — the thrown one knows which failure
 *  happened, and erasing that is the defect this file now pins. */
function thrownForkResult(
  status: StripePaymentIntentStatus,
  over: Partial<StripePaymentIntentResult> = {},
): StripePaymentIntentResult {
  return {
    ...returnedForkResult(status),
    blocker: 'declined',
    failureCode: 'card_declined',
    ...over,
  };
}

// ── Row 1: card error + attached non-succeeded intent → normalized result ──
//
// The only row that CHANGES behavior. All three blocker-bearing statuses are
// walked because each one renders a different owner-facing sentence.

for (const status of ['requires_payment_method', 'requires_action', 'processing'] as const) {
  test(`normalizeThrownConfirmError: card error carrying a ${status} intent → the returning fork's fields, plus the code`, () => {
    const result = normalizeThrownConfirmError(cardErrorWithIntent(attachedIntent(status)));
    assert.deepEqual(result, thrownForkResult(status));
  });
}

test('normalizeThrownConfirmError: canceled and requires_confirmation also normalize', () => {
  // Not statuses a confirm is documented to attach, but the blocker table maps
  // them, so the seam must not be the thing that drops them.
  assert.equal(
    normalizeThrownConfirmError(cardErrorWithIntent(attachedIntent('canceled'))).status,
    'canceled',
  );
  assert.equal(
    normalizeThrownConfirmError(cardErrorWithIntent(attachedIntent('requires_confirmation')))
      .status,
    'requires_confirmation',
  );
});

test('normalizeThrownConfirmError: a null client_secret normalizes to null, not a crash', () => {
  const result = normalizeThrownConfirmError(
    cardErrorWithIntent(attachedIntent('requires_payment_method', { client_secret: null })),
  );
  assert.equal(result.clientSecret, null);
});

// ── Row 2: attached intent SUCCEEDED → throw (an error path may never settle) ──

test('normalizeThrownConfirmError: card error carrying a SUCCEEDED intent → throws', () => {
  assert.throws(
    () => normalizeThrownConfirmError(cardErrorWithIntent(attachedIntent('succeeded'))),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(
        /SUCCEEDED PaymentIntent/.test(err.message),
        `anomaly must be named in the message, got: ${err.message}`,
      );
      // A plain Error → an honest 500. Rethrowing the Stripe error would carry
      // its statusCode 402 into the envelope under code 'internal'.
      assert.ok(!(err instanceof Stripe.errors.StripeError));
      return true;
    },
  );
});

// ── Row 3: card error with no / unreadable attached intent → throw ──

test('normalizeThrownConfirmError: card error with NO attached intent → throws', () => {
  const err = new Stripe.errors.StripeCardError({
    type: 'card_error',
    code: 'card_declined',
    message: 'Your card was declined.',
    statusCode: 402,
  } as never);
  assert.throws(() => normalizeThrownConfirmError(err), /no readable PaymentIntent/);
});

test('normalizeThrownConfirmError: attached intent with an UNKNOWN status → throws', () => {
  // A future Stripe status must not be smuggled through as a domain outcome —
  // the blocker switch downstream is exhaustive over the statuses we model.
  assert.throws(
    () =>
      normalizeThrownConfirmError(
        cardErrorWithIntent(attachedIntent('requires_payment_method', { status: 'requires_alien' })),
      ),
    /no readable PaymentIntent/,
  );
});

test('normalizeThrownConfirmError: attached intent with no id → throws', () => {
  assert.throws(
    () =>
      normalizeThrownConfirmError(
        cardErrorWithIntent(attachedIntent('requires_payment_method', { id: '' })),
      ),
    /no readable PaymentIntent/,
  );
});

// ── Rows 4/5: every NON-card error rethrows the ORIGINAL object, untouched ──
//
// This is the row that protects an outage from being narrated as a decline.
// Identity (`thrown === err`) is asserted, not just the class: a wrapper would
// lose `statusCode` / `requestId` and change what the error mapper does.

const NON_CARD_ERRORS: ReadonlyArray<[string, Error]> = [
  ['StripeConnectionError', new Stripe.errors.StripeConnectionError({ message: 'network' })],
  ['StripeAPIError', new Stripe.errors.StripeAPIError({ message: 'api' })],
  ['StripeRateLimitError', new Stripe.errors.StripeRateLimitError({ message: 'slow down' })],
  [
    'StripeAuthenticationError',
    new Stripe.errors.StripeAuthenticationError({ message: 'bad key' }),
  ],
  [
    'StripeInvalidRequestError (same-key-changed-params)',
    new Stripe.errors.StripeInvalidRequestError({
      message: 'Keys for idempotent requests can only be used with the same parameters',
      statusCode: 400,
    }),
  ],
  ['StripeIdempotencyError', new Stripe.errors.StripeIdempotencyError({ message: 'idem' })],
  ['a plain Error', new Error('something else entirely')],
];

for (const [label, err] of NON_CARD_ERRORS) {
  test(`normalizeThrownConfirmError: ${label} rethrows the SAME object, untouched`, () => {
    let thrown: unknown;
    try {
      normalizeThrownConfirmError(err);
      assert.fail('expected a rethrow');
    } catch (caught) {
      thrown = caught;
    }
    assert.equal(thrown, err, 'a non-card error must never be relabelled a decline');
  });
}

test('normalizeThrownConfirmError: a non-card error carrying a payment_intent STILL rethrows', () => {
  // Discrimination is by error CLASS. An API error that happens to echo an
  // intent is still "we do not know whether money moved".
  const err = new Stripe.errors.StripeAPIError({
    message: 'api',
    payment_intent: attachedIntent('requires_payment_method'),
  } as never);
  assert.throws(
    () => normalizeThrownConfirmError(err),
    (caught: unknown) => caught === err,
  );
});

// ── The SDK client actually CALLS the normalizer ──────────────────────────
//
// Everything above tests the normalizer as a function, and every route test
// reaches it through the contract-test stub. Neither touches
// `defaultStripeClient.createAndConfirmPaymentIntent` — the ONE implementation
// production runs — so deleting its try/catch would leave the whole suite green
// while every real decline went back to 500ing. These three pin it.
//
// `stripeSingleton` is module-private by design, but stripe-node builds every
// client's resources from one shared prototype (verified by the third test
// below, which reaches the real mapping through the same seam), so mocking
// `create` there reaches the singleton without exporting it.

function mockPaymentIntentsCreate(
  t: TestContext,
  impl: () => Promise<unknown>,
): void {
  const paymentIntentsPrototype = Object.getPrototypeOf(
    new Stripe('sk_test_seam').paymentIntents,
  ) as { create: (...a: unknown[]) => Promise<unknown> };
  t.mock.method(paymentIntentsPrototype, 'create', impl);
}

const CONFIRM_ARGS = {
  amountCents: 12_500,
  currency: 'usd',
  customerId: 'cus_seam',
  paymentMethodId: 'pm_seam',
  metadata: {},
} as const;

test('defaultStripeClient.createAndConfirmPaymentIntent: a THROWN card error RESOLVES to the normalized result', async (t) => {
  mockPaymentIntentsCreate(t, () =>
    Promise.reject(cardErrorWithIntent(attachedIntent('requires_payment_method'))),
  );

  // Resolves — per the `StripeClient` contract, a card-level failure is a
  // result, not an exception. This is the assertion that goes red if the
  // try/catch at the seam is ever removed.
  const result = await defaultStripeClient.createAndConfirmPaymentIntent(
    CONFIRM_ARGS,
    'idem-seam-card',
  );
  assert.deepEqual(result, thrownForkResult('requires_payment_method'));
  // And the pin that goes red if a future refactor normalizes inside the client
  // but drops the new fields on the floor — which is exactly the shape of the
  // bug this whole change exists to undo, one layer down.
  assert.equal(result.blocker, 'declined', 'the ONE production implementation must carry it');
  assert.equal(result.failureCode, 'card_declined');
});

test('defaultStripeClient.createAndConfirmPaymentIntent: a transport error REJECTS with the same object', async (t) => {
  const transport = new Stripe.errors.StripeConnectionError({ message: 'cannot reach Stripe' });
  mockPaymentIntentsCreate(t, () => Promise.reject(transport));

  await assert.rejects(
    defaultStripeClient.createAndConfirmPaymentIntent(CONFIRM_ARGS, 'idem-seam-net'),
    (err: unknown) => err === transport,
  );
});

test('defaultStripeClient.createAndConfirmPaymentIntent: the RETURNING fork maps unchanged', async (t) => {
  // Also proves the mock is wired to the singleton at all — without this, the
  // two tests above could pass against a seam that never ran.
  mockPaymentIntentsCreate(t, () =>
    Promise.resolve({
      id: 'pi_thrown_1',
      status: 'requires_payment_method',
      client_secret: 'pi_thrown_1_secret_abc',
      amount: 12_500,
    }),
  );

  // Exactly the returning-fork shape — no `blocker`, no `failureCode`. There is
  // no code to read on this fork, and inventing one from the status is the
  // original defect running backwards.
  assert.deepEqual(
    await defaultStripeClient.createAndConfirmPaymentIntent(CONFIRM_ARGS, 'idem-seam-ok'),
    returnedForkResult('requires_payment_method'),
  );
});

// ──────────────────────────────────────────────────────────────────────────
// RECORDED STRIPE — the rows that would have caught the 2026-08-11 defect
//
// Everything above builds its own errors. Everything below replays errors live
// Stripe actually threw. The difference is not stylistic: the defect fixed here
// lived for eight days inside a green suite precisely because no hand-built
// error contained the shape Stripe sends.
// ──────────────────────────────────────────────────────────────────────────

test('recorded fixture: the recording is loadable and names its provenance', () => {
  // If this file were missing or truncated, every test below would throw at
  // import rather than pass vacuously — but say the date out loud anyway, so a
  // reader knows how old the evidence is.
  assert.match(RECORDED_AT, /^\d{4}-\d{2}-\d{2}T/);
  const auth = recordedScenario('authentication-required');
  const declined = recordedScenario('saved-card-declined');
  // Pin the TOKEN we asked for, and assert the card is whatever Stripe said it
  // charged. These are pinned separately on purpose: an earlier version of this
  // fixture labelled the 3DS scenario with the PAN Stripe's docs advertise
  // (4000002500003155) while the token had actually resolved to a card ending
  // 3184 — a hand-chosen field, wrong, inside the one file whose claim is that
  // no human chose its contents.
  assert.equal(auth.paymentMethodToken, 'pm_card_authenticationRequired');
  assert.equal(declined.paymentMethodToken, 'pm_card_chargeCustomerFail');
  assert.match(auth.card, /^visa ••\d{4} \([A-Z]{2}\)$/);
  assert.match(declined.card, /^visa ••\d{4} \([A-Z]{2}\)$/);
  // THE observation the whole design rests on: two DIFFERENT failures rest at
  // the SAME status. If this ever stops being true, the precedence rule below
  // is solving a problem that no longer exists and should be re-examined.
  assert.equal(auth.error.payment_intent.status, 'requires_payment_method');
  assert.equal(declined.error.payment_intent.status, 'requires_payment_method');
  assert.equal(auth.error.code, 'authentication_required');
  assert.equal(declined.error.code, 'card_declined');
});

test('KEYSTONE — a RECORDED off-session 3DS failure derives authentication_required, not declined', () => {
  // The one test that fails against the pre-fix code. Before this change the
  // chain below produced 'declined', and mobile rendered "try a different card"
  // for a card that would work with verification. The probe printed exactly
  // this input; nothing about it is imagined.
  const { log, warns } = capturingLogger();
  const result = normalizeThrownConfirmError(rebuildRecordedCardError('authentication-required'));

  assert.equal(result.status, 'requires_payment_method', 'the RESTING status, as Stripe sends it');
  assert.equal(result.failureCode, 'authentication_required');
  assert.equal(result.blocker, 'authentication_required', 'the seam must carry the code across');
  assert.equal(chargeBlockerForConfirm(result, log), 'authentication_required');
  assert.deepEqual(warns, [], 'a mapped code is not an anomaly — nothing to warn about');
});

test('the other direction: a RECORDED decline stays declined (the inversion would be worse)', () => {
  // The mirror of the keystone. Relabelling genuine declines as "needs
  // verification" would be worse than the bug being fixed — same status, so
  // only the code keeps these two apart.
  const { log, warns } = capturingLogger();
  const result = normalizeThrownConfirmError(rebuildRecordedCardError('saved-card-declined'));

  assert.equal(result.status, 'requires_payment_method');
  assert.equal(result.failureCode, 'card_declined');
  assert.equal(result.blocker, 'declined');
  assert.equal(chargeBlockerForConfirm(result, log), 'declined');
  assert.deepEqual(warns, []);
});

test('the recorded pair are distinguishable ONLY by code — the status cannot tell them apart', () => {
  // Stated as an executable claim rather than a comment, because it is the
  // entire justification for the precedence rule. If a future Stripe made the
  // statuses differ, this goes red and the design gets revisited.
  const auth = normalizeThrownConfirmError(rebuildRecordedCardError('authentication-required'));
  const declined = normalizeThrownConfirmError(rebuildRecordedCardError('saved-card-declined'));

  assert.equal(auth.status, declined.status, 'identical resting status');
  assert.notEqual(auth.failureCode, declined.failureCode, 'only the code differs');
  assert.notEqual(auth.blocker, declined.blocker, 'and the owner reads two different sentences');
});

// ── The precedence rule and its one carve-out ─────────────────────────────

test('chargeBlockerForConfirm: an UNMAPPED code falls back to the status AND warns', () => {
  // HAND-BUILT from the recorded intent: `expired_card` is Stripe-documented
  // but has never been observed on this path, and a speculative row in a
  // money-path map is how a wrong observation gets invented. Fallback gives the
  // right owner ACTION ("try a different card"); the warn is how we would learn
  // to map it for real.
  const { log, warns } = capturingLogger();
  const result = normalizeThrownConfirmError(
    cardErrorWithIntent(recordedScenario('saved-card-declined').error.payment_intent, 'expired_card'),
  );

  assert.equal(result.blocker, undefined, 'unmapped codes must not invent a blocker');
  assert.equal(result.failureCode, 'expired_card', 'but the raw code is carried for the log');
  assert.equal(chargeBlockerForConfirm(result, log), 'declined');
  assert.equal(warns.length, 1, 'an unmapped code on a money path is never silent');
  assert.match(warns[0]!.msg, /unmapped code/);
  assert.equal(warns[0]!.obj.code, 'expired_card');
});

test('chargeBlockerForConfirm: a code NEVER overrides a processing status (the double-charge shield)', () => {
  // HAND-BUILT counterfactual — a card error means the attempt failed,
  // `processing` means it may not have, so Stripe should never send this pair.
  // When evidence contradicts itself on a money path we take the money-safe
  // reading: `declined` copy says "try a different card", and trying again
  // against in-flight money is the reachable double charge.
  const { log, warns } = capturingLogger();
  const result = normalizeThrownConfirmError(cardErrorWithIntent(attachedIntent('processing')));

  assert.equal(result.blocker, 'declined', 'the seam still reports what the code said');
  assert.equal(
    chargeBlockerForConfirm(result, log),
    'processing',
    'the status wins — this is the only arm where the wrong copy costs real money',
  );
  assert.equal(warns.length, 1, 'contradictory evidence on a money path is never silent');
  assert.match(warns[0]!.msg, /contradicts an in-flight status/);
});

test('chargeBlockerForConfirm: the carve-out covers the anomalous requires_capture too', () => {
  // HAND-BUILT. `requires_capture` maps to `processing` because the money may be
  // authorized and in flight; the shield follows the MAPPED value, not the raw
  // status, so it covers this without a second rule.
  const { log, warns } = capturingLogger();
  const result = normalizeThrownConfirmError(
    cardErrorWithIntent(attachedIntent('requires_capture'), 'authentication_required'),
  );

  assert.equal(result.blocker, 'authentication_required');
  assert.equal(chargeBlockerForConfirm(result, log), 'processing');
  // Two warnings: the anomalous-status one that predates this change, and the
  // contradiction one. Both matter; neither replaces the other.
  assert.equal(warns.length, 2);
  assert.ok(warns.some((w) => /requires_capture/.test(w.msg)));
  assert.ok(warns.some((w) => /contradicts an in-flight status/.test(w.msg)));
});

test('chargeBlockerForConfirm: a code AGREEING with a processing status warns about nothing', () => {
  // The carve-out shields; it does not accuse. A `processing` blocker on a
  // `processing` status is not a contradiction.
  const { log, warns } = capturingLogger();
  assert.equal(
    chargeBlockerForConfirm(
      { status: 'processing', blocker: 'processing', failureCode: 'processing_error' },
      log,
    ),
    'processing',
  );
  assert.deepEqual(warns, []);
});

// ── The RETURNING fork must not regress ───────────────────────────────────

test('chargeBlockerForConfirm: the returning fork still derives from status alone', () => {
  const { log, warns } = capturingLogger();
  // Full results via `returnedForkResult`, never a bare `{ status }`:
  // `chargeBlockerForConfirm` takes the whole `StripePaymentIntentResult` on
  // purpose, so that a caller cannot hand it a hand-built status and derive
  // from that alone. `test/` is in no tsconfig, so nothing here would catch the
  // shortcut — these use the real shape so they cannot assert against one that
  // cannot occur.
  assert.equal(
    chargeBlockerForConfirm(returnedForkResult('requires_action'), log),
    'authentication_required',
    'the pre-existing status mapping is preserved verbatim',
  );
  assert.equal(
    chargeBlockerForConfirm(returnedForkResult('requires_payment_method'), log),
    'declined',
  );
  assert.equal(chargeBlockerForConfirm(returnedForkResult('processing'), log), 'processing');
  assert.equal(chargeBlockerForConfirm(returnedForkResult('canceled'), log), 'declined');
  assert.deepEqual(warns, [], 'none of those four are anomalies');
});

test('the returning fork READS an unknown Stripe status as processing, not as nothing', () => {
  // The fork that was never a trust boundary. `status` used to be an `as` cast,
  // so a status Stripe adds later fell off the end of both exhaustive switches
  // and produced `undefined` at RUNTIME: the wire-required `charge_status` went
  // missing and `charges.status` silently took its DDL default — a mis-typed
  // money row. Stripe has added statuses before.
  //
  // The safe reading is `processing`, never `declined`: an unrecognized status
  // does not tell us the money stopped, and `processing` is the one blocker
  // that refuses a retry. Wrongly cautious costs a wait; wrongly confident
  // costs a second charge.
  const { log, errors } = capturingLogger();
  // Run the REAL normalizer over a Stripe-shaped intent carrying a status this
  // codebase does not model. Nothing here is hand-built except Stripe's own
  // payload — the assertion is on what production code does with it.
  const carried = normalizeReturnedConfirm({
    id: 'pi_unknown',
    status: 'partially_funded',
    client_secret: null,
    amount: 4500,
  } as unknown as Stripe.PaymentIntent);

  assert.equal(carried.status, 'processing', 'unknown status is read as in-flight');
  assert.equal(carried.unknownStatus, 'partially_funded', 'the raw value is carried for the log');
  assert.equal(chargeBlockerForConfirm(carried, log), 'processing');
  assert.equal(errors.length, 1, 'an unmodelled status on a money path is logged loudly');
  assert.match(String(errors[0]), /UNKNOWN PaymentIntent status/);
});

test('the returning fork leaves a KNOWN status exactly as it was', () => {
  // The guard must not become a rewrite: every modelled status passes through
  // untouched and carries no `unknownStatus`, or the alarm above would fire on
  // ordinary traffic and stop meaning anything.
  for (const status of [
    'succeeded',
    'processing',
    'requires_payment_method',
    'requires_action',
    'canceled',
    'requires_confirmation',
    'requires_capture',
  ] as const) {
    const out = normalizeReturnedConfirm({
      id: 'pi_known',
      status,
      client_secret: null,
      amount: 4500,
    } as unknown as Stripe.PaymentIntent);
    assert.equal(out.status, status);
    assert.equal(out.unknownStatus, undefined, `${status} is modelled and must not be flagged`);
  }
});

test('chargeBlockerForConfirm: a SUCCEEDED confirm has no blocker, on either fork', () => {
  const { log, warns } = capturingLogger();
  assert.equal(chargeBlockerForConfirm(returnedForkResult('succeeded'), log), undefined);
  // Even if a code somehow rode along, `succeeded` means nothing blocked it —
  // an error path may never be allowed to describe a settlement.
  assert.equal(
    chargeBlockerForConfirm(
      { status: 'succeeded', blocker: 'declined', failureCode: 'card_declined' },
      log,
    ),
    undefined,
  );
  assert.deepEqual(warns, []);
});

test('normalizeThrownConfirmError: an INHERITED object key is not a blocker', () => {
  // HAND-BUILT, and unreachable in practice — Stripe would have to send
  // `code: 'toString'`. It is here because the code map is a plain object, so a
  // bare index finds Object.prototype's keys: without the `Object.hasOwn`
  // guard, `blocker` becomes a FUNCTION that TypeScript believes is a
  // `ChargeBlocker`, and it would be serialized onto a money response. Same
  // trust-boundary discipline as `isPaymentIntentStatus`.
  const { log } = capturingLogger();
  for (const inherited of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) {
    const result = normalizeThrownConfirmError(
      cardErrorWithIntent(attachedIntent('requires_payment_method'), inherited),
    );
    assert.equal(result.blocker, undefined, `${inherited} must not resolve to a blocker`);
    assert.equal(chargeBlockerForConfirm(result, log), 'declined', `${inherited} falls back`);
  }
});

test('normalizeThrownConfirmError: a card error with NO code carries neither new field', () => {
  // HAND-BUILT. Defensive: `err.code` is optional on the SDK type. Absent code
  // means we fall back to the status with nothing to warn about — there is no
  // unmapped code, there is no code.
  const { log, warns } = capturingLogger();
  const err = new Stripe.errors.StripeCardError({
    type: 'card_error',
    message: 'Your card was declined.',
    statusCode: 402,
    payment_intent: attachedIntent('requires_payment_method'),
  } as never);
  const result = normalizeThrownConfirmError(err);

  assert.deepEqual(result, returnedForkResult('requires_payment_method'));
  assert.equal(chargeBlockerForConfirm(result, log), 'declined');
  assert.deepEqual(warns, [], 'no code is not the same event as an unrecognized code');
});
