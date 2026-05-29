import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import {
  bookings as bookingsTable,
  bookingDogs as bookingDogsTable,
  notifications as notificationsTable,
  reports as reportsTable,
} from '../../src/db/schema/schema.js';
import { registerStaffReportsRoute } from '../../src/routes/staffReports.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';

/**
 * Day 19 contract tests for the staff-portal verb 2 (report authoring,
 * DATA-CONTRACT R2):
 *   POST  /staff/reports       — author (base + results|content by program)
 *   PATCH /staff/reports/:id   — edit content fields
 *
 * Covers the R2 content-by-program rule (session requires content,
 * curriculum forbids it), the optional single-booking session_report_id
 * back-link, the report-published notification, and the obvious edges.
 * (Media report-photo/video attachment is a documented deferral.)
 */

registerFixtureHooks();

const REPORT_DATE = '2026-05-20T15:00:00Z';

function staffReportsApp(
  principal = FIXTURE_STAFF_PRINCIPAL,
): ReturnType<typeof makeContractApp>['app'] {
  const { app, authenticate } = makeContractApp(principal);
  registerStaffReportsRoute(app, { authenticate });
  return app;
}

function postReport(opts: {
  app: ReturnType<typeof makeContractApp>['app'];
  payload: Record<string, unknown>;
  idempotencyKey?: string;
}): ReturnType<ReturnType<typeof makeContractApp>['app']['inject']> {
  const headers: Record<string, string> = {};
  if (opts.idempotencyKey !== undefined) headers['idempotency-key'] = opts.idempotencyKey;
  return opts.app.inject({ method: 'POST', url: '/staff/reports', headers, payload: opts.payload });
}

function patchReport(opts: {
  app: ReturnType<typeof makeContractApp>['app'];
  id: string;
  payload: Record<string, unknown>;
  idempotencyKey?: string;
}): ReturnType<ReturnType<typeof makeContractApp>['app']['inject']> {
  const headers: Record<string, string> = {};
  if (opts.idempotencyKey !== undefined) headers['idempotency-key'] = opts.idempotencyKey;
  return opts.app.inject({
    method: 'PATCH',
    url: `/staff/reports/${opts.id}`,
    headers,
    payload: opts.payload,
  });
}

const curriculumPayload = (): Record<string, unknown> => ({
  dog_id: FIXTURE_IDS.dog1Id,
  date: REPORT_DATE,
  category: 'group-class',
  program: 'foundation',
  excerpt: 'Great progress on loose-leash this week.',
  full_text: 'Waffles nailed the heel position and held a 30s stay.',
  results: {
    results: { 'loose-leash': { status: 'pass' }, stay: { status: 'learning', score: '30s' } },
    practice_at_home: [{ text: 'Practice stay near the door.' }],
    friends_today: ['Lola'],
  },
});

const sessionPayload = (): Record<string, unknown> => ({
  dog_id: FIXTURE_IDS.dog1Id,
  date: REPORT_DATE,
  category: 'private-lesson',
  program: 'private-lesson',
  excerpt: 'Focused 1:1 on door manners.',
  full_text: 'Worked thresholds; strong impulse control by the end.',
  content: { sections: [{ heading: 'Door manners', body: 'Calm exits.' }] },
});

async function seedBookingForDog(dogId: string): Promise<string> {
  const id = randomUUID();
  await db.insert(bookingsTable).values({
    id,
    ownerId: FIXTURE_IDS.ownerId,
    leadDogId: dogId,
    category: 'private-lesson',
    status: 'upcoming',
    scheduledAt: REPORT_DATE,
    location: 'fayetteville',
  });
  await db.insert(bookingDogsTable).values([{ bookingId: id, dogId, isLead: true }]);
  return id;
}

/** Seed N weekly group-class bookings for one (cohort, dog). */
async function seedGroupClassWeeks(
  dogId: string,
  cohortId: string,
  weekDates: string[],
): Promise<string[]> {
  const ids = weekDates.map(() => randomUUID());
  await db.insert(bookingsTable).values(
    weekDates.map((scheduledAt, i) => ({
      id: ids[i]!,
      ownerId: FIXTURE_IDS.ownerId,
      leadDogId: dogId,
      category: 'group-class' as const,
      status: 'upcoming' as const,
      scheduledAt,
      location: 'fayetteville' as const,
      cohortId,
    })),
  );
  await db
    .insert(bookingDogsTable)
    .values(ids.map((id) => ({ bookingId: id, dogId, isLead: true })));
  return ids;
}

// ──────────────────────────────────────────────────────────────────────────
// POST /staff/reports
// ──────────────────────────────────────────────────────────────────────────

