import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import { db } from '../db/client.js';
import { peekCompletedIdempotency } from '../db/idempotency.js';
import { hashRequestBody, requireIdempotencyKey, withMutation } from '../db/mutation.js';
import { chargesRepository, type ChargeStatus } from '../db/repositories/chargesRepository.js';
import { invoicesRepository } from '../db/repositories/invoicesRepository.js';
import { ApiError } from '../lib/errors.js';
import { loadStripePaymentContext } from '../lib/loadStripePaymentContext.js';
import { requireOwner } from '../lib/principalNarrows.js';
import {
  defaultStripeClient,
  stripeIntentStatusToChargeStatus,
  type StripeClient,
} from '../lib/stripe.js';
import { formatZodIssues } from '../lib/zodIssues.js';

/**
 * `POST /invoices/:id/pay` `[auth, $]` — pay-later settlement.
 *
 * Owner pays an open invoice using its bound `payment_method_id`. The
 * shape mirrors Day-14's `POST /credit-packages/:key/purchase`:
 *
 *   1. Pre-validate the invoice (owned, open, payment method live).
 *   2. Stripe `paymentIntents.create + confirm` pre-tx (idempotency-keyed).
 *   3. `withMutation` opens the audit-stamped tx:
 *      - INSERT `charges` row mirroring Stripe status.
 *      - On Stripe 'succeeded': `invoices.markPaid` flips the invoice
 *        to 'paid' + links the charge id.
 *      - 3DS / requires_action paths return `client_secret`; Day-15
 *        webhook's `payment_intent.succeeded` reconciles by flipping
 *        BOTH the charges row AND (TODO: invoice link — needs a
 *        webhook-driven invoice settlement path) once Stripe confirms.
 *
 * The webhook does NOT currently re-settle the invoice for the async
 * path (only the charge flips). That's a known caveat for Day-15: 3DS
 * pay-later flows write `charges` at requires_payment but leave the
 * invoice 'open' until the next /pay attempt. The synchronous path
 * (test mode + stored non-3DS card) settles atomically.
 */

export interface InvoicesRouteOptions extends AuthRouteOptions {
  /** Stripe seam (Day 14). Contract tests inject a stub. */
  stripe?: StripeClient;
}

export interface InvoicePayWire {
  charge_id: string;
  charge_status: ChargeStatus;
  stripe_payment_intent_id: string;
  client_secret: string | null;
  invoice_status: 'open' | 'paid' | 'void';
}

const idParamSchema = z.object({ id: z.string().uuid('id must be a UUID') });

export function registerInvoicesRoute(app: FastifyInstance, opts: InvoicesRouteOptions = {}): void {
  const authHook = resolveAuthHook(opts);
  const stripe = opts.stripe ?? defaultStripeClient;

  app.post(
    '/invoices/:id/pay',
    { preHandler: [authHook] },
    async (request, reply): Promise<InvoicePayWire> => {
      const principal = requirePrincipal(request);
      requireOwner(principal, 'pay an invoice');
      const { id } = parseIdParam(request.params);
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
      const requestHash = hashRequestBody({ id });

      // ── Idempotency replay short-circuit ──
      // The pre-validation below checks `invoice.status === 'open'`, but
      // this route MUTATES that field on success (open → paid). Without
      // the early peek a legitimate replay (same key, original call's
      // 201 already stored) would 409 on the post-paid pre-validation
      // before withIdempotency could replay. Peek first; replay if
      // matched; else continue to pre-validation. The peek throws
      // `idempotency_mismatch` 422 on a key collision with a different
      // body — same boundary semantic as the inside-tx `withIdempotency`.
      const replay = await peekCompletedIdempotency<InvoicePayWire>(
        idempotencyKey,
        'POST /invoices/:id/pay',
        requestHash,
      );
      if (replay !== undefined) {
        reply.code(replay.status);
        return replay.body;
      }

      // ── Pre-Stripe validation (pool reads only) ──
      const invoiceRow = await invoicesRepository.findByIdForOwner(db, {
        id,
        ownerId: principal.ownerId,
      });
      if (invoiceRow === undefined) {
        throw new ApiError('not_found', `invoice ${id} not found`);
      }
      if (invoiceRow.status !== 'open') {
        throw new ApiError('conflict', `invoice ${id} is ${invoiceRow.status}, not open`);
      }

      const stripeCtx = await loadStripePaymentContext({
        ownerId: principal.ownerId,
        paymentMethodId: invoiceRow.paymentMethodId,
      });

      // ── Stripe call (outside tx; idempotency-keyed) ──
      const intent = await stripe.createAndConfirmPaymentIntent(
        {
          customerId: stripeCtx.stripeCustomerId,
          paymentMethodId: stripeCtx.stripePaymentMethodId,
          amountCents: invoiceRow.amountCents,
          currency: 'usd',
          metadata: {
            owner_id: principal.ownerId,
            invoice_id: invoiceRow.id,
            purpose: invoiceRow.purpose,
          },
        },
        `${idempotencyKey}:payment-intent`,
      );
      const chargeStatus = stripeIntentStatusToChargeStatus(intent.status);

      // ── DB writes (inside withMutation; idempotency-keyed) ──
      const outcome = await withMutation<InvoicePayWire>(
        {
          principal,
          idempotencyKey,
          endpoint: 'POST /invoices/:id/pay',
          requestHash,
          // cache-noop — invoices aren't cached today.
        },
        async (tx) => {
          const charge = await chargesRepository.create(tx, {
            ownerId: principal.ownerId,
            amountCents: intent.amountCents,
            status: chargeStatus,
            purpose: invoiceRow.purpose,
            stripePaymentIntentId: intent.id,
            bookingId: invoiceRow.bookingId,
          });

          let invoiceStatus: 'open' | 'paid' | 'void' = 'open';
          if (chargeStatus === 'succeeded') {
            const flipped = await invoicesRepository.markPaid(tx, {
              id: invoiceRow.id,
              paidChargeId: charge.id,
            });
            if (flipped > 0) {
              invoiceStatus = 'paid';
            } else {
              // Race: a concurrent worker auto-charge or webhook already
              // settled the invoice. The charges row still belongs to
              // this request; the invoice is just already-paid.
              invoiceStatus = 'paid';
            }
          }

          return {
            status: 201,
            body: {
              charge_id: charge.id,
              charge_status: chargeStatus,
              stripe_payment_intent_id: intent.id,
              client_secret: intent.clientSecret,
              invoice_status: invoiceStatus,
            },
          };
        },
      );

      reply.code(outcome.status);
      return outcome.body;
    },
  );
}

function parseIdParam(params: unknown): { id: string } {
  const parsed = idParamSchema.safeParse(params);
  if (!parsed.success) {
    throw new ApiError('bad_request', `invalid path: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}
