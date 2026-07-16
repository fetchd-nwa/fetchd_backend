import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { bookings as bookingsTable, cancelWindowSettings } from '../../src/db/schema/schema.js';
import { registerBookingsRoute } from '../../src/routes/bookings.js';
import { registerStaffCancelWindowRoute } from '../../src/routes/staffCancelWindow.js';
import { futureWeekday, FIXTURE_IDS, FIXTURE_NOW, topUpCredits } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';

/**
 * Day 13 contract tests for the staff cancel-window verbs:
 *   - GET  /staff/cancel-window
 *   - PATCH /staff/cancel-window/:category
 *
 * The staff-tunable policy authority. PATCH affects future bookings
 * (the next POST /bookings stamps `cancel_deadline_at` from the new
 * hours); existing bookings keep their original stamped deadline.
 */

registerFixtureHooks();

const ONE_HOUR_MS = 3_600_000;

function staffApp(principal = FIXTURE_STAFF_PRINCIPAL): {
  app: ReturnType<typeof makeContractApp>['app'];
} {
  const { app, authenticate } = makeContractApp(principal);
  registerStaffCancelWindowRoute(app, { authenticate });
  registerBookingsRoute(app, { authenticate, now: FIXTURE_NOW });
  return { app };
}

/** Reset cancel_window_settings to its seeded default (48h flat across
 * all categories) so PATCH tests don't bleed into each other. */
async function resetCancelWindowSettings(): Promise<void> {
  await db.update(cancelWindowSettings).set({ hoursBefore: 48, updatedByStaffId: null });
}

// ──────────────────────────────────────────────────────────────────────────
// GET /staff/cancel-window
// ──────────────────────────────────────────────────────────────────────────

test(
  'GET /staff/cancel-window — returns 7 categories, each at the seeded 48h',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetCancelWindowSettings();
    const { app } = staffApp();
    const res = await app.inject({ method: 'GET', url: '/staff/cancel-window' });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as Array<{
      category: string;
      hours_before: number;
      updated_at: string;
      updated_by_staff_id: string | null;
    }>;
    assert.equal(body.length, 7, 'all 7 service_category values seeded');
    const categories = new Set(body.map((r) => r.category));
    for (const c of [
      'day-school',
      'day-care',
      'private-lesson',
      'group-class',
      'boarding',
      'board-and-train',
      'evaluation',
    ]) {
      assert.ok(categories.has(c), `missing category ${c}`);
    }
    for (const r of body) {
      assert.equal(r.hours_before, 48, `${r.category} should be at seeded 48h`);
      assert.equal(r.updated_by_staff_id, null, `${r.category} seeded => updated_by null`);
      assert.match(r.updated_at, /^\d{4}-\d{2}-\d{2}T/);
    }
  },
);

test('GET /staff/cancel-window — owner principal → 403', SKIP_WHEN_NO_DB, async () => {
  const { app } = staffApp(FIXTURE_OWNER_PRINCIPAL);
  const res = await app.inject({ method: 'GET', url: '/staff/cancel-window' });
  assert.equal(res.statusCode, 403, res.body);
});

// ──────────────────────────────────────────────────────────────────────────
// PATCH /staff/cancel-window/:category
// ──────────────────────────────────────────────────────────────────────────

test(
  'PATCH /staff/cancel-window/:category — updates hours + stamps actor',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetCancelWindowSettings();
    const { app } = staffApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/staff/cancel-window/boarding',
      headers: { 'idempotency-key': `pcw-${randomUUID()}` },
      payload: { hours_before: 96 },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as {
      category: string;
      hours_before: number;
      updated_by_staff_id: string | null;
    };
    assert.equal(body.category, 'boarding');
    assert.equal(body.hours_before, 96);
    assert.equal(body.updated_by_staff_id, FIXTURE_IDS.staffDonavanId);

    // DB-side confirmation: other categories are unchanged.
    const allRows = await db.select().from(cancelWindowSettings);
    const map = new Map(allRows.map((r) => [r.category, r.hoursBefore]));
    assert.equal(map.get('boarding'), 96);
    assert.equal(map.get('day-school'), 48, 'unrelated category not touched');
    assert.equal(map.get('evaluation'), 48);
  },
);

