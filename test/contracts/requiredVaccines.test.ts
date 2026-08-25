import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { requiredVaccines } from '../../src/db/schema/schema.js';
import { registerRequiredVaccinesRoute } from '../../src/routes/requiredVaccines.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  loadSnapshot,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';

registerFixtureHooks();

test(
  'GET /required-vaccines byte-matches the DATA-CONTRACT §C catalog shape',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerRequiredVaccinesRoute(app, { authenticate });

    const res = await app.inject({ method: 'GET', url: '/required-vaccines' });
    if (res.statusCode !== 200) {
      throw new Error(`/required-vaccines returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('required-vaccines'));
  },
);

test(
  'GET /required-vaccines emits exempt_class_keys, including a non-empty list',
  SKIP_WHEN_NO_DB,
  async () => {
    // Delete-first: a prior crashed run can leave the PK row behind
    // (the booking-approval-divert suite's convention for this table).
    await db.delete(requiredVaccines).where(eq(requiredVaccines.key, 'test-rabies-exempt'));
    await db.insert(requiredVaccines).values({
      key: 'test-rabies-exempt',
      label: 'Rabies (exempt-arm fixture)',
      gatesCategories: ['group-class'],
      exemptClassKeys: ['puppy'],
    });
    try {
      const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
      registerRequiredVaccinesRoute(app, { authenticate });

      const res = await app.inject({ method: 'GET', url: '/required-vaccines' });
      assert.equal(res.statusCode, 200, res.body);
      const rows = res.json() as {
        key: string;
        exempt_class_keys: string[];
      }[];
      // Every row carries the key — it is NOT NULL DEFAULT '{}' on the wire.
      for (const row of rows) {
        assert.ok(Array.isArray(row.exempt_class_keys), `${row.key} missing exempt_class_keys`);
      }
      const exempt = rows.find((r) => r.key === 'test-rabies-exempt');
      assert.deepStrictEqual(exempt?.exempt_class_keys, ['puppy']);
    } finally {
      await db.delete(requiredVaccines).where(eq(requiredVaccines.key, 'test-rabies-exempt'));
    }
  },
);
