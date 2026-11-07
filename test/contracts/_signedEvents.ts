import Stripe from 'stripe';
import { randomUUID } from 'node:crypto';
import { env } from '../../src/env.js';
import { defaultStripeClient } from '../../src/lib/stripe.js';
import type { StripeClient } from '../../src/lib/stripe.js';

/**
 * A `payment_intent.*` event as Stripe delivers it: real bytes, a real signature over
 * them, verified and projected by the production `constructWebhookEvent`. Local: it signs
 * with the webhook secret and calls nothing.
 */
export interface SignedEvent {
  id: string;
  payload: string;
  signature: string;
}

export function signedIntentEvent(args: {
  type: 'payment_intent.succeeded' | 'payment_intent.payment_failed' | 'payment_intent.canceled';
  intentId: string;
  amountCents: number;
  metadata: Record<string, string>;
  id?: string;
}): SignedEvent {
  const id = args.id ?? `evt_test_${randomUUID().slice(0, 12)}`;
  const payload = JSON.stringify({
    id,
    object: 'event',
    type: args.type,
    data: {
      object: {
        id: args.intentId,
        object: 'payment_intent',
        amount: args.amountCents,
        metadata: args.metadata,
      },
    },
  });
  return {
    id,
    payload,
    signature: Stripe.webhooks.generateTestHeaderString({
      payload,
      secret: env.STRIPE_WEBHOOK_SECRET,
    }),
  };
}

/** A stub that verifies signatures for real: every other verb stays the stub's. */
export function verifyingSignatures<T extends StripeClient>(stub: T): T {
  stub.constructWebhookEvent = defaultStripeClient.constructWebhookEvent;
  return stub;
}
