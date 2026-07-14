import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import { hashRequestBody, requireIdempotencyKey, withMutation } from '../db/mutation.js';
import { creditLedgerRepository } from '../db/repositories/creditLedgerRepository.js';
import { membershipsRepository } from '../db/repositories/membershipsRepository.js';
import type { Tx } from '../db/tx.js';
import { ApiError } from '../lib/errors.js';
import { pgTimestampToDate } from '../lib/pgTimestamp.js';
import { requireStaff } from '../lib/principalNarrows.js';
import { loadMembershipPackage, toMembershipWire, type MembershipWire } from './memberships.js';
import { formatZodIssues } from '../lib/zodIssues.js';

/**
 * §J.1 staff membership verbs — pause is STAFF-MEDIATED, not self-serve
 * (the owner UI carries "reach out to staff to pause").
 *
 *   POST /staff/memberships/:id/pause    stop the roll (paused_at + staff id)
 *   POST /staff/memberships/:id/resume   restart; the clock stopped while
 *                                        paused, so `current_period_end` and
 *                                        `ends_at` shift forward by the gap —
 *                                        the owner keeps the paid-but-unused
 *                                        remainder of the period and the
 *                                        un-billed remainder of the term.
 *
 * Wire = the owner MembershipWire + `owner_id` (staff work cross-owner and
 * need the owner context the owner shape leaves implicit). Follows the
 * staff-route conventions (requireStaff, withMutation + Idempotency-Key,
 * inline wire — NOT portal-mirrored yet; the portal UI lives in the other
 * repo).
 */

interface StaffMembershipWire extends MembershipWire {
  owner_id: string;
}

const idParamSchema = z.object({ id: z.string().uuid('id must be a UUID') });

async function loadStaffWire(tx: Tx, id: string): Promise<StaffMembershipWire> {
  const row = await membershipsRepository.findById(tx, id);
  if (row === undefined) {
    throw new Error(`staffMemberships: ${id} vanished mid-mutation`);
  }
  return { ...toMembershipWire(row, await loadMembershipPackage(row, tx)), owner_id: row.ownerId };
}

export interface StaffMembershipsRouteOptions extends AuthRouteOptions {
  /** Injectable clock for the pause stamp / resume gap-shift. */
  now?: () => Date;
}

export function registerStaffMembershipsRoute(
  app: FastifyInstance,
  opts: StaffMembershipsRouteOptions = {},
): void {
  const authHook = resolveAuthHook(opts);
  const nowFactory = opts.now ?? ((): Date => new Date());

  // --- POST /staff/memberships/:id/pause --------------------------------
  // 404 unknown id; 409 when not active-and-unpaused (double-pausing would
  // silently move paused_at and corrupt the resume gap-shift).
  app.post(
    '/staff/memberships/:id/pause',
    { preHandler: [authHook] },
    async (request): Promise<StaffMembershipWire> => {
      const principal = requirePrincipal(request);
      requireStaff(principal, 'pause a membership');
      const { id } = parseIdParam(request.params);
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
      const now = nowFactory();

      const outcome = await withMutation<StaffMembershipWire>(
        {
          principal,
          idempotencyKey,
          endpoint: 'POST /staff/memberships/:id/pause',
          requestHash: hashRequestBody({ id }),
          keysToInvalidate: () => [],
        },
        async (tx) => {
          const existing = await membershipsRepository.findById(tx, id);
          if (existing === undefined) {
            throw new ApiError('not_found', `membership ${id} not found`);
          }
          const paused = await membershipsRepository.pause(tx, {
            id,
            staffId: principal.staffId,
            now,
          });
          if (paused === 0) {
            throw new ApiError(
              'conflict',
              existing.pausedAt !== null
                ? `membership ${id} is already paused`
                : `membership ${id} is ${existing.status}, not active`,
            );
          }
          return { status: 200, body: await loadStaffWire(tx, id) };
        },
      );

      return outcome.body;
    },
  );

  // --- POST /staff/memberships/:id/resume --------------------------------
  app.post(
    '/staff/memberships/:id/resume',
    { preHandler: [authHook] },
    async (request): Promise<StaffMembershipWire> => {
      const principal = requirePrincipal(request);
      requireStaff(principal, 'resume a membership');
      const { id } = parseIdParam(request.params);
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
      const now = nowFactory();

      // Closure-captured for the post-commit credits-cache wipe (set only
      // when the resume actually shifted the paid month's lot).
      let shiftedLotDogId: string | null = null;

      const outcome = await withMutation<StaffMembershipWire>(
        {
          principal,
          idempotencyKey,
          endpoint: 'POST /staff/memberships/:id/resume',
          requestHash: hashRequestBody({ id }),
          // The lot's expires_at moved — the cached per-dog credit reads
          // (balance + expiring-lots) are stale (§3 map).
          patternsToInvalidate: () =>
            shiftedLotDogId !== null ? [`credits:${shiftedLotDogId}:*`] : [],
        },
        async (tx) => {
          const existing = await membershipsRepository.findById(tx, id);
          if (existing === undefined) {
            throw new ApiError('not_found', `membership ${id} not found`);
          }
          const resumed = await membershipsRepository.resume(tx, { id, now });
          if (resumed === 0) {
            throw new ApiError(
              'conflict',
              existing.pausedAt === null
                ? `membership ${id} is not paused`
                : `membership ${id} is ${existing.status}, not active`,
            );
          }
          // The clock stopped for the CREDITS too: the paid month's lot was
          // stamped expires_at = the pre-shift period end — move it to the
          // shifted end (read back from the row so the two stay exactly
          // aligned). Alumni lots are NULL-expiry and never match.
          const shifted = await membershipsRepository.findById(tx, id);
          if (shifted === undefined) {
            throw new Error(`staffMemberships: ${id} vanished mid-resume`);
          }
          const lotsMoved = await creditLedgerRepository.shiftMembershipGrantExpiry(tx, {
            dogId: existing.dogId,
            fromExpiresAt: existing.currentPeriodEnd,
            to: pgTimestampToDate(shifted.currentPeriodEnd),
          });
          if (lotsMoved > 0) shiftedLotDogId = existing.dogId;
          return { status: 200, body: await loadStaffWire(tx, id) };
        },
      );

      return outcome.body;
    },
  );
}

function parseIdParam(params: unknown): { id: string } {
  const parsed = idParamSchema.safeParse(params);
  if (!parsed.success) {
    throw new ApiError('bad_request', `invalid path: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}
