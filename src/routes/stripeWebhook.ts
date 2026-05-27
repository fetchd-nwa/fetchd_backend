import type { FastifyInstance } from 'fastify';
import { ApiError } from '../lib/errors.js';
import { defaultStripeClient, type StripeClient } from '../lib/stripe.js';
import { stripeEventsRepository } from '../db/repositories/stripeEventsRepository.js';
import { dispatchStripeEvent } from '../webhooks/stripeEventHandlers.js';

export interface StripeWebhookOpts {
  /** Stripe seam. Contract tests inject `_stripeStub.ts`. */
  stripe?: StripeClient;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Raw request body — preserved only inside the Stripe webhook scope for HMAC. */
    rawBody?: string;
  }
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * `POST /webhooks/stripe` `[public, signed]` — Stripe event receiver.
 *
 * Registered in its own Fastify scope (`app.register(...)`) so the raw-
 * body content-type parser applies to *this route only* — every other
 * route keeps Fastify's default JSON parsing. Same pattern as
 * `routes/authWebhook.ts` (Day-2 Supabase auth hook).
 *
 * Dispatch lifecycle (claim → dispatch → mark/release):
 *   1. Read & verify `Stripe-Signature` against `STRIPE_WEBHOOK_SECRET`.
 *      Invalid → 400 (ApiError maps it). Stripe stops retrying on 4xx,
 *      so signature failure is permanent — exactly what we want.
 *   2. `stripeEventsRepository.claim(eventId, type)`. Insert-on-conflict
 *      makes this race-safe: duplicate delivery returns 'duplicate'
 *      without running the handler. 200 OK either way.
 *   3. Dispatch the event handler (per-event tx scoped by `withActor`).
 *   4. On success: `markProcessed(eventId)` (sets `processed_at`).
 *      On failure: `release(eventId)` (DELETE so Stripe's next retry
 *      re-enters dispatch) + re-throw → 500 → Stripe retries.
 *
 * Dispatch errors don't leak to the response body — Fastify maps the
 * re-thrown error to 500 via the route's existing ApiError mapper; the
 * log line carries the event id + type for ops to grep.
 */
export function registerStripeWebhookRoute(
  app: FastifyInstance,
  opts: StripeWebhookOpts = {},
): void {
  const stripe = opts.stripe ?? defaultStripeClient;

  app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
      request.rawBody = typeof body === 'string' ? body : body.toString('utf8');
      try {
        done(null, JSON.parse(request.rawBody));
      } catch {
        // Signature verification needs the raw body even when the JSON
        // is malformed — but signature is verified first in the handler,
        // so a non-JSON body falls through to 400 here cleanly.
        done(new Error('invalid JSON body'), undefined);
      }
    });

    scope.post('/webhooks/stripe', async (request, reply) => {
      const event = stripe.constructWebhookEvent(
        request.rawBody ?? '',
        firstHeader(request.headers['stripe-signature']),
      );

      const claim = await stripeEventsRepository.claim(event.id, event.type);
      if (claim === 'duplicate') {
        // Stripe redelivered an event we already saw. The first delivery
        // either succeeded (processed_at set) or is in-flight elsewhere
        // (processed_at null) — either way returning 200 stops the
        // retry storm. Log differentiates the two cases for ops.
        const state = await stripeEventsRepository.findProcessedState(event.id);
        request.log.info(
          {
            stripeEventId: event.id,
            stripeEventType: event.type,
            processedAt: state?.processedAt ?? null,
            outcome: state?.processedAt ? 'duplicate-processed' : 'duplicate-inflight',
          },
          'stripe webhook duplicate event',
        );
        return reply.code(200).send({ ok: true, outcome: 'duplicate' });
      }

      try {
        const result = await dispatchStripeEvent(event, { stripe });
        await stripeEventsRepository.markProcessed(event.id);
        request.log.info(
          {
            stripeEventId: event.id,
            stripeEventType: event.type,
            outcome: result.outcome,
            note: result.note,
          },
          'stripe webhook processed',
        );
        return reply.code(200).send({ ok: true, outcome: result.outcome });
      } catch (err) {
        // Dispatcher failed — release the claim so Stripe's retry
        // re-enters this code path. ApiError 4xx errors (the receiver
        // rejecting a malformed event) DON'T trigger retry from Stripe,
        // so we also release on those for consistency: same dispatch
        // logic on next inbound delivery.
        await stripeEventsRepository.release(event.id).catch((releaseErr) => {
          request.log.error(
            { stripeEventId: event.id, releaseErr },
            'stripe webhook release failed after dispatcher error',
          );
        });
        if (err instanceof ApiError) {
          throw err;
        }
        // Re-throw so Fastify's error handler logs + 500s. Stripe retries
        // on any non-2xx response.
        throw err;
      }
    });
  });
}
