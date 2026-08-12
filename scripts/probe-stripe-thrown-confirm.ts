/**
 * Live probe for THE unverified assumption in the wire-1.9.0 seam
 * (`npm run probe:stripe`). Follows `smoke-r2.mjs`: it talks to the REAL
 * Stripe API, in TEST MODE ONLY, and reports rather than asserts.
 *
 * WHAT IS ACTUALLY IN QUESTION
 *
 * `normalizeThrownConfirmError` (src/lib/stripe.ts) reads the failed
 * PaymentIntent off `err.payment_intent` when an off-session confirm THROWS a
 * card error. That is pinned against `stripe@22.1.1` — but every test that
 * covers it (`test/stripeSeam.test.ts:33`) CONSTRUCTS the error object itself:
 *
 *     payment_intent: intent,          // ← our object, not Stripe's
 *
 * So the suite proves we read the field correctly. It cannot prove Stripe
 * populates it. If live Stripe does not, the seam throws "Stripe card error
 * carried no readable PaymentIntent" on the FIRST real decline in production —
 * a 500 on a money path, on the exact arm built to give owners a specific
 * sentence instead of a generic one.
 *
 * WHAT THIS RUNS
 *
 * The production call shape verbatim — `paymentIntents.create` with
 * `confirm: true, off_session: true` against a customer-attached card, which is
 * what every settle site does. Two cards, both named in the 2026-08-03 handoff:
 *
 *   · pm_card_chargeDeclined        (4000000000000002) — expected to THROW
 *   · pm_card_authenticationRequired (4000002500003155) — expected to RETURN
 *                                    `requires_action`, exercising the other fork
 *
 * For each it reports which fork Stripe took, and — on the throwing fork —
 * whether `err.payment_intent` is present and readable, then feeds the REAL
 * error to the REAL `normalizeThrownConfirmError` and prints what it produced.
 *
 * WHAT IT ALSO DOES, SINCE 2026-08-11 (`designs/charge-blocker-lost-at-the-seam.md`)
 *
 * The first run of this probe found a second defect: the 3DS card ALSO throws
 * off-session, with `code=authentication_required`, and the PaymentIntent it
 * carries rests at `requires_payment_method` — so the seam, which discarded
 * `err.code`, made "needs verification" indistinguishable from "declined". The
 * fix reads the code; this probe is the only executable evidence that the code
 * Stripe actually sends is the one the fix reads. Three additions:
 *
 *   1. `--record` writes `test/fixtures/stripe-thrown-confirm.json` from the
 *      live run, so the unit suite replays a RECORDED Stripe error instead of
 *      a hand-built one. Hand-building the error is how the original defect
 *      survived a green suite: the test constructed the very field it asserted.
 *   2. Every run COMPARES live Stripe to that committed fixture and exits
 *      non-zero on drift. Honest about its own reach: this alarm only rings
 *      when a human runs the probe — nothing in `npm run gate` calls Stripe,
 *      so the suite proves conformance to the RECORDING, and only a probe run
 *      re-verifies the recording.
 *   3. It prints `chargeBlockerForConfirm → <blocker>` per scenario — the
 *      end-to-end check of the fix against real Stripe. Expected:
 *      `authentication_required` for 4000002500003155, `declined` for
 *      4000000000000341. Anything else and the fix is not doing its job.
 *
 * SAFETY
 *
 *   · Aborts unless STRIPE_SECRET_KEY starts with `sk_test_`.
 *   · Never prints the key, or any part of it.
 *   · Creates one throwaway customer, then deletes it (which detaches its
 *     payment methods). Declined/uncaptured intents cost nothing and cannot be
 *     deleted via the API; they are left behind, which is normal for test mode.
 *   · Every `client_secret` is scrubbed out of the recorded fixture, at any
 *     depth — a committed file is a published file.
 *
 * Exits 0 if the probe RAN and matched the fixture; non-zero if it could not
 * run, if the seam mishandled a real error, or if live Stripe has drifted from
 * the recording. Read the output — a green exit here means "we now know", not
 * "everything is fine".
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyBaseLogger } from 'fastify';
import Stripe from 'stripe';
import { env } from '../src/env.js';
import { chargeBlockerForConfirm, normalizeThrownConfirmError } from '../src/lib/stripe.js';

const TEST_KEY_PREFIX = 'sk_test_';
const PROBE_AMOUNT_CENTS = 4500;

const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'test',
  'fixtures',
  'stripe-thrown-confirm.json',
);

/** Scenario keys are the fixture's keys and the stub's
 *  `setNextIntentThrowsRecorded` argument — keep the three in step. */
