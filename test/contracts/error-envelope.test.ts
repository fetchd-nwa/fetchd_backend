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
 * pins the serializer's branches through a REAL app instance (the live
 * `registerAuth` error mapper — `makeContractApp` wires it, not a re-built
 * lookalike):
 *
 *   1. a gate 422 — `details` present, discriminated by `kind`;
 *   2. a 401 — `details` OMITTED, never null (the key must be absent);
 *   3. a forced non-ApiError throw — the `'internal'` fallback, which is a
 *      member of `ApiErrorCode` precisely so a client switch can't miss it
 *      (api-conventions.md:151);
 *   4. a FASTIFY-originated error — the same `'internal'` fallback branch,
 *      but riding `err.statusCode` straight through, so the client sees
 *      `code: 'internal'` on a 400/413/415. That is the runtime truth
 *      `API_ERROR_STATUS`'s `internal: 500` doc block now cites (2.6
 *      adversary, fix round 1); without this arm the doc's claim is
 *      unpinned prose.
 *
 * **Statuses are asserted as LITERALS, not read out of `API_ERROR_STATUS`.**
 * They used to be read from the table — which made the assertion circular:
 * `assert.equal(res.statusCode, API_ERROR_STATUS['unauthenticated'])` passes
 * for ANY value the table holds, so an edit to the table could never fail
 * here, and the docstring's old claim that "a status edit that escapes the
 * table fails here" described a guard that could not fail (2.6 adversary,
 * fix round 1). The table is instead compared to the same literals ONCE, in
 * its own test below: runtime and contract are two independent readings that
 * have to agree.
 *
 * No DB, no fixtures: the routes below throw before any data layer exists.
 * Proven RED first (2026-08-24, skeleton bump): the details-is-null variant
 * of pin 2 failed against the real serializer before the true key-absent
 * shape was pinned — see the session scratchpad `envelope-red.log`. Pin 4
 * was proven red the same way in the 1.13.0 fix round
 * (`fix-r1/item3-red-passthrough.log`): all three cases were asserted at 500
 * first, and the suite reported 400 / 415 / 413 back — which is how the
 * three statuses below are known rather than assumed.
 */

/** `bodyLimit` for the 413 arm's route — small enough to overshoot cheaply. */
const TINY_BODY_LIMIT = 64;

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
  // Pass-through arms. Neither handler ever runs: Fastify's content-type
  // parser rejects the request before the preHandler, which is exactly the
  // production shape — the error reaches the same `setErrorHandler` with a
  // `statusCode` already on it.
  app.post('/t/echo', { preHandler: [authenticate] }, (request) => request.body);
  app.post(
    '/t/tiny',
    { preHandler: [authenticate], bodyLimit: TINY_BODY_LIMIT },
    (request) => request.body,
  );
  return app;
}

test('gate 422 — nested envelope, details present, discriminated by kind', async () => {
  const app = buildThrowingApp();
  const res = await app.inject({ method: 'GET', url: '/t/gate-422' });
  assert.equal(res.statusCode, 422, res.body);
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
  assert.equal(res.statusCode, 401, res.body);
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
  assert.equal(res.statusCode, 500, res.body);
  assert.deepStrictEqual(res.json(), {
    error: { code: 'internal', message: 'Internal Server Error' },
  });
});

/**
 * The pass-through arm. `auth/plugin.ts`'s fallback branch is
 * `typeof err.statusCode === 'number' ? err.statusCode : 500`, so a Fastify
 * error arrives with its own status and keeps it — while the BODY is still
 * the `internal` envelope. A client that reads `API_ERROR_STATUS.internal`
 * and expects 500 whenever it sees `code: 'internal'` is wrong on every one
 * of these; the table's doc block says so, and this is what makes that
 * sentence checkable.
 *
 * All three cases are collected before asserting so one run reports every
 * status at once rather than stopping at the first.
 */
test("Fastify-originated errors pass their status through under code 'internal'", async () => {
  const app = buildThrowingApp();
  const cases = [
    {
      name: 'malformed JSON body',
      inject: {
        method: 'POST' as const,
        url: '/t/echo',
        headers: { 'content-type': 'application/json' },
        payload: '{"a":',
      },
    },
    {
      name: 'unsupported content-type',
      inject: {
        method: 'POST' as const,
        url: '/t/echo',
        headers: { 'content-type': 'application/xml' },
        payload: '<a/>',
      },
    },
    {
      name: 'body over the route bodyLimit',
      inject: {
        method: 'POST' as const,
        url: '/t/tiny',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ pad: 'x'.repeat(TINY_BODY_LIMIT * 4) }),
      },
    },
  ];

  const observed: { name: string; status: number; body: unknown }[] = [];
  for (const c of cases) {
    const res = await app.inject(c.inject);
    observed.push({ name: c.name, status: res.statusCode, body: res.json() });
  }

  const internalEnvelope = { error: { code: 'internal', message: 'Internal Server Error' } };
  assert.deepStrictEqual(observed, [
    // FST_ERR_CTP_INVALID_JSON_BODY
    { name: 'malformed JSON body', status: 400, body: internalEnvelope },
    // FST_ERR_CTP_INVALID_MEDIA_TYPE
    { name: 'unsupported content-type', status: 415, body: internalEnvelope },
    // FST_ERR_CTP_BODY_TOO_LARGE
    { name: 'body over the route bodyLimit', status: 413, body: internalEnvelope },
  ]);
});

/**
 * The contract half, de-circularized: the table is compared against the same
 * literals the runtime arms above assert. Either side moving alone fails —
 * which is precisely what the old `assert.equal(res.statusCode,
 * API_ERROR_STATUS[code])` form could not do.
 */
test('API_ERROR_STATUS agrees with the statuses this suite observed at runtime', () => {
  assert.equal(API_ERROR_STATUS.vaccine_missing, 422);
  assert.equal(API_ERROR_STATUS.unauthenticated, 401);
  assert.equal(API_ERROR_STATUS.internal, 500);
});
