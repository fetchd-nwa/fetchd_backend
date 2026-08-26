import type { FastifyInstance } from 'fastify';
import { ApiError } from '../lib/errors.js';
import { defaultStripeClient, type StripeClient } from '../lib/stripe.js';
import { invalidatePattern } from '../lib/cache.js';
import { creditsInvalidationPattern } from '../db/repositories/creditsRepository.js';
import { stripeEventsRepository } from '../db/repositories/stripeEventsRepository.js';
import { firePendingRefundPostCommit } from '../lib/pendingRefund.js';
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
        // Signature verification needs the raw body even when the JSON is
        // malformed, so the parser records `rawBody` before it tries to parse.
        //
        // D20-A4 §A4.2 — the comment that stood here claimed a non-JSON body
        // "falls through to 400 here cleanly". **It did not, and that was
        // proven by execution, not by reading**: a BARE `Error` carries no
        // `statusCode`, so `auth/plugin.ts`'s mapper computed 500 and logged at
        // error — which, since the Day-20 tap, PAGES A HUMAN. An 854-injection
        // sweep across all 178 route entries found exactly four such reachable
        // spots: this route and `/auth/webhook`, on malformed-JSON and
        // empty-body. Sustained, that is 43,200 events/month against a
        // 5,000/month tier — an anonymous `curl` draining in ~3.5 days the same
        // quota the SURPLUS REFUND page spends from.
        //
        // A client's malformed JSON is not our error (the reasoning D20-A2
        // §A2.1(a) applied to `auth/plugin.ts`, simply not carried here).
        // Attaching the status makes the mapper answer 400 and log at warn.
        // Genuine Stripe traffic is unaffected: Stripe does not send malformed
        // JSON, and the signature check runs after parsing regardless.
        done(Object.assign(new Error('invalid JSON body'), { statusCode: 400 }), undefined);
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
        const result = await dispatchStripeEvent(event, { stripe, log: request.log });
        await stripeEventsRepository.markProcessed(event.id);
        // Post-commit Stripe refund when settling an orphaned invoice charge
        // LOST the `markPaid` race — the owner had already paid that invoice, so
        // this PaymentIntent double-bills and its 'pending' refund row is
        // waiting. Fired here, never inside the handler's tx (R5), exactly as
        // the auto-charge worker fires its own; a failure leaves the pending
        // row for retry rather than a silent double charge. This is the second
        // half of "two charges, one refund, no human".
        await firePendingRefundPostCommit({
          pending: result.pendingStripeRefund,
          stripe,
          log: request.log,
          context: { stripeEventId: event.id, stripeEventType: event.type },
        });
        // Post-commit credit-balance cache wipe when the event moved a dog's
        // balance (async purchase grant / payment_failed reversal). Best-effort:
        // the DB is already committed + marked processed, so a Redis blip here
        // must NOT 500 (that would make Stripe redeliver → dedupe → no re-run,
        // leaving the cache to self-heal via TTL either way). Swallow + log,
        // mirroring `withMutation`'s post-commit invalidation policy.
        if (result.creditsDogId !== undefined) {
          await invalidatePattern(creditsInvalidationPattern(result.creditsDogId)).catch(
            (invErr) => {
              request.log.error(
                { stripeEventId: event.id, dogId: result.creditsDogId, invErr },
                'stripe webhook post-commit credits invalidation failed',
              );
            },
          );
        }
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
