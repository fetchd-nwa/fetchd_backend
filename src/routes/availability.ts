import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import { BOOKING_MODES, type DayCapacityWire } from '../contracts/wire.js';
import { ApiError } from '../lib/errors.js';
import { formatZodIssues } from '../lib/zodIssues.js';
import { defaultDayCapacity, enumerateRangeWithCap } from '../lib/availability.js';
import { isValidCalendarDate } from '../lib/chicagoDate.js';
import { LOCATION_SLUGS } from '../db/schema/schema.js';
import { dayCapacityRepository } from '../db/repositories/dayCapacityRepository.js';

/**
 * `GET /availability?from=&to=&mode=&location=` `[auth]` — per-location
 * day-program capacity over a calendar range (DATA-CONTRACT §C
 * availability + §B DayCapacity Δ 2026-05-20).
 *
 * One `DayCapacity` row per date in `[from, to]` inclusive, default rule
 * applied where no override exists (weekend=closed, weekday=3/3). The
 * `mode` query param is validated to the booking_mode enum but does not
 * filter the wire — all four columns (`school_openings`,
 * `daycare_openings`, `school_remaining`, `daycare_remaining`) always emit,
 * and the FE selects which to display. Catalog endpoint: both owner
 * and staff principals get the same data (no per-user scoping).
 *
 * Range cap = `AVAILABILITY_MAX_DATES` (92 dates ≈ 3 months). Larger
 * windows fail with 400 `invalid_payload` to bound query + response size.
 *
 * **Four numbers per day, two meanings.** `*_openings` is the day's
 * CONFIGURED cap — the override row, or the default rule. `*_remaining` is
 * that cap minus the seats already booked for (location, date, mode),
 * floored at 0. The gap flagged 2026-07-31 — the calendar rendering a
 * fully-booked day as open until the owner hit a 422 `insufficient_capacity`
 * at submit — closed here: Allison's §6-batch decision #3, option C, approved
 * 2026-08-24 (`designs/decision-batch-2026-08.md` item 3). Additive, so the
 * shared `*_openings` field keeps its meaning and the bump stays minor.
 *
 * **`*_remaining` is ADVISORY.** It is computed outside any booking lock, so
 * a booking that commits between this read and the client's POST staled it.
 * The authoritative arithmetic is still
 * `dayCapacityRepository.assertCapacityWithinLock` inside the booking
 * transaction, and its 422 is still the source of truth at write time. This
 * number exists to stop the walk-the-whole-flow-then-fail experience, not to
 * replace the check. Its booked count is deliberately UNCACHED (see
 * `findBookedCountsInRange`) — the `avail:*` range cache is invalidated by
 * `day_capacity` writes only, so caching it would reintroduce the same lie
 * as staleness.
 */

// Wire 1.13.0 §5.4: the mode vocabulary now comes from the contract tuple
// rather than being re-derived from the pgEnum here. Member-for-member
// identical to `bookingMode.enumValues` (proof in the lane patch), and
// `conformance.ts` pins `BookingMode` to that pgEnum, so DB ↔ wire drift is
// a compile error rather than a silent validation change.
const MODES = BOOKING_MODES;
const LOCATIONS = LOCATION_SLUGS;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const dateField = z
  .string()
  .regex(ISO_DATE, 'must be YYYY-MM-DD')
  .refine(isValidCalendarDate, 'not a real calendar date');

const querySchema = z.object({
  from: dateField,
  to: dateField,
  mode: z.enum(MODES),
  location: z.enum(LOCATIONS),
});

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
      const dates = resolveRange(from, to);

      // Two independent reads: the (cached) sparse override rows and the
      // (uncached) live booked counts. Neither depends on the other, so they
      // go in parallel — one round trip, not two.
      const [overrides, booked] = await Promise.all([
        dayCapacityRepository.findOverridesInRange(location, from, to),
        dayCapacityRepository.findBookedCountsInRange(location, from, to),
      ]);
      const overrideByDate = new Map(overrides.map((row) => [row.date, row] as const));
      const bookedByDate = new Map(booked.map((row) => [row.date, row] as const));

      return dates.map((date) => {
        const override = overrideByDate.get(date);
        const { school_openings, daycare_openings } = override ?? defaultDayCapacity(date);
        // A date nobody has booked is absent from the aggregate, not zeroed.
        const used = bookedByDate.get(date);
        return {
          location,
          date,
          school_openings,
          daycare_openings,
          school_remaining: remainingSeats(school_openings, used?.school_booked ?? 0),
          daycare_remaining: remainingSeats(daycare_openings, used?.daycare_booked ?? 0),
        };
      });
    },
  );
}

/**
 * Configured openings minus booked seats, floored at 0. The floor is
 * reachable in production, not defensive decoration: staff can shrink a
 * day's `day_capacity` override below what is already booked, and the
 * booking transaction never rejects an existing booking to make the numbers
 * line up. Same `Math.max(0, …)` the 422's `openings_remaining` detail
 * applies (`dayCapacityRepository.ts` — `insufficientCapacityError`), so the
 * advisory read and the authoritative error agree on the wording of "full".
 */
function remainingSeats(openings: number, booked: number): number {
  return Math.max(0, openings - booked);
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
function resolveRange(from: string, to: string): string[] {
  const result = enumerateRangeWithCap(from, to);
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
