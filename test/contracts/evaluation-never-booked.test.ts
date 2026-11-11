import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { sql } from 'drizzle-orm';
import type { ApiErrorEnvelope } from '../../src/contracts/wire.js';
import { db } from '../../src/db/client.js';
import { registerBookingsRoute } from '../../src/routes/bookings.js';
import { registerRequestsRoute } from '../../src/routes/requests.js';
import { createFundedDog, removeDogs } from './_dayFixture.js';
import { FIXTURE_NOW, futureWeekday } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
  registerRequestServicesOn,
} from './_harness.js';
import { makeStripeStub } from './_stripeStub.js';

/**
 * No evaluation booking can arise in M1 (P20 `plan_added`, B1-8): neither the day-program
 * booking nor the request flow takes category `'evaluation'`, and a refused request
 * writes no booking, order or request row. Today's code already refuses both
 * (`bookings.ts` `z.enum(['day-school', 'day-care'])`, `requests.ts`
 * `REQUEST_CATEGORIES`), so this test is proved red by mutation: `'evaluation'` added to
 * each accepted list in a scratch copy.
 */

registerFixtureHooks();
registerRequestServicesOn();
const createdDogs: string[] = [];
after(async () => {
  await removeDogs(createdDogs);
});

async function counts(): Promise<{ bookings: number; orders: number; requests: number }> {
  const { rows } = await db.execute(sql`
    SELECT (SELECT count(*)::int FROM bookings) AS bookings,
           (SELECT count(*)::int FROM orders) AS orders,
           (SELECT count(*)::int FROM pending_requests) AS requests`);
  return rows[0] as { bookings: number; orders: number; requests: number };
}

function categoryRefusal(res: { statusCode: number; body: string }): void {
  assert.equal(res.statusCode, 400, res.body);
  const { error } = JSON.parse(res.body) as ApiErrorEnvelope;
  assert.equal(error.code, 'bad_request', res.body);
  assert.match(error.message, /category/, res.body);
}

test(
  "POST /bookings with category 'evaluation' is refused and writes no booking or order",
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await createFundedDog(createdDogs);
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerBookingsRoute(app, { authenticate, now: FIXTURE_NOW, stripe: makeStripeStub() });
    const before = await counts();
    const res = await app.inject({
      method: 'POST',
      url: '/bookings',
      headers: { 'idempotency-key': `p20-eval-booking-${randomUUID()}` },
      payload: {
        category: 'evaluation',
        lead_dog_id: dogId,
        dates: [futureWeekday(3)],
        location: 'fayetteville',
        payment: { kind: 'credits' },
      },
    });
    categoryRefusal(res);
    assert.deepEqual(await counts(), before);
  },
);

test(
  "POST /requests with category 'evaluation' is refused and writes no request or booking",
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await createFundedDog(createdDogs);
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerRequestsRoute(app, { authenticate, now: FIXTURE_NOW });
    const before = await counts();
    const res = await app.inject({
      method: 'POST',
      url: '/requests',
      headers: { 'idempotency-key': `p20-eval-request-${randomUUID()}` },
      payload: {
        category: 'evaluation',
        lead_dog_id: dogId,
        preferred_dates: ['2026-07-15T15:00:00Z'],
      },
    });
    categoryRefusal(res);
    assert.deepEqual(await counts(), before);
  },
);
