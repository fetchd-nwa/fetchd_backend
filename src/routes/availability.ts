import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import type { DayCapacityWire, GetAvailabilityQuery } from '../contracts/wire.js';
import type { Equal, Expect } from '../contracts/typeAsserts.js';
import { ApiError } from '../lib/errors.js';
import { formatZodIssues } from '../lib/zodIssues.js';
import {
  availabilityMaxDates,
  dayCapacityFor,
  dayCapacityWire,
  enumerateRangeWithCap,
} from '../lib/availability.js';
import { isValidCalendarDate } from '../lib/chicagoDate.js';
import { LOCATION_SLUGS } from '../db/schema/schema.js';
import { dayCapacityRepository } from '../db/repositories/dayCapacityRepository.js';
import { settingsRepository } from '../db/repositories/settingsRepository.js';

/**
 * `GET /availability?from=&to=&location=` `[auth]` — per-campus day-program
 * capacity over a calendar range (DATA-CONTRACT §C availability + §B DayCapacity,
 * wire 4.0.0-lg3.1).
 *
 * One `DayCapacityWire` per date in `[from, to]` inclusive, whether or not the
 * date has an override. One cap per (location, date), shared by day school and
 * daycare, so there is no mode to ask about: a stale client's `mode=` is dropped,
 * because the query is not `.strict()`. Catalog endpoint: both owner and staff
 * principals get the same data (no per-user scoping).
 *
 * Range cap = `availabilityMaxDates(day.booking_horizon_months)`, so a window from
 * today through the horizon's last date always fits. Larger windows fail with 422
 * `invalid_payload` to bound query + response size.
 *
 * **Two numbers per day, two meanings.** `capacity_dogs` is the date's CONFIGURED
 * cap (`lib/availability.dayCapacityFor`). `remaining_dogs` is that cap minus the
 * seats already booked at that campus, floored at 0. The gap flagged 2026-07-31 —
 * the calendar rendering a fully-booked day as open until the owner hit a 422
 * `insufficient_capacity` at submit — closed with the first version of this field:
 * Allison's §6-batch decision #3, option C, approved 2026-08-24
 * (`designs/decision-batch-2026-08.md` item 3).
 *
 * **`remaining_dogs` is ADVISORY.** It is computed outside any booking lock, so a
 * booking that commits between this read and the client's POST staled it. The
 * authoritative arithmetic is still
 * `dayCapacityRepository.assertCapacityWithinLock` inside the booking transaction,
 * and its 422 is still the source of truth at write time. This number exists to
 * stop the walk-the-whole-flow-then-fail experience, not to replace the check. Its
 * booked count is deliberately UNCACHED (see `findBookedCountsInRange`) — the
 * `avail:*` range cache is invalidated by `day_capacity` writes only, so caching it
 * would reintroduce the same lie as staleness. The settings are uncached too: every
 * settings read goes to Postgres (conflict 19).
 */

const LOCATIONS = LOCATION_SLUGS;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const dateField = z
  .string()
  .regex(ISO_DATE, 'must be YYYY-MM-DD')
  .refine(isValidCalendarDate, 'not a real calendar date');

const querySchema = z.object({
  from: dateField,
  to: dateField,
  location: z.enum(LOCATIONS),
});

/** The pin `mode` lacked: without it, removing a key from the wire reds nothing and
 *  this schema goes on requiring it. `z.input`: what a client may SEND. */
export type GetAvailabilityQueryConformance = Expect<
  Equal<z.input<typeof querySchema>, GetAvailabilityQuery>
>;

// Wire 1.13.0 (§6): `DayCapacityWire` is contract-owned now — re-exported so
// no consumer of this route module has to move.
export type { DayCapacityWire };

export function registerAvailabilityRoute(app: FastifyInstance, opts: AuthRouteOptions = {}): void {
  const authHook = resolveAuthHook(opts);

  app.get(
    '/availability',
    { preHandler: [authHook] },
    async (request): Promise<DayCapacityWire[]> => {
      requirePrincipal(request); // any authenticated principal; no role scope here
      const { from, to, location } = parseQuery(request.query);
      const [campus, global] = await Promise.all([
        settingsRepository.dayCampus(location),
        settingsRepository.dayGlobal(),
      ]);
      const dates = resolveRange(from, to, availabilityMaxDates(global.booking_horizon_months));

      // Two independent reads: the (cached) sparse override rows and the
      // (uncached) live booked counts. Neither depends on the other, so they
      // go in parallel — one round trip, not two.
      const [overrides, booked] = await Promise.all([
        dayCapacityRepository.findOverridesInRange(location, from, to),
        dayCapacityRepository.findBookedCountsInRange(location, from, to),
      ]);
      const overrideByDate = new Map(overrides.map((row) => [row.date, row] as const));
      const bookedByDate = new Map(booked.map((row) => [row.date, row.booked] as const));

      return dates.map((date) =>
        dayCapacityWire(
          location,
          date,
          dayCapacityFor(date, campus, overrideByDate.get(date)),
          // A date nobody has booked is absent from the aggregate, not zeroed.
          bookedByDate.get(date) ?? 0,
        ),
      );
    },
  );
}

function parseQuery(raw: unknown): z.infer<typeof querySchema> {
  const parsed = querySchema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError('bad_request', `invalid query: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}

/**
 * Map the Result from `enumerateRangeWithCap` to either the date list or a
 * precise `invalid_payload` (422). Both error branches are user-fixable
 * mistakes that passed field-level validation — reversed bounds or a
 * window past the cap — so they belong on 422, not 400.
 */
function resolveRange(from: string, to: string, limit: number): string[] {
  const result = enumerateRangeWithCap(from, to, limit);
  if (result.ok) return result.dates;
  if (result.reason === 'reversed') {
    throw new ApiError(
      'invalid_payload',
      `'to' (${result.to}) must not precede 'from' (${result.from})`,
    );
  }
  throw new ApiError(
    'invalid_payload',
    `range exceeds the ${result.limit}-date cap (got at least ${result.count} dates)`,
  );
}