type ScenarioKey = 'saved-card-declined' | 'authentication-required';

type Scenario = {
  /** `null` for the control, which is expected to SUCCEED and so has no thrown
   *  error to record. Only throwing scenarios appear in the fixture. */
  key: ScenarioKey | null;
  label: string;
  cardNumber: string;
  paymentMethodId: string;
  expectation: string;
};

const SCENARIOS: Scenario[] = [
  {
    // The realistic decline for THIS codebase. `pm_card_chargeDeclined`
    // (4000000000000002) is declined by Stripe at ATTACH time, so it can never
    // reach an off-session confirm — no card on file in this product is one the
    // owner could not save. 4000000000000341 is Stripe's card for exactly this
    // shape: attaching to a Customer succeeds, later charges fail. That is what
    // a real saved card going bad looks like.
    key: 'saved-card-declined',
    label: 'saved card, later declined',
    cardNumber: '4000000000000341',
    paymentMethodId: 'pm_card_chargeCustomerFail',
    expectation: 'THROW a StripeCardError carrying the failed PaymentIntent',
  },
  {
    // Off-session means there is no one present to challenge, so Stripe reports
    // authentication_required as an ERROR rather than handing back an intent to
    // challenge on — the second way this seam gets exercised in production.
    key: 'authentication-required',
    label: '3DS / authentication required',
    cardNumber: '4000002500003155',
    paymentMethodId: 'pm_card_authenticationRequired',
    expectation: 'THROW authentication_required off-session (no one to challenge)',
  },
  {
    // Control. If this does not settle cleanly, the probe itself is wrong and
    // nothing else it printed can be trusted.
    key: null,
    label: 'control — a card that works',
    cardNumber: '4242424242424242',
    paymentMethodId: 'pm_card_visa',
    expectation: 'RETURN succeeded',
  },
];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * The card Stripe reports having actually charged, as `brand ••last4 (COUNTRY)`.
 * `undefined` when the error carries no payment-method detail. Read off the
 * recording rather than the scenario so the fixture cannot claim a card that
 * was never used — the canned test tokens do not always resolve to the PAN the
 * docs advertise.
 */
function describeRecordedCard(err: unknown): string | undefined {
  if (!isRecord(err)) return undefined;
  const intent = err.payment_intent;
  if (!isRecord(intent)) return undefined;
  const lastErr = intent.last_payment_error;
  if (!isRecord(lastErr)) return undefined;
  const pm = lastErr.payment_method;
  if (!isRecord(pm)) return undefined;
  const card = pm.card;
  if (!isRecord(card)) return undefined;
  const brand = typeof card.brand === 'string' ? card.brand : 'card';
  const last4 = typeof card.last4 === 'string' ? card.last4 : '????';
  const country = typeof card.country === 'string' ? card.country : '??';
  return `${brand} ••${last4} (${country})`;
}

function describeAttachedIntent(err: unknown): string {
  if (!isRecord(err)) return 'error is not an object';
  const attached = err.payment_intent;
  if (attached === undefined) return 'ABSENT — err.payment_intent is undefined';
  if (!isRecord(attached)) return `present but not an object (${typeof attached})`;
  const id = typeof attached.id === 'string' ? attached.id : '(no id)';
  const status = typeof attached.status === 'string' ? attached.status : '(no status)';
  const secret = typeof attached.client_secret === 'string' ? 'present' : 'absent';
  const amount = typeof attached.amount === 'number' ? String(attached.amount) : '(no amount)';
  return `PRESENT — id=${id} status=${status} amount=${amount} client_secret=${secret}`;
}

// ── Recording + drift alarm ───────────────────────────────────────────────
//
// The recorded shape is deliberately the RAW error body, not the normalized
// result: the tests rebuild a real `Stripe.errors.StripeCardError` from it and
// run the PRODUCTION normalizer over it. Recording the normalized result would
// re-introduce exactly the circularity this replaces — a test asserting the
// output of the thing under test.

const SCRUBBED = '<scrubbed by probe --record>';

/**
 * A client secret wherever it appears — as a `client_secret` KEY, or embedded
 * in a string value. Matching the key alone is not enough: a `requires_action`
 * intent carries the secret as a query parameter inside
 * `next_action.redirect_to_url.url`, so the first person to record that
 * scenario would commit it verbatim under a comment promising otherwise.
 * Stripe's format is `<intent id>_secret_<random>`.
 */
