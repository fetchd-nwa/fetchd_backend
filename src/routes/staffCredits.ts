import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePrincipal, resolveAuthHook, type AuthRouteOptions } from '../auth/plugin.js';
import { requireCreditEditRole } from '../auth/requireCreditEditRole.js';
import type { Equal, Expect } from '../contracts/typeAsserts.js';
import {
  BOOKING_MODES,
  CREDIT_TIERS,
  type CreditLotDetailWire,
  type PatchStaffCreditLotsRequest,
  type PostStaffOwnersCreditAdjustmentsRequest,
  type StaffCreditPoolWire,
  type StaffOwnerCreditsWire,
} from '../contracts/wire.js';
import { db } from '../db/client.js';
import { lockPools } from '../db/locks.js';
import { hashRequestBody, requireIdempotencyKey, withMutation } from '../db/mutation.js';
import {
  creditLedgerRepository,
  findGrantLot,
  findLotDetails,
  type CreditPool,
  type LotDetailRow,
} from '../db/repositories/creditLedgerRepository.js';
import { creditPackagesRepository } from '../db/repositories/creditPackagesRepository.js';
import { creditsInvalidationPattern } from '../db/repositories/creditsRepository.js';
import { dogsRepository } from '../db/repositories/dogsRepository.js';
import { ownersRepository } from '../db/repositories/ownersRepository.js';
import { settingsRepository } from '../db/repositories/settingsRepository.js';
import { LOCATION_SLUGS } from '../db/schema/schema.js';
import type { Tx } from '../db/tx.js';
import { bucketChicagoToday } from '../lib/chicagoDate.js';
import { addChicagoMonths } from '../lib/creditExpiry.js';
import { ApiError } from '../lib/errors.js';
import { pgTimestampToIso } from '../lib/pgTimestamp.js';
import { requireStaff } from '../lib/principalNarrows.js';
import { uuidId } from '../lib/uuidId.js';
import { parseOrThrow } from '../lib/zodIssues.js';

/**
 * Staff's hand on an owner's credits (design §1.1:988-1001, §2.4:3073-3098; CRED-U14,
 * CRED-U15). Any staff role reads the pools (DECISIONS 174(e)), and the two writes are the
 * role list's (`requireCreditEditRole`, read at the verb):
 *
 *   - `POST /staff/owners/:ownerId/credit-adjustments` adds a lot or takes credits off one.
 *     Each is a ledger row carrying the staffer and the reason.
 *   - `PATCH /staff/credit-lots/:id` moves a lot's date, and writes one history row from the
 *     locked read. A lot past its date is live again once its date is later (CRED-62),
 *     because liveness is computed at read.
 *
 * Both take the pool lock, the last of the booking order (`db/locks.ts`), so a hand remove
 * and a booking debit cannot both spend one credit. Each refusal with a clock in it runs
 * inside the mutation, behind the claim: a replay outlives every clock.
 */

// `:id`, like the other `/staff/owners/:id/*` routes: one radix node holds one param name.
const ownerParamSchema = z.object({ id: uuidId('id must be a UUID') });
const lotParamSchema = z.object({ id: uuidId('id must be a UUID') });

const noteSchema = z.string().min(1).max(500);
const instantSchema = z.string().datetime({ offset: true });

const adjustmentBodySchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('add'),
      location: z.enum(LOCATION_SLUGS),
      mode: z.enum(BOOKING_MODES),
      tier: z.enum(CREDIT_TIERS),
      credits: z.number().int().positive(),
      expires_at: instantSchema.optional(),
      note: noteSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('remove'),
      lot_id: uuidId('lot_id must be a UUID'),
      credits: z.number().int().positive(),
      note: noteSchema,
    })
    .strict(),
]);

const lotBodySchema = z.object({ expires_at: instantSchema, note: noteSchema }).strict();

/** Zod ↔ wire pins (design §5.1.3, `z.input`). */
export type PostStaffOwnersCreditAdjustmentsBodyConformance = Expect<
  Equal<z.input<typeof adjustmentBodySchema>, PostStaffOwnersCreditAdjustmentsRequest>
>;
export type PatchStaffCreditLotsBodyConformance = Expect<
  Equal<z.input<typeof lotBodySchema>, PatchStaffCreditLotsRequest>
>;

type AdjustmentBody = z.infer<typeof adjustmentBodySchema>;
type AddBody = Extract<AdjustmentBody, { kind: 'add' }>;
type RemoveBody = Extract<AdjustmentBody, { kind: 'remove' }>;

export interface StaffCreditsRouteOptions extends AuthRouteOptions {
  /** Injectable clock: "now" for a date's refusal and a default expiry, "today" for a read. */
  now?: () => Date;
}

function notInFuture(): ApiError {
  return new ApiError('expiry_not_in_future', 'that date is not later than now');
}

