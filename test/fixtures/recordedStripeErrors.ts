import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Stripe from 'stripe';

/**
 * The bridge from RECORDED Stripe to the test suite.
 *
 * WHY THIS EXISTS. Until 2026-08-11 every test of the thrown-confirm seam
 * CONSTRUCTED the `StripeCardError` it then asserted against
 * (`test/stripeSeam.test.ts` built `code: 'card_declined'` by hand). That suite
 * could only ever prove we read the fields we invented — and it stayed green
 * through a live defect where Stripe's real off-session 3DS failure arrives as
 * `code=authentication_required` with the attached intent already reset to
 * `requires_payment_method`. Nobody imagined that shape, so no test contained
 * it. A device-QA pass then "confirmed" the arm in mock mode. Two instruments,
 * both measuring their own assumptions.
 *
 * The countermeasure is provenance, not more assertions. The chain is:
 *
 *     live Stripe → `npm run probe:stripe -- --record` → the committed JSON
 *                 → this module → the tests
 *
 * and the probe re-compares live Stripe to the JSON on every run, exiting
 * non-zero on drift.
 *
 * HONEST LABEL, so nothing here reads as more than it is: the fixture is a
 * snapshot of Stripe TEST MODE on its recording date. These tests prove
 * conformance to the recording. Only re-running the probe re-verifies the
 * recording, and live-mode behavior is UNVERIFIED and assumed symmetric. That
 * residual is irreducible without network tests in the gate.
 *
 * Counterfactual shapes — no attached intent, a succeeded attached intent, an
 * unknown status, a `processing` intent under a card error — CANNOT be recorded,
 * because they are refusals of shapes Stripe should never send. Those stay
 * hand-built and are labelled as such at each use.
 */

const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'stripe-thrown-confirm.json',
);

/** The recorded scenarios. Keep in step with `scripts/probe-stripe-thrown-confirm.ts`. */
export type RecordedScenarioKey = 'saved-card-declined' | 'authentication-required';

export interface RecordedScenario {
  /** The canned Stripe test token the probe attached — what was ASKED for. */
  paymentMethodToken: string;
  /** The card Stripe reports having actually charged (`brand ••last4 (CC)`),
   *  read off the recording. Not the token's documented PAN — for
   *  `pm_card_authenticationRequired` the two disagree. */
  card: string;
  /** What `chargeBlockerForConfirm` produced at record time, against real Stripe. */
  derivedBlocker: string;
  error: {
    /** The RAW body's `type` (`'card_error'`) — what Stripe sent, not the SDK class name. */
    type: string;
    sdkErrorClass: string;
    code: string;
    decline_code: string;
    message: string;
    statusCode: number;
    payment_intent: Record<string, unknown>;
  };
}

interface Recording {
  recordedAt: string;
  stripeSdkVersion: string;
  note: string;
  scenarios: Partial<Record<RecordedScenarioKey, RecordedScenario>>;
}

function loadRecording(): Recording {
  if (!fs.existsSync(FIXTURE_PATH)) {
    // Loud, not skipped. A missing recording must never let the seam tests pass
    // by quietly testing nothing — that is the failure mode this file replaces.
    throw new Error(
      `No recorded Stripe fixture at ${FIXTURE_PATH}. These tests replay a recording of ` +
        'live Stripe; without it they prove nothing. Run `npm run probe:stripe -- --record`.',
    );
  }
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf-8')) as Recording;
}

const recording = loadRecording();

/** When live Stripe was last recorded — printed by tests that want to say so. */
export const RECORDED_AT = recording.recordedAt;

export function recordedScenario(key: RecordedScenarioKey): RecordedScenario {
  const scenario = recording.scenarios[key];
  if (scenario === undefined) {
    throw new Error(
      `Recorded Stripe fixture has no '${key}' scenario (recorded ${recording.recordedAt}). ` +
        'Re-record with `npm run probe:stripe -- --record`.',
    );
  }
  return scenario;
}

/**
 * Rebuild the REAL `Stripe.errors.StripeCardError` Stripe threw, from the
 * recording. The raw body is handed to the SDK's own constructor, so the object
 * under test is built by the same code path production sees — `instanceof`
 * discrimination, `err.code`, `err.payment_intent` and all.
 *
 * `intentOverrides` exists for the route-level stub, which must make the
 * recorded intent's `id` / `amount` match the call being simulated; it is not a
 * license to edit the recorded FAILURE (`code`, `status`, `decline_code`), which
 * is the part that carries the evidence.
 */
export function rebuildRecordedCardError(
  key: RecordedScenarioKey,
  intentOverrides: Record<string, unknown> = {},
): Stripe.errors.StripeCardError {
  const scenario = recordedScenario(key);
  const err = new Stripe.errors.StripeCardError({
    type: scenario.error.type,
    code: scenario.error.code,
    decline_code: scenario.error.decline_code,
    message: scenario.error.message,
    statusCode: scenario.error.statusCode,
    payment_intent: { ...scenario.error.payment_intent, ...intentOverrides },
  } as never);
  // Cheap self-check: if a future SDK stops populating these off the raw body,
  // every test downstream would assert against an empty object and pass for the
  // wrong reason. Fail here instead, where the cause is readable.
  if (err.code !== scenario.error.code || err.payment_intent === undefined) {
    throw new Error(
      `stripe@${Stripe.PACKAGE_VERSION} no longer copies code/payment_intent off the raw ` +
        `error body — the recorded fixture cannot be rebuilt (scenario '${key}').`,
    );
  }
  return err;
}
