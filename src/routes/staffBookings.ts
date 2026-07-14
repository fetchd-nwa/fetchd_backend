import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import { hashRequestBody, requireIdempotencyKey, withMutation } from '../db/mutation.js';
import { bookingsRepository } from '../db/repositories/bookingsRepository.js';
import { creditsInvalidationPattern } from '../db/repositories/creditsRepository.js';
import { refundsRepository } from '../db/repositories/refundsRepository.js';
import { type BookingWire } from '../lib/bookingWire.js';
import type { AttendanceWire } from '../contracts/wire.js';
import { cancelBookingInTx } from '../lib/cancelBookingService.js';
import { ApiError } from '../lib/errors.js';
import { requireStaff } from '../lib/principalNarrows.js';
import { defaultStripeClient, type StripeClient } from '../lib/stripe.js';
import { sortBookingsByScheduledAt, wireManyBookings } from '../lib/wireManyBookings.js';

/**
 * Day-19 staff portal verb 4 — bookings. Cross-owner reads/writes gated by
 * `requireStaff` (the owner-scoped surface lives in `routes/bookings.ts`).
 *
 *   GET  /staff/bookings              — the live, non-cancelled queue
 *   POST /staff/bookings/:id/confirm  — stamp confirmed_at (drives reminders)
 *   POST /staff/bookings/:id/cancel   — the shared cancel txn, cross-owner
 *   POST /staff/bookings/:id/attendance — per-dog check-in
 *
 * Cancel reuses `lib/cancelBookingService.cancelBookingInTx` — the SAME
 * forfeit/refund transaction the owner self-cancel runs (schema.sql
 * `cancelBooking` contract: owner-OR-staff authorized, one transaction).
 * The only difference is `requireOwnerId: null` (cross-owner) here vs the
 * owner's own id in `routes/bookings.ts`.
 *
 * Attendance response shape (§A Clarification 2026-05-28, additive, no
 * DDL): `{ booking_id, dog_id, attendance, checked_in_at }` — the §B
 * BookingWire carries no per-dog attendance, so the check-in verb returns
 * the row it touched. The booking_attendance value 'pending' is the
 * default/unset state, never a check-in action; the body accepts only
 * 'attended' | 'no-show' | 'excused'.
 */

const uuidParamSchema = z.object({ id: z.string().uuid() });

const attendanceBodySchema = z
  .object({
    dog_id: z.string().uuid(),
    status: z.enum(['attended', 'no-show', 'excused']),
  })
  .strict();

// AttendanceWire is owned by the single-source contract (contracts/wire.ts).

export interface StaffBookingsRouteOptions extends AuthRouteOptions {
  /** Stripe seam for the cancel money-back postCommit (mirrors bookings). */
  stripe?: StripeClient;
}

