import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import { actorOf } from '../auth/principal.js';
import {
  deepLinkToPath,
  type ApiErrorEnvelope,
  type InvoiceDeepLinkReason,
  type InvoicePayRequest,
  type InvoicePayWire,
} from '../contracts/wire.js';
import type { Expect, Equal } from '../contracts/typeAsserts.js';
import { db } from '../db/client.js';
import { bucketToChicagoDate } from '../lib/chicagoDate.js';
import { peekCompletedIdempotency, peekEngineClaim } from '../db/idempotency.js';
import { hashRequestBody, requireIdempotencyKey, withMutation } from '../db/mutation.js';
import { bookingsRepository } from '../db/repositories/bookingsRepository.js';
import { invoicesRepository, type InvoiceRow } from '../db/repositories/invoicesRepository.js';
import { ledgerRepository } from '../db/repositories/ledgerRepository.js';
import { ordersRepository } from '../db/repositories/ordersRepository.js';
import { scheduledNotificationsRepository } from '../db/repositories/scheduledNotificationsRepository.js';
import type { Tx } from '../db/tx.js';
import { confirmCharge, type ChargeTerms } from '../lib/confirmCharge.js';
import { toLedgerEntryWire, type LedgerEntryWire } from '../lib/ledgerWire.js';
import { ApiError } from '../lib/errors.js';
import { formatDollars, purposeLabel } from '../lib/invoiceReceiptCopy.js';
import { loadStripePaymentContext } from '../lib/loadStripePaymentContext.js';
import { pgTimestampToDate } from '../lib/pgTimestamp.js';
import { requireOwner } from '../lib/principalNarrows.js';
import { resolveInvoiceAnchorBookingId } from '../lib/settleInvoiceCharge.js';
import { defaultStripeClient, type StripeClient } from '../lib/stripe.js';
import { uuidId } from '../lib/uuidId.js';
import { formatZodIssues } from '../lib/zodIssues.js';

/**
 * `POST /invoices/:id/pay` `[auth, $]` — pay an open invoice, on the order engine
 * (P15, `lib/confirmCharge.ts`; design §2.7:3824-3898, PAY-U05, PAY-U07).
 *
 * The owner pays with the card chosen at settle time (`payment_method_id` in the body,
 * wire 1.7.0), or the invoice's bound card when the body omits one. The route's own
 * work is thin: replay what the key already answered, pre-validate on the pool, and
 * hand the engine its tx1 work with the `'leave-invoice-open'` policy.
 *
 *   1. A stored answer replays, the committed 402 included, and an open claim answers
 *      409 `idempotency_inflight`.
 *   2. Pre-validate the invoice (owned, open, payment method live).
 *   3. {@link confirmCharge}: tx1 claims the key, writes the order, locks the invoice,
 *      refuses 409 `invoice_payment_in_flight` while another order's charge on it is
 *      inside its lease, and writes the one charge. Then Stripe, with no transaction
 *      open. Then the settle.
 *
 * Four answers, whoever settled the order:
 *
 *   - 201 `InvoicePayWire`, `invoice_status: 'paid'`.
 *   - 201 with `charge_status: 'requires_payment'`, `charge_blocker: 'processing'`:
 *     Stripe has not answered, the intent is LIVE, the claim stays open, and the
 *     webhook or the sweeper settles it.
 *   - 402 `payment_failed`: a final decline. It commits: the invoice stays open with
 *     only the failed charge recorded (PAY-36), the 402 is stored, and a replay
 *     returns it and tries no card. The next try takes a fresh key. The request cancels
 *     nothing: the sweeper's watch cancels that intent on a later tick.
 *   - 409 `idempotency_inflight`: nothing is known yet, and a same-key re-send gets the
 *     answer once there is one.
 */

export interface InvoicesRouteOptions extends AuthRouteOptions {
  /** Stripe seam (Day 14). Contract tests inject a stub. */
  stripe?: StripeClient;
  /**
   * Injectable clock (mirrors `BookingsRouteOptions.now`). `pay-in-person`
   * anchors its payment-due reminder relative to "now"; a test that books
   * on a frozen clock has to be able to flag that invoice on the SAME
   * clock, or the reminder's 24h lead clamps against the real calendar and
   * the arithmetic under test disappears. Production passes the real clock.
   */
  now?: () => Date;
}

const idParamSchema = z.object({ id: uuidId('id must be a UUID') });

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
  .object({ payment_method_id: uuidId('payment_method_id must be a UUID').optional() })
  .strict();

/**
 * §5.1.3 Zod ↔ wire pin. Until 1.13.0 `InvoicePayRequest` was dead code
 * server-side — nothing tied the wire's description of this body to the schema
 * that actually validates it, so the two could drift silently on the system's
 * highest-consequence endpoint. This is that tie. `z.input`, not `z.infer`:
 * the wire documents what a client may SEND. If it flips red, the WIRE TYPE is
 * wrong, never the schema (§14.1).
 */
