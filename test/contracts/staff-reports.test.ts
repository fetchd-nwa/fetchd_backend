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
import { registerReportsRoute } from '../../src/routes/reports.js';
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

/**
 * An app carrying BOTH report route files, for the tests that have to watch a
 * staff write land in an OWNER read (the soft-delete drop-out). Two Fastify
 * instances against the same DB would work too; one app is less ceremony.
 */
function bothReportsApp(
  principal = FIXTURE_STAFF_PRINCIPAL,
): ReturnType<typeof makeContractApp>['app'] {
  const { app, authenticate } = makeContractApp(principal);
  registerStaffReportsRoute(app, { authenticate });
  registerReportsRoute(app, { authenticate });
  return app;
}

function deleteReport(opts: {
  app: ReturnType<typeof makeContractApp>['app'];
  id: string;
  idempotencyKey?: string;
}): ReturnType<ReturnType<typeof makeContractApp>['app']['inject']> {
  const headers: Record<string, string> = {};
  if (opts.idempotencyKey !== undefined) headers['idempotency-key'] = opts.idempotencyKey;
  return opts.app.inject({ method: 'DELETE', url: `/staff/reports/${opts.id}`, headers });
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

/**
 * Runtime shape check for the `private_lesson_content` this file POSTs and
 * reads back. `sessionPayload()` authors the doc, so the expected shape is
 * local knowledge — a mismatch here means the wire type or the payload drifted.
 */
function assertPrivateLessonContentShape(value: unknown): void {
  assert.equal(typeof value, 'object', 'private_lesson_content: expected an object');
  assert.ok(value !== null && !Array.isArray(value), 'private_lesson_content: expected an object');
  const content = value as Record<string, unknown>;
  assert.equal(typeof content['session_focus'], 'string', 'session_focus must be a string');
  assert.ok(Array.isArray(content['topics']), 'topics must be an array');
  for (const topic of content['topics'] as Record<string, unknown>[]) {
    assert.equal(typeof topic['id'], 'string', 'topic.id must be a string');
    assert.equal(typeof topic['title'], 'string', 'topic.title must be a string');
    assert.ok(Array.isArray(topic['sections']), 'topic.sections must be an array');
  }
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
  // 1.13.0: authors a doc that satisfies PrivateLessonContentWire — the shape
  // the owner app actually renders (mobile RawPrivateLessonContent requires
  // session_focus + topics). The pre-1.13.0 payload here authored
  // `{ sections: [...] }`, a doc the client cannot render, and the opaque
  // `unknown` typing let it pass — BUG-13's write hole demonstrated by this
  // suite's own fixture. The write path still does not validate (that fix is
  // filed, not enacted); this payload is simply now REPRESENTATIVE.
  content: {
    session_focus: 'Door manners + threshold impulse control',
    topics: [
      {
        id: 'door-manners',
        title: 'Door manners',
        sections: [{ kind: 'note', text: 'Calm exits.' }],
      },
    ],
  },
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
      .select({
        type: notificationsTable.type,
        deepLinkKind: notificationsTable.deepLinkKind,
        deepLinkId: notificationsTable.deepLinkId,
      })
      .from(notificationsTable)
      .where(
        and(
          eq(notificationsTable.ownerId, FIXTURE_IDS.ownerId),
          eq(notificationsTable.deepLinkPath, `/report-card/${body.dog_id}?reportId=${body.id}`),
        ),
      );
    assert.ok(
      notes.some(
        (n) =>
          n.type === 'report-published' && n.deepLinkKind === 'report' && n.deepLinkId === body.id,
      ),
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
    // 1.13.0: the field is `PrivateLessonContentWire`, not `unknown`. The type
    // annotation above is erased (test/ is in no tsconfig), so the shape is
    // asserted at runtime — this is the write-path half of the §14.2-A pins in
    // `report-content-types.test.ts`.
    assertPrivateLessonContentShape(body.private_lesson_content);
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

// ──────────────────────────────────────────────────────────────────────────
// GET /staff/reports — the cross-owner staff report list (wire 1.13.0, 2.3b)
//
// `GetStaffReportsQuery`: `dog_id` REQUIRED (Allison ruling WC-A5 — an
// unscoped cross-owner dump 400s, the `GET /staff/invoices?parked` precedent
// at `staffInvoices.ts:81-84`), `program`/`category` optional filters.
// Response is a bare `ReportWire[]`, live rows only, newest first.
// ──────────────────────────────────────────────────────────────────────────

/** The dog-1 fixture reports, newest → oldest by `date`. */
const DOG1_FIXTURE_REPORTS_DESC = [
  FIXTURE_IDS.reportFoundationId, // 2026-05-08
  FIXTURE_IDS.reportPrivateLessonId, // 2026-04-25
  FIXTURE_IDS.reportBoardTrainId, // 2026-03-15
  FIXTURE_IDS.reportGroupClassId, // 2026-03-01
];

function listStaffReports(
  app: ReturnType<typeof makeContractApp>['app'],
  query: string,
): ReturnType<ReturnType<typeof makeContractApp>['app']['inject']> {
  return app.inject({ method: 'GET', url: `/staff/reports${query}` });
}

test(
  'GET /staff/reports?dog_id= — staff read the dog’s live reports, newest first',
  SKIP_WHEN_NO_DB,
  async () => {
    const app = staffReportsApp();
    const res = await listStaffReports(app, `?dog_id=${FIXTURE_IDS.dog1Id}`);
    assert.equal(res.statusCode, 200, res.body);
    const rows = res.json() as { id: string; dog_id: string; program: string }[];
    assert.ok(Array.isArray(rows), 'bare array, no envelope (the staff-list house shape)');
    for (const row of rows) {
      assert.equal(row.dog_id, FIXTURE_IDS.dog1Id, 'every row is scoped to the requested dog');
    }
    // Other tests in this file POST extra dog-1 reports, so assert on the
    // fixture rows' RELATIVE order rather than the whole array.
    const ids = rows.map((r) => r.id);
    const fixtureOrder = ids.filter((id) => DOG1_FIXTURE_REPORTS_DESC.includes(id));
    assert.deepEqual(fixtureOrder, DOG1_FIXTURE_REPORTS_DESC, 'DESC by date');
    assert.ok(
      !ids.includes(FIXTURE_IDS.reportBoardingId),
      "another dog's report is not in a dog-scoped list",
    );
  },
);

test(
  'GET /staff/reports without dog_id → 400 bad_request (WC-A5: no unscoped dump)',
  SKIP_WHEN_NO_DB,
  async () => {
    const app = staffReportsApp();
    const res = await listStaffReports(app, '');
    assert.equal(res.statusCode, 400, res.body);
    const body = res.json() as { error?: { code?: string } };
    assert.equal(body.error?.code, 'bad_request');
  },
);

test('GET /staff/reports?dog_id=not-a-uuid → 400 bad_request', SKIP_WHEN_NO_DB, async () => {
  const app = staffReportsApp();
  const res = await listStaffReports(app, '?dog_id=not-a-uuid');
  assert.equal(res.statusCode, 400, res.body);
  const body = res.json() as { error?: { code?: string } };
  assert.equal(body.error?.code, 'bad_request');
});

test('GET /staff/reports — program filter narrows the list', SKIP_WHEN_NO_DB, async () => {
  const app = staffReportsApp();
  const res = await listStaffReports(
    app,
    `?dog_id=${FIXTURE_IDS.dog1Id}&program=board-train-session`,
  );
  assert.equal(res.statusCode, 200, res.body);
  const rows = res.json() as { id: string; program: string }[];
  assert.deepEqual(
    rows.map((r) => r.id),
    [FIXTURE_IDS.reportBoardTrainId],
  );
});

test('GET /staff/reports — category filter narrows the list', SKIP_WHEN_NO_DB, async () => {
  const app = staffReportsApp();
  const res = await listStaffReports(app, `?dog_id=${FIXTURE_IDS.dog1Id}&category=board-and-train`);
  assert.equal(res.statusCode, 200, res.body);
  const rows = res.json() as { id: string; category: string }[];
  assert.deepEqual(
    rows.map((r) => r.id),
    [FIXTURE_IDS.reportBoardTrainId],
  );
});

test('GET /staff/reports — unknown program value → 400 bad_request', SKIP_WHEN_NO_DB, async () => {
  const app = staffReportsApp();
  const res = await listStaffReports(app, `?dog_id=${FIXTURE_IDS.dog1Id}&program=nope`);
  assert.equal(res.statusCode, 400, res.body);
  const body = res.json() as { error?: { code?: string } };
  assert.equal(body.error?.code, 'bad_request');
});

test(
  'GET /staff/reports — a dog with no reports → [] (not a 404; no id leak)',
  SKIP_WHEN_NO_DB,
  async () => {
    const app = staffReportsApp();
    const res = await listStaffReports(app, `?dog_id=${randomUUID()}`);
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json(), []);
  },
);

test('GET /staff/reports — owner principal → 403', SKIP_WHEN_NO_DB, async () => {
  const app = staffReportsApp(FIXTURE_OWNER_PRINCIPAL);
  const res = await listStaffReports(app, `?dog_id=${FIXTURE_IDS.dog1Id}`);
  assert.equal(res.statusCode, 403, res.body);
});

// ──────────────────────────────────────────────────────────────────────────
// DELETE /staff/reports/:id — soft delete (wire 1.13.0, 2.3b)
//
// Stamps `reports.expired_at`; the row is retained and drops out of every
// read through the `live()` predicate. 204 No Content, staff-only,
// Idempotency-Key required. A second DELETE 404s (no LIVE row with that id).
// ──────────────────────────────────────────────────────────────────────────

/** POST a throwaway curriculum report and return its id. */
async function seedReportViaApi(app: ReturnType<typeof makeContractApp>['app']): Promise<string> {
  const created = await postReport({
    app,
    payload: curriculumPayload(),
    idempotencyKey: `rp-del-seed-${randomUUID()}`,
  });
  assert.equal(created.statusCode, 201, created.body);
  return (created.json() as { id: string }).id;
}

test(
  'DELETE /staff/reports/:id — 204, empty body, row soft-expired and RETAINED',
  SKIP_WHEN_NO_DB,
  async () => {
    const app = staffReportsApp();
    const id = await seedReportViaApi(app);

    const res = await deleteReport({ app, id, idempotencyKey: `rp-del-${randomUUID()}` });
    assert.equal(res.statusCode, 204, res.body);
    assert.equal(res.body, '', '204 No Content carries no body');

    const [row] = await db
      .select({ id: reportsTable.id, expiredAt: reportsTable.expiredAt })
      .from(reportsTable)
      .where(eq(reportsTable.id, id));
    assert.ok(row, 'the row is RETAINED — soft delete, never a DELETE');
    assert.ok(row.expiredAt !== null, 'expired_at stamped');
  },
);

test(
  'DELETE /staff/reports/:id — a second delete 404s (no live row), not a false success',
  SKIP_WHEN_NO_DB,
  async () => {
    const app = staffReportsApp();
    const id = await seedReportViaApi(app);
    const first = await deleteReport({ app, id, idempotencyKey: `rp-del2a-${randomUUID()}` });
    assert.equal(first.statusCode, 204, first.body);
    // A DIFFERENT key — a replay of the same key is the idempotency case below.
    const second = await deleteReport({ app, id, idempotencyKey: `rp-del2b-${randomUUID()}` });
    assert.equal(second.statusCode, 404, second.body);
  },
);

test('DELETE /staff/reports/:id — unknown id → 404 not_found', SKIP_WHEN_NO_DB, async () => {
  const app = staffReportsApp();
  const res = await deleteReport({
    app,
    id: randomUUID(),
    idempotencyKey: `rp-del404-${randomUUID()}`,
  });
  assert.equal(res.statusCode, 404, res.body);
  // The API envelope, not Fastify's default route-not-found body — without
  // this assertion the test passes before the route exists at all.
  const body = res.json() as { error?: { code?: string } };
  assert.equal(body.error?.code, 'not_found');
});

test('DELETE /staff/reports/:id — owner principal → 403', SKIP_WHEN_NO_DB, async () => {
  const app = staffReportsApp(FIXTURE_OWNER_PRINCIPAL);
  const res = await deleteReport({
    app,
    id: FIXTURE_IDS.reportFoundationId,
    idempotencyKey: `rp-delowner-${randomUUID()}`,
  });
  assert.equal(res.statusCode, 403, res.body);
});

test(
  'DELETE /staff/reports/:id — missing Idempotency-Key → 400 bad_request',
  SKIP_WHEN_NO_DB,
  async () => {
    const app = staffReportsApp();
    const id = await seedReportViaApi(app);
    const res = await deleteReport({ app, id });
    assert.equal(res.statusCode, 400, res.body);
    const body = res.json() as { error?: { code?: string } };
    assert.equal(body.error?.code, 'bad_request');
  },
);

test(
  'DELETE /staff/reports/:id — idempotency replay returns the stored 204, not a 404',
  SKIP_WHEN_NO_DB,
  async () => {
    const app = staffReportsApp();
    const id = await seedReportViaApi(app);
    const key = `rp-delidem-${randomUUID()}`;
    const first = await deleteReport({ app, id, idempotencyKey: key });
    assert.equal(first.statusCode, 204, first.body);
    const replay = await deleteReport({ app, id, idempotencyKey: key });
    assert.equal(replay.statusCode, 204, replay.body);
  },
);

test(
  'DELETE /staff/reports/:id — the report drops out of every read: owner list, owner by-id, staff list',
  SKIP_WHEN_NO_DB,
  async () => {
    const staffApp = bothReportsApp();
    const ownerApp = bothReportsApp(FIXTURE_OWNER_PRINCIPAL);
    const id = await seedReportViaApi(staffApp);

    const beforeOwner = await ownerApp.inject({ method: 'GET', url: `/reports/${id}` });
    assert.equal(beforeOwner.statusCode, 200, 'owner can read it while it is live');

    const del = await deleteReport({ app: staffApp, id, idempotencyKey: `rp-drop-${randomUUID()}` });
    assert.equal(del.statusCode, 204, del.body);

    const ownerList = await ownerApp.inject({
      method: 'GET',
      url: `/dogs/${FIXTURE_IDS.dog1Id}/reports`,
    });
    assert.equal(ownerList.statusCode, 200, ownerList.body);
    const ownerIds = (ownerList.json() as { id: string }[]).map((r) => r.id);
    assert.ok(!ownerIds.includes(id), 'gone from the owner list');

    const ownerById = await ownerApp.inject({ method: 'GET', url: `/reports/${id}` });
    assert.equal(ownerById.statusCode, 404, 'gone from the owner by-id read');

    const staffList = await listStaffReports(staffApp, `?dog_id=${FIXTURE_IDS.dog1Id}`);
    assert.equal(staffList.statusCode, 200, staffList.body);
    const staffIds = (staffList.json() as { id: string }[]).map((r) => r.id);
    assert.ok(!staffIds.includes(id), 'gone from the staff list');

    const staffById = await staffApp.inject({ method: 'GET', url: `/reports/${id}` });
    assert.equal(staffById.statusCode, 404, 'gone from the staff by-id read too');
  },
);