test(
  'POST /staff/reports — curriculum report → 201 + results envelope spread + owner notified',
  SKIP_WHEN_NO_DB,
  async () => {
    const app = staffReportsApp();
    const res = await postReport({
      app,
      payload: curriculumPayload(),
      idempotencyKey: `rp-cur-${randomUUID()}`,
    });
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json() as {
      id: string;
      dog_id: string;
      program: string;
      trainer?: string;
      results?: Record<string, unknown>;
      practice_at_home?: { text: string }[];
    };
    assert.equal(body.dog_id, FIXTURE_IDS.dog1Id);
    assert.equal(body.program, 'foundation');
    assert.ok(body.trainer, 'trainer name resolved (defaults to acting staff)');
    assert.ok(body.results && body.results['loose-leash'], 'results envelope spread onto the wire');
    assert.ok(
      body.practice_at_home && body.practice_at_home.length === 1,
      'practice_at_home spread',
    );

    const rows = await db
      .select({ id: reportsTable.id })
      .from(reportsTable)
      .where(eq(reportsTable.id, body.id));
    assert.equal(rows.length, 1, 'report row persisted');

    const notes = await db
      .select({ type: notificationsTable.type })
      .from(notificationsTable)
      .where(
        and(
          eq(notificationsTable.ownerId, FIXTURE_IDS.ownerId),
          eq(notificationsTable.deepLinkPath, `/reports/${body.id}`),
        ),
      );
    assert.ok(
      notes.some((n) => n.type === 'report-published'),
      'report-published notification enqueued',
    );
  },
);

test(
  'POST /staff/reports — session report → 201 + variant content on the wire',
  SKIP_WHEN_NO_DB,
  async () => {
    const app = staffReportsApp();
    const res = await postReport({
      app,
      payload: sessionPayload(),
      idempotencyKey: `rp-sess-${randomUUID()}`,
    });
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json() as { program: string; private_lesson_content?: unknown };
    assert.equal(body.program, 'private-lesson');
    assert.ok(body.private_lesson_content, 'variant content emitted under the program-keyed field');
  },
);

test('POST /staff/reports — session program without content → 422', SKIP_WHEN_NO_DB, async () => {
  const app = staffReportsApp();
  const payload = sessionPayload();
  delete payload.content;
  const res = await postReport({ app, payload, idempotencyKey: `rp-nocontent-${randomUUID()}` });
  assert.equal(res.statusCode, 422, res.body);
});

test('POST /staff/reports — curriculum program with content → 422', SKIP_WHEN_NO_DB, async () => {
  const app = staffReportsApp();
  const payload = { ...curriculumPayload(), content: { stray: true } };
  const res = await postReport({ app, payload, idempotencyKey: `rp-badcontent-${randomUUID()}` });
  assert.equal(res.statusCode, 422, res.body);
});

test('POST /staff/reports — unknown dog → 404', SKIP_WHEN_NO_DB, async () => {
  const app = staffReportsApp();
  const payload = { ...curriculumPayload(), dog_id: randomUUID() };
  const res = await postReport({ app, payload, idempotencyKey: `rp-404-${randomUUID()}` });
  assert.equal(res.statusCode, 404, res.body);
});

test(
  'POST /staff/reports — link_booking_id back-links session_report_id',
  SKIP_WHEN_NO_DB,
  async () => {
    const bookingId = await seedBookingForDog(FIXTURE_IDS.dog1Id);
    const app = staffReportsApp();
    const payload = { ...sessionPayload(), link_booking_id: bookingId };
    const res = await postReport({ app, payload, idempotencyKey: `rp-link-${randomUUID()}` });
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json() as { id: string };

    const [booking] = await db
      .select({ sessionReportId: bookingsTable.sessionReportId })
      .from(bookingsTable)
      .where(eq(bookingsTable.id, bookingId));
    assert.equal(booking?.sessionReportId, body.id, 'booking back-linked to the new report');
  },
);

test(
  'POST /staff/reports — link_booking_id for a different dog → 422',
  SKIP_WHEN_NO_DB,
  async () => {
    const bookingId = await seedBookingForDog(FIXTURE_IDS.dog2Id); // booking is for dog2
    const app = staffReportsApp();
    const payload = { ...sessionPayload(), dog_id: FIXTURE_IDS.dog1Id, link_booking_id: bookingId };
    const res = await postReport({ app, payload, idempotencyKey: `rp-linkbad-${randomUUID()}` });
    assert.equal(res.statusCode, 422, res.body);
  },
);

