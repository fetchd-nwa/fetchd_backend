import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import { ApiError } from '../lib/errors.js';
import { formatZodIssues } from '../lib/zodIssues.js';
import { bucketChicagoToday } from '../lib/chicagoDate.js';
import { pgEnumTuple } from '../lib/pgEnumTuple.js';
import { toRateWire, type RateWire } from '../lib/ratesWire.js';
import { LOCATION_SLUGS, serviceCategory } from '../db/schema/schema.js';
import { serviceRatesRepository } from '../db/repositories/serviceRatesRepository.js';

/**
 * `GET /rates?category=&location=` `[auth]` — effective-dated price catalog
 * (DATA-CONTRACT §B Rate Δ 2026-05-20).
 *
 * Both query params are required. Precedence: a location-specific row
 * (`service_rates.location = $loc`) beats a null-location row ("applies to
 * all"). 404 (`not_found`) when no row matches at `today_chicago`. Both
 * owner and staff principals get the same data — rates are reference data,
 * not user data.
 *
 * Layer responsibilities:
 *   route → parse, call repo, map to wire, respond
 *   repo  → SQL (effective-window filter + ORDER BY location NULLS LAST)
 *   wire  → §B optional-omit / location-null-not-omitted (lib/ratesWire)
 */

const CATEGORIES = pgEnumTuple(serviceCategory);
const LOCATIONS = LOCATION_SLUGS;

const querySchema = z.object({
  category: z.enum(CATEGORIES),
  location: z.enum(LOCATIONS),
});

export interface RatesRouteOptions extends AuthRouteOptions {
  /**
   * Injectable clock so contract tests get a deterministic "today" for the
   * effective-dated lookup. A factory, not a `Date`, so a captured clock
   * at registration time can't freeze production. Default = `new Date()`.
   */
  now?: () => Date;
}

export function registerRatesRoute(app: FastifyInstance, opts: RatesRouteOptions = {}): void {
  const authHook = resolveAuthHook(opts);
  const nowFactory = opts.now ?? ((): Date => new Date());

  app.get('/rates', { preHandler: [authHook] }, async (request): Promise<RateWire> => {
    requirePrincipal(request);
    const { category, location } = parseQuery(request.query);
    const today = bucketChicagoToday(nowFactory());

    const row = await serviceRatesRepository.findActiveRate(category, location, today);
    if (row === undefined) {
      throw new ApiError(
        'not_found',
        `no active rate for category=${category} location=${location} on ${today}`,
      );
    }
    return toRateWire(row);
  });
}

function parseQuery(raw: unknown): z.infer<typeof querySchema> {
  const parsed = querySchema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError('bad_request', `invalid query: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}
