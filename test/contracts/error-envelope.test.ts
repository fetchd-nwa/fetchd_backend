import assert from 'node:assert/strict';
import { test } from 'node:test';
import { API_ERROR_STATUS } from '../../src/contracts/wire.js';
import { vaccineMissingError } from '../../src/lib/bookingErrors.js';
import { ApiError } from '../../src/lib/errors.js';
import { FIXTURE_OWNER_PRINCIPAL, makeContractApp } from './_harness.js';

/**
 * Wire 1.13.0 §3.3 — the error-envelope byte-shape pin. The envelope was
 * promoted from runtime truth (`auth/plugin.ts` serializer) into the contract
 * (`ApiErrorEnvelope` + `ApiErrorCode` + `ApiErrorDetailWire`); this suite
 * pins the three serializer branches through a REAL app instance (the live
 * `registerAuth` error mapper — `makeContractApp` wires it, not a re-built
 * lookalike):
 *
 *   1. a gate 422 — `details` present, discriminated by `kind`;
 *   2. a 401 — `details` OMITTED, never null (the key must be absent);
 *   3. a forced non-ApiError throw — the `'internal'` fallback, which is a
 *      member of `ApiErrorCode` precisely so a client switch can't miss it
 *      (api-conventions.md:151).
 *
 * Statuses are asserted FROM `API_ERROR_STATUS` — the table is contractual
 * now, so a status edit that escapes the table fails here.
 *
 * No DB, no fixtures: the routes below throw before any data layer exists.
 * Proven RED first (2026-08-24, skeleton bump): the details-is-null variant
 * of pin 2 failed against the real serializer before the true
 * key-absent shape was pinned — see the session scratchpad
 * `envelope-red.log`.
 */

function buildThrowingApp(): ReturnType<typeof makeContractApp>['app'] {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  app.get('/t/gate-422', { preHandler: [authenticate] }, () => {
    throw vaccineMissingError([{ dog_id: 'dog-1', requirement_key: 'rabies', label: 'Rabies' }]);
  });
  app.get('/t/unauthenticated', { preHandler: [authenticate] }, () => {
    throw new ApiError('unauthenticated', 'missing or malformed Authorization header');
  });
  app.get('/t/boom', { preHandler: [authenticate] }, () => {
    throw new Error('boom — not an ApiError');
  });
  return app;
}

test('gate 422 — nested envelope, details present, discriminated by kind', async () => {
  const app = buildThrowingApp();
  const res = await app.inject({ method: 'GET', url: '/t/gate-422' });
  assert.equal(res.statusCode, API_ERROR_STATUS['vaccine_missing'], res.body);
  assert.deepStrictEqual(res.json(), {
    error: {
      code: 'vaccine_missing',
      message: 'Required vaccination(s) missing or expired: Rabies.',
      details: {
        kind: 'vaccine_missing',
        missing: [{ dog_id: 'dog-1', requirement_key: 'rabies', label: 'Rabies' }],
      },
    },
  });
});

test('401 — details key is ABSENT (omitted-not-null)', async () => {
  const app = buildThrowingApp();
  const res = await app.inject({ method: 'GET', url: '/t/unauthenticated' });
  assert.equal(res.statusCode, API_ERROR_STATUS['unauthenticated'], res.body);
  const body = res.json() as { error: Record<string, unknown> };
  assert.deepStrictEqual(body, {
    error: { code: 'unauthenticated', message: 'missing or malformed Authorization header' },
  });
  // deepStrictEqual treats `details: undefined` and an absent key as equal on
  // parsed JSON only when the key never serialized — pin the absence
  // explicitly so the omit-on-null rule can't degrade to `details: null`.
  assert.equal('details' in body.error, false, 'details must be OMITTED, not emitted as null');
});

test('non-ApiError throw — the internal fallback envelope', async () => {
  const app = buildThrowingApp();
  const res = await app.inject({ method: 'GET', url: '/t/boom' });
  assert.equal(res.statusCode, API_ERROR_STATUS['internal'], res.body);
  assert.deepStrictEqual(res.json(), {
    error: { code: 'internal', message: 'Internal Server Error' },
  });
});
