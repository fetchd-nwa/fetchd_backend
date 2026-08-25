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
 * filter the wire — both `school_openings` and `daycare_openings` always
 * emit, and the FE selects which to display. Catalog endpoint: both owner
 * and staff principals get the same data (no per-user scoping).
 *
 * Range cap = `AVAILABILITY_MAX_DATES` (92 dates ≈ 3 months). Larger
 * windows fail with 400 `invalid_payload` to bound query + response size.
 *
 * **Known gap — this endpoint emits the day's CAP, not its free seats.**
 * `school_openings` / `daycare_openings` are the configured openings for the
 * date; nothing is subtracted for dogs already booked. The mobile app consumes
 * them as remaining seats (`availabilityService.classifyStatus`: "green if
 * every selected dog fits"), so a fully-booked day still renders open and the
 * booking path is the first place the owner learns otherwise.
 *
 * The seat arithmetic that *is* authoritative lives in
 * `dayCapacityRepository.assertCapacityWithinLock` (openings − booked), which
 * every booking path goes through. Making this route emit that number instead
 * changes the meaning of a §B wire field shared by three repos and its
 * byte-match snapshots — contract-first work for the orchestrator, not a
 * drive-by. Flagged 2026-07-31.
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

      const overrides = await dayCapacityRepository.findOverridesInRange(location, from, to);
      const overrideByDate = new Map(overrides.map((row) => [row.date, row] as const));

      return dates.map((date) => {
        const override = overrideByDate.get(date);
        const { school_openings, daycare_openings } = override ?? defaultDayCapacity(date);
        return { location, date, school_openings, daycare_openings };
      });
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
