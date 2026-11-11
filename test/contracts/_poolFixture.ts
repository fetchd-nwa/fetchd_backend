import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { like, sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { creditLedger, creditLotExpiryEdits } from '../../src/db/schema/schema.js';
import type { ApiErrorEnvelope, InsufficientCreditsDetails } from '../../src/contracts/wire.js';
import { FIXTURE_IDS } from './_fixture.js';

/**
 * Credits are the owner's, so a test that counts them needs a pool nothing else touches.
 * These files use Bentonville day school, which the fixture leaves empty, and everything
 * planted carries {@link PLANTED}, so teardown takes exactly what a test added.
 */

export const PLANTED = 'pool-fixture';

export type Campus = 'fayetteville' | 'bentonville';

export async function plantLot(args: {
  credits: number;
  expiresAt: Date | string;
  location?: Campus;
  mode?: 'school' | 'daycare';
  tier?: 'regular' | 'alumni';
}): Promise<string> {
  const id = randomUUID();
  await db.insert(creditLedger).values({
    id,
    ownerId: FIXTURE_IDS.ownerId,
    location: args.location ?? 'bentonville',
    mode: args.mode ?? 'school',
    tier: args.tier ?? 'regular',
    delta: args.credits,
    reason: 'purchase',
    expiresAt: typeof args.expiresAt === 'string' ? args.expiresAt : args.expiresAt.toISOString(),
    note: PLANTED,
  });
  return id;
}

/**
 * Every ledger row of the pools these tests use: a lot, what spent it, and what returned
 * it, in ONE statement. A return names the debit it reverses (M5.10's
 * `reverses_entry_id`) and a fresh-lot return is itself a lot a re-debit can spend, so the
 * rows reference each other both ways; one DELETE of the closure is checked at its end,
 * where none of them is left to dangle.
 */
export async function clearPlantedPools(): Promise<void> {
  // The date history goes first: each row holds its lot.
  await db.delete(creditLotExpiryEdits);
  await db.execute(sql`
    WITH RECURSIVE doomed(id) AS (
      SELECT row.id FROM credit_ledger row
       WHERE row.owner_id = ${FIXTURE_IDS.ownerId}
         AND (row.charge_id IS NOT NULL
           OR row.tier = 'alumni'
           OR row.note LIKE ${`${PLANTED}%`}
           OR (row.location = 'bentonville' AND row.mode = 'school'))
      UNION
      SELECT r.id FROM credit_ledger r JOIN doomed d ON r.lot_id = d.id OR r.reverses_entry_id = d.id
    )
    DELETE FROM credit_ledger WHERE id IN (SELECT id FROM doomed)`);
  await db.delete(creditLedger).where(like(creditLedger.note, `${PLANTED}%`));
}

export async function poolBalance(
  args: { location?: Campus; mode?: 'school' | 'daycare'; tier?: 'regular' | 'alumni' } = {},
): Promise<number> {
  const result = await db.execute(sql`
    SELECT balance::int AS balance FROM owner_credit_balance
     WHERE owner_id = ${FIXTURE_IDS.ownerId}
       AND location = ${args.location ?? 'bentonville'}
       AND mode = ${args.mode ?? 'school'}
       AND tier = ${args.tier ?? 'regular'}`);
  return (result.rows[0] as { balance: number } | undefined)?.balance ?? 0;
}

/** On a connection of its own: `pg_stat_activity` is one snapshot per transaction. */
export async function waitForBlockedBackends(count: number): Promise<void> {
  for (let tries = 0; tries < 300; tries += 1) {
    const { rows } = await db.execute(sql`
      SELECT count(*)::int AS blocked FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'`);
    if ((rows[0] as { blocked: number }).blocked >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`fewer than ${count} requests reached a lock`);
}

export function refusalOf<T>(res: { body: string; statusCode: number }, code: string): T {
  assert.equal(res.statusCode, 422, res.body);
  const { error } = JSON.parse(res.body) as ApiErrorEnvelope;
  assert.equal(error.code, code, res.body);
  return error.details as T;
}

export const insufficient = (res: { body: string; statusCode: number }) =>
  refusalOf<InsufficientCreditsDetails>(res, 'insufficient_credits');
