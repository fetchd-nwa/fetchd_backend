import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerAvailabilityRoute } from '../../src/routes/availability.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  loadSnapshot,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';

registerFixtureHooks();

test(
  'GET /availability byte-matches the §B DayCapacity wire shape (default rule + sparse overrides)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerAvailabilityRoute(app, { authenticate });

    // 7-day window: Fri/Sat/Sun/Mon/Tue/Wed/Thu starting 2026-05-15. Hits
    // both override rows (Sun OPEN @ 2026-05-17, Tue CLOSED @ 2026-05-19)
    // plus the weekend-closed default (Sat 2026-05-16) and four weekday
    // defaults (Fri/Mon/Wed/Thu = 3/3).
    const res = await app.inject({
      method: 'GET',
      url: '/availability?from=2026-05-15&to=2026-05-21&mode=school&location=fayetteville',
    });
    if (res.statusCode !== 200) {
      throw new Error(`/availability returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('availability-fayetteville'));
  },
);

test(
  'GET /availability for bentonville falls through to defaults (no override rows)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerAvailabilityRoute(app, { authenticate });

    const res = await app.inject({
      method: 'GET',
      url: '/availability?from=2026-05-15&to=2026-05-17&mode=daycare&location=bentonville',
    });
    if (res.statusCode !== 200) {
      throw new Error(`/availability returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('availability-bentonville'));
  },
);

test(
  'GET /availability as staff returns the same data (catalog endpoint, no owner scoping)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
    registerAvailabilityRoute(app, { authenticate });

    const res = await app.inject({
      method: 'GET',
      url: '/availability?from=2026-05-15&to=2026-05-21&mode=school&location=fayetteville',
    });
    assert.equal(res.statusCode, 200);
    assert.deepStrictEqual(res.json(), loadSnapshot('availability-fayetteville'));
  },
);

test('GET /availability with missing params returns 400 bad_request', SKIP_WHEN_NO_DB, async () => {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerAvailabilityRoute(app, { authenticate });

  const res = await app.inject({ method: 'GET', url: '/availability?from=2026-05-15' });
  assert.equal(res.statusCode, 400);
  const body = res.json() as { error?: { code?: string } };
  assert.equal(body.error?.code, 'bad_request');
});

test(
  'GET /availability with bad date format returns 400 bad_request',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerAvailabilityRoute(app, { authenticate });

    const res = await app.inject({
      method: 'GET',
      url: '/availability?from=05/15/2026&to=2026-05-21&mode=school&location=fayetteville',
    });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { error?: { code?: string } };
    assert.equal(body.error?.code, 'bad_request');
  },
);

test(
  'GET /availability with invalid enum value returns 400 bad_request',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerAvailabilityRoute(app, { authenticate });

    const res = await app.inject({
      method: 'GET',
      url: '/availability?from=2026-05-15&to=2026-05-21&mode=school&location=nowhere',
    });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { error?: { code?: string } };
    assert.equal(body.error?.code, 'bad_request');
  },
);

test('GET /availability with from > to returns 422 invalid_payload', SKIP_WHEN_NO_DB, async () => {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerAvailabilityRoute(app, { authenticate });

  const res = await app.inject({
    method: 'GET',
    url: '/availability?from=2026-05-21&to=2026-05-15&mode=school&location=fayetteville',
  });
  assert.equal(res.statusCode, 422);
  const body = res.json() as { error?: { code?: string } };
  assert.equal(body.error?.code, 'invalid_payload');
});

test(
  'GET /availability over the 92-date cap returns 422 invalid_payload',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerAvailabilityRoute(app, { authenticate });

    // 93-day window — one day past the cap.
    const res = await app.inject({
      method: 'GET',
      url: '/availability?from=2026-05-01&to=2026-08-01&mode=school&location=fayetteville',
    });
    assert.equal(res.statusCode, 422);
    const body = res.json() as { error?: { code?: string } };
    assert.equal(body.error?.code, 'invalid_payload');
  },
);

test(
  'GET /availability skips a soft-expired override (live() filter), falling back to the default rule',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerAvailabilityRoute(app, { authenticate });

    // 2026-05-22 (Fri) has an EXPIRED override (0/0). The route should
    // emit weekday defaults 3/3 because `live(dayCapacity)` drops the
    // expired row before the override map is built.
    const res = await app.inject({
      method: 'GET',
      url: '/availability?from=2026-05-22&to=2026-05-22&mode=school&location=fayetteville',
    });
    assert.equal(res.statusCode, 200);
    assert.deepStrictEqual(res.json(), [
      {
        location: 'fayetteville',
        date: '2026-05-22',
        school_openings: 3,
        daycare_openings: 3,
      },
    ]);
  },
);

test(
  'GET /availability with semantically-invalid YYYY-MM-DD (2026-13-40) returns 400 bad_request',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerAvailabilityRoute(app, { authenticate });

    const res = await app.inject({
      method: 'GET',
      url: '/availability?from=2026-13-40&to=2026-05-21&mode=school&location=fayetteville',
    });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { error?: { code?: string } };
    assert.equal(body.error?.code, 'bad_request');
  },
);

// Wire 1.13.0 §5.4 guard: `mode` is validated against the contract tuple
// BOOKING_MODES instead of a re-derivation of the booking_mode pgEnum. The
// suite pinned a bad `location` but never a bad `mode`, so nothing would have
// caught the swap widening or narrowing the accepted set. Both members are
// exercised as accepted above (mode=school, mode=daycare).
test(
  'GET /availability with a non-member mode returns 400 bad_request',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerAvailabilityRoute(app, { authenticate });

    const res = await app.inject({
      method: 'GET',
      url: '/availability?from=2026-05-15&to=2026-05-21&mode=boarding&location=fayetteville',
    });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { error?: { code?: string } };
    assert.equal(body.error?.code, 'bad_request');
  },
);