const CLIENT_SECRET_IN_VALUE = /\b(pi|seti)_[A-Za-z0-9]+_secret_[A-Za-z0-9-]+/g;

/** Deep copy with every client secret replaced, at any depth, by key OR by
 *  value shape. A committed fixture is a published file; a test-mode secret is
 *  still a secret. */
function scrubSecrets(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(CLIENT_SECRET_IN_VALUE, SCRUBBED);
  if (Array.isArray(value)) return value.map(scrubSecrets);
  if (!isRecord(value)) return value;
  // `Object.create(null)`: writing arbitrary Stripe keys onto a `{}` literal is
  // the same inherited-key hazard `Object.hasOwn` guards in `src/lib/stripe.ts`
  // — a `__proto__` key would mutate the prototype instead of being copied.
  const out = Object.create(null) as Record<string, unknown>;
  for (const [k, v] of Object.entries(value)) {
    out[k] = k === 'client_secret' && typeof v === 'string' ? SCRUBBED : scrubSecrets(v);
  }
  return { ...out };
}

/**
 * The raw error BODY, as it must be handed back to
 * `new Stripe.errors.StripeCardError(raw)` to rebuild the same object. `type`
 * is therefore `err.rawType` (`'card_error'` — the wire value Stripe sent), NOT
 * `err.type`, which the SDK overwrites with its own class name. Recording the
 * class name here and feeding it back as `raw.type` would rebuild an error that
 * disagrees with Stripe about what Stripe said — a small lie, in the one file
 * whose entire purpose is not lying about what Stripe said.
 */
interface RecordedError {
  type: unknown;
  /** `err.type` — the SDK's class name. Informational; the tests assert the
   *  rebuilt object is a `StripeCardError` by `instanceof`, not by this. */
  sdkErrorClass: unknown;
  code: unknown;
  decline_code: unknown;
  message: unknown;
  statusCode: unknown;
  payment_intent: unknown;
}

interface RecordedScenario {
  /** The canned Stripe test token the probe attached — what we ASKED for. */
  paymentMethodToken: string;
  /** The card Stripe reports having actually charged, read back off the
   *  recording. Not the scenario's documented PAN: the two disagree for
   *  `pm_card_authenticationRequired`. */
  card: string;
  /** What `chargeBlockerForConfirm` produced from this error at record time —
   *  in the drift signature, so a regression in the fix fails the probe too. */
  derivedBlocker: string;
  error: RecordedError;
}

interface Recording {
  recordedAt: string;
  stripeSdkVersion: string;
  note: string;
  scenarios: Partial<Record<ScenarioKey, RecordedScenario>>;
}

/**
 * The stable slice of a recording — what must NOT change between runs. The full
 * `payment_intent` is recorded (the tests need it) but cannot be compared: ids,
 * timestamps and the customer differ every run. What the seam actually depends
 * on is here, and nothing else, so the alarm rings for meaning and not for noise.
 */
function driftSignature(scenario: RecordedScenario): string {
  const pi = isRecord(scenario.error.payment_intent) ? scenario.error.payment_intent : undefined;
  return JSON.stringify({
    card: scenario.card,
    type: scenario.error.type,
    sdkErrorClass: scenario.error.sdkErrorClass,
    code: scenario.error.code,
    decline_code: scenario.error.decline_code,
    intentPresent: pi !== undefined,
    intentStatus: pi?.status,
    hasIntentId: typeof pi?.id === 'string',
    hasAmount: typeof pi?.amount === 'number',
    hasClientSecret: typeof pi?.client_secret === 'string',
    derivedBlocker: scenario.derivedBlocker,
  });
}

function readFixture(): Recording | undefined {
  if (!fs.existsSync(FIXTURE_PATH)) return undefined;
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf-8')) as Recording;
}

/**
 * A console-backed `FastifyBaseLogger` so the probe can call the production
 * derivation with the production signature. Only `warn` prints — the unmapped-
 * code and carve-out warnings are exactly what a human running this wants to
 * see; everything else would bury them.
 */
function probeLogger(): FastifyBaseLogger {
  const noop = (): void => {};
  const logger = {
    level: 'warn',
    silent: noop,
    fatal: noop,
    error: noop,
    info: noop,
    debug: noop,
    trace: noop,
    warn: (obj: unknown, msg?: string): void => {
      console.log(`   log.warn: ${msg ?? ''} ${JSON.stringify(obj)}`);
    },
    child: (): unknown => logger,
  };
  return logger as unknown as FastifyBaseLogger;
}

