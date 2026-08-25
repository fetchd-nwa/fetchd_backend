import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import type {
  PostStaffRatesRequest,
  StaffRateWire,
  StaffRateHistoryWire,
} from '../contracts/wire.js';
import type { Equal, Expect } from '../contracts/typeAsserts.js';
import { hashRequestBody, requireIdempotencyKey, withMutation } from '../db/mutation.js';
import { withServiceRateLock } from '../db/locks.js';
import {
  serviceRatesRepository,
  type StaffRateHistoryRow,
  type StaffServiceRateRow,
} from '../db/repositories/serviceRatesRepository.js';
import { LOCATION_SLUGS, rateUnit, serviceCategory } from '../db/schema/schema.js';
import { bucketChicagoToday, isValidCalendarDate } from '../lib/chicagoDate.js';
import { ApiError } from '../lib/errors.js';
import { pgEnumTuple } from '../lib/pgEnumTuple.js';
import { requireStaff } from '../lib/principalNarrows.js';
import { formatZodIssues, parseOrThrow } from '../lib/zodIssues.js';

/**
 * Staff per-location service-rate editor (DATA-CONTRACT §B Rate + 2026-06-20
 * amendment). Owner-facing pricing is read-only at `GET /rates`; this is the
 * write side, owner principals get 403.
 *
 *   GET  /staff/rates                       active + scheduled catalog
 *   GET  /staff/rates/history?category&loc  full change log for one track
 *   POST /staff/rates                       set a rate (effective-dated supersede)
 *   POST /staff/rates/:id/void              cancel/remove an entry
 *
 * `service_rates` is **append-only**: a price change closes the open window's
 * `effective_to` and inserts a new row; a same-day re-edit voids the prior
 * entry and inserts a new one; a cancel voids an entry (reopening its
 * predecessor). `amount_cents`/`unit`/`note` are never overwritten — so a past
 * booking's as-charged rate (and a locked PAYG invoice) survive every change,
 * and the rows themselves form the audit-able change history. All writes run
 * under `withServiceRateLock` (per-track advisory lock) so concurrent edits
 * can't corrupt the windows.
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
 * their unit is unconstrained here (the PAYG charger also guards this defensively).
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

const historyQuerySchema = z.object({
  category: z.enum(SERVICE_CATEGORY_VALUES),
  location: z.enum(LOCATION_VALUES),
});

const uuidParamSchema = z.object({ id: z.string().uuid() });

/** Wire 1.13.0 §5.1.3 — the body type and `postBodySchema` are the same shape
 *  or `tsc` fails here. `z.input`, not `z.infer`: `effective_from` and `note`
 *  are optional on the WIRE because a client may omit them, even though the
 *  route defaults `effective_from` to today-in-Chicago afterwards. Exported so
 *  no unused-symbol rule can eat the pin. */
export type PostStaffRatesBodyConformance = Expect<
  Equal<z.input<typeof postBodySchema>, PostStaffRatesRequest>
>;

// StaffRateWire + StaffRateHistoryWire are owned by the single-source contract
// (contracts/wire.ts).

function toStaffRateWire(row: StaffServiceRateRow): StaffRateWire {
  return {
    id: row.id,
    category: row.category,
    location: row.location,
    amount_cents: row.amount_cents,
    unit: row.unit,
    effective_from: row.effective_from,
    effective_to: row.effective_to,
    note: row.note,
    created_by_staff_id: row.created_by_staff_id,
  };
}

function toHistoryWire(row: StaffRateHistoryRow): StaffRateHistoryWire {
  return {
    ...toStaffRateWire(row),
    created_at: row.created_at,
    voided_at: row.voided_at,
    voided_by_staff_id: row.voided_by_staff_id,
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
  // Every rate row active or scheduled at today (expired + voided excluded).
  app.get('/staff/rates', { preHandler: [authHook] }, async (request): Promise<StaffRateWire[]> => {
    const principal = requirePrincipal(request);
    requireStaff(principal, 'read service rates');
    const today = bucketChicagoToday(nowFactory());
    const rows = await serviceRatesRepository.findActiveAndScheduledForStaff(today);
    return rows.map(toStaffRateWire);
  });

  // --- GET /staff/rates/history?category=&location= ---------------------
  // The full change log for one track (every row incl. expired + voided),
  // newest first — the append-only rows ARE the history.
  app.get(
    '/staff/rates/history',
    { preHandler: [authHook] },
    async (request): Promise<StaffRateHistoryWire[]> => {
      const principal = requirePrincipal(request);
      requireStaff(principal, 'read rate history');
      const { category, location } = parseQuery(historyQuerySchema, request.query);
      const rows = await serviceRatesRepository.findHistoryForTrack(category, location);
      return rows.map(toHistoryWire);
    },
  );

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
        // through) by both GET /rates and the PAYG booking path.
        keysToInvalidate: () => [],
      },
      async (tx) => {
        const result = await withServiceRateLock(tx, body.category, body.location, () =>
          serviceRatesRepository.supersedeRate(tx, {
            category: body.category,
            location: body.location,
            amountCents: body.amount_cents,
            unit: body.unit,
            effectiveFrom,
            note: body.note ?? null,
            createdByStaffId: principal.staffId,
          }),
        );
        return { status: 200, body: toStaffRateWire(result.row) };
      },
    );

    return outcome.body;
  });

  // --- POST /staff/rates/:id/void ---------------------------------------
  // Cancel/remove one entry (a scheduled future change or the current rate).
  // Soft-voids it and reopens its predecessor so no pricing gap opens — there
  // is no way to trap a track. Returns the voided row. Idempotency-Key required.
  app.post(
    '/staff/rates/:id/void',
    { preHandler: [authHook] },
    async (request): Promise<StaffRateWire> => {
      const principal = requirePrincipal(request);
      requireStaff(principal, 'void a service rate');
      const { id } = parseUuidParam(request.params);
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);

      const outcome = await withMutation<StaffRateWire>(
        {
          principal,
          idempotencyKey,
          endpoint: 'POST /staff/rates/:id/void',
          requestHash: hashRequestBody({ id }),
          keysToInvalidate: () => [],
        },
        async (tx) => {
          // (category, location) are immutable, so reading them for the lock key
          // outside the lock is safe; the void+reopen runs under the lock.
          const track = await serviceRatesRepository.findTrackById(id, tx);
          if (track === undefined) {
            throw new ApiError('not_found', `service rate ${id} not found`);
          }
          const voided = await withServiceRateLock(tx, track.category, track.location ?? '', () =>
            serviceRatesRepository.voidRate(tx, { id, voidedByStaffId: principal.staffId }),
          );
          if (voided === undefined) {
            // Vanished or already voided between the track read and the lock.
            throw new ApiError('not_found', `service rate ${id} not found`);
          }
          return { status: 200, body: toStaffRateWire(voided) };
        },
      );

      return outcome.body;
    },
  );
}

function parseQuery<T extends z.ZodTypeAny>(schema: T, raw: unknown): z.infer<T> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError('bad_request', `invalid query: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}

function parseUuidParam(params: unknown): { id: string } {
  const parsed = uuidParamSchema.safeParse(params);
  if (!parsed.success) {
    throw new ApiError('bad_request', `invalid path: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}
