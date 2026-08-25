import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import type { CancelWindowSettingWire, PatchStaffCancelWindowRequest } from '../contracts/wire.js';
import type { Equal, Expect } from '../contracts/typeAsserts.js';
import { hashRequestBody, requireIdempotencyKey, withMutation } from '../db/mutation.js';
import { cancelWindowSettingsRepository } from '../db/repositories/cancelWindowSettingsRepository.js';
import type { ServiceCategory } from '../lib/bookingBucket.js';
import { ApiError } from '../lib/errors.js';
import { pgEnumTuple } from '../lib/pgEnumTuple.js';
import { pgTimestampToIso } from '../lib/pgTimestamp.js';
import { requireStaff } from '../lib/principalNarrows.js';
import { parseOrThrow } from '../lib/zodIssues.js';
import { serviceCategory } from '../db/schema/schema.js';

/**
 * `GET /staff/cancel-window` `[staff]` + `PATCH /staff/cancel-window/
 * :category` `[staff]` — Day-13 staff portal verb 3 family. Owner-
 * tunable per-category free-cancel hours; one row per service_category;
 * seeded at 48h flat in `schema.sql`.
 *
 * URL surface is `/staff/cancel-window/*` to mirror the existing staff
 * verbs (`/staff/requests/*`). Owner principals get 403; the data is
 * staff-config, not a per-owner read.
 *
 * Wire shape per category row:
 *   { category, hours_before, updated_at, updated_by_staff_id }
 *
 * `updated_at` is ISO; `updated_by_staff_id` is the staff member who
 * last edited the row (NULL = still the seeded default — useful for
 * portal UX "policy never customized" hint).
 *
 * Active-policy authority: the `cancel_window_settings` row is what
 * booking creation reads via `cancelWindowSettingsRepository.
 * resolveHoursFor(category)` to stamp `bookings.cancel_deadline_at`.
 * Editing a row changes future bookings; existing bookings keep the
 * deadline they were stamped with at creation time.
 */

const SERVICE_CATEGORY_VALUES = pgEnumTuple(serviceCategory);

const categoryParamSchema = z.object({
  category: z.enum(SERVICE_CATEGORY_VALUES),
});

const patchBodySchema = z
  .object({
    // 1h floor — anything less makes "same-day cancel" the policy,
    // which doesn't fit any of the business categories we run.
    // 720h (30 days) ceiling — same scale as the longest B&T window
    // we'd ever realistically run; cap exists so a typo can't push
    // the policy to a year and silently block all cancels.
    hours_before: z.number().int().min(1).max(720),
  })
  .strict();

/** Wire 1.13.0 §5.1.3 — the body type and this schema are the same shape or
 *  `tsc` fails here. `z.input`, not `z.infer`: the wire documents what a
 *  client may SEND. Exported so no unused-symbol rule can eat the pin. */
export type PatchStaffCancelWindowBodyConformance = Expect<
  Equal<z.input<typeof patchBodySchema>, PatchStaffCancelWindowRequest>
>;

// CancelWindowSettingWire is owned by the single-source contract
// (contracts/wire.ts) as of 1.13.0.

function toWire(row: {
  category: ServiceCategory;
  hoursBefore: number;
  updatedAt: string;
  updatedByStaffId: string | null;
}): CancelWindowSettingWire {
  return {
    category: row.category,
    hours_before: row.hoursBefore,
    updated_at: pgTimestampToIso(row.updatedAt),
    updated_by_staff_id: row.updatedByStaffId,
  };
}

export function registerStaffCancelWindowRoute(
  app: FastifyInstance,
  opts: AuthRouteOptions = {},
): void {
  const authHook = resolveAuthHook(opts);

  // --- GET /staff/cancel-window ----------------------------------------
  // Lists every category's current free-cancel policy. Always 7 rows
  // (one per service_category) given the schema seed.
  app.get(
    '/staff/cancel-window',
    { preHandler: [authHook] },
    async (request): Promise<CancelWindowSettingWire[]> => {
      const principal = requirePrincipal(request);
      requireStaff(principal, 'read the cancel-window policy');
      const rows = await cancelWindowSettingsRepository.findAll();
      return rows.map(toWire);
    },
  );

  // --- PATCH /staff/cancel-window/:category ----------------------------
  // Update one category's `hours_before`. Stamps `updated_at = now()`
  // and `updated_by_staff_id`. Returns the updated wire row.
  //
  // Active-policy effect: future bookings of this category stamp
  // their `cancel_deadline_at` using the new hours. Existing rows
  // keep their original stamped deadline — promise made at booking
  // time honors at cancel time even when the policy moves later.
  app.patch(
    '/staff/cancel-window/:category',
    { preHandler: [authHook] },
    async (request): Promise<CancelWindowSettingWire> => {
      const principal = requirePrincipal(request);
      requireStaff(principal, 'edit the cancel-window policy');
      const { category } = parseOrThrow(categoryParamSchema, request.params, 'path');
      const body = parseOrThrow(patchBodySchema, request.body, 'body');
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);

      const outcome = await withMutation<CancelWindowSettingWire>(
        {
          principal,
          idempotencyKey,
          endpoint: 'PATCH /staff/cancel-window/:category',
          requestHash: hashRequestBody({ category, ...body }),
          // No cache wipe: cancel_window_settings is read direct from
          // pg (no Redis read-through). Future bookings naturally
          // observe the new policy. Existing booking-list / availability
          // caches don't depend on the policy value — the resolved
          // deadline is on the booking row.
          keysToInvalidate: () => [],
        },
        async (tx) => {
          const row = await cancelWindowSettingsRepository.updateHoursFor(tx, {
            category,
            hoursBefore: body.hours_before,
            staffId: principal.staffId,
          });
          if (row === undefined) {
            // Shouldn't happen — the schema seeds all 7 categories.
            // Surface as 404 so the operator gets a clean signal if
            // they accidentally DROPped the row in dev.
            throw new ApiError(
              'not_found',
              `cancel_window_settings has no row for ${category} — re-seed required`,
            );
          }
          return { status: 200, body: toWire(row) };
        },
      );

      return outcome.body;
    },
  );
}
