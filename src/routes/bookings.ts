import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import { ApiError } from '../lib/errors.js';
import { formatZodIssues } from '../lib/zodIssues.js';
import { isInView } from '../lib/bookingBucket.js';
import { groupBookingDogs, toBookingWire, type BookingWire } from '../lib/bookingWire.js';
import { pgTimestampToDate } from '../lib/pgTimestamp.js';
import { bookingsRepository, type BookingRow } from '../db/repositories/bookingsRepository.js';
import { staffRepository } from '../db/repositories/staffRepository.js';

/**
 * `GET /bookings?view=upcoming|past` `[auth]` and three companions —
 * the booking-data read surface (DATA-CONTRACT §C bookings).
 *
 * The four endpoints share a query skeleton + the same wire helper, so
 * they live in one file. Each runs against the **owner**'s data only;
 * staff principals get an empty list (or 404 on the single-resource
 * lookups). Day-19 staff portal uses `/staff/bookings/*` for cross-owner
 * access — out of scope here.
 *
 * Runtime bucketing is server-side (DATA-CONTRACT §B Δ 2026-05-20):
 * `view=upcoming` / `view=past` use `isInView`, not the stored
 * `bookings.status` column directly. Status is allowed to lag (the
 * Day-16 worker transitions it on a schedule) — the read never has to
 * wait for the worker to be correct. `status='cancelled'` rows are
 * excluded from both views and surface only via `GET /bookings/:id`.
 *
 * Layer responsibilities (Day-5a Clean-Architecture seam):
 *   route   → parse query/params, call repo, bucket+sort, wire, respond
 *   repo    → SQL queries + projection (bookings + booking_dogs + staff)
 *   wire    → DB row + dog ids + trainer name → §B JSON shape (pure)
 *   bucket  → category-aware end-time + view filter (pure)
 *
 * Injectable clock: a `now?: () => Date` factory keeps contract tests
 * deterministic; production uses `() => new Date()`.
 */

const VIEW_VALUES = ['upcoming', 'past'] as const;
type BookingView = (typeof VIEW_VALUES)[number];

const viewQuerySchema = z.object({
  view: z.enum(VIEW_VALUES),
});

const uuidParamSchema = z.object({
  id: z.string().uuid(),
});

export interface BookingsRouteOptions extends AuthRouteOptions {
  now?: () => Date;
}

