import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import * as creditExpiry from '../../src/lib/creditExpiry.js';
import { AUDITED_SETTINGS_TABLES, SETTINGS_REGISTRY } from '../../src/lib/settingsRegistry.js';
import { buildApp } from '../../src/server.js';
import { runSchedulerTickOnce } from '../../src/workers/scheduler.js';
import { makeExpoPushStub } from './_expoPushStub.js';
import { FIXTURE_IDS } from './_fixture.js';
import { SKIP_WHEN_NO_DB, registerFixtureHooks } from './_harness.js';
import { makeStripeStub } from './_stripeStub.js';

/**
 * `credit_expiry_settings` is gone (M4.07; design §2.4:2891-2893, CRED-U05): from the
 * volume, from the routes, from the settings and from the code. Each of these executes
 * what used to answer, so a search that misses a reader cannot pass it.
 */

registerFixtureHooks();

const app = buildApp();
after(async () => {
  await app.close();
});

const SHANTI = `staff:${FIXTURE_IDS.staffShanthiId}:owner`;

test('the table is gone from a fresh volume', SKIP_WHEN_NO_DB, async () => {
  const { rows } = await db.execute(
    sql`SELECT to_regclass('credit_expiry_settings')::text AS name`,
  );
  assert.deepEqual(rows, [{ name: null }]);
});

test('the two staff verbs answer 404: the router holds neither', SKIP_WHEN_NO_DB, async () => {
  const reading = await app.inject({
    method: 'GET',
    url: '/staff/credit-expiry-settings',
    headers: { 'x-dev-principal': SHANTI },
  });
  assert.equal(reading.statusCode, 404, reading.body);

  const writing = await app.inject({
    method: 'POST',
    url: '/staff/credit-expiry-settings',
    headers: { 'x-dev-principal': SHANTI, 'idempotency-key': `gone-${randomUUID()}` },
    payload: { location: 'fayetteville', expiry_window_months: 6, warning_lead_days: 14 },
  });
  assert.equal(writing.statusCode, 404, writing.body);
});

test('no setting answers for it, and the audit list does not name it', () => {
  assert.equal(AUDITED_SETTINGS_TABLES.includes('credit_expiry_settings'), false);
  const stored = SETTINGS_REGISTRY.filter((entry) =>
    JSON.stringify(entry.store).includes('credit_expiry_settings'),
  );
  assert.deepEqual(stored, []);
});

test('the one helper is all `lib/creditExpiry.ts` exports', () => {
  assert.deepEqual(Object.keys(creditExpiry).sort(), ['addChicagoMonths']);
});

test(
  'one scheduler tick on a volume without the table logs no error',
  SKIP_WHEN_NO_DB,
  async () => {
    const lines: { level: string; msg: string; err?: unknown }[] = [];
    const log = {
      info: () => undefined,
      warn: (obj: object, msg?: string) => lines.push({ level: 'warn', msg: msg ?? '', err: obj }),
      error: (obj: object, msg?: string) =>
        lines.push({ level: 'error', msg: msg ?? '', err: obj }),
    };
    await runSchedulerTickOnce({
      now: new Date(),
      expoPush: makeExpoPushStub(),
      stripe: makeStripeStub(),
      log,
    });
    assert.deepEqual(
      lines.filter((line) => JSON.stringify(line).includes('42P01')),
      [],
    );
  },
);
