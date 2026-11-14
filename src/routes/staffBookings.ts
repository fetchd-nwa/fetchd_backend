import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import { hashRequestBody, requireIdempotencyKey, withMutation } from '../db/mutation.js';
import { bookingsRepository } from '../db/repositories/bookingsRepository.js';
import { creditsInvalidationPattern } from '../db/repositories/creditsRepository.js';
import { LOCATION_SLUGS, serviceCategory } from '../db/schema/schema.js';
import { type BookingWire } from '../lib/bookingWire.js';
import type {
  GetStaffBookingsQuery,
  PostStaffBookingsCancelRequest,
  PostStaffBookingsDogsCancelRequest,
} from '../contracts/wire.js';
import type { Equal, Expect } from '../contracts/typeAsserts.js';
import {
  askWhatWonForPendingRow,
  cancelBookingInTx,
  cancelOneDogInTx,
} from '../lib/cancelBookingService.js';
import { isValidCalendarDate } from '../lib/chicagoDate.js';
import { ApiError } from '../lib/errors.js';
import { pgEnumTuple } from '../lib/pgEnumTuple.js';
import { firePendingRefundPostCommit, type PendingStripeRefund } from '../lib/pendingRefund.js';
import { requireStaff } from '../lib/principalNarrows.js';
import { defaultStripeClient, type StripeClient } from '../lib/stripe.js';
import { uuidId } from '../lib/uuidId.js';
import { sortBookingsByScheduledAt, wireManyBookings } from '../lib/wireManyBookings.js';
import { formatZodIssues } from '../lib/zodIssues.js';

/**
 * Day-19 staff portal verb 4 — bookings. Cross-owner reads/writes gated by
 * `requireStaff` (the owner-scoped surface lives in `routes/bookings.ts`).
 *
 *   GET  /staff/bookings              — the live, non-cancelled queue
 *   POST /staff/bookings/:id/confirm  — stamp confirmed_at (drives reminders)
 *   POST /staff/bookings/:id/cancel   — the shared cancel txn, cross-owner
 *   POST /staff/bookings/:id/dogs/:dogId/cancel — one dog of several (s11, 6.0.0-lg5.1)
 *
 * Cancel reuses `lib/cancelBookingService.cancelBookingInTx` — the SAME
 * transaction the owner self-cancel runs (schema.sql `cancelBooking` contract:
 * owner-OR-staff authorized, one transaction): the row's credits come back and
 * nothing is forfeited or refunded in money (P21, wire 6.0.0-lg5.2).
 * The only difference is `requireOwnerId: null` (cross-owner) here vs the
 * owner's own id in `routes/bookings.ts`.
 *
 * `POST /staff/bookings/:id/attendance` is gone (6.0.0-lg5.1, M5.12): the board's
 * append-only log replaces it (`routes/staffCheckin.ts`).
 */

const uuidParamSchema = z.object({ id: uuidId() });
/** Both path ids lowercased at the parse, before any key, lock or comparison. */
const shareParamSchema = z.object({ id: uuidId(), dogId: uuidId() });

const SERVICE_CATEGORY_VALUES = pgEnumTuple(serviceCategory);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A Chicago calendar day. The regex pins the SHAPE; `isValidCalendarDate`
 * rejects the shapes that aren't real days (`2027-13-40` passes a regex).
 * Same pair as `availability.ts:52-55` and `staffRates.ts:79-80`.
 */
const chicagoDayField = z
  .string()
  .regex(ISO_DATE, 'must be YYYY-MM-DD')
  .refine(isValidCalendarDate, 'not a real calendar date');

/**
 * `GET /staff/bookings` query — the four server-side filters
 * (`GetStaffBookingsQuery`, wire 1.13.0; built here in 2.3b). Every key is
 * optional and an all-omitted query returns the unfiltered queue, which is
 * what makes this build ADDITIVE (design §14.1: promotion never tightens).
 *
 * Deliberately NOT `.strict()`, for the same reason: today the handler parses
 * no query at all, so `?anything=x` is accepted and ignored. Rejecting unknown
 * keys would turn a working request into a 400 — a behavior change wearing a
 * validation change's clothes. It also keeps `?search=` (Allison ruling WC-A5:
 * deferred to phase 3, needs a search domain + matching rule before it can be
 * contracted) inert rather than an error.
 */