function lotNotFound(lotId: string): ApiError {
  return new ApiError('not_found', `lot ${lotId} not found`);
}

function toLotWire(row: LotDetailRow): CreditLotDetailWire {
  return {
    id: row.id,
    reason: row.reason,
    granted: row.granted,
    remaining: row.remaining,
    granted_at: pgTimestampToIso(row.created_at),
    expires_at: pgTimestampToIso(row.expires_at),
    live: row.live,
    ...(row.package_id !== null ? { package_id: row.package_id } : {}),
    ...(row.charge_id !== null ? { charge_id: row.charge_id } : {}),
    ...(row.note !== null ? { note: row.note } : {}),
    ...(row.created_by_staff_id !== null ? { created_by_staff_id: row.created_by_staff_id } : {}),
    last_expiry_edit:
      row.edit_from !== null &&
      row.edit_to !== null &&
      row.edit_note !== null &&
      row.edit_at !== null
        ? {
            from: pgTimestampToIso(row.edit_from),
            to: pgTimestampToIso(row.edit_to),
            staff_id: row.edit_staff_id,
            note: row.edit_note,
            at: pgTimestampToIso(row.edit_at),
          }
        : null,
    booked_ahead: { count: row.booked_dates.length, dates: row.booked_dates },
  };
}

const samePool = (a: Omit<CreditPool, 'ownerId'>, b: Omit<CreditPool, 'ownerId'>): boolean =>
  a.location === b.location && a.mode === b.mode && a.tier === b.tier;

/** The order `StaffOwnerCreditsWire` promises: location, program, regular before alumni. */
function byPool(a: StaffCreditPoolWire, b: StaffCreditPoolWire): number {
  return (
    a.location.localeCompare(b.location) ||
    a.mode.localeCompare(b.mode) ||
    CREDIT_TIERS.indexOf(a.tier) - CREDIT_TIERS.indexOf(b.tier)
  );
}

/** Every pool that has a lot, whatever is left in it. */
async function poolsOf(
  runner: Tx | typeof db,
  args: { ownerId: string; today: string; only?: CreditPool },
): Promise<StaffCreditPoolWire[]> {
  const { ownerId, today, only } = args;
  const lots = await findLotDetails(runner, {
    ownerId,
    today,
    ...(only !== undefined ? { pool: only } : {}),
  });
  const balances = await creditLedgerRepository.ownerBalances(runner, ownerId);
  const pools: StaffCreditPoolWire[] = [];
  for (const row of lots) {
    const pool = pools.find((candidate) => samePool(candidate, row));
    if (pool !== undefined) {
      pool.lots.push(toLotWire(row));
      continue;
    }
    pools.push({
      location: row.location,
      mode: row.mode,
      tier: row.tier,
      balance: balances.find((candidate) => samePool(candidate, row))?.balance ?? 0,
      lots: [toLotWire(row)],
    });
  }
  return pools.sort(byPool);
}

/** The refusals of a pool no v1 booking can draw from (design §2.4:3088-3089). */
async function assertPoolBookable(tx: Tx, pool: CreditPool, today: string): Promise<void> {
  const rows = await creditPackagesRepository.findLiveForProgram(tx, {
    location: pool.location,
    mode: pool.mode,
    today,
  });
  if (rows.length === 0) {
    throw new ApiError('pool_not_bookable', `no package sells ${pool.mode} at ${pool.location}`);
  }
  if (pool.tier === 'alumni' && !(await dogsRepository.ownerHasAlumniDog(tx, pool.ownerId))) {
    throw new ApiError('pool_not_bookable', 'this account has no alumni dog');
  }
}

async function addCredits(
  tx: Tx,
  args: { ownerId: string; body: AddBody; staffId: string; now: Date; today: string },
): Promise<CreditPool> {
  const { ownerId, body, staffId, now, today } = args;
  const pool: CreditPool = { ownerId, location: body.location, mode: body.mode, tier: body.tier };
  const { manual_grant_expiry_months: months } = await settingsRepository.credit(tx);
  const expiresAt =
    body.expires_at !== undefined ? new Date(body.expires_at) : addChicagoMonths(now, months);
  if (expiresAt.getTime() <= now.getTime()) throw notInFuture();
  await assertPoolBookable(tx, pool, today);
  await lockPools(tx, [pool]);
  await creditLedgerRepository.addHandLot(tx, {
    ...pool,
    credits: body.credits,
    expiresAt,
    note: body.note,
    staffId,
  });
  return pool;
}

