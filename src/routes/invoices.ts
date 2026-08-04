import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import { deepLinkToPath, type InvoicePayWire } from '../contracts/wire.js';
import { db } from '../db/client.js';
import { bucketToChicagoDate } from '../lib/chicagoDate.js';
import { peekCompletedIdempotency } from '../db/idempotency.js';
import { hashRequestBody, requireIdempotencyKey, withMutation } from '../db/mutation.js';
import { bookingsRepository } from '../db/repositories/bookingsRepository.js';
import { chargesRepository } from '../db/repositories/chargesRepository.js';
import {
  invoicesRepository,
  repointPaymentMethod,
  type InvoiceRow,
} from '../db/repositories/invoicesRepository.js';
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
  stripeIntentStatusToChargeBlocker,
  stripeIntentStatusToChargeStatus,
  type StripeClient,
} from '../lib/stripe.js';
import { formatZodIssues } from '../lib/zodIssues.js';

/**
 * `POST /invoices/:id/pay` `[auth, $]` — pay-later settlement.
 *
 * Owner pays an open invoice with the card they chose at settle time
 * (`payment_method_id` in the body, wire 1.7.0), falling back to the invoice's
 * bound `payment_method_id` when the body omits one. The shape mirrors Day-14's
 * `POST /credit-packages/:key/purchase`:
 *
 *   1. Pre-validate the invoice (owned, open, payment method live).
 *   2. Stripe `paymentIntents.create + confirm` pre-tx (idempotency-keyed).
 *   3. `withMutation` opens the audit-stamped tx:
 *      - INSERT `charges` row mirroring Stripe status.
 *      - On Stripe 'succeeded': `invoices.markPaid` flips the invoice
 *        to 'paid' + links the charge id.
 *      - Non-succeeded (3DS / requires_action / declined): the intent is
 *        CANCELLED pre-tx (wire 1.7.1) and the charge row is written at
 *        its non-succeeded status; the invoice stays open for the next
 *        attempt, which mints a fresh intent.
 *
 * The webhook does NOT currently re-settle the invoice for the async
 * path (only the charge flips). That caveat survives the cancel rule
 * only for the rare `processing` intent Stripe won't let us cancel: it
 * can still flip to succeeded via webhook with the invoice left open.
 * The synchronous path (test mode + stored non-3DS card) settles
 * atomically.
 */

export interface InvoicesRouteOptions extends AuthRouteOptions {
  /** Stripe seam (Day 14). Contract tests inject a stub. */
  stripe?: StripeClient;
}

const idParamSchema = z.object({ id: z.string().uuid('id must be a UUID') });

/**
 * `POST /invoices/:id/pay` body (wire 1.7.0). Every field optional and the whole
 * body optional — a bodyless POST is the pre-1.7.0 call and still means "charge
 * the invoice's bound card".
 *
 * `.strict()` so an unknown key is a 400 rather than silently ignored: the bug
 * this endpoint is fixing was precisely a client sending a card the server threw
 * away, and failing loudly is what stops the next version of that.
 */
const paySchema = z
  .object({ payment_method_id: z.string().uuid('payment_method_id must be a UUID').optional() })
  .strict();

/**
 * Parse the optional pay body. `undefined`/null/empty body → no card chosen.
 *
 * Returned as `{ payment_method_id?: string }` (key ABSENT rather than set to
 * `undefined`) so the idempotency hash of a bodyless call is byte-identical to
 * the pre-1.7.0 `hashRequestBody({ id })` — canonical JSON drops undefined
 * values, so either spelling hashes the same, but keeping the key absent makes
 * that property obvious instead of incidental.
 */
