import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq, sql } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { owners } from '../src/db/schema/schema.js';
import { live } from '../src/db/softExpire.js';

// --- live() compile/sanity (the type bound is the real guarantee) ---

test('live(table) returns a defined SQL expression for a soft-expire table', () => {
  const expr = live(owners);
  assert.ok(expr);
});

// --- The soft-expire → audit_log story end-to-end. DB-gated. ---
//
// Day 3 Exit check #1: a row that gets soft-expired is captured by the
// `audit_capture` AFTER UPDATE trigger with `op='UPDATE'` and the prior LIVE
// row (`expired_at IS NULL`) preserved in `before`. The actor is read from
// `app.actor` (stamped via `withActor` / direct set_config), so the audit row
// records exactly who soft-expired it. Rolled back via a sentinel — zero net
// writes to the live DB.

const dbConfigured = typeof process.env.DATABASE_URL === 'string';

test(
  'soft-expire UPDATE on a soft-expire table is captured in audit_log with the live prior state',
  { skip: dbConfigured ? false : 'DATABASE_URL not set' },
  async () => {
    class Rollback extends Error {}
    let captured: Record<string, unknown> | undefined;

    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.actor', 'owner:soft-expire-test', true)`);

        const [created] = await tx
          .insert(owners)
          .values({
            supabaseUid: randomUUID(),
            name: 'Soft Expire Tmp',
            email: `soft-expire-${randomUUID()}@example.com`,
            phone: '000',
            location: 'fayetteville',
          })
          .returning();
        assert.ok(created);

        // The soft-expire op: UPDATE ... SET expired_at = now(). NEVER DELETE.
        await tx
          .update(owners)
          .set({ expiredAt: sql`now()` })
          .where(eq(owners.id, created.id));

        const log = await tx.execute(
          sql`select op, actor, before from audit_log
              where table_name = 'owners' and row_pk = ${created.id}
              order by at desc limit 1`,
        );
        captured = log.rows[0];

        throw new Rollback();
      }),
      Rollback,
    );

    assert.equal(String(captured?.op), 'UPDATE');
    assert.equal(String(captured?.actor), 'owner:soft-expire-test');

    // `before` carries the LIVE state at trigger-fire time: expired_at is the
    // OLD value (NULL), proving we caught the soft-expire transition itself
    // rather than a no-op or a re-expire of an already-tombstoned row.
    const before = captured?.before as { expired_at: unknown; id: string } | undefined;
    assert.ok(before);
    assert.equal(before.expired_at, null);
  },
);