test(
  'POST /staff/reports — group-class report fans the link out to every weekly booking for the (cohort, dog)',
  SKIP_WHEN_NO_DB,
  async () => {
    const cohortId = FIXTURE_IDS.cohortMannersId;
    const weekIds = await seedGroupClassWeeks(FIXTURE_IDS.dog1Id, cohortId, [
      '2026-06-01T15:00:00Z',
      '2026-06-08T15:00:00Z',
      '2026-06-15T15:00:00Z',
    ]);
    // Negative control: a different dog in the SAME cohort must NOT be linked.
    const [otherDogBooking] = await seedGroupClassWeeks(FIXTURE_IDS.dog2Id, cohortId, [
      '2026-06-01T15:00:00Z',
    ]);
    try {
      const app = staffReportsApp();
      const payload = {
        dog_id: FIXTURE_IDS.dog1Id,
        date: REPORT_DATE,
        category: 'group-class',
        program: 'group-class-session',
        excerpt: 'Manners 2 cohort recap.',
        full_text: 'Four weeks of group manners — solid recall + place.',
        content: { class_name: 'Group Manners 2', weeks: [{ week_number: 1 }] },
        link_booking_id: weekIds[0], // pick ONE week; the link must fan out to all
      };
      const res = await postReport({ app, payload, idempotencyKey: `rp-gc-${randomUUID()}` });
      assert.equal(res.statusCode, 201, res.body);
      const reportId = (res.json() as { id: string }).id;

      const linked = await db
        .select({ id: bookingsTable.id, sessionReportId: bookingsTable.sessionReportId })
        .from(bookingsTable)
        .where(inArray(bookingsTable.id, weekIds));
      assert.equal(linked.length, weekIds.length, 'all weekly bookings present');
      for (const row of linked) {
        assert.equal(row.sessionReportId, reportId, `week ${row.id} back-linked to the report`);
      }

      const [other] = await db
        .select({ sessionReportId: bookingsTable.sessionReportId })
        .from(bookingsTable)
        .where(eq(bookingsTable.id, otherDogBooking!));
      assert.equal(other?.sessionReportId, null, "a different dog's cohort booking is NOT linked");
    } finally {
      const all = [...weekIds, otherDogBooking!];
      await db.delete(bookingDogsTable).where(inArray(bookingDogsTable.bookingId, all));
      await db.delete(bookingsTable).where(inArray(bookingsTable.id, all));
    }
  },
);

test('POST /staff/reports — owner principal → 403', SKIP_WHEN_NO_DB, async () => {
  const app = staffReportsApp(FIXTURE_OWNER_PRINCIPAL);
  const res = await postReport({
    app,
    payload: curriculumPayload(),
    idempotencyKey: `rp-owner-${randomUUID()}`,
  });
  assert.equal(res.statusCode, 403, res.body);
});

test(
  'POST /staff/reports — idempotency replay returns stored body, no double insert',
  SKIP_WHEN_NO_DB,
  async () => {
    const app = staffReportsApp();
    const key = `rp-idem-${randomUUID()}`;
    const first = await postReport({ app, payload: curriculumPayload(), idempotencyKey: key });
    assert.equal(first.statusCode, 201, first.body);
    const replay = await postReport({ app, payload: curriculumPayload(), idempotencyKey: key });
    assert.equal(replay.statusCode, 201, replay.body);
    assert.deepEqual(replay.json(), first.json(), 'replay byte-identical');
    const firstId = (first.json() as { id: string }).id;
    const rows = await db
      .select({ id: reportsTable.id })
      .from(reportsTable)
      .where(eq(reportsTable.id, firstId));
    assert.equal(rows.length, 1, 'no second report inserted on replay');
  },
);

// ──────────────────────────────────────────────────────────────────────────
// PATCH /staff/reports/:id
// ──────────────────────────────────────────────────────────────────────────

test('PATCH /staff/reports/:id — edits excerpt + full_text', SKIP_WHEN_NO_DB, async () => {
  const app = staffReportsApp();
  const created = await postReport({
    app,
    payload: curriculumPayload(),
    idempotencyKey: `rp-pre-${randomUUID()}`,
  });
  const id = (created.json() as { id: string }).id;

  const res = await patchReport({
    app,
    id,
    idempotencyKey: `rp-patch-${randomUUID()}`,
    payload: { excerpt: 'Edited excerpt', full_text: 'Edited full text' },
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { excerpt: string; full_text: string };
  assert.equal(body.excerpt, 'Edited excerpt');
  assert.equal(body.full_text, 'Edited full text');

  const [row] = await db
    .select({ excerpt: reportsTable.excerpt })
    .from(reportsTable)
    .where(eq(reportsTable.id, id));
  assert.equal(row?.excerpt, 'Edited excerpt', 'edit persisted');
});

test('PATCH /staff/reports/:id — unknown id → 404', SKIP_WHEN_NO_DB, async () => {
  const app = staffReportsApp();
  const res = await patchReport({
    app,
    id: randomUUID(),
    idempotencyKey: `rp-patch404-${randomUUID()}`,
    payload: { excerpt: 'nope' },
  });
  assert.equal(res.statusCode, 404, res.body);
});

test(
  'PATCH /staff/reports/:id — adding content to a curriculum report → 422',
  SKIP_WHEN_NO_DB,
  async () => {
    const app = staffReportsApp();
    const created = await postReport({
      app,
      payload: curriculumPayload(),
      idempotencyKey: `rp-pre2-${randomUUID()}`,
    });
    const id = (created.json() as { id: string }).id;

    const res = await patchReport({
      app,
      id,
      idempotencyKey: `rp-patchcontent-${randomUUID()}`,
      payload: { content: { stray: true } },
    });
    assert.equal(res.statusCode, 422, res.body);
  },
);

test('PATCH /staff/reports/:id — owner principal → 403', SKIP_WHEN_NO_DB, async () => {
  const app = staffReportsApp(FIXTURE_OWNER_PRINCIPAL);
  const res = await patchReport({
    app,
    id: randomUUID(),
    idempotencyKey: `rp-patchowner-${randomUUID()}`,
    payload: { excerpt: 'x' },
  });
  assert.equal(res.statusCode, 403, res.body);
});
