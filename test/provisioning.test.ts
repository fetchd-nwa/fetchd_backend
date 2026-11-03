import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { ApiError } from '../src/lib/errors.js';
import { makeVerifyWebhook } from '../src/auth/webhookSignature.js';
import { parseInvite } from '../src/auth/provisioning.js';
import { registerAuth } from '../src/auth/plugin.js';
import { registerAuthWebhook } from '../src/routes/authWebhook.js';
import { db } from '../src/db/client.js';
import { owners } from '../src/db/schema/schema.js';

// --- Standard Webhooks signature verification (pure, no infra) ---

const SECRET = 'whsec_dGVzdC1zZWNyZXQtMzI=';
const verify = makeVerifyWebhook(SECRET, () => 1_700_000_000_000);

function sign(id: string, ts: string, body: string): string {
  const key = Buffer.from(SECRET.slice('whsec_'.length), 'base64');
  return 'v1,' + createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64');
}

test('accepts a correctly signed, in-window webhook', () => {
  const body = '{"hello":"world"}';
  const ts = '1700000000';
  assert.doesNotThrow(() =>
    verify({ id: 'msg_1', timestamp: ts, signature: sign('msg_1', ts, body) }, body),
  );
});

test('rejects a tampered body', () => {
  const ts = '1700000000';
  const sig = sign('msg_1', ts, '{"hello":"world"}');
  assert.throws(
    () => verify({ id: 'msg_1', timestamp: ts, signature: sig }, '{"hello":"evil"}'),
    (e) => e instanceof ApiError && e.status === 401,
  );
});

test('rejects a stale timestamp (replay)', () => {
  const body = '{}';
  const ts = '1699990000'; // ~2.8h before the fixed clock
  assert.throws(
    () => verify({ id: 'm', timestamp: ts, signature: sign('m', ts, body) }, body),
    (e) => e instanceof ApiError && /tolerance/.test((e as Error).message),
  );
});

test('rejects missing signature headers', () => {
  assert.throws(
    () => verify({ id: undefined, timestamp: undefined, signature: undefined }, '{}'),
    (e) => e instanceof ApiError && e.code === 'unauthenticated',
  );
});

// --- parseInvite (pure: payload → the skip and its reason, or a precise 422) ---

function envelope(meta: Record<string, unknown>, email = 'jane@example.com') {
  return { record: { id: randomUUID(), email, raw_user_meta_data: meta } };
}

// ACCT-U04 (design §2.2:2244; X9): the webhook stops minting owners. The seed
// and the import write owner rows; an INSERT without `app_role` in the
// server-written app metadata is skipped, owner fields or not.
test('a complete owner set in user metadata, no app_role → skipped: the webhook mints no owner', () => {
  assert.deepEqual(
    parseInvite(envelope({ name: 'Jane', phone: '555', location: 'Fayetteville, AR' })),
    { kind: 'skip', reason: 'no_app_role' },
  );
});

test('a partial owner set → skipped, never 422: the partial-metadata refusal went with the owner branch', () => {
  assert.deepEqual(parseInvite(envelope({ name: 'Jane', location: 'Fayetteville, AR' })), {
    kind: 'skip',
    reason: 'no_app_role',
  });
});

// ACCT-U05 (design §2.1:2099-2115, :1713; DECISIONS 42/L5): the webhook never
// creates a staff row. `raw_user_meta_data` is what a client's signUp writes, so
// an `app_role` there is just another field: skipped like any app-role-less
// INSERT, never staff.
test('app_role in user metadata → skipped like any app-role-less INSERT, never staff', () => {
  assert.deepEqual(parseInvite(envelope({ name: 'Fed', app_role: 'trainer' })), {
    kind: 'skip',
    reason: 'no_app_role',
  });
});

test('app_role alone in user metadata, no owner field → skipped, never staff', () => {
  assert.deepEqual(parseInvite(envelope({ app_role: 'owner' })), {
    kind: 'skip',
    reason: 'no_app_role',
  });
});

test('app_role in app metadata (server-written) → skipped: the staff row is staff:provision’s', () => {
  const record = {
    record: {
      id: randomUUID(),
      email: 'amber@example.com',
      raw_app_meta_data: { provider: 'email', providers: ['email'], app_role: 'manager' },
      raw_user_meta_data: { name: 'Amber', phone: '555', location: 'Bentonville, AR' },
    },
  };
  assert.deepEqual(parseInvite(record), { kind: 'skip', reason: 'staff_app_role' });
});

test('unrecognized envelope → 422', () => {
  assert.throws(
    () => parseInvite({ not: 'a supabase record' }),
    (e) => e instanceof ApiError && e.code === 'invalid_payload',
  );
});

// --- Webhook route: signature is enforced before any provisioning work ---

function webhookApp(verifyImpl: typeof verify) {
  const app = Fastify();
  registerAuth(app);
  registerAuthWebhook(app, verifyImpl);
  return app;
}