test(
  'PATCH /staff/cancel-window/:category — new policy applies to the NEXT booking only',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetCancelWindowSettings();
    // Two apps: staff PATCHes the policy, owner POSTs the bookings. Both
    // hit the same DB so the policy edit is visible to the owner's
    // subsequent booking creation.
    const { app: staffOnly } = staffApp();
    const { app: ownerOnly } = staffApp(FIXTURE_OWNER_PRINCIPAL);

    // Book first at the seeded 48h policy.
    await topUpCredits(FIXTURE_IDS.dog1Id, 'school', 2);
    const date1 = futureWeekday(11);
    const before = await ownerOnly.inject({
      method: 'POST',
      url: '/bookings',
      headers: { 'idempotency-key': `pcw-before-${randomUUID()}` },
      payload: {
        category: 'day-school',
        lead_dog_id: FIXTURE_IDS.dog1Id,
        dates: [date1],
        location: 'fayetteville',
      },
    });
    assert.equal(before.statusCode, 201, before.body);
    const beforeId = (before.json() as Array<{ id: string }>)[0]!.id;

    // PATCH policy → 24h (staff).
    const patchRes = await staffOnly.inject({
      method: 'PATCH',
      url: '/staff/cancel-window/day-school',
      headers: { 'idempotency-key': `pcw-patch-${randomUUID()}` },
      payload: { hours_before: 24 },
    });
    assert.equal(patchRes.statusCode, 200);

    // Book second — should stamp 24h (owner).
    const date2 = futureWeekday(12);
    const after = await ownerOnly.inject({
      method: 'POST',
      url: '/bookings',
      headers: { 'idempotency-key': `pcw-after-${randomUUID()}` },
      payload: {
        category: 'day-school',
        lead_dog_id: FIXTURE_IDS.dog1Id,
        dates: [date2],
        location: 'fayetteville',
      },
    });
    assert.equal(after.statusCode, 201, after.body);
    const afterId = (after.json() as Array<{ id: string }>)[0]!.id;

    const [beforeRow] = await db
      .select({
        scheduledAt: bookingsTable.scheduledAt,
        cancelDeadlineAt: bookingsTable.cancelDeadlineAt,
      })
      .from(bookingsTable)
      .where(eq(bookingsTable.id, beforeId));
    const [afterRow] = await db
      .select({
        scheduledAt: bookingsTable.scheduledAt,
        cancelDeadlineAt: bookingsTable.cancelDeadlineAt,
      })
      .from(bookingsTable)
      .where(eq(bookingsTable.id, afterId));

    const beforeDelta =
      new Date(beforeRow!.scheduledAt).getTime() - new Date(beforeRow!.cancelDeadlineAt!).getTime();
    const afterDelta =
      new Date(afterRow!.scheduledAt).getTime() - new Date(afterRow!.cancelDeadlineAt!).getTime();
    assert.equal(beforeDelta, 48 * ONE_HOUR_MS, 'first booking honors prior 48h policy');
    assert.equal(afterDelta, 24 * ONE_HOUR_MS, 'second booking honors new 24h policy');
  },
);

test('PATCH /staff/cancel-window/:category — owner principal → 403', SKIP_WHEN_NO_DB, async () => {
  const { app } = staffApp(FIXTURE_OWNER_PRINCIPAL);
  const res = await app.inject({
    method: 'PATCH',
    url: '/staff/cancel-window/boarding',
    headers: { 'idempotency-key': `pcw-403-${randomUUID()}` },
    payload: { hours_before: 96 },
  });
  assert.equal(res.statusCode, 403, res.body);
});

test('PATCH /staff/cancel-window/:category — hours_before < 1 → 400', SKIP_WHEN_NO_DB, async () => {
  const { app } = staffApp();
  const res = await app.inject({
    method: 'PATCH',
    url: '/staff/cancel-window/boarding',
    headers: { 'idempotency-key': `pcw-bad-${randomUUID()}` },
    payload: { hours_before: 0 },
  });
  assert.equal(res.statusCode, 400, res.body);
});

test(
  'PATCH /staff/cancel-window/:category — hours_before > 720 → 400',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app } = staffApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/staff/cancel-window/boarding',
      headers: { 'idempotency-key': `pcw-toobig-${randomUUID()}` },
      payload: { hours_before: 9999 },
    });
    assert.equal(res.statusCode, 400, res.body);
  },
);

test('PATCH /staff/cancel-window/:category — unknown category → 400', SKIP_WHEN_NO_DB, async () => {
  const { app } = staffApp();
  const res = await app.inject({
    method: 'PATCH',
    url: '/staff/cancel-window/dog-grooming',
    headers: { 'idempotency-key': `pcw-unk-${randomUUID()}` },
    payload: { hours_before: 48 },
  });
  assert.equal(res.statusCode, 400, res.body);
});
