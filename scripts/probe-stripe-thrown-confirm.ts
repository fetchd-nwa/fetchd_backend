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
 * SAFETY
 *
 *   · Aborts unless STRIPE_SECRET_KEY starts with `sk_test_`.
 *   · Never prints the key, or any part of it.
 *   · Creates one throwaway customer, then deletes it (which detaches its
 *     payment methods). Declined/uncaptured intents cost nothing and cannot be
 *     deleted via the API; they are left behind, which is normal for test mode.
 *
 * Exits 0 if the probe RAN (whatever it found), non-zero only if it could not
 * run or the seam mishandled a real error. Read the output — a green exit here
 * means "we now know", not "everything is fine".
 */

import Stripe from 'stripe';
import { env } from '../src/env.js';
import { normalizeThrownConfirmError } from '../src/lib/stripe.js';

const TEST_KEY_PREFIX = 'sk_test_';
const PROBE_AMOUNT_CENTS = 4500;

type Scenario = {
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
    label: 'saved card, later declined',
    cardNumber: '4000000000000341',
    paymentMethodId: 'pm_card_chargeCustomerFail',
    expectation: 'THROW a StripeCardError carrying the failed PaymentIntent',
  },
  {
    // Off-session means there is no one present to challenge, so Stripe reports
    // authentication_required as an ERROR rather than handing back an intent to
    // challenge on — the second way this seam gets exercised in production.
    label: '3DS / authentication required',
    cardNumber: '4000002500003155',
    paymentMethodId: 'pm_card_authenticationRequired',
    expectation: 'THROW authentication_required off-session (no one to challenge)',
  },
  {
    // Control. If this does not settle cleanly, the probe itself is wrong and
    // nothing else it printed can be trusted.
    label: 'control — a card that works',
    cardNumber: '4242424242424242',
    paymentMethodId: 'pm_card_visa',
    expectation: 'RETURN succeeded',
  },
];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
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

async function main(): Promise<void> {
  const key = env.STRIPE_SECRET_KEY;
  if (!key.startsWith(TEST_KEY_PREFIX)) {
    // Never echo the key. The prefix is the only thing worth saying out loud.
    throw new Error(
      `REFUSING TO RUN: STRIPE_SECRET_KEY does not start with "${TEST_KEY_PREFIX}". ` +
        'This probe issues real declines and must never touch a live account.',
    );
  }

  const stripe = new Stripe(key);
  console.log('probe:stripe — live Stripe, TEST MODE');
  console.log(`  stripe sdk: ${Stripe.PACKAGE_VERSION}`);
  console.log(`  question:   does a thrown card error carry err.payment_intent?\n`);

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
              }`,
          );
          console.log('   VERDICT: the seam holds against a real Stripe error.');
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
    console.log('RESULT: a real off-session decline DOES carry a readable PaymentIntent.');
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
