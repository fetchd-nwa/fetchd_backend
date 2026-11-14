import Stripe from 'stripe';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
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

// ── P22: the refund events, as the recording has them ───────────────────────

interface RecordedEvent {
  type: string;
  object: Record<string, unknown>;
}

const RECORDING = JSON.parse(
  readFileSync(new URL('../fixtures/stripe-refunds.json', import.meta.url), 'utf8'),
) as Record<'a' | 'b' | 'f', { events: RecordedEvent[] }>;

/** A recorded event object of this type, the template for a signed delivery. */
function recordedObject(type: string): Record<string, unknown> {
  for (const c of ['b', 'a', 'f'] as const) {
    const found = RECORDING[c].events.find((e) => e.type === type);
    if (found !== undefined) return found.object;
  }
  throw new Error(`the recording holds no ${type} event`);
}

function signed(id: string, type: string, object: Record<string, unknown>): SignedEvent {
  const payload = JSON.stringify({ id, object: 'event', type, data: { object } });
  return {
    id,
    payload,
    signature: Stripe.webhooks.generateTestHeaderString({
      payload,
      secret: env.STRIPE_WEBHOOK_SECRET,
    }),
  };
}

/**
 * `charge.refund.updated`, `refund.updated` or `refund.failed` as Stripe sends it: the
 * recording's own refund object (P22, B-1), its ids and figures replaced by this test's.
 * `status` is the EVENT's reading; the arm retrieves the live one.
 */
export function signedRefundEvent(args: {
  type: 'charge.refund.updated' | 'refund.updated' | 'refund.failed';
  refundId: string;
  paymentIntentId: string | null;
  amountCents: number;
  status: string;
  refundRowId?: string;
  id?: string;
}): SignedEvent {
  const object = {
    ...recordedObject(args.type),
    id: args.refundId,
    amount: args.amountCents,
    status: args.status,
    payment_intent: args.paymentIntentId,
    charge: args.paymentIntentId === null ? null : `ch_${args.paymentIntentId.replace(/^pi_/, '')}`,
    metadata: args.refundRowId !== undefined ? { refund_id: args.refundRowId } : {},
  };
  return signed(args.id ?? `evt_test_${randomUUID().slice(0, 12)}`, args.type, object);
}

/** `charge.refunded` as Stripe sends it: the CHARGE object, which lists no refunds. */
export function signedChargeRefundedEvent(args: {
  paymentIntentId: string;
  amountCents: number;
  amountRefundedCents: number;
  id?: string;
}): SignedEvent {
  const object = {
    ...recordedObject('charge.refunded'),
    id: `ch_${args.paymentIntentId.replace(/^pi_/, '')}`,
    amount: args.amountCents,
    amount_refunded: args.amountRefundedCents,
    refunded: args.amountRefundedCents >= args.amountCents,
    payment_intent: args.paymentIntentId,
    metadata: {},
  };
  return signed(args.id ?? `evt_test_${randomUUID().slice(0, 12)}`, 'charge.refunded', object);
}
