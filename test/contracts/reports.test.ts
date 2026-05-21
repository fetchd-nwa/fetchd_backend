import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerReportsRoute } from '../../src/routes/reports.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  loadSnapshot,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';

registerFixtureHooks();

// --- GET /dogs/:id/reports ---------------------------------------------

test(
  'GET /dogs/:id/reports byte-matches §B Report wire shape (Waffles: foundation curriculum + 3 variant programs — private-lesson + board-train + group-class, DESC by date)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerReportsRoute(app, { authenticate });
    const res = await app.inject({ method: 'GET', url: `/dogs/${FIXTURE_IDS.dog1Id}/reports` });
    if (res.statusCode !== 200) {
      throw new Error(`/dogs/.../reports returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('reports-waffles'));
  },
);

test(
  'GET /dogs/:id/reports for Lola byte-matches §B Report (boarding-session variant, no trainer, results-null branch)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerReportsRoute(app, { authenticate });
    const res = await app.inject({ method: 'GET', url: `/dogs/${FIXTURE_IDS.dog2Id}/reports` });
    if (res.statusCode !== 200) {
      throw new Error(`/dogs/.../reports returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('reports-lola'));
  },
);

test('GET /dogs/:id/reports as a staff principal returns []', SKIP_WHEN_NO_DB, async () => {
  const { app, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
  registerReportsRoute(app, { authenticate });
  const res = await app.inject({ method: 'GET', url: `/dogs/${FIXTURE_IDS.dog1Id}/reports` });
  assert.equal(res.statusCode, 200);
  assert.deepStrictEqual(res.json(), []);
});

test('GET /dogs/not-a-uuid/reports returns 400 bad_request', SKIP_WHEN_NO_DB, async () => {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerReportsRoute(app, { authenticate });
  const res = await app.inject({ method: 'GET', url: '/dogs/not-a-uuid/reports' });
  assert.equal(res.statusCode, 400);
  const body = res.json() as { error?: { code?: string } };
  assert.equal(body.error?.code, 'bad_request');
});

// --- GET /reports/:id --------------------------------------------------

test(
  'GET /reports/:id (private-lesson) byte-matches §B Report with variant content + sparse curriculum envelope',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerReportsRoute(app, { authenticate });
    const res = await app.inject({
      method: 'GET',
      url: `/reports/${FIXTURE_IDS.reportPrivateLessonId}`,
    });
    if (res.statusCode !== 200) {
      throw new Error(`/reports/:id returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('report-private-lesson'));
  },
);

test(
  'GET /reports/:id (boarding) byte-matches §B Report with boarding_session_content variant',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerReportsRoute(app, { authenticate });
    const res = await app.inject({
      method: 'GET',
      url: `/reports/${FIXTURE_IDS.reportBoardingId}`,
    });
    if (res.statusCode !== 200) {
      throw new Error(`/reports/:id returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('report-boarding'));
  },
);

test(
  'GET /reports/:id (board-train) byte-matches §B Report with board_train_session_content variant',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerReportsRoute(app, { authenticate });
    const res = await app.inject({
      method: 'GET',
      url: `/reports/${FIXTURE_IDS.reportBoardTrainId}`,
    });
    if (res.statusCode !== 200) {
      throw new Error(`/reports/:id returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('report-board-train'));
  },
);

test(
  'GET /reports/:id (group-class) byte-matches §B Report with group_class_session_content variant',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerReportsRoute(app, { authenticate });
    const res = await app.inject({
      method: 'GET',
      url: `/reports/${FIXTURE_IDS.reportGroupClassId}`,
    });
    if (res.statusCode !== 200) {
      throw new Error(`/reports/:id returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('report-group-class'));
  },
);

test('GET /reports/:id for an unknown UUID returns 404 not_found', SKIP_WHEN_NO_DB, async () => {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerReportsRoute(app, { authenticate });
  const res = await app.inject({
    method: 'GET',
    url: '/reports/11111111-1111-4111-8111-111111111199',
  });
  assert.equal(res.statusCode, 404);
  const body = res.json() as { error?: { code?: string } };
  assert.equal(body.error?.code, 'not_found');
});

test('GET /reports/:id as a staff principal returns 404 not_found', SKIP_WHEN_NO_DB, async () => {
  const { app, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
  registerReportsRoute(app, { authenticate });
  const res = await app.inject({
    method: 'GET',
    url: `/reports/${FIXTURE_IDS.reportFoundationId}`,
  });
  assert.equal(res.statusCode, 404);
});

// --- GET /dogs/:id/reports/latest -------------------------------------

test(
  'GET /dogs/:id/reports/latest (Waffles) byte-matches the foundation curriculum report',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerReportsRoute(app, { authenticate });
    const res = await app.inject({
      method: 'GET',
      url: `/dogs/${FIXTURE_IDS.dog1Id}/reports/latest`,
    });
    if (res.statusCode !== 200) {
      throw new Error(`/dogs/.../reports/latest returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('report-foundation'));
  },
);

test(
  'GET /dogs/:id/reports/latest as a staff principal returns null',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
    registerReportsRoute(app, { authenticate });
    const res = await app.inject({
      method: 'GET',
      url: `/dogs/${FIXTURE_IDS.dog1Id}/reports/latest`,
    });
    assert.equal(res.statusCode, 200);
    assert.deepStrictEqual(res.json(), null);
  },
);

// --- GET /dogs/:id/reports/resolve -------------------------------------

test(
  "GET /dogs/:id/reports/resolve?reportId=<dog1's private-lesson> returns that exact report",
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerReportsRoute(app, { authenticate });
    const res = await app.inject({
      method: 'GET',
      url: `/dogs/${FIXTURE_IDS.dog1Id}/reports/resolve?reportId=${FIXTURE_IDS.reportPrivateLessonId}`,
    });
    if (res.statusCode !== 200) {
      throw new Error(`/resolve returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('report-private-lesson'));
  },
);

test(
  'GET /dogs/:id/reports/resolve?program=private-lesson returns the most-recent matching',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerReportsRoute(app, { authenticate });
    const res = await app.inject({
      method: 'GET',
      url: `/dogs/${FIXTURE_IDS.dog1Id}/reports/resolve?program=private-lesson`,
    });
    if (res.statusCode !== 200) {
      throw new Error(`/resolve returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('report-private-lesson'));
  },
);

test(
  'GET /dogs/:id/reports/resolve (no args) falls back to the most-recent report overall',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerReportsRoute(app, { authenticate });
    const res = await app.inject({
      method: 'GET',
      url: `/dogs/${FIXTURE_IDS.dog1Id}/reports/resolve`,
    });
    if (res.statusCode !== 200) {
      throw new Error(`/resolve returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('report-foundation'));
  },
);

test(
  "GET /dogs/:id/reports/resolve?reportId=<wrong-dog's report> falls through to the latest for THIS dog",
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerReportsRoute(app, { authenticate });
    // reportBoardingId belongs to dog2 (Lola); we ask for it on dog1 (Waffles).
    // The exact-id branch SHOULD NOT return it; the fallback returns Waffles'
    // latest (foundation).
    const res = await app.inject({
      method: 'GET',
      url: `/dogs/${FIXTURE_IDS.dog1Id}/reports/resolve?reportId=${FIXTURE_IDS.reportBoardingId}`,
    });
    if (res.statusCode !== 200) {
      throw new Error(`/resolve returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('report-foundation'));
  },
);

test(
  'GET /dogs/:id/reports/resolve?program=invalid returns 400 bad_request',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerReportsRoute(app, { authenticate });
    const res = await app.inject({
      method: 'GET',
      url: `/dogs/${FIXTURE_IDS.dog1Id}/reports/resolve?program=not-a-program`,
    });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { error?: { code?: string } };
    assert.equal(body.error?.code, 'bad_request');
  },
);

test(
  'GET /dogs/:id/reports/resolve as a staff principal returns null',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
    registerReportsRoute(app, { authenticate });
    const res = await app.inject({
      method: 'GET',
      url: `/dogs/${FIXTURE_IDS.dog1Id}/reports/resolve`,
    });
    assert.equal(res.statusCode, 200);
    assert.deepStrictEqual(res.json(), null);
  },
);