function parsePayBody(body: unknown): { payment_method_id?: string } {
  if (body === undefined || body === null) return {};
  const parsed = paySchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError('invalid_payload', `invalid body: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data.payment_method_id === undefined
    ? {}
    : { payment_method_id: parsed.data.payment_method_id };
}

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
      // Parse BEFORE the peek: the peek and `withMutation` must agree on the
      // hash, and since 1.7.0 the chosen card is part of it. Two calls naming
      // different cards now hash differently — under the old
      // `hashRequestBody({ id })` they collided, so the second replayed the
      // first's response and the owner was told a card was charged that wasn't.
      const payBody = parsePayBody(request.body);
      const requestHash = hashRequestBody({ id, ...payBody });

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

      // The card the owner picked at settle time wins over the invoice's bound
      // one (wire 1.7.0); omitting it keeps the bound card. `loadStripePaymentContext`
      // IS the ownership check — it resolves through
      // `paymentMethodsRepository.findLiveByIdForOwner` and throws 404 for a card
      // that isn't a live card of THIS owner, so a chosen card needs no second,
      // driftable check of its own.
      const chargingPaymentMethodId = payBody.payment_method_id ?? invoiceRow.paymentMethodId;
      const stripeCtx = await loadStripePaymentContext({
        ownerId: principal.ownerId,
        paymentMethodId: chargingPaymentMethodId,
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
        // Deliberately NOT keyed by the chosen card. Since 1.7.0 the peek above
        // already 422s a same-key-different-card retry, so the only way to reach
        // Stripe twice under one key with two cards is a first attempt that
        // called Stripe and then rolled back without persisting its idempotency
        // row. Stripe rejects the reused key with changed params, and that loud
        // error is the outcome we want: the alternative — folding the card into
        // this key — would make the retry a SECOND capture on top of the first
        // attempt's orphaned charge. Failing beats charging twice.
        `${idempotencyKey}:payment-intent`,
      );
      const chargeStatus = stripeIntentStatusToChargeStatus(intent.status);
      // Why it stopped, in domain vocabulary — derived from the RAW Stripe
      // status, which is only in hand HERE: the line above collapses five of
      // them into `requires_payment`, and the copy the owner reads depends on
      // exactly that distinction (wire 1.8.0). Pre-tx so the anomalous-status
      // warnings inside fire once per real confirm, not once per replay.
      const chargeBlocker =
        intent.status === 'succeeded'
          ? undefined
          : stripeIntentStatusToChargeBlocker(intent.status, request.log);

      // Non-succeeded confirm: cancel the intent so it can't later auto-succeed
      // and double-charge against the next attempt's fresh one — the same rule
      // and the same reason as the auto-charge worker's cancel
      // (`invoiceAutoCharge.ts`). It applies here too because no client-side 3DS
      // completion flow exists anywhere in this system, so a live intent buys
      // nothing to weigh against that hazard; wire 1.7.1 documents
      // `client_secret` as naming a CANCELLED intent on this arm.
      //
      // PRE-TX deliberately: no Stripe call may run inside `withMutation`'s
      // transaction. Best-effort — an intent Stripe refuses to cancel (a rare
      // `processing`) is covered by Stripe's changed-params rejection on the
      // next same-key attempt, and by the duplicate-settle refund on a
      // fresh-key one.
      if (chargeStatus !== 'succeeded') {
        try {
          await stripe.cancelPaymentIntent(intent.id);
        } catch (err) {
          request.log.warn(
            { err, invoiceId: invoiceRow.id, paymentIntentId: intent.id },
            'invoice pay: could not cancel unsettled PaymentIntent (best-effort)',
          );
        }
      }

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
          // 3DS / async path: Stripe didn't settle synchronously, and the intent
          // was cancelled above. INSERT the charge at its non-succeeded status
          // as audit trail (R32 keeps it out of the owner ledger) and leave the
          // invoice open for the owner's next /pay attempt. No race to resolve —
          // nothing was actually captured.
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
                charge_blocker: chargeBlocker,
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
          } else if (chargingPaymentMethodId !== invoiceRow.paymentMethodId) {
            // Clean win on a card the owner PICKED over the bound one: repoint
            // the invoice at what actually paid it, in the same tx that settled
            // it. `LedgerEntryWire.settled_card` is derived from
            // `invoices.payment_method_id` (the `charges` row stores no card),
            // so without this the receipt would name a card that was never
            // charged. Same lever, same reason as the expired-card auto-charge
            // fallback.
            //
            // Deliberately NOT on the two other branches: on 'refunded' another
            // path settled this invoice and its bound card must keep naming
            // whatever THAT charged; on the 3DS path nothing was captured and
            // the invoice stays open, so repointing would hand the auto-charge
            // worker a card the owner never successfully paid with.
            await repointPaymentMethod(tx, {
              id: invoiceRow.id,
              paymentMethodId: chargingPaymentMethodId,
            });
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
          )} ${dropOffPhrase(scheduledFor, anchor.at)}.`,
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
 * How the reminder should refer to the drop-off, derived from the gap between
 * when it FIRES and the drop-off it is about — both bucketed to America/Chicago
 * calendar days, the convention the capacity count and the vaccine gate already
 * use for "which day is this on".
 *
 * Deliberately NOT a hardcoded "tomorrow" (Allison 2026-07-31 raised the lead to
 * 24h so the push lands the day before). At a 24h lead the clamp in
 * `paymentDueReminderAt` is the COMMON case, not the edge: most invoices are
 * flagged in-person less than a day before the drop-off they bill, so the
 * reminder fires immediately and the drop-off is TODAY. Wording it "tomorrow"
 * unconditionally would be wrong for exactly those, and a reminder that names
 * the wrong day is worse than one that names no day.
 *
 * The neutral fallback also covers the invoice flagged after its own drop-off,
 * where no day-word is true.
 */
function dropOffPhrase(scheduledFor: Date, anchorAt: Date): string {
  const fireDay = bucketToChicagoDate(scheduledFor);
  const dropDay = bucketToChicagoDate(anchorAt);
  if (dropDay === fireDay) return 'when you drop off today';
  if (dropDay === chicagoDayAfter(fireDay)) return 'when you drop off tomorrow';
  return 'when you drop off';
}

/** The calendar day after `day` (YYYY-MM-DD). Pure date arithmetic on the
 *  already-bucketed Chicago day — anchored at UTC midnight so no DST shift can
 *  move it, because the value is a calendar label, not an instant. */
function chicagoDayAfter(day: string): string {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, date! + 1)).toISOString().slice(0, 10);
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
