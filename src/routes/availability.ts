import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import { ApiError } from '../lib/errors.js';
import { formatZodIssues } from '../lib/zodIssues.js';
import { pgEnumTuple } from '../lib/pgEnumTuple.js';
import { defaultDayCapacity, enumerateRangeWithCap } from '../lib/availability.js';
import { isValidCalendarDate } from '../lib/chicagoDate.js';
import { bookingMode, LOCATION_SLUGS } from '../db/schema/schema.js';
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
 */

const MODES = pgEnumTuple(bookingMode);
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

type LocationKey = (typeof LOCATIONS)[number];

export interface DayCapacityWire {
  location: LocationKey;
  date: string;
  school_openings: number;
  daycare_openings: number;
}

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