test('webhook with no signature → 401, no provisioning attempted', async () => {
  const res = await webhookApp(verify).inject({
    method: 'POST',
    url: '/auth/webhook',
    payload: { record: { id: randomUUID(), email: 'a@b.co', raw_user_meta_data: {} } },
  });
  assert.equal(res.statusCode, 401);
});

// --- ACCT-U05 end to end: what the route writes, counted in the database ---

const dbGate = typeof process.env.DATABASE_URL === 'string' ? false : 'DATABASE_URL not set';

async function rowsFor(uid: string): Promise<{ staff: number; owners: number }> {
  const [s] = (
    await db.execute(sql`select count(*)::int as n from staff where supabase_uid = ${uid}`)
  ).rows as Array<{ n: number }>;
  const [o] = (
    await db.execute(sql`select count(*)::int as n from owners where supabase_uid = ${uid}`)
  ).rows as Array<{ n: number }>;
  return { staff: s?.n ?? -1, owners: o?.n ?? -1 };
}

async function cleanup(uid: string): Promise<void> {
  await db.execute(sql`delete from staff where supabase_uid = ${uid}`);
  await db.execute(sql`delete from owners where supabase_uid = ${uid}`);
}

function postRecord(record: Record<string, unknown>, logs?: string[], type?: string) {
  const app = Fastify({
    logger:
      logs === undefined
        ? false
        : { level: 'info', stream: { write: (line: string) => void logs.push(line) } },
  });
  registerAuth(app);
  registerAuthWebhook(app, () => undefined);
  // A Supabase database webhook's envelope carries the event `type` beside the record.
  const payload =
    type === undefined
      ? { record }
      : { type, table: 'users', schema: 'auth', record, old_record: record };
  return app.inject({ method: 'POST', url: '/auth/webhook', payload });
}

test(
  'ACCT-U05: app_role in raw_app_meta_data → 200 skipped, and nothing is written',
  { skip: dbGate },
  async () => {
    const uid = randomUUID();
    try {
      const res = await postRecord({
        id: uid,
        email: 'amber@example.com',
        raw_app_meta_data: { provider: 'email', app_role: 'manager' },
        raw_user_meta_data: { name: 'Amber', phone: '555', location: 'Bentonville, AR' },
      });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(res.json().result, 'skipped');
      assert.deepEqual(await rowsFor(uid), { staff: 0, owners: 0 });
    } finally {
      await cleanup(uid);
    }
  },
);

test(
  'ACCT-U05: a sign-up carrying app_role in raw_user_meta_data never mints staff — the live hole',
  { skip: dbGate },
  async () => {
    // Today's hole: signUp({options: {data: {app_role: 'owner-shanthi', …}}}).
    // From ACCT-U04 (3.0.0-lg2.1) each is 200 skipped with nothing written:
    // no staff row, and no owner row either — the webhook mints neither.
    const metas = [
      { app_role: 'owner-shanthi', name: 'Mallory' },
      { app_role: 'trainer' },
      { app_role: 'owner-shanthi', name: 'Mallory', phone: '555', location: 'Fayetteville, AR' },
    ];
    const seen: Array<{ status: number; result: unknown; staff: number; owners: number }> = [];
    for (const meta of metas) {
      const uid = randomUUID();
      try {
        const res = await postRecord({
          id: uid,
          email: 'mallory@example.com',
          raw_user_meta_data: meta,
        });
        const rows = await rowsFor(uid);
        seen.push({ status: res.statusCode, result: res.json().result, ...rows });
      } finally {
        await cleanup(uid);
      }
    }
    assert.deepEqual(
      seen,
      metas.map(() => ({ status: 200, result: 'skipped', staff: 0, owners: 0 })),
    );
  },
);

test(
  'ACCT-U05: neither app_role nor an owner field → 200 {result: skipped}, no write, never 422',
  { skip: dbGate },
  async () => {
    const uid = randomUUID();
    try {
      const res = await postRecord({
        id: uid,
        email: 'script-created@example.com',
        raw_app_meta_data: { provider: 'email', providers: ['email'] },
        raw_user_meta_data: {},
      });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(res.json().result, 'skipped');
      assert.deepEqual(await rowsFor(uid), { staff: 0, owners: 0 });
    } finally {
      await cleanup(uid);
    }
  },
);

test(
  'ACCT-U04: a complete owner sign-up → 200 skipped, and 0 owner rows: the webhook mints no owner',
  { skip: dbGate },
  async () => {
    const uid = randomUUID();
    try {
      const res = await postRecord({
        id: uid,
        email: 'jane@example.com',
        raw_user_meta_data: { name: 'Jane', phone: '555', location: 'Fayetteville, AR' },
      });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(res.json().result, 'skipped');
      assert.deepEqual(await rowsFor(uid), { staff: 0, owners: 0 });
    } finally {
      await cleanup(uid);
    }
  },
);

