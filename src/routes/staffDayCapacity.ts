import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import type {
  DayCapacityWire,
  LocationKey,
  PutStaffDayCapacityRequest,
} from '../contracts/wire.js';
import type { Equal, Expect } from '../contracts/typeAsserts.js';
import { hashRequestBody, requireIdempotencyKey, withMutation } from '../db/mutation.js';
import { dayCapacityRepository } from '../db/repositories/dayCapacityRepository.js';
import { settingsRepository } from '../db/repositories/settingsRepository.js';
import { LOCATION_SLUGS } from '../db/schema/schema.js';
import type { Tx } from '../db/tx.js';
import { dayCapacityFor, dayCapacityWire } from '../lib/availability.js';
import { assertCapEditKeepsBooked } from '../lib/capLowering.js';
import { isValidCalendarDate } from '../lib/chicagoDate.js';
import { requireStaff } from '../lib/principalNarrows.js';
import { INT4_MAX } from '../lib/settingsRegistry.js';
import { parseOrThrow } from '../lib/zodIssues.js';

/**
 * `PUT` and `DELETE /staff/day-capacity/:location/:date` `[staff]` — one campus's
 * cap on one date, the store of `day.capacity_override_dogs` (DAY-U07, DAY-11,
 * DAY-67; wire `PutStaffDayCapacityRequest`).
 *
 * `PUT` is an upsert: it sets the date's seats, opens a date the rule closes (a
 * weekend included) and re-opens a withdrawn date. `DELETE` withdraws the override,
 * so the date falls back to the campus's rule. A `DELETE` that finds no live override
 * changes nothing, runs no check and is still 200, so PUT, DELETE, PUT on one date is
 * 200 three times.
 *
 * Any staff role, at either campus: `home_locations` is descriptive and refuses
 * nothing (STAFF-71, STAFF-73). An owner principal is 403.
 *
 * Both run the one cap-lowering check (`lib/capLowering.ts`) inside `withMutation`,
 * under the date's `(location, date)` lock, and answer the date's `DayCapacityWire`
 * read in the write's transaction.
 *
 * The idempotency claim is on the key alone and the endpoint is the route pattern,
 * so the `requestHash` must carry the path: without it, one key sent to a second date
 * would replay the first date's response and write nothing.
 *
 * Both invalidate `avail:{location}:*`, the one cache a `day_capacity` write stales.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const pathSchema = z.object({
  location: z.enum(LOCATION_SLUGS),
  date: z
    .string()
    .regex(ISO_DATE, 'must be YYYY-MM-DD')
    .refine(isValidCalendarDate, 'not a real calendar date'),
});

const putBodySchema = z.object({ capacity_dogs: z.number().int().min(0).max(INT4_MAX) }).strict();

/** Zod ↔ wire pin (§5.1.3). */
export type PutStaffDayCapacityBodyConformance = Expect<
  Equal<z.input<typeof putBodySchema>, PutStaffDayCapacityRequest>
>;

export interface StaffDayCapacityRouteOptions extends AuthRouteOptions {
  /** Injectable clock: "within the horizon" is reckoned from it. */
  now?: () => Date;
}

/** The date as it now stands, read in the write's transaction. */
async function dateInTx(tx: Tx, location: LocationKey, date: string): Promise<DayCapacityWire> {
  const rule = await settingsRepository.dayCampus(location, tx);
  const [override] = await dayCapacityRepository.findLiveOverridesInTx(tx, location, date, date);
  const [count] = await dayCapacityRepository.findBookedCountsInRange(location, date, date, tx);
  return dayCapacityWire(location, date, dayCapacityFor(date, rule, override), count?.booked ?? 0);
}

export function registerStaffDayCapacityRoute(
  app: FastifyInstance,
  opts: StaffDayCapacityRouteOptions = {},
): void {
  const authHook = resolveAuthHook(opts);
  const nowFactory = opts.now ?? ((): Date => new Date());

  app.put(
    '/staff/day-capacity/:location/:date',
    { preHandler: [authHook] },
    async (request): Promise<DayCapacityWire> => {
      const principal = requirePrincipal(request);
      requireStaff(principal, "set a date's capacity");
      const { location, date } = parseOrThrow(pathSchema, request.params, 'path');
      const body = parseOrThrow(putBodySchema, request.body, 'body');
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);

      const outcome = await withMutation<DayCapacityWire>(
        {
          principal,
          idempotencyKey,
          endpoint: 'PUT /staff/day-capacity/:location/:date',
          requestHash: hashRequestBody({ location, date, ...body }),
          patternsToInvalidate: () => [`avail:${location}:*`],
        },
        async (tx) => {
          await assertCapEditKeepsBooked(tx, {
            location,
            now: nowFactory(),
            edit: { kind: 'date', date, capacityAfter: body.capacity_dogs },
          });
          await dayCapacityRepository.upsertOverride(tx, {
            location,
            date,
            capacityDogs: body.capacity_dogs,
            staffId: principal.staffId,
          });
          return { status: 200, body: await dateInTx(tx, location, date) };
        },
      );
      return outcome.body;
    },
  );

  app.delete(
    '/staff/day-capacity/:location/:date',
    { preHandler: [authHook] },
    async (request): Promise<DayCapacityWire> => {
      const principal = requirePrincipal(request);
      requireStaff(principal, "withdraw a date's capacity");
      const { location, date } = parseOrThrow(pathSchema, request.params, 'path');
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);

      const outcome = await withMutation<DayCapacityWire>(
        {
          principal,
          idempotencyKey,
          endpoint: 'DELETE /staff/day-capacity/:location/:date',
          requestHash: hashRequestBody({ location, date }),
          patternsToInvalidate: () => [`avail:${location}:*`],
        },
        async (tx) => {
          await assertCapEditKeepsBooked(tx, {
            location,
            now: nowFactory(),
            edit: { kind: 'date', date, capacityAfter: 'rule' },
          });
          await dayCapacityRepository.withdrawOverride(tx, {
            location,
            date,
            staffId: principal.staffId,
          });
          return { status: 200, body: await dateInTx(tx, location, date) };
        },
      );
      return outcome.body;
    },
  );
}
