import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import { deepLinkToPath } from '../contracts/wire.js';
import { db } from '../db/client.js';
import { peekCompletedIdempotency } from '../db/idempotency.js';
import { hashRequestBody, requireIdempotencyKey, withMutation } from '../db/mutation.js';
import { bookingsRepository } from '../db/repositories/bookingsRepository.js';
import { chargesRepository, type ChargeStatus } from '../db/repositories/chargesRepository.js';
import { invoicesRepository, type InvoiceRow } from '../db/repositories/invoicesRepository.js';
import { ledgerRepository } from '../db/repositories/ledgerRepository.js';
import { refundsRepository } from '../db/repositories/refundsRepository.js';
import { scheduledNotificationsRepository } from '../db/repositories/scheduledNotificationsRepository.js';
import type { Tx } from '../db/tx.js';
import { toLedgerEntryWire, type LedgerEntryWire } from '../lib/ledgerWire.js';
import { ApiError } from '../lib/errors.js';
import { formatDollars, purposeLabel } from '../lib/invoiceReceiptCopy.js';
import { loadStripePaymentContext } from '../lib/loadStripePaymentContext.js';
import { pgTimestampToDate } from '../lib/pgTimestamp.js';
import { requireOwner } from '../lib/principalNarrows.js';
import { settleInvoiceCharge, type PendingDuplicateRefund } from '../lib/settleInvoiceCharge.js';
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
  /**
   * True when this charge succeeded at Stripe but LOST the settle race against
   * a concurrent worker auto-charge (or webhook) -- the invoice is already
   * `paid` by that path, so this duplicate charge is being refunded post-commit
   * (a 'pending' refund row was written in-tx; Stripe + webhook reconcile it).
   * The owner's card nets exactly one charge. Honest signal so the client
   * never renders "payment complete" for money that's on its way back. False
   * on the clean win and on the 3DS / requires_action path.
   */
  charge_refunded: boolean;
}

const idParamSchema = z.object({ id: z.string().uuid('id must be a UUID') });

