import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import { hashRequestBody, requireIdempotencyKey, withMutation } from '../db/mutation.js';
import { withServiceRateLock } from '../db/locks.js';
import {
  serviceRatesRepository,
  type StaffServiceRateRow,
} from '../db/repositories/serviceRatesRepository.js';
import {
  LOCATION_SLUGS,
  rateUnit,
  serviceCategory,
  type LocationKey,
} from '../db/schema/schema.js';
import { bucketChicagoToday, isValidCalendarDate } from '../lib/chicagoDate.js';
import { ApiError } from '../lib/errors.js';
import { pgEnumTuple } from '../lib/pgEnumTuple.js';
import { requireStaff } from '../lib/principalNarrows.js';
import { parseOrThrow } from '../lib/zodIssues.js';

/**
 * `GET /staff/rates` `[staff]` + `POST /staff/rates` `[staff]` — the
 * staff-portal per-location service-rate editor (DATA-CONTRACT §B Rate +
 * 2026-06-20 amendment). Owner-facing pricing is read-only at `GET /rates`;
 * this is the write side. Owner principals get 403 — rates are staff config.
 *
 * `service_rates` is an **effective-dated** catalog: each (category, location)
 * track is a sequence of rows with non-overlapping `[effective_from,
 * effective_to)` windows (open-ended `effective_to NULL` = current). Editing a
 * price is therefore NEVER an in-place amount change — it closes the current
 * window and opens a new one (`serviceRatesRepository.supersedeRate`), so a
 * past booking's as-charged rate (and a PAYG invoice's locked amount) survive
 * the change. The supersede runs under a per-track advisory lock so concurrent
 * edits can't leave two open windows.
 *
 * Read shape (`GET /staff/rates`): every row active or scheduled at today
 * (expired history excluded), so the portal can show each track's current rate
 * plus any pending change.
 */

const SERVICE_CATEGORY_VALUES = pgEnumTuple(serviceCategory);
const RATE_UNIT_VALUES = pgEnumTuple(rateUnit);
const LOCATION_VALUES = LOCATION_SLUGS;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Amount sanity band. min 1¢ — a rate exists to charge something (a "$0 rate"
 * is a different concept, not a price). max $10,000 — a generous ceiling that
 * still covers a flat board-and-train package, while stopping a fat-finger from
 * setting a $1M/day price that would auto-charge cards before anyone noticed.
 */
const MIN_AMOUNT_CENTS = 1;
const MAX_AMOUNT_CENTS = 1_000_000;

/**
 * PAYG charges day-school / day-care per booking DATE straight off
 * `amount_cents` (see routes/bookings.ts), so those two categories MUST be
 * priced `per-day` — a `per-week`/`flat` figure would be silently billed as a
 * daily one. Other categories have no live rate-charged money path yet, so
 * their unit is unconstrained here.
 */
const PER_DAY_REQUIRED_CATEGORIES = new Set<string>(['day-school', 'day-care']);

const postBodySchema = z
  .object({
    category: z.enum(SERVICE_CATEGORY_VALUES),
    location: z.enum(LOCATION_VALUES),
    amount_cents: z.number().int().min(MIN_AMOUNT_CENTS).max(MAX_AMOUNT_CENTS),
    unit: z.enum(RATE_UNIT_VALUES),
    // Omitted = effective today (Chicago). When present it may schedule a
    // future change; the route rejects back-dating (would corrupt as-charged
    // history).
    effective_from: z
      .string()
      .regex(ISO_DATE, 'must be YYYY-MM-DD')
      .refine(isValidCalendarDate, 'not a real calendar date')
      .optional(),
    note: z.string().max(500).optional(),
  })
  .strict();

type ServiceCategory = (typeof serviceCategory.enumValues)[number];
type RateUnit = (typeof rateUnit.enumValues)[number];

interface StaffRateWire {
  category: ServiceCategory;
  location: LocationKey | null;
  amount_cents: number;
  unit: RateUnit;
  effective_from: string;
  effective_to: string | null;
  note: string | null;
}

function toStaffRateWire(row: StaffServiceRateRow): StaffRateWire {
  return {
    category: row.category,
    location: row.location,
    amount_cents: row.amount_cents,
    unit: row.unit,
    effective_from: row.effective_from,
    effective_to: row.effective_to,
    note: row.note,
  };
}

export interface StaffRatesRouteOptions extends AuthRouteOptions {
  /** Injectable clock so contract tests pin a deterministic "today" for the
   *  active/scheduled filter + the back-date check. Default = `new Date()`. */
  now?: () => Date;
}

export function registerStaffRatesRoute(
  app: FastifyInstance,
  opts: StaffRatesRouteOptions = {},
): void {
  const authHook = resolveAuthHook(opts);
  const nowFactory = opts.now ?? ((): Date => new Date());

  // --- GET /staff/rates -------------------------------------------------
  // Every rate row active or scheduled at today (expired history excluded).
  app.get('/staff/rates', { preHandler: [authHook] }, async (request): Promise<StaffRateWire[]> => {
    const principal = requirePrincipal(request);
    requireStaff(principal, 'read service rates');
    const today = bucketChicagoToday(nowFactory());
    const rows = await serviceRatesRepository.findActiveAndScheduledForStaff(today);
    return rows.map(toStaffRateWire);
  });

  // --- POST /staff/rates ------------------------------------------------
  // Set the rate for one (category, location) track, effective-dated. Returns
  // the resulting current/scheduled row. Idempotency-Key required.
  app.post('/staff/rates', { preHandler: [authHook] }, async (request): Promise<StaffRateWire> => {
    const principal = requirePrincipal(request);
    requireStaff(principal, 'set a service rate');
    const body = parseOrThrow(postBodySchema, request.body, 'body');
    const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);

    const today = bucketChicagoToday(nowFactory());
    const effectiveFrom = body.effective_from ?? today;
    if (effectiveFrom < today) {
      throw new ApiError(
        'invalid_payload',
        `effective_from ${effectiveFrom} is in the past (today in America/Chicago is ${today}); rates can't be back-dated`,
      );
    }
    if (PER_DAY_REQUIRED_CATEGORIES.has(body.category) && body.unit !== 'per-day') {
      throw new ApiError(
        'invalid_payload',
        `${body.category} is billed per booking day; unit must be 'per-day' (got '${body.unit}')`,
      );
    }

    const outcome = await withMutation<StaffRateWire>(
      {
        principal,
        idempotencyKey,
        endpoint: 'POST /staff/rates',
        requestHash: hashRequestBody({ ...body, effective_from: effectiveFrom }),
        // No cache wipe: service_rates is read direct from pg (no Redis read-
        // through) by both GET /rates and the PAYG booking path — they observe
        // the new row on the next read with no invalidation hop.
        keysToInvalidate: () => [],
      },
      async (tx) => {
        // Advisory lock per (category, location) so two concurrent edits to the
        // same track serialize — otherwise both could read "no open row" and
        // leave two open windows.
        const result = await withServiceRateLock(tx, body.category, body.location, () =>
          serviceRatesRepository.supersedeRate(tx, {
            category: body.category,
            location: body.location,
            amountCents: body.amount_cents,
            unit: body.unit,
            effectiveFrom,
            note: body.note ?? null,
          }),
        );
        if (result.kind === 'conflict') {
          throw new ApiError(
            'conflict',
            `a later rate for ${body.category} @ ${body.location} already takes effect ${result.scheduledFrom}; choose an effective_from on or after it, or edit that row`,
          );
        }
        return { status: 200, body: toStaffRateWire(result.row) };
      },
    );

    return outcome.body;
  });
}