export type InvoicePayBodyConformance = Expect<Equal<z.input<typeof paySchema>, InvoicePayRequest>>;

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
  const nowFactory = opts.now ?? ((): Date => new Date());

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
    async (request, reply): Promise<InvoicePayWire | ApiErrorEnvelope> => {
      const principal = requirePrincipal(request);
      requireOwner(principal, 'pay an invoice');
      const { id } = parseIdParam(request.params);
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
      // Parse BEFORE the peek: the peek and the claim must agree on the hash, and
      // since 1.7.0 the chosen card is part of it. Two calls naming different cards
      // hash differently — under the old `hashRequestBody({ id })` they collided, so
      // the second replayed the first's response and the owner was told a card was
      // charged that wasn't.
      const payBody = parsePayBody(request.body);
      const requestHash = hashRequestBody({ id, ...payBody });
      const endpoint = 'POST /invoices/:id/pay';

      // ── What the key already answers ──
      // The pre-validation below checks `invoice.status === 'open'`, but this route
      // MUTATES that field (open → paid), so without the peek a legitimate replay of
      // a stored 201 would 409 before anything could replay it. A stored 402 replays
      // here too, which is why this body is not only `InvoicePayWire`. A key reused
      // with a different body throws `idempotency_mismatch`; an open claim, 409.
      const replay = await peekEngineClaim<InvoicePayWire | ApiErrorEnvelope>(
        idempotencyKey,
        endpoint,
        requestHash,
        principal.ownerId,
      );
      if (replay !== undefined) {
        reply.code(replay.status);
        return replay.body;
      }

      // ── Pre-validation (pool reads only) ──
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
      if (chargingPaymentMethodId === null) {
        // Reachable from P25, the first writer of a NULL card: M4.04 opened the column.
        throw new ApiError(
          'bad_request',
          `invoice ${id} has no card on it: name one with payment_method_id`,
        );
      }
      const stripeCtx = await loadStripePaymentContext({
        ownerId: principal.ownerId,
        paymentMethodId: chargingPaymentMethodId,
      });

      const result = await confirmCharge<InvoicePayWire>(
        {
          actor: actorOf(principal),
          ownerId: principal.ownerId,
          claim: {
            key: idempotencyKey,
            ownerId: principal.ownerId,
            endpoint,
            requestHash,
          },
          invoiceId: id,
          inTx1: async (tx) => ({
            ...(await holdInvoiceForPayment(tx, { id, at: opts.now?.(), log: request.log })),
            card: { ...stripeCtx, paymentMethodId: chargingPaymentMethodId },
          }),
          stripe,
          log: request.log,
          now: opts.now,
        },
        'leave-invoice-open',
      );

      switch (result.kind) {
        case 'answered':
          reply.code(result.status);
          return result.body;
        case 'processing':
          // Not stored: the claim stays open, so a same-key request answers 409
          // until the order settles, and the final answer is what it then replays.
          reply.code(201);
          return {
            charge_id: result.chargeId,
            charge_status: 'requires_payment',
            stripe_payment_intent_id: result.intent.id,
            client_secret: result.intent.clientSecret,
            invoice_status: 'open',
            charge_refunded: false,
            charge_blocker: 'processing',
          };
        case 'open':
          throw new ApiError(
            'idempotency_inflight',
            'this payment has no answer yet: re-send it under the same Idempotency-Key',
          );
      }
    },
  );

  // `POST /invoices/:id/pay-in-person` `[auth]` — R3 cash/check flag flip.
  //
  // The owner elects to settle this OPEN invoice IN PERSON (cash
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
    const now = nowFactory();

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
        // cache-noop: only the §3 `credits:{ownerId}:*` family is read-through
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
          throw new ApiError('conflict', `invoice ${id} is no longer open and payable by card`);
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
          // Wire 1.9.0: carry the FRAMING the push promised through to the
          // sheet the tap opens. `satisfies` rather than a bare string so a
          // typo is a compile error here instead of an emit-time throw inside
          // a worker tick.
          deepLinkPath: deepLinkToPath({
            kind: 'invoice',
            id,
            params: { reason: 'payment-due' satisfies InvoiceDeepLinkReason },
          }),
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

/**
 * `/pay`'s work inside tx1: lock the invoice so two tenders serialise, re-check what
 * the pool read said, refuse while another order's charge on it is inside its lease
 * (design §2.7:3815), and name what the charge is for. Past the lease the second
 * tender goes through, and PAY-35 refunds the loser (DECISIONS 142(b)).
 */
async function holdInvoiceForPayment(
  tx: Tx,
  args: {
    id: string;
    at: Date | undefined;
    log: { warn(obj: Record<string, unknown>, msg: string): void };
  },
): Promise<Omit<ChargeTerms, 'card'>> {
  const invoice = await invoicesRepository.lockById(tx, args.id);
  if (invoice === undefined) {
    throw new ApiError('not_found', `invoice ${args.id} not found`);
  }
  if (invoice.status !== 'open') {
    throw new ApiError('conflict', `invoice ${args.id} is ${invoice.status}, not open`);
  }
  if (await ordersRepository.invoiceHasChargeInLease(tx, { invoiceId: args.id, at: args.at })) {
    throw new ApiError(
      'invoice_payment_in_flight',
      `invoice ${args.id} has another payment in flight`,
    );
  }
  return {
    amountCents: invoice.amountCents,
    purpose: invoice.purpose,
    // The invoice's own enrollment anchor (§A3.18 D1), with the §A3.19 F2 fallback
    // behind it for invoices carrying none.
    bookingId: await resolveInvoiceAnchorBookingId(tx, invoice, args.log),
    cohortId: invoice.cohortId,
    dogId: invoice.dogId,
  };
}

function parseIdParam(params: unknown): { id: string } {
  const parsed = idParamSchema.safeParse(params);
  if (!parsed.success) {
    throw new ApiError('bad_request', `invalid path: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}
