import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePrincipal, resolveAuthHook, type AuthRouteOptions } from '../auth/plugin.js';
import { requireCreditEditRole } from '../auth/requireCreditEditRole.js';
import type { Equal, Expect } from '../contracts/typeAsserts.js';
import type { CreditPackageWire, PatchStaffCreditPackagesRequest } from '../contracts/wire.js';
import { withCreditPackageLock } from '../db/locks.js';
import { hashRequestBody, requireIdempotencyKey, withMutation } from '../db/mutation.js';
import {
  creditPackagesInvalidationPattern,
  creditPackagesRepository,
} from '../db/repositories/creditPackagesRepository.js';
import { bucketChicagoToday } from '../lib/chicagoDate.js';
import { ApiError } from '../lib/errors.js';
import { requireStaff } from '../lib/principalNarrows.js';
import { parseOrThrow } from '../lib/zodIssues.js';

/**
 * `PATCH /staff/credit-packages/:key` — one catalog row's expiry window, and nothing
 * else (CRED-U08 narrowed; design §1.1:1002-1004, §2.4:3099-3106). Price and credit
 * count are reference data: a change is a seed step, never a route.
 *
 * The next purchase stamps the new months; lots already sold keep their date. The
 * catalog's cache is wiped in this request, so a shop opened one second later reads
 * them. Gated by `staff.credit_hand_edit_role_list` (`requireCreditEditRole`).
 */

// The same bound as `routes/creditPackages.ts`'s path param: a key is `[a-z0-9-]`.
const keyParamSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/i, 'key must be alphanumeric with dashes'),
});

const MIN_EXPIRY_MONTHS = 1;
// `CHECK (expiry_months > 0)` alone would let a fat finger stamp a lot centuries out.
const MAX_EXPIRY_MONTHS = 120;

const patchBodySchema = z
  .object({
    expiry_months: z.number().int().min(MIN_EXPIRY_MONTHS).max(MAX_EXPIRY_MONTHS),
  })
  .strict();

/** Zod ↔ wire pin (design §5.1.3, `z.input`). */
export type PatchStaffCreditPackagesBodyConformance = Expect<
  Equal<z.input<typeof patchBodySchema>, PatchStaffCreditPackagesRequest>
>;

export interface StaffCreditPackagesRouteOptions extends AuthRouteOptions {
  /** Injectable clock: "today" picks the live row and dates its successor. */
  now?: () => Date;
}

export function registerStaffCreditPackagesRoute(
  app: FastifyInstance,
  opts: StaffCreditPackagesRouteOptions = {},
): void {
  const authHook = resolveAuthHook(opts);
  const nowFactory = opts.now ?? ((): Date => new Date());

  app.patch(
    '/staff/credit-packages/:key',
    { preHandler: [authHook, requireCreditEditRole] },
    async (request): Promise<CreditPackageWire> => {
      const principal = requirePrincipal(request);
      requireStaff(principal, 'edit a credit package');
      const { key } = parseOrThrow(keyParamSchema, request.params, 'path');
      const body = parseOrThrow(patchBodySchema, request.body, 'body');
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
      const today = bucketChicagoToday(nowFactory());

      const outcome = await withMutation<CreditPackageWire>(
        {
          principal,
          idempotencyKey,
          endpoint: 'PATCH /staff/credit-packages/:key',
          requestHash: hashRequestBody({ key, ...body }),
          patternsToInvalidate: (wire) => [creditPackagesInvalidationPattern(wire.location)],
        },
        async (tx) => {
          const row = await withCreditPackageLock(tx, key, () =>
            creditPackagesRepository.setExpiryMonths(tx, key, body.expiry_months, today),
          );
          if (row === undefined) {
            throw new ApiError('not_found', `credit package ${key} not found or retired`);
          }
          return { status: 200, body: row };
        },
      );

      return outcome.body;
    },
  );
}