async function removeCredits(
  tx: Tx,
  args: { ownerId: string; body: RemoveBody; staffId: string },
): Promise<CreditPool> {
  const { ownerId, body, staffId } = args;
  const lot = await findGrantLot(tx, body.lot_id);
  if (lot === undefined || lot.ownerId !== ownerId) throw lotNotFound(body.lot_id);
  await lockPools(tx, [lot]);
  const unspent = await creditLedgerRepository.lotUnspentInTx(tx, lot.id);
  if (body.credits > unspent) {
    throw new ApiError('lot_insufficient', `this lot has ${unspent} unspent`);
  }
  await creditLedgerRepository.removeFromLot(tx, {
    lot,
    credits: body.credits,
    note: body.note,
    staffId,
  });
  return lot;
}

export function registerStaffCreditsRoute(
  app: FastifyInstance,
  opts: StaffCreditsRouteOptions = {},
): void {
  const authHook = resolveAuthHook(opts);
  const nowFactory = opts.now ?? ((): Date => new Date());

  app.get(
    '/staff/owners/:id/credits',
    { preHandler: [authHook] },
    async (request): Promise<StaffOwnerCreditsWire> => {
      const principal = requirePrincipal(request);
      requireStaff(principal, "read an owner's credits");
      const { id: ownerId } = parseOrThrow(ownerParamSchema, request.params, 'path');
      if (!(await ownersRepository.existsLive(db, ownerId))) {
        throw new ApiError('not_found', `owner ${ownerId} not found`);
      }
      const { expiry_enforced_enabled: enforced } = await settingsRepository.credit();
      return {
        owner_id: ownerId,
        expiry_enforced: enforced,
        pools: await poolsOf(db, { ownerId, today: bucketChicagoToday(nowFactory()) }),
      };
    },
  );

  app.post(
    '/staff/owners/:id/credit-adjustments',
    { preHandler: [authHook, requireCreditEditRole] },
    async (request, reply): Promise<StaffCreditPoolWire> => {
      const principal = requirePrincipal(request);
      requireStaff(principal, "adjust an owner's credits");
      const { id: ownerId } = parseOrThrow(ownerParamSchema, request.params, 'path');
      const body = parseOrThrow(adjustmentBodySchema, request.body, 'body');
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);

      const outcome = await withMutation<StaffCreditPoolWire>(
        {
          principal,
          idempotencyKey,
          endpoint: 'POST /staff/owners/:id/credit-adjustments',
          requestHash: hashRequestBody({ ownerId, ...body }),
          patternsToInvalidate: () => [creditsInvalidationPattern(ownerId)],
        },
        async (tx) => {
          if (!(await ownersRepository.existsLive(tx, ownerId))) {
            throw new ApiError('not_found', `owner ${ownerId} not found`);
          }
          const now = nowFactory();
          const today = bucketChicagoToday(now);
          const staffId = principal.staffId;
          const pool =
            body.kind === 'add'
              ? await addCredits(tx, { ownerId, body, staffId, now, today })
              : await removeCredits(tx, { ownerId, body, staffId });
          const [changed] = await poolsOf(tx, { ownerId, today, only: pool });
          if (changed === undefined) throw new Error('the changed pool read back empty');
          return { status: 201, body: changed };
        },
      );

      reply.code(outcome.status);
      return outcome.body;
    },
  );

  app.patch(
    '/staff/credit-lots/:id',
    { preHandler: [authHook, requireCreditEditRole] },
    async (request): Promise<CreditLotDetailWire> => {
      const principal = requirePrincipal(request);
      requireStaff(principal, "move a lot's date");
      const { id } = parseOrThrow(lotParamSchema, request.params, 'path');
      const body = parseOrThrow(lotBodySchema, request.body, 'body');
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
      let creditsOwnerId: string | undefined;

      const outcome = await withMutation<CreditLotDetailWire>(
        {
          principal,
          idempotencyKey,
          endpoint: 'PATCH /staff/credit-lots/:id',
          requestHash: hashRequestBody({ id, ...body }),
          patternsToInvalidate: () =>
            creditsOwnerId !== undefined ? [creditsInvalidationPattern(creditsOwnerId)] : [],
        },
        async (tx) => {
          const lot = await findGrantLot(tx, id);
          if (lot === undefined) throw lotNotFound(id);
          const now = nowFactory();
          const to = new Date(body.expires_at);
          if (to.getTime() <= now.getTime()) throw notInFuture();
          await lockPools(tx, [lot]);
          await creditLedgerRepository.moveLotExpiry(tx, {
            lotId: id,
            to,
            note: body.note,
            staffId: principal.staffId,
          });
          creditsOwnerId = lot.ownerId;
          const [moved] = await findLotDetails(tx, {
            ownerId: lot.ownerId,
            today: bucketChicagoToday(now),
            lotId: id,
          });
          if (moved === undefined) throw new Error(`lot ${id} read back empty`);
          return { status: 200, body: toLotWire(moved) };
        },
      );

      return outcome.body;
    },
  );
}
