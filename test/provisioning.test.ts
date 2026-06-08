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

// --- parseInvite (pure: payload → mirror target, or precise 422) ---

function envelope(meta: Record<string, unknown>, email = 'jane@example.com') {
  return { record: { id: randomUUID(), email, raw_user_meta_data: meta } };
}

test('parses a valid owner invite', () => {
  const t = parseInvite(envelope({ name: 'Jane', phone: '555', location: 'Fayetteville, AR' }));
  assert.equal(t.kind, 'owner');
  assert.equal(t.kind === 'owner' && t.email, 'jane@example.com');
});

test('owner invite missing phone → 422 naming the field', () => {
  assert.throws(
    () => parseInvite(envelope({ name: 'Jane', location: 'Fayetteville, AR' })),
    (e) => e instanceof ApiError && e.status === 422 && /phone/.test((e as Error).message),
  );
});

test('app_role present → provisioned as staff', () => {
  const t = parseInvite(envelope({ name: 'Fed', app_role: 'trainer' }));
  assert.equal(t.kind, 'staff');
  assert.equal(t.kind === 'staff' && t.role, 'trainer');
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
