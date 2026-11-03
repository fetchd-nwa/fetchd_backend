import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { owners } from '../../src/db/schema/schema.js';
import { SKIP_WHEN_NO_DB } from './_harness.js';

/**
 * M2.01 (ACCT-U04; design §4 LG2, design.md:6162): an owner's name, phone and
 * home campus may be NULL — an imported family may arrive without any of them
 * (MIG-57), and the sign-up map decides which she must fill. `email` stays
 * NOT NULL: it is the login identity. Run against the test volume, so a volume
 * loaded from the pre-M2.01 `schema.sql` is red here with 23502.
 */

/** The SQLSTATE a refused insert carries, walking Drizzle's `cause` chain. */
function sqlStateOf(err: unknown): string | undefined {
  for (
    let e: unknown = err;
    e !== null && typeof e === 'object';
    e = (e as { cause?: unknown }).cause
  ) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return undefined;
}

test(
  'M2.01: an owners row with name, phone and location all NULL inserts, and reads back NULL',
  SKIP_WHEN_NO_DB,
  async () => {
    const id = randomUUID();
    try {
      await db.insert(owners).values({
        id,
        supabaseUid: randomUUID(),
        name: null,
        email: 'no-contact@example.invalid',
        phone: null,
        location: null,
      });
      const [row] = await db
        .select({ name: owners.name, phone: owners.phone, location: owners.location })
        .from(owners)
        .where(eq(owners.id, id));
      assert.deepEqual(row, { name: null, phone: null, location: null });
    } finally {
      await db.delete(owners).where(eq(owners.id, id));
    }
  },
);

test('M2.01: email stays NOT NULL — the login identity (23502)', SKIP_WHEN_NO_DB, async () => {
  const id = randomUUID();
  try {
    await assert.rejects(
      db.execute(
        sql`INSERT INTO owners (id, supabase_uid, name, email, phone, location)
            VALUES (${id}, ${randomUUID()}, 'No Email', NULL, '555-0199', 'fayetteville')`,
      ),
      (err: unknown) => sqlStateOf(err) === '23502',
    );
  } finally {
    await db.delete(owners).where(eq(owners.id, id));
  }
});