export function registerStaffBookingsRoute(
  app: FastifyInstance,
  opts: StaffBookingsRouteOptions = {},
): void {
  const authHook = resolveAuthHook(opts);
  const stripe = opts.stripe ?? defaultStripeClient;

  // --- GET /staff/bookings ------------------------------------------------
  //
  // The cross-owner triage queue: every live, non-cancelled booking,
  // soonest scheduled first. No view/date filter today — the portal is the
  // "dumbest viable" client and filters client-side; a server-side window
  // (?from=&to=) is a Day-20 hardening item if the row count grows.
  app.get(
    '/staff/bookings',
    { preHandler: [authHook] },
    async (request): Promise<BookingWire[]> => {
      const principal = requirePrincipal(request);
      requireStaff(principal, 'read the staff booking queue');
      const rows = await bookingsRepository.findLiveActive();
      const sorted = sortBookingsByScheduledAt(rows, 'asc');
      return wireManyBookings(sorted);
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
          const [wire] = await wireManyBookings([updated]);
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
  // Cross-owner cancel via the shared txn. Same forfeit/refund branching as
  // the owner self-cancel; the money-back branch fires the Stripe refund
  // post-commit (skipped on idempotency replay — the txn body doesn't run).
  app.post(
    '/staff/bookings/:id/cancel',
    { preHandler: [authHook] },
    async (request): Promise<BookingWire> => {
      const principal = requirePrincipal(request);
      requireStaff(principal, 'cancel a booking');
      const { id } = parseUuidParam(request.params);
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);

      let pendingStripeRefund:
        | { refundId: string; paymentIntentId: string; amountCents: number }
        | undefined;
      let creditRefundedDogIds: string[] = [];

      const outcome = await withMutation<BookingWire>(
        {
          principal,
          idempotencyKey,
          endpoint: 'POST /staff/bookings/:id/cancel',
          requestHash: hashRequestBody({ id }),
          // Day-13 cache invalidation: drop the freed seat's availability
          // range cache plus each credited-back dog's balance cache. Mirrors
          // the owner cancel route.
          patternsToInvalidate: (body) => {
            const patterns: string[] = [];
            if (body.location !== undefined && body.location !== null) {
              patterns.push(`avail:${body.location}:*`);
            }
            for (const dogId of creditRefundedDogIds) {
              patterns.push(creditsInvalidationPattern(dogId));
            }
            return patterns;
          },
          postCommit: async () => {
            if (pendingStripeRefund === undefined) return;
            const result = await stripe.createRefund(
              {
                paymentIntentId: pendingStripeRefund.paymentIntentId,
                amountCents: pendingStripeRefund.amountCents,
                reason: 'requested_by_customer',
              },
              `${idempotencyKey}:refund`,
            );
            await refundsRepository.markStripeId({
              id: pendingStripeRefund.refundId,
              stripeRefundId: result.id,
            });
          },
        },
        async (tx) => {
          const result = await cancelBookingInTx(tx, { id, requireOwnerId: null });
          pendingStripeRefund = result.pendingStripeRefund;
          creditRefundedDogIds = result.creditRefundedDogIds;
          return { status: 200, body: result.wire };
        },
      );
      return outcome.body;
    },
  );

  // --- POST /staff/bookings/:id/attendance --------------------------------
  //
  // Per-dog check-in. Locks the booking (404 missing/expired, 409
  // cancelled), then sets booking_dogs.attendance + checked_in_at +
  // checked_in_by_staff_id. The RETURNING folds the roster-membership
  // check into the write: a dog not on the booking → 404.
  app.post(
    '/staff/bookings/:id/attendance',
    { preHandler: [authHook] },
    async (request): Promise<AttendanceWire> => {
      const principal = requirePrincipal(request);
      requireStaff(principal, 'mark attendance');
      const { id } = parseUuidParam(request.params);
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
      const body = parseAttendanceBody(request.body);

      // cache-noop: attendance is a post-session fact write; it touches no
      // availability or §3-cached read.
      const outcome = await withMutation<AttendanceWire>(
        {
          principal,
          idempotencyKey,
          endpoint: 'POST /staff/bookings/:id/attendance',
          requestHash: hashRequestBody({ id, ...body }),
        },
        async (tx) => {
          const row = await bookingsRepository.lockById(tx, id);
          if (row === undefined || row.expiredAt !== null) {
            throw new ApiError('not_found', `booking ${id} not found`);
          }
          if (row.status === 'cancelled') {
            throw new ApiError(
              'conflict',
              `booking ${id} is cancelled — attendance cannot be marked`,
            );
          }

          const updated = await bookingsRepository.setAttendance(tx, {
            bookingId: id,
            dogId: body.dog_id,
            status: body.status,
            staffId: principal.staffId,
          });
          if (updated === undefined) {
            throw new ApiError('not_found', `dog ${body.dog_id} is not on booking ${id}`);
          }

          return {
            status: 200,
            body: {
              booking_id: id,
              dog_id: body.dog_id,
              attendance: body.status,
              checked_in_at: updated.checkedInAt,
            },
          };
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

function parseAttendanceBody(body: unknown): z.infer<typeof attendanceBodySchema> {
  const parsed = attendanceBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError('invalid_payload', `invalid body: ${parsed.error.message}`);
  }
  return parsed.data;
}