export function registerInvoicesRoute(app: FastifyInstance, opts: InvoicesRouteOptions = {}): void {
  const authHook = resolveAuthHook(opts);
  const stripe = opts.stripe ?? defaultStripeClient;

  // `GET /invoices` `[auth]` — the owner's billing ledger (charges + open
  // invoices), newest first. Owner-scoped; a staff principal gets an empty
  // list (the portal uses `/staff/*`), matching the GET /bookings convention.
  app.get('/invoices', { preHandler: [authHook] }, async (request): Promise<LedgerEntryWire[]> => {
    const principal = requirePrincipal(request);
    if (principal.kind !== 'owner') return [];
    const rows = await ledgerRepository.listForOwner(db, principal.ownerId);
    return rows.map(toLedgerEntryWire);
  });

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

      // Closure-captured handle for the post-commit Stripe refund. Set inside
      // the withMutation body ONLY when this succeeded charge LOST the settle
      // race (a concurrent worker auto-charge / webhook flipped the invoice
      // first); read by the postCommit below. Stays undefined on the clean win
      // and on the 3DS / requires_action path (postCommit no-ops).
      let pendingStripeRefund: PendingDuplicateRefund | undefined;

      // ── DB writes (inside withMutation; idempotency-keyed) ──
      const outcome = await withMutation<InvoicePayWire>(
        {
          principal,
          idempotencyKey,
          endpoint: 'POST /invoices/:id/pay',
          requestHash,
          // Invoices aren't cached, but a §J.1 MEMBERSHIP settle grants a
          // credit lot inside `settleInvoiceCharge` — the per-dog credit
          // cache is stale the moment that lands (§3 map: credit_ledger
          // write → credits:{dogId}:* wipe).
          patternsToInvalidate: (body) =>
            body.invoice_status === 'paid' &&
            invoiceRow.purpose === 'membership' &&
            invoiceRow.dogId !== null
              ? [`credits:${invoiceRow.dogId}:*`]
              : [],
          // Post-commit Stripe refund for a lost-race duplicate charge. Fires
          // once per non-replayed outcome; failure is logged + swallowed by the
          // withMutation seam (the 'pending' refund row is the commitment, the
          // webhook reconciles terminal status). Mirrors the cancel route.
          postCommit: async () => {
            if (pendingStripeRefund === undefined) return;
            const refund = await stripe.createRefund(
              {
                paymentIntentId: pendingStripeRefund.paymentIntentId,
                amountCents: pendingStripeRefund.amountCents,
                reason: 'requested_by_customer',
              },
              `${idempotencyKey}:dup-settle-refund`,
            );
            await refundsRepository.markStripeId({
              id: pendingStripeRefund.refundId,
              stripeRefundId: refund.id,
            });
          },
        },
        async (tx) => {
          // 3DS / async path: Stripe didn't settle synchronously. INSERT the
          // charge at its non-succeeded status and leave the invoice open; the
          // webhook (or the owner's next /pay attempt) settles it. No race to
          // resolve — nothing was actually captured yet.
          if (chargeStatus !== 'succeeded') {
            const charge = await chargesRepository.create(tx, {
              ownerId: principal.ownerId,
              amountCents: intent.amountCents,
              status: chargeStatus,
              purpose: invoiceRow.purpose,
              stripePaymentIntentId: intent.id,
              bookingId: invoiceRow.bookingId,
              cohortId: invoiceRow.cohortId,
              dogId: invoiceRow.dogId,
            });
            return {
              status: 201,
              body: {
                charge_id: charge.id,
                charge_status: chargeStatus,
                stripe_payment_intent_id: intent.id,
                client_secret: intent.clientSecret,
                invoice_status: 'open',
                charge_refunded: false,
              },
            };
          }

          // Succeeded path: the shared settle primitive INSERTs the charge,
          // conditionally claims the invoice (open->paid), and on a lost race
          // writes a 'pending' refund row for this duplicate. notifyOwner=false:
          // the owner initiated and gets THIS response — a push receipt would
          // be redundant.
          const settle = await settleInvoiceCharge(tx, {
            invoice: invoiceRow,
            paymentIntentId: intent.id,
            amountCents: intent.amountCents,
            purpose: invoiceRow.purpose,
            notifyOwner: false,
          });

          if (settle.outcome === 'refunded') {
            // Lost the race: the invoice is paid (by the winner) and this
            // duplicate charge is being reversed. Hand the refund to postCommit;
            // the response carries charge_refunded=true so the client never
            // claims a clean payment for money on its way back.
            pendingStripeRefund = settle.pendingStripeRefund;
          }

          return {
            status: 201,
            body: {
              charge_id: settle.chargeId,
              charge_status: 'succeeded',
              stripe_payment_intent_id: intent.id,
              client_secret: intent.clientSecret,
              invoice_status: 'paid',
              charge_refunded: settle.outcome === 'refunded',
            },
          };
        },
      );

      reply.code(outcome.status);
      return outcome.body;
    },
  );

  // `POST /invoices/:id/pay-in-person` `[auth]` — R3 cash/check flag flip.
  //
  // The owner elects to settle this OPEN, card-backed invoice IN PERSON (cash
  // or check at drop-off) rather than on the card. It charges nothing: it flips
  // `payment_expected` → 'in-person' and, in the same tx, schedules a
  // `payment-due` reminder 24h before the linked booking's drop-off (or 24h
  // before the invoice's due time when no booking is linked). Bodyless 204 on
  // success (flag-flip convention, like POST /notifications/:id/read).
  //
  // Choosing in-person is never a one-way door: `POST /invoices/:id/pay` still
  // accepts an in-person invoice (it gates on `status='open'` only), and the
  // settle tears down this reminder — see `settleInvoiceCharge`. That is what
  // backs the app's "pay by card now" option on an already-flagged invoice.
  //
  // Shape mirrors `/pay`: peek for an idempotent replay FIRST (this route flips
  // `payment_expected`, which the pre-validation reads — a replay would 409
  // before the idempotency layer could replay the stored 204), then pre-validate
  // on the pool (a cross-owner id 404s BEFORE any `idempotency_keys` write, so
  // the owner FK never trips), then the mutation tx does the flip + enqueue.
  app.post('/invoices/:id/pay-in-person', { preHandler: [authHook] }, async (request, reply) => {
    const principal = requirePrincipal(request);
    requireOwner(principal, 'pay an invoice in person');
    const { id } = parseIdParam(request.params);
    const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
    const requestHash = hashRequestBody({ id });
    const now = new Date();

    const replay = await peekCompletedIdempotency<null>(
      idempotencyKey,
      'POST /invoices/:id/pay-in-person',
      requestHash,
    );
    if (replay !== undefined) {
      reply.code(replay.status);
      return replay.body;
    }

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
    if (invoiceRow.paymentExpected !== 'card') {
      throw new ApiError('conflict', `invoice ${id} is already flagged pay-in-person`);
    }

    const outcome = await withMutation<null>(
      {
        principal,
        idempotencyKey,
        endpoint: 'POST /invoices/:id/pay-in-person',
        requestHash,
        // cache-noop: only the §3 `credits:{dogId}:*` family is read-through
        // cached, and it's keyed off `credit_ledger` writes. This flips
        // `invoices.payment_expected` (invoices aren't cached) and enqueues a
        // `scheduled_notifications` row (not cached) — no credit grant, so
        // nothing in the cache map goes stale.
      },
      async (tx) => {
        const flipped = await invoicesRepository.markPayInPerson(tx, { id });
        if (flipped === 0) {
          // A concurrent flip won between the pre-check and here — same
          // row-visibility guard the pay route leans on for `markPaid`. Honest 409.
          throw new ApiError('conflict', `invoice ${id} is no longer open + card-backed`);
        }

        // Anchor the reminder PAYMENT_DUE_LEAD_MS before drop-off, clamped to
        // now when that lands in the past (R3) so the worker fires it on the
        // next tick, same convention as booking reminders.
        const anchor = await resolvePaymentDueAnchor(tx, invoiceRow);
        const scheduledFor = paymentDueReminderAt(anchor.at, now);

        await scheduledNotificationsRepository.enqueueIdempotent(tx, {
          ownerId: invoiceRow.ownerId,
          type: 'payment-due',
          trigger: 'payment-due',
          dedupeKey: `payment-due:${id}`,
          scheduledFor,
          title: 'Payment due at drop-off',
          body: `Please bring ${formatDollars(invoiceRow.amountCents)} for your ${purposeLabel(
            invoiceRow.purpose,
          )} when you drop off.`,
          deepLinkPath: deepLinkToPath({ kind: 'invoice', id }),
          deepLinkKind: 'invoice',
          deepLinkId: id,
          ...(anchor.leadDogId !== null ? { dogId: anchor.leadDogId } : {}),
        });

        return { status: 204, body: null };
      },
    );

    reply.code(outcome.status);
    return outcome.body;
  });
}