async function main(): Promise<void> {
  const key = env.STRIPE_SECRET_KEY;
  if (!key.startsWith(TEST_KEY_PREFIX)) {
    // Never echo the key. The prefix is the only thing worth saying out loud.
    throw new Error(
      `REFUSING TO RUN: STRIPE_SECRET_KEY does not start with "${TEST_KEY_PREFIX}". ` +
        'This probe issues real declines and must never touch a live account.',
    );
  }

  const recording = process.argv.includes('--record');
  const committed = readFixture();
  const log = probeLogger();
  const observed: Partial<Record<ScenarioKey, RecordedScenario>> = {};

  const stripe = new Stripe(key);
  console.log('probe:stripe — live Stripe, TEST MODE');
  console.log(`  stripe sdk: ${Stripe.PACKAGE_VERSION}`);
  console.log(`  question:   does a thrown card error carry err.payment_intent AND err.code?`);
  console.log(
    `  fixture:    ${committed === undefined ? 'ABSENT' : `recorded ${committed.recordedAt}`}` +
      `${recording ? '  (--record: this run will REWRITE it)' : ''}`,
  );
  console.log(
    '  NOTE: the fixture-staleness alarm only rings when a HUMAN runs this. Nothing in\n' +
      '        `npm run gate` calls Stripe, so the suite proves conformance to the RECORDING;\n' +
      '        only this command re-verifies the recording against Stripe itself.\n',
  );

  const customer = await stripe.customers.create({
    name: 'wire-1.9.0 seam probe',
    metadata: { purpose: 'probe-stripe-thrown-confirm', delete_me: 'true' },
  });
  console.log(`  throwaway customer: ${customer.id}\n`);

  let sawThrowingFork = false;
  let seamHandledIt = false;

  try {
    for (const scenario of SCENARIOS) {
      console.log(`── ${scenario.label} (${scenario.cardNumber}) ──`);
      console.log(`   expected: ${scenario.expectation}`);

      try {
        await stripe.paymentMethods.attach(scenario.paymentMethodId, { customer: customer.id });
      } catch (attachErr) {
        // Informative, not fatal: a card Stripe refuses to SAVE never becomes a
        // card on file, so it cannot reach the confirm seam at all.
        const msg = attachErr instanceof Error ? attachErr.message : String(attachErr);
        console.log(`   ACTUAL:   declined at ATTACH — ${msg}`);
        console.log('   (never reaches the confirm seam; not the arm under test)\n');
        continue;
      }

      try {
        // The production shape, verbatim (src/lib/stripe.ts
        // `createAndConfirmPaymentIntent`). `off_session: true` is load-bearing:
        // it is what makes Stripe treat an unauthenticated card as an error
        // rather than handing back a client secret to challenge on.
        const intent = await stripe.paymentIntents.create({
          amount: PROBE_AMOUNT_CENTS,
          currency: 'usd',
          customer: customer.id,
          payment_method: scenario.paymentMethodId,
          confirm: true,
          off_session: true,
          metadata: { purpose: 'probe-stripe-thrown-confirm' },
        });
        console.log(`   ACTUAL:   RETURNED — id=${intent.id} status=${intent.status}`);
      } catch (err) {
        sawThrowingFork = true;
        const isCardError = err instanceof Stripe.errors.StripeCardError;
        const cls = err instanceof Error ? err.constructor.name : typeof err;
        const code = isRecord(err) && typeof err.code === 'string' ? err.code : '(no code)';
        console.log(`   ACTUAL:   THREW — ${cls} code=${code}`);
        console.log(`   is StripeCardError: ${isCardError}  ← the seam's discriminator`);
        console.log(`   err.payment_intent: ${describeAttachedIntent(err)}`);

        // The real question: does the REAL production function survive a REAL error?
        try {
          const normalized = normalizeThrownConfirmError(err);
          seamHandledIt = true;
          console.log(
            `   normalizeThrownConfirmError → id=${normalized.id} status=${normalized.status} ` +
              `amountCents=${normalized.amountCents} clientSecret=${
                normalized.clientSecret === null ? 'null' : 'present'
              } blocker=${normalized.blocker ?? '(none)'} failureCode=${
                normalized.failureCode ?? '(none)'
              }`,
          );
          // THE end-to-end line: what an owner's copy is selected from, computed
          // by the production derivation off a real Stripe error. This is the
          // only executable evidence for the 2026-08-11 fix that touches Stripe.
          const derived = chargeBlockerForConfirm(normalized, log);
          console.log(`   chargeBlockerForConfirm → ${derived ?? '(none — succeeded)'}`);
          console.log('   VERDICT: the seam holds against a real Stripe error.');

          if (scenario.key !== null && isRecord(err)) {
            observed[scenario.key] = {
              // What Stripe SAYS it charged, never what we asked for. The
              // scenario's `cardNumber` is the documented PAN behind a canned
              // token, and for `pm_card_authenticationRequired` the two do not
              // match — the token resolves to a card ending 3184 (DE), not the
              // 4000002500003155 the docs name. A file whose whole claim is
              // "no human chose these contents" must not carry a human-chosen
              // field that is wrong, so this is read back off the recording.
              paymentMethodToken: scenario.paymentMethodId,
              card: describeRecordedCard(err) ?? `(unrecorded; requested ${scenario.cardNumber})`,
              derivedBlocker: derived ?? '(none)',
              error: {
                type: err.rawType,
                sdkErrorClass: err.type,
                code: err.code,
                decline_code: err.decline_code,
                message: err.message,
                statusCode: err.statusCode,
                payment_intent: scrubSecrets(err.payment_intent),
              },
            };
          }
        } catch (seamErr) {
          const msg = seamErr instanceof Error ? seamErr.message : String(seamErr);
          console.log(`   VERDICT: *** THE SEAM FAILED *** — ${msg}`);
          console.log('   This would be a 500 on a real decline. The assumption is WRONG.');
          process.exitCode = 1;
        }
      }
      console.log('');
    }
  } finally {
    await stripe.customers.del(customer.id);
    console.log(`  cleaned up customer ${customer.id} (detaches its payment methods)\n`);
  }

  if (!sawThrowingFork) {
    console.log(
      'NOTE: neither card threw. The normalization path was never exercised, so this run ' +
        'says nothing about it — the assumption remains unverified, not confirmed.',
    );
  } else if (seamHandledIt) {
    console.log('RESULT: a real off-session decline DOES carry a readable PaymentIntent.\n');
  }

  // ── fixture: record, or compare ────────────────────────────────────────
  const observedKeys = Object.keys(observed) as ScenarioKey[];
  if (recording) {
    if (observedKeys.length === 0) {
      console.log('--record: nothing threw, so there is nothing to record. Fixture untouched.');
      process.exitCode = 1;
      return;
    }
    const next: Recording = {
      recordedAt: new Date().toISOString(),
      stripeSdkVersion: Stripe.PACKAGE_VERSION,
      note:
        'Machine-recorded by `npm run probe:stripe -- --record` from LIVE Stripe test mode. ' +
        'Never hand-edit: the point of this file is that no human chose its contents. ' +
        'client_secret is scrubbed at every depth. Re-record with the same command.',
      scenarios: observed,
    };
    fs.mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true });
    fs.writeFileSync(FIXTURE_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
    console.log(`--record: wrote ${observedKeys.length} scenario(s) to ${FIXTURE_PATH}`);
    return;
  }

  if (committed === undefined) {
    console.log(
      `NO FIXTURE at ${FIXTURE_PATH}. The unit suite replays a recording of this probe; ` +
        'without one it has nothing to replay. Run `npm run probe:stripe -- --record`.',
    );
    process.exitCode = 1;
    return;
  }

  let drifted = false;
  for (const scenarioKey of observedKeys) {
    const live = observed[scenarioKey];
    const fixed = committed.scenarios[scenarioKey];
    if (live === undefined) continue;
    if (fixed === undefined) {
      console.log(`DRIFT: scenario '${scenarioKey}' threw live but is missing from the fixture.`);
      drifted = true;
      continue;
    }
    const liveSig = driftSignature(live);
    const fixedSig = driftSignature(fixed);
    if (liveSig === fixedSig) {
      console.log(`fixture OK: '${scenarioKey}' matches the recording.`);
      continue;
    }
    console.log(`DRIFT: '${scenarioKey}' no longer matches the recording.`);
    console.log(`  recorded: ${fixedSig}`);
    console.log(`  live:     ${liveSig}`);
    drifted = true;
  }
  for (const scenarioKey of Object.keys(committed.scenarios) as ScenarioKey[]) {
    if (!observedKeys.includes(scenarioKey)) {
      console.log(`DRIFT: scenario '${scenarioKey}' is in the fixture but did not throw live.`);
      drifted = true;
    }
  }
  if (drifted) {
    console.log(
      '\nThe recording the test suite replays no longer describes Stripe. Every green ' +
        'seam test is now proving conformance to history. Re-record and re-read the ' +
        'blocker mapping before trusting the suite again.',
    );
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