const bookingsQuerySchema = z.object({
  from: chicagoDayField.optional(),
  to: chicagoDayField.optional(),
  category: z.enum(SERVICE_CATEGORY_VALUES).optional(),
  location: z.enum(LOCATION_SLUGS).optional(),
});

/**
 * Staff cancel body (R5, Allison sim-QA 2026-07-27). The only field is an
 * OPTIONAL reason the school can attach — surfaced under "The school cancelled
 * this on …" in the owner app. Trimmed + capped so a runaway paste can't bloat
 * the banner; omitted when the staff cancels without a note.
 */
const cancelBodySchema = z
  .object({
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

/**
 * The staff one-dog cancel's body (6.0.0-lg5.1; D17): the board's *Cancel* opens a reason
 * sheet, so `reason` is required, the cancel reason's band. It rides the idempotency hash
 * and is not stored: NOTIF-U17 (P21) puts it on the owner's notice.
 */
const dogCancelBodySchema = z
  .object({
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

/** §5.1.3 pins — see `PostBookingsBodyConformance` in `routes/bookings.ts`.
 *  The QUERY pin is what stops the four filters drifting from the contract in
 *  either direction: add a fifth key here (`search`, say) or drop one and
 *  `tsc` fails with TS2344 before any test runs. */
export type GetStaffBookingsQueryConformance = Expect<
  Equal<z.input<typeof bookingsQuerySchema>, GetStaffBookingsQuery>
>;

/** Unlike the deny verb's `reason`, THIS `reason` is persisted and comes back
 *  as `BookingWire.cancel_reason`. */
export type PostStaffBookingsCancelBodyConformance = Expect<
  Equal<z.input<typeof cancelBodySchema>, PostStaffBookingsCancelRequest>
>;

export type PostStaffBookingsDogsCancelBodyConformance = Expect<
  Equal<z.input<typeof dogCancelBodySchema>, PostStaffBookingsDogsCancelRequest>
>;

export interface StaffBookingsRouteOptions extends AuthRouteOptions {
  /** Stripe seam (mirrors bookings): a pending row's order is asked about and its
   *  F4 refund fired post-commit; the cancel's money-back branch was deleted in P21. */
  stripe?: StripeClient;
  /**
   * Injectable clock (mirrors `BookingsRouteOptions.now`). The staff cancel
   * runs the same `cancelBookingInTx` the owner cancel does, and that
   * transaction's time-sensitive decisions (the day session's refusals and the
   * return's landing) read the caller's instant rather than Postgres `now()` —
   * so this route has to own one. Production passes the
   * real clock; contract tests freeze it.
   */
  now?: () => Date;
}

export function registerStaffBookingsRoute(
  app: FastifyInstance,
  opts: StaffBookingsRouteOptions = {},
): void {
  const authHook = resolveAuthHook(opts);
  const stripe = opts.stripe ?? defaultStripeClient;
  const nowFactory = opts.now ?? ((): Date => new Date());

  // --- GET /staff/bookings ------------------------------------------------
  //
  // The cross-owner triage queue: every live, non-cancelled booking,
  // soonest scheduled first. Δ wire 1.13.0 (2.3b) — the Day-20 hardening item
  // this comment used to defer is built: four optional server-side filters
  // (`GetStaffBookingsQuery`), all of which NARROW the same base queue. Omit
  // them all and the response is what it has always been.
  app.get(
    '/staff/bookings',
    { preHandler: [authHook] },
    async (request): Promise<BookingWire[]> => {
      const principal = requirePrincipal(request);
      requireStaff(principal, 'read the staff booking queue');
      const query = parseBookingsQuery(request.query);
      const rows = await bookingsRepository.findLiveActive({
        fromChicagoDate: query.from,
        toChicagoDate: query.to,
        category: query.category,
        location: query.location,
      });
      const sorted = sortBookingsByScheduledAt(rows, 'asc');
      return wireManyBookings(sorted, { now: nowFactory(), viewer: 'staff' });
    },
  );

  // --- POST /staff/bookings/:id/confirm -----------------------------------
  //
  // Stamp confirmed_at (only when NULL — preserves the first-confirm time
  // that drives reminder scheduling). Idempotent at the DB layer; a replay
  // with the same Idempotency-Key returns the stored body. 409 on a
  // cancelled booking; a re-confirm of an already-confirmed booking is a
  // 200 no-op.
  app.post(
    '/staff/bookings/:id/confirm',
    { preHandler: [authHook] },
    async (request): Promise<BookingWire> => {
      const principal = requirePrincipal(request);
      requireStaff(principal, 'confirm a booking');
      const { id } = parseUuidParam(request.params);
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);

      // cache-noop: confirmed_at doesn't change capacity (status is the
      // availability axis) or any §3-cached read.
      const outcome = await withMutation<BookingWire>(
        {
          principal,
          idempotencyKey,
          endpoint: 'POST /staff/bookings/:id/confirm',
          requestHash: hashRequestBody({ id }),
        },
        async (tx) => {
          const row = await bookingsRepository.lockById(tx, id);
          if (row === undefined || row.expiredAt !== null) {
            throw new ApiError('not_found', `booking ${id} not found`);
          }
          if (row.status === 'cancelled') {
            throw new ApiError('conflict', `booking ${id} is cancelled and cannot be confirmed`);
          }

          await bookingsRepository.setConfirmed(tx, id);

          const updated = await bookingsRepository.findFullByIdInTx(tx, id);
          if (updated === undefined) {
            throw new Error(`confirm ${id}: row vanished before re-fetch`);
          }
          const [wire] = await wireManyBookings([updated], {
            now: nowFactory(),
            viewer: 'staff',
            runner: tx,
          });
          if (wire === undefined) {
            throw new Error(`confirm ${id}: wire assembly returned no row`);
          }
          return { status: 200, body: wire };
        },
      );
      return outcome.body;
    },
  );

  // --- POST /staff/bookings/:id/cancel ------------------------------------
  //
  // Cross-owner cancel via the shared txn, any role (no ladder): every credit back,
  // nothing forfeited, no money (P21). A pending row's F4 refund fires post-commit
  // (skipped on idempotency replay — the txn body doesn't run).
  app.post(
    '/staff/bookings/:id/cancel',
    { preHandler: [authHook] },
    async (request): Promise<BookingWire> => {
      const principal = requirePrincipal(request);
      requireStaff(principal, 'cancel a booking');
      const { id } = parseUuidParam(request.params);
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
      const reason = parseCancelReason(request.body);

      // Set only by a pending row's F4 refund; an upcoming row's cancel moves no money.
      let pendingStripeRefund: PendingStripeRefund | undefined;
      let creditRefundedOwnerId: string | undefined;
      // A pending row cancels its whole order, through the one service (DECISIONS
      // 142(e)), and asks Stripe first with no transaction open.
      const whatWon = await askWhatWonForPendingRow({ id, requireOwnerId: null, stripe });

      const outcome = await withMutation<BookingWire>(
        {
          principal,
          idempotencyKey,
          endpoint: 'POST /staff/bookings/:id/cancel',
          // Reason rides the hash so a replay under the same key with a DIFFERENT
          // reason is caught as a mismatch, not silently ignored.
          requestHash: hashRequestBody({ id, reason }),
          // Day-13 cache invalidation: drop the freed seat's availability
          // range cache plus each credited-back dog's balance cache. Mirrors
          // the owner cancel route.
          patternsToInvalidate: (body) => {
            const patterns: string[] = [];
            if (body.location !== undefined && body.location !== null) {
              patterns.push(`avail:${body.location}:*`);
            }
            if (creditRefundedOwnerId !== undefined) {
              patterns.push(creditsInvalidationPattern(creditRefundedOwnerId));
            }
            return patterns;
          },
          postCommit: async () => {
            await firePendingRefundPostCommit({
              pending: pendingStripeRefund,
              stripe,
              log: request.log,
              context: { bookingId: id, cancelPath: 'staff-cancel' },
            });
          },
        },
        async (tx) => {
          // Staff cancel → "The school cancelled this on …" (R5), with the
          // reason line when the caller supplied one.
          const result = await cancelBookingInTx(tx, {
            id,
            requireOwnerId: null,
            cancelledBy: 'staff',
            ...(reason !== undefined ? { cancelReason: reason } : {}),
            now: nowFactory(),
            whatWon,
            log: request.log,
          });
          pendingStripeRefund = result.pendingStripeRefund;
          creditRefundedOwnerId = result.creditRefundedOwnerId;
          return { status: 200, body: result.wire };
        },
      );
      return outcome.body;
    },
  );

  // --- POST /staff/bookings/:id/dogs/:dogId/cancel ------------------------
  //
  // One dog of several (s11; CXL-U09), any role, no ladder: her credit back to the
  // family's pool, her seat free, the session cancelled with its last dog. The
  // transaction is `cancelOneDogInTx`'s; every refusal with a clock in it runs after the
  // claim, so an answer replays.
  app.post(
    '/staff/bookings/:id/dogs/:dogId/cancel',
    { preHandler: [authHook] },
    async (request): Promise<BookingWire> => {
      const principal = requirePrincipal(request);
      requireStaff(principal, "cancel one dog's day");
      const { id, dogId } = parseShareParam(request.params);
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
      const parsed = dogCancelBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw new ApiError('invalid_payload', `invalid body: ${formatZodIssues(parsed.error)}`);
      }
      const { reason } = parsed.data;
      let freed: { ownerId: string; location: string | null } | undefined;

      const outcome = await withMutation<BookingWire>(
        {
          principal,
          idempotencyKey,
          endpoint: 'POST /staff/bookings/:id/dogs/:dogId/cancel',
          requestHash: hashRequestBody({ id, dogId, reason }),
          patternsToInvalidate: () =>
            freed === undefined
              ? []
              : [
                  ...(freed.location !== null ? [`avail:${freed.location}:*`] : []),
                  creditsInvalidationPattern(freed.ownerId),
                ],
        },
        async (tx) => {
          const result = await cancelOneDogInTx(tx, {
            id,
            dogId,
            requireOwnerId: null,
            // The reason sheet's words, quoted verbatim in the owner's notice (D13).
            who: { by: 'staff', reason },
            now: nowFactory(),
            log: request.log,
          });
          freed = { ownerId: result.creditRefundedOwnerId, location: result.location };
          return { status: 200, body: result.wire };
        },
      );
      return outcome.body;
    },
  );
}

function parseUuidParam(params: unknown): { id: string } {
  const parsed = uuidParamSchema.safeParse(params);
  if (!parsed.success) {
    throw new ApiError('bad_request', `invalid path: ${parsed.error.message}`);
  }
  return parsed.data;
}

/**
 * Query parse for `GET /staff/bookings`. A malformed VALUE is 400
 * `bad_request` — the query convention (`bookings.ts:666`, `requests.ts:518`,
 * `staffRequests.ts:590`); route BODIES use `invalid_payload`.
 */
function parseBookingsQuery(query: unknown): z.infer<typeof bookingsQuerySchema> {
  const parsed = bookingsQuerySchema.safeParse(query);
  if (!parsed.success) {
    throw new ApiError('bad_request', `invalid query: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}

function parseShareParam(params: unknown): { id: string; dogId: string } {
  const parsed = shareParamSchema.safeParse(params);
  if (!parsed.success) {
    throw new ApiError('bad_request', `invalid path: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}

/** Optional staff cancel reason. Tolerates an absent body (`{}` / undefined). */
function parseCancelReason(body: unknown): string | undefined {
  const parsed = cancelBodySchema.safeParse(body ?? {});
  if (!parsed.success) {
    throw new ApiError('invalid_payload', `invalid body: ${parsed.error.message}`);
  }
  return parsed.data.reason;
}