/**
 * Lead time for the pay-in-person reminder: 24h before the drop-off anchor.
 * (Was 1h through Phase 4c; Allison 2026-07-31 — an hour's notice isn't enough
 * to get to an ATM, a day is.)
 */
const PAYMENT_DUE_LEAD_MS = 24 * 60 * 60 * 1000;

/**
 * When to fire the "bring cash at drop-off" reminder: PAYMENT_DUE_LEAD_MS
 * before the anchor, clamped into `[now, anchor]`.
 *
 * With a 24h lead the clamp is the COMMON case, not the edge — most invoices
 * are created (and flagged in-person) less than a day before the drop-off they
 * bill, so `anchor − 24h` is usually already past. Clamping to `now` makes the
 * worker fire it on its next tick: late notice beats no notice, and a
 * `scheduled_for` in the past would otherwise be indistinguishable from a
 * backlog the worker is behind on.
 *
 * The clamp can only push the reminder PAST the anchor when the anchor itself
 * is already behind us (an invoice flagged after its own drop-off / due date).
 * No instant satisfies both bounds there, so we still fire now: the money is
 * owed either way, and staying silent about it is the worse failure.
 */
function paymentDueReminderAt(anchorAt: Date, now: Date): Date {
  const lead = new Date(anchorAt.getTime() - PAYMENT_DUE_LEAD_MS);
  return lead > now ? lead : now;
}

/**
 * Resolve the payment-due reminder anchor for a cash/check invoice: the linked
 * booking's drop-off (or its `scheduled_at` when the category has no drop-off),
 * else the invoice's own `due_at`. Also surfaces the dog to tag on the
 * notification — the booking's lead dog when linked, otherwise the invoice's
 * `dog_id` (if any). A `booking_id` that no longer resolves (ON DELETE SET NULL
 * race) degrades to the due-date fallback rather than throwing.
 */
async function resolvePaymentDueAnchor(
  tx: Tx,
  invoice: InvoiceRow,
): Promise<{ at: Date; leadDogId: string | null }> {
  if (invoice.bookingId !== null) {
    const booking = await bookingsRepository.findScheduleAnchorById(tx, invoice.bookingId);
    if (booking !== undefined) {
      return {
        at: pgTimestampToDate(booking.dropoffAt ?? booking.scheduledAt),
        leadDogId: booking.leadDogId,
      };
    }
  }
  return { at: pgTimestampToDate(invoice.dueAt), leadDogId: invoice.dogId };
}

function parseIdParam(params: unknown): { id: string } {
  const parsed = idParamSchema.safeParse(params);
  if (!parsed.success) {
    throw new ApiError('bad_request', `invalid path: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}
