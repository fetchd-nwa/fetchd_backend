import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import {
  dayProgramSettings,
  idempotencyKeys,
  owners,
  pendingRequests,
} from '../../src/db/schema/schema.js';
import { registerRequestsRoute } from '../../src/routes/requests.js';
import { FIXTURE_IDS, FIXTURE_NOW, setRequestServicesOffered } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';

/**
 * P13 item 0b (ruling (f); design §2.6:3727, wire 4.0.0-lg3.1): `POST /requests`
 * answers 422 `service_not_offered` when the service is off at the family's home
 * campus, so a stale build or a crafted call cannot reach today's wrong money.
 *
 * The body names no campus and a request stores none, so the campus is
 * `owners.location`. A family with none is refused only when no campus offers the
 * service. The check reads `offered`, never `client_visible`, and runs after the
 * idempotency claim.
 */

registerFixtureHooks();

// After EACH test: a boarding request left open would answer `already_requested`
// to the next test before the check under test could speak.
const createdRequestIds: string[] = [];
afterEach(async () => {
  await setRequestServicesOffered(false);
  await db
    .update(owners)
    .set({ location: 'fayetteville' })
    .where(eq(owners.id, FIXTURE_IDS.ownerId));
  for (const id of createdRequestIds.splice(0)) {
    await db.delete(pendingRequests).where(eq(pendingRequests.id, id)); // children CASCADE
  }
});

const PREFERRED = ['2026-07-15T15:00:00Z'];

function ownerApp(): ReturnType<typeof makeContractApp>['app'] {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerRequestsRoute(app, { authenticate, now: FIXTURE_NOW });
  return app;
}

type App = ReturnType<typeof ownerApp>;

function boardingBody(): Record<string, unknown> {
  return {
    category: 'boarding',
    lead_dog_id: FIXTURE_IDS.dog1Id,
    preferred_dates: PREFERRED,
  };
}

async function postBoarding(
  app: App,
  key = randomUUID(),
): Promise<{ statusCode: number; code: string | undefined; id: string | undefined }> {
  const res = await app.inject({
    method: 'POST',
    url: '/requests',
    headers: { 'idempotency-key': key },
    payload: boardingBody(),
  });
  const body = res.json() as { id?: string; error?: { code: string } };
  if (body.id !== undefined) createdRequestIds.push(body.id);
  return { statusCode: res.statusCode, code: body.error?.code, id: body.id };
}

async function requestRows(): Promise<number> {
  const rows = await db
    .select({ id: pendingRequests.id })
    .from(pendingRequests)
    .where(eq(pendingRequests.ownerId, FIXTURE_IDS.ownerId));
  return rows.length;
}

test(
  'boarding off at the family campus: 422, no pending_requests row',
  SKIP_WHEN_NO_DB,
  async () => {
    const before = await requestRows();
    const res = await postBoarding(ownerApp());
    assert.equal(res.statusCode, 422);
    assert.equal(res.code, 'service_not_offered');
    assert.equal(await requestRows(), before);
  },
);

test('boarding on at the family campus: 201, a row, as before', SKIP_WHEN_NO_DB, async () => {
  await setRequestServicesOffered(true, { location: 'fayetteville', services: ['boarding'] });
  const before = await requestRows();
  const res = await postBoarding(ownerApp());
  assert.equal(res.statusCode, 201);
  assert.equal(await requestRows(), before + 1);
});

test('on at the other campus only: the family campus decides, 422', SKIP_WHEN_NO_DB, async () => {
  await setRequestServicesOffered(true, { location: 'bentonville', services: ['boarding'] });
  const res = await postBoarding(ownerApp());
  assert.equal(res.statusCode, 422);
  assert.equal(res.code, 'service_not_offered');
});

test('one service on does not open another', SKIP_WHEN_NO_DB, async () => {
  await setRequestServicesOffered(true, { services: ['private-lesson'] });
  const res = await postBoarding(ownerApp());
  assert.equal(res.code, 'service_not_offered');
});

test('no home campus, off everywhere: 422', SKIP_WHEN_NO_DB, async () => {
  await db.update(owners).set({ location: null }).where(eq(owners.id, FIXTURE_IDS.ownerId));
  const res = await postBoarding(ownerApp());
  assert.equal(res.statusCode, 422);
  assert.equal(res.code, 'service_not_offered');
});

test(
  'no home campus, on at one campus: 201, staff name the campus at approve',
  SKIP_WHEN_NO_DB,
  async () => {
    await db.update(owners).set({ location: null }).where(eq(owners.id, FIXTURE_IDS.ownerId));
    await setRequestServicesOffered(true, { location: 'bentonville', services: ['boarding'] });
    const res = await postBoarding(ownerApp());
    assert.equal(res.statusCode, 201);
  },
);

test('the switch is `offered`, not `client_visible`', SKIP_WHEN_NO_DB, async () => {
  // Seeded with client_visible false: a hidden tile, offered, still takes a request.
  await setRequestServicesOffered(true, { location: 'fayetteville', services: ['boarding'] });
  const [row] = await db
    .select({ offerings: dayProgramSettings.offerings })
    .from(dayProgramSettings)
    .where(eq(dayProgramSettings.location, 'fayetteville'));
  const doc = row?.offerings as Record<string, { client_visible: boolean }>;
  assert.equal(doc.boarding?.client_visible, false, 'the seed hides the tile');
  const res = await postBoarding(ownerApp());
  assert.equal(res.statusCode, 201);
});

test(
  'it runs after the claim: a stored 201 replays after the switch goes off',
  SKIP_WHEN_NO_DB,
  async () => {
    await setRequestServicesOffered(true, { location: 'fayetteville', services: ['boarding'] });
    const app = ownerApp();
    const key = randomUUID();
    const first = await postBoarding(app, key);
    assert.equal(first.statusCode, 201);
    await setRequestServicesOffered(false);
    const replay = await postBoarding(app, key);
    assert.equal(replay.statusCode, 201);
    assert.equal(replay.id, first.id);
  },
);

test(
  'a refusal leaves no claim behind: the same key books once the switch is on',
  SKIP_WHEN_NO_DB,
  async () => {
    const app = ownerApp();
    const key = randomUUID();
    const refused = await postBoarding(app, key);
    assert.equal(refused.code, 'service_not_offered');
    const claims = await db
      .select({ key: idempotencyKeys.key })
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.key, key));
    assert.deepEqual(claims, []);
    await setRequestServicesOffered(true, { location: 'fayetteville', services: ['boarding'] });
    const retried = await postBoarding(app, key);
    assert.equal(retried.statusCode, 201);
  },
);