export function registerBookingsRoute(app: FastifyInstance, opts: BookingsRouteOptions = {}): void {
  const authHook = resolveAuthHook(opts);
  const nowFactory = opts.now ?? ((): Date => new Date());

  // --- GET /bookings?view=upcoming|past ---------------------------------
  app.get('/bookings', { preHandler: [authHook] }, async (request): Promise<BookingWire[]> => {
    const principal = requirePrincipal(request);
    const view = parseView(request.query);
    if (principal.kind !== 'owner') return [];

    const rows = await bookingsRepository.findLiveActiveByOwner(principal.ownerId);
    const bucketed = rows.filter((row) => isInView(row, view, nowFactory()));
    const sorted = sortByScheduledAt(bucketed, view === 'past' ? 'desc' : 'asc');
    return wireBookings(sorted);
  });

  // --- GET /bookings/up-next ---------------------------------------------
  // Most-imminent upcoming booking (ascending scheduledAt, first row).
  // `null` when none. "Upcoming" here is the runtime bucket — an in-
  // progress day-school session at 11am still counts (end = 17:30).
  app.get(
    '/bookings/up-next',
    { preHandler: [authHook] },
    async (request): Promise<BookingWire | null> => {
      const principal = requirePrincipal(request);
      if (principal.kind !== 'owner') return null;

      const rows = await bookingsRepository.findLiveActiveByOwner(principal.ownerId);
      const upcoming = rows.filter((row) => isInView(row, 'upcoming', nowFactory()));
      const sorted = sortByScheduledAt(upcoming, 'asc');
      const first = sorted[0];
      if (first === undefined) return null;
      const [wire] = await wireBookings([first]);
      return wire ?? null;
    },
  );

  // --- GET /bookings/:id -------------------------------------------------
  // Single booking lookup by id, owner-scoped. Returns 404 if the booking
  // doesn't exist OR doesn't belong to the authenticated owner — same
  // response for both branches so an attacker can't enumerate ids.
  app.get('/bookings/:id', { preHandler: [authHook] }, async (request): Promise<BookingWire> => {
    const principal = requirePrincipal(request);
    const { id } = parseUuidParam(request.params);
    if (principal.kind !== 'owner') {
      throw new ApiError('not_found', `booking ${id} not found`);
    }
    const row = await bookingsRepository.findByIdForOwner(id, principal.ownerId);
    if (row === undefined) {
      throw new ApiError('not_found', `booking ${id} not found`);
    }
    const [wire] = await wireBookings([row]);
    if (wire === undefined) {
      // booking_dogs is empty for this booking — structural bug.
      throw new Error(`booking ${id}: failed to resolve lead dog from booking_dogs`);
    }
    return wire;
  });

  // --- GET /dogs/:id/bookings?view= -------------------------------------
  // Per-dog filter. The dog appears as lead OR additional on the
  // booking_dogs roster (see repo doc). A dog the principal doesn't own
  // → empty list (same response as "dog has no bookings", no id leak).
  app.get(
    '/dogs/:id/bookings',
    { preHandler: [authHook] },
    async (request): Promise<BookingWire[]> => {
      const principal = requirePrincipal(request);
      const { id: dogId } = parseUuidParam(request.params);
      const view = parseView(request.query);
      if (principal.kind !== 'owner') return [];

      const rows = await bookingsRepository.findLiveActiveForDog(dogId, principal.ownerId);
      const bucketed = rows.filter((row) => isInView(row, view, nowFactory()));
      const sorted = sortByScheduledAt(bucketed, view === 'past' ? 'desc' : 'asc');
      return wireBookings(sorted);
    },
  );
}

// ---- query/param parsing --------------------------------------------

function parseView(query: unknown): BookingView {
  const parsed = viewQuerySchema.safeParse(query);
  if (!parsed.success) {
    throw new ApiError('bad_request', `invalid query: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data.view;
}

function parseUuidParam(params: unknown): { id: string } {
  const parsed = uuidParamSchema.safeParse(params);
  if (!parsed.success) {
    throw new ApiError('bad_request', `invalid path: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}

// ---- sort + denormalize ----------------------------------------------

/**
 * Pure sort by scheduled_at. Used by every booking list endpoint —
 * upcoming = ASC (soonest first), past = DESC (most recent first).
 */
function sortByScheduledAt(rows: BookingRow[], direction: 'asc' | 'desc'): BookingRow[] {
  const sorted = [...rows].sort(
    (a, b) =>
      pgTimestampToDate(a.scheduledAt).getTime() - pgTimestampToDate(b.scheduledAt).getTime(),
  );
  return direction === 'desc' ? sorted.reverse() : sorted;
}

/**
 * Denormalize a set of booking rows into wire shapes. Two batched
 * lookups (booking_dogs + staff names) regardless of row count — cost
 * is constant in the input size. Pure side of the route: takes already-
 * sorted, already-bucketed rows; returns the JSON the FE consumes.
 *
 * Throws if a booking has no `booking_dogs` rows at all (schema-level
 * invariant violation — better to fail loud than emit a malformed
 * wire shape the FE doesn't know how to handle).
 */
async function wireBookings(rows: BookingRow[]): Promise<BookingWire[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [bookingDogRows, trainerName] = await Promise.all([
    bookingsRepository.findDogsByBookingIds(ids),
    staffRepository.resolveTrainerNames(rows),
  ]);
  const dogsByBooking = groupBookingDogs(bookingDogRows);
  return rows.map((row) => {
    const dogIds = dogsByBooking.get(row.id);
    if (dogIds === undefined) {
      throw new Error(`booking ${row.id}: no booking_dogs rows found`);
    }
    return toBookingWire(row, dogIds, trainerName(row.trainerStaffId));
  });
}
