import { registerCreditPackagesRoute } from '../../src/routes/creditPackages.js';
import { registerStripeWebhookRoute } from '../../src/routes/stripeWebhook.js';
import { stripeEventsRepository } from '../../src/db/repositories/stripeEventsRepository.js';
import { FIXTURE_OWNER_PRINCIPAL, makeContractApp } from './_harness.js';
import { verifyingSignatures } from './_signedEvents.js';
import { makeStripeStub } from './_stripeStub.js';

/**
 * The process P18's kill tests really kill (`pack-kill.test.ts`). It runs the production
 * route, then sends SIGKILL to its own pid at one exact point, so nothing after that point
 * runs: no `finally`, no rollback handler, no flush. No test double stands in for the
 * death, and the parent sees the exit signal.
 *
 *   `claim`   a webhook: dies after `stripe_events` commits the claim, before the handler.
 *   `answer`  a purchase: dies after Stripe's answer, before the settle. It writes the
 *             intent to stdout first, since the parent's stub must answer for it.
 */
const [mode, a, b, c] = process.argv.slice(2);

function die(): never {
  process.kill(process.pid, 'SIGKILL');
  throw new Error('SIGKILL did not land');
}

if (mode === 'claim') {
  const realClaim = stripeEventsRepository.claim.bind(stripeEventsRepository);
  stripeEventsRepository.claim = async (...args: Parameters<typeof realClaim>) => {
    await realClaim(...args);
    return die();
  };
  const { app } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerStripeWebhookRoute(app, { stripe: verifyingSignatures(makeStripeStub()) });
  await app.inject({
    method: 'POST',
    url: '/webhooks/stripe',
    headers: { 'content-type': 'application/json', 'stripe-signature': b as string },
    payload: a as string,
  });
} else if (mode === 'answer') {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  const stripe = makeStripeStub();
  stripe.afterNextConfirmAnswer(async (answer) => {
    const { amountCents, metadata } = stripe.intentSnapshot(answer.id);
    process.stdout.write(`${JSON.stringify({ id: answer.id, amountCents, metadata })}\n`);
    await new Promise((resolve) => process.stdout.write('', resolve));
    die();
  });
  registerCreditPackagesRoute(app, { authenticate, stripe });
  await app.inject({
    method: 'POST',
    url: `/credit-packages/${a as string}/purchase`,
    headers: { 'idempotency-key': b as string },
    payload: { payment_method_id: c as string },
  });
}
process.stdout.write('SURVIVED\n');
process.exit(0);