test(
  'ACCT-U05: the handler logs the record’s keys and the app-metadata keys — names, never values',
  { skip: dbGate },
  async () => {
    const uid = randomUUID();
    const logs: string[] = [];
    try {
      await postRecord(
        {
          id: uid,
          email: 'secret-address@example.com',
          raw_app_meta_data: { provider: 'email', app_role: 'manager' },
          raw_user_meta_data: { name: 'Secret Name' },
        },
        logs,
      );
      const lines = logs.map((l) => JSON.parse(l) as Record<string, unknown>);
      const keysLine = lines.find((l) => Array.isArray(l.app_metadata_keys));
      assert.ok(keysLine !== undefined, `no key-names log line: ${logs.join('')}`);
      assert.deepEqual(keysLine.app_metadata_keys, ['provider', 'app_role']);
      assert.ok(Array.isArray(keysLine.record_keys));
      assert.ok((keysLine.record_keys as string[]).includes('raw_app_meta_data'));
      const all = logs.join('\n');
      for (const value of ['manager', 'secret-address@example.com', 'Secret Name', uid]) {
        assert.ok(!all.includes(value), `a value reached the log: ${value}`);
      }
    } finally {
      await cleanup(uid);
    }
  },
);

// DECISIONS 78 (adversary L1): ACCT-U05 describes the INSERT alone. Bound to
// UPDATE, every sign-in (GoTrue updates last_sign_in_at) would re-run the owner
// upsert, and its RELINK would un-expire a soft-expired family.
test('a payload type other than INSERT → skipped, owner fields or not', () => {
  for (const type of ['UPDATE', 'DELETE', 'insert', 7]) {
    const t = parseInvite({
      type,
      record: {
        id: randomUUID(),
        email: 'jane@example.com',
        raw_user_meta_data: { name: 'Jane', phone: '555', location: 'Fayetteville, AR' },
      },
    });
    assert.equal(t.kind, 'skip', JSON.stringify(type));
  }
});

/** The skip reason the route logged with its outcome (names, never values). */
function loggedReason(logs: string[]): unknown {
  const line = logs
    .map((l) => JSON.parse(l) as { outcome?: { reason?: unknown } })
    .find((l) => l.outcome !== undefined);
  return line?.outcome?.reason;
}

test(
  'DECISIONS 78: an UPDATE carrying complete owner fields → 200 skipped not_insert, zero rows; the INSERT twin is skipped too (ACCT-U04)',
  { skip: dbGate },
  async () => {
    const meta = { name: 'Jane', phone: '555', location: 'Fayetteville, AR' };
    const uid = randomUUID();
    try {
      const updateLogs: string[] = [];
      const res = await postRecord(
        { id: uid, email: 'jane@example.com', raw_user_meta_data: meta },
        updateLogs,
        'UPDATE',
      );
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(res.json().result, 'skipped');
      assert.equal(loggedReason(updateLogs), 'not_insert');
      assert.deepEqual(await rowsFor(uid), { staff: 0, owners: 0 });

      const insertLogs: string[] = [];
      const insert = await postRecord(
        { id: uid, email: 'jane@example.com', raw_user_meta_data: meta },
        insertLogs,
        'INSERT',
      );
      assert.equal(insert.statusCode, 200, insert.body);
      assert.equal(insert.json().result, 'skipped');
      assert.equal(loggedReason(insertLogs), 'no_app_role');
      assert.deepEqual(await rowsFor(uid), { staff: 0, owners: 0 });
    } finally {
      await cleanup(uid);
    }
  },
);

test('valid signature but unusable payload → 422 (pre-DB)', async () => {
  const res = await webhookApp(() => undefined).inject({
    method: 'POST',
    url: '/auth/webhook',
    payload: { garbage: true },
  });
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().error.code, 'invalid_payload');
});

// --- The audited write, end to end: an UPDATE under `withActor`'s actor is
// captured by the schema's `audit_capture` trigger with the right actor. Fully
// rolled back via a sentinel — zero net writes to the live DB. DB-gated. ---

const dbConfigured = typeof process.env.DATABASE_URL === 'string';

test(
  'an audited UPDATE records the stamped app.actor',
  { skip: dbConfigured ? false : 'DATABASE_URL not set' },
  async () => {
    class Rollback extends Error {}
    let captured: Record<string, unknown> | undefined;

    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.actor', 'owner:audit-it', true)`);
        const [created] = await tx
          .insert(owners)
          .values({
            supabaseUid: randomUUID(),
            name: 'Audit Tmp',
            email: 'audit-tmp@example.com',
            phone: '000',
            location: 'fayetteville',
          })
          .returning({ id: owners.id });
        assert.ok(created);
        await tx.update(owners).set({ phone: '111' }).where(eq(owners.id, created.id));
        const log = await tx.execute(
          sql`select actor, op, table_name from audit_log where row_pk = ${created.id} order by at desc limit 1`,
        );
        captured = log.rows[0];
        throw new Rollback();
      }),
      Rollback,
    );

    assert.equal(String(captured?.actor), 'owner:audit-it');
    assert.equal(String(captured?.op), 'UPDATE');
    assert.equal(String(captured?.table_name), 'owners');
  },
);
