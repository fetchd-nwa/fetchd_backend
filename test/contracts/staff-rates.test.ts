import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, test } from 'node:test';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { serviceRates } from '../../src/db/schema/schema.js';
import { registerStaffRatesRoute } from '../../src/routes/staffRates.js';
import { FIXTURE_IDS, FIXTURE_NOW, resetServiceRates } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_MANAGER_PRINCIPAL,
  FIXTURE_OWNER_ROLE_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';

/**
 * Contract tests for the staff per-location service-rate editor (append-only,
 * void, no-trap model — DATA-CONTRACT amendment 2026-06-20):
 *   GET  /staff/rates                       active + scheduled catalog
 *   GET  /staff/rates/history?category&loc  full change log (incl. voided)
 *   POST /staff/rates                       effective-dated supersede
 *   POST /staff/rates/:id/void              cancel/remove an entry
 *
 * Invariants exercised: never overwrite a row's values (same-day edit VOIDS +
 * inserts); a scheduled future rate never blocks the current one (slot-in, no
 * 409); voiding reopens the predecessor (no trap, no gap); who/when is logged.
 *
 * DAY-U23 narrowed the POST to the evaluation rate at its seed, 0, so every write
 * here is on that track and the rows are told apart by `note`. FIXTURE_TODAY =
 * 2026-05-19. The volume holds M3.05's two evaluation rows, open from 2025-01-01,
 * and nothing else; the fixture's teardown clears what a test adds and reopens what
 * a test closes. The staff principal is the manager, `staffAmberId` (P02): the rate
 * editor is owner and manager since STAFF-U07, and the trainer's 403 is pinned at
 * the end.
 */

registerFixtureHooks();
afterEach(resetServiceRates);

const STAFF_ID = FIXTURE_IDS.staffAmberId;

/** A POST body on the evaluation track at its seed, the one amount the route takes. */
function evaluationRate(
  location: 'fayetteville' | 'bentonville',
  extra: { note?: string; effective_from?: string } = {},
) {
  return {
    category: 'evaluation',
    location,
    amount_cents: 0,
    unit: 'per-session',
    ...extra,
  };
}

function staffApp(principal = FIXTURE_MANAGER_PRINCIPAL): {
  app: ReturnType<typeof makeContractApp>['app'];
} {
  const { app, authenticate } = makeContractApp(principal);
  registerStaffRatesRoute(app, { authenticate, now: FIXTURE_NOW });
  return { app };
}

async function postRate(opts: {
  app: ReturnType<typeof makeContractApp>['app'];
  payload: Record<string, unknown>;
  idempotencyKey?: string;
}) {
  const headers: Record<string, string> = {};
  if (opts.idempotencyKey !== undefined) headers['idempotency-key'] = opts.idempotencyKey;
  return opts.app.inject({ method: 'POST', url: '/staff/rates', headers, payload: opts.payload });
}

async function voidRate(
  app: ReturnType<typeof makeContractApp>['app'],
  id: string,
  key = `sr-void-${randomUUID()}`,
) {
  return app.inject({
    method: 'POST',
    url: `/staff/rates/${id}/void`,
    headers: { 'idempotency-key': key },
    payload: {},
  });
}

async function getHistory(
  app: ReturnType<typeof makeContractApp>['app'],
  category: string,
  location: string,
) {
  return app.inject({
    method: 'GET',
    url: `/staff/rates/history?category=${category}&location=${location}`,
  });
}

/** All rows for one track, including voided (raw DB state). */
async function rowsForTrack(category: string, location: string) {
  return db
    .select({
      id: serviceRates.id,
      amountCents: serviceRates.amountCents,
      note: serviceRates.note,
      unit: serviceRates.unit,
      effectiveFrom: serviceRates.effectiveFrom,
      effectiveTo: serviceRates.effectiveTo,
      voidedAt: serviceRates.voidedAt,
      createdByStaffId: serviceRates.createdByStaffId,
    })
    .from(serviceRates)
    .where(
      and(
        eq(serviceRates.category, category as 'evaluation'),
        eq(serviceRates.location, location as 'fayetteville'),
      ),
    );
}

// ──────────────────────────────────────────────────────────────────────────
// GET /staff/rates
// ──────────────────────────────────────────────────────────────────────────

test(
  'GET /staff/rates — active + scheduled rows; expired excluded; carries created_by',
  SKIP_WHEN_NO_DB,
  async () => {
    await db.insert(serviceRates).values([
      {
        category: 'boarding',
        location: 'bentonville',
        amountCents: 4000,
        unit: 'per-night',
        effectiveFrom: '2025-12-01',
        effectiveTo: '2026-04-01',
        note: 'expired',
      },
      {
        category: 'boarding',
        location: 'bentonville',
        amountCents: 4500,
        unit: 'per-night',
        effectiveFrom: '2026-07-01',
        note: 'scheduled',
      },
      {
        category: 'boarding',
        location: null,
        amountCents: 4200,
        unit: 'per-night',
        effectiveFrom: '2026-01-01',
      },
    ]);
    const { app } = staffApp();
    const res = await app.inject({ method: 'GET', url: '/staff/rates' });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as Array<{
      category: string;
      location: string | null;
      amount_cents: number;
      effective_to: string | null;
      note: string | null;
      created_by_staff_id: string | null;
    }>;
    const evaluationFay = body.find(
      (r) => r.category === 'evaluation' && r.location === 'fayetteville',
    );
    assert.ok(evaluationFay, 'evaluation fayetteville present');
    assert.equal(evaluationFay.amount_cents, 0);
    assert.equal(evaluationFay.effective_to, null);
    assert.equal(evaluationFay.created_by_staff_id, null, 'seed rows have no creator');
    assert.equal(
      body.find((r) => r.note === 'expired'),
      undefined,
      'the expired row is excluded',
    );
    assert.ok(
      body.some((r) => r.note === 'scheduled'),
      'the scheduled row is present',
    );
    assert.ok(
      body.some((r) => r.category === 'boarding' && r.location === null),
      'null-location row present with explicit null',
    );
  },
);

test(
  'POST /staff/rates — TAX-10: a price in fractions of a cent is 400',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app } = staffApp();
    const res = await postRate({
      app,
      idempotencyKey: `sr-fraction-${randomUUID()}`,
      payload: { ...evaluationRate('fayetteville'), amount_cents: 7_550.5 },
    });
    assert.equal(res.statusCode, 400, res.body);
    assert.equal((res.json() as { error: { code: string } }).error.code, 'bad_request');
  },
);

test('GET /staff/rates — owner principal → 403', SKIP_WHEN_NO_DB, async () => {
  const { app } = staffApp(FIXTURE_OWNER_PRINCIPAL);
  const res = await app.inject({ method: 'GET', url: '/staff/rates' });
  assert.equal(res.statusCode, 403, res.body);
});

// ──────────────────────────────────────────────────────────────────────────
// POST /staff/rates — insert / supersede / same-day (void, not overwrite)
// ──────────────────────────────────────────────────────────────────────────

test(
  'POST /staff/rates — the seed on a track closes the open row and opens a new one, stamps created_by',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app } = staffApp();
    const res = await postRate({
      app,
      idempotencyKey: `sr-insert-${randomUUID()}`,
      payload: evaluationRate('bentonville', { note: 'restated' }),
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as {
      amount_cents: number;
      effective_from: string;
      effective_to: null;
      created_by_staff_id: string;
    };
    assert.equal(body.amount_cents, 0);
    assert.equal(body.effective_to, null);
    assert.equal(body.effective_from, '2026-05-19', 'defaults to today (Chicago)');
    assert.equal(body.created_by_staff_id, STAFF_ID, 'stamps the acting staff');

    const rows = await rowsForTrack('evaluation', 'bentonville');
    assert.equal(rows.length, 2, 'the seed row and the new row');
    const seed = rows.find((r) => r.effectiveFrom === '2025-01-01')!;
    assert.equal(seed.effectiveTo, '2026-05-19', 'the seed row closes where the new row opens');
  },
);

for (const category of [
  'day-school',
  'day-care',
  'private-lesson',
  'group-class',
  'boarding',
  'board-and-train',
]) {
  test(
    `DAY-U23: POST /staff/rates narrows to the evaluation, so ${category} is 400 and writes nothing`,
    SKIP_WHEN_NO_DB,
    async () => {
      const { app } = staffApp();
      const res = await postRate({
        app,
        idempotencyKey: `sr-narrow-${randomUUID()}`,
        payload: { ...evaluationRate('fayetteville'), category },
      });
      assert.equal(res.statusCode, 400, res.body);
      assert.equal(res.json().error.code, 'bad_request');
      assert.deepEqual(await rowsForTrack(category, 'fayetteville'), []);
    },
  );
}

test(
  'DAY-U23: POST /staff/rates takes the seed amount 0, and any other amount is 422 invalid_payload',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app } = staffApp();
    for (const amount_cents of [1, 5000, -1, 2_000_000]) {
      const res = await postRate({
        app,
        idempotencyKey: `sr-amount-${randomUUID()}`,
        payload: { ...evaluationRate('fayetteville'), amount_cents },
      });
      assert.equal(res.statusCode, 422, `${amount_cents}: ${res.body}`);
      assert.equal(res.json().error.code, 'invalid_payload');
    }
    assert.equal((await rowsForTrack('evaluation', 'fayetteville')).length, 1, 'nothing written');

    const seed = await postRate({
      app,
      idempotencyKey: `sr-amount-${randomUUID()}`,
      payload: evaluationRate('fayetteville'),
    });
    assert.equal(seed.statusCode, 200, seed.body);
  },
);

test(
  'POST /staff/rates — same-day re-edit VOIDS the prior entry + inserts new (never overwrites)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app } = staffApp();
    await postRate({
      app,
      idempotencyKey: `sr-c1-${randomUUID()}`,
      payload: evaluationRate('fayetteville', { note: 'first' }),
    });
    const second = await postRate({
      app,
      idempotencyKey: `sr-c2-${randomUUID()}`,
      payload: evaluationRate('fayetteville', { note: 'second' }),
    });
    assert.equal(second.statusCode, 200, second.body);
    assert.equal((second.json() as { note: string }).note, 'second');

    const rows = (await rowsForTrack('evaluation', 'fayetteville')).filter(
      (r) => r.effectiveFrom === '2026-05-19',
    );
    assert.equal(rows.length, 2, 'append-only: old entry kept (voided), new inserted');
    const voided = rows.filter((r) => r.voidedAt !== null);
    const live = rows.filter((r) => r.voidedAt === null);
    assert.equal(voided.length, 1, 'the prior entry is voided, not overwritten');
    assert.equal(voided[0]!.note, 'first', 'old value preserved on the voided row');
    assert.equal(live.length, 1);
    assert.equal(live[0]!.note, 'second', 'the new value is a fresh row');
  },
);

test(
  'POST /staff/rates — future effective_from supersedes: closes the open row, opens a new one',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app } = staffApp();
    const res = await postRate({
      app,
      idempotencyKey: `sr-sup-${randomUUID()}`,
      payload: evaluationRate('fayetteville', { note: 'next', effective_from: '2026-07-01' }),
    });
    assert.equal(res.statusCode, 200, res.body);
    const rows = await rowsForTrack('evaluation', 'fayetteville');
    assert.equal(rows.length, 2, 'old window + new window');
    const old = rows.find((r) => r.note !== 'next')!;
    const next = rows.find((r) => r.note === 'next')!;
    assert.equal(old.effectiveTo, '2026-07-01', 'prior window closed at the new start');
    assert.equal(next.effectiveFrom, '2026-07-01');
    assert.equal(next.effectiveTo, null);
  },
);

test(
  'POST /staff/rates — a new current rate slots in BEFORE a scheduled future rate (no conflict)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app } = staffApp();
    // Schedule a future change, then set a different current rate today.
    const future = await postRate({
      app,
      idempotencyKey: `sr-slot1-${randomUUID()}`,
      payload: evaluationRate('bentonville', { note: 'autumn', effective_from: '2026-09-01' }),
    });
    assert.equal(future.statusCode, 200, future.body);
    const current = await postRate({
      app,
      idempotencyKey: `sr-slot2-${randomUUID()}`,
      payload: evaluationRate('bentonville', { note: 'today' }),
    });
    assert.equal(current.statusCode, 200, current.body);
    const body = current.json() as {
      note: string;
      effective_from: string;
      effective_to: string | null;
    };
    assert.equal(body.note, 'today');
    assert.equal(body.effective_from, '2026-05-19');
    assert.equal(
      body.effective_to,
      '2026-09-01',
      'current window ends where the scheduled one begins',
    );

    const live = (await rowsForTrack('evaluation', 'bentonville')).filter(
      (r) => r.voidedAt === null,
    );
    assert.equal(live.length, 3, 'the closed seed, the current and the scheduled, no overlap');
  },
);

// ──────────────────────────────────────────────────────────────────────────
// POST /staff/rates/:id/void — cancel/remove, predecessor reopens (no trap)
// ──────────────────────────────────────────────────────────────────────────

test(
  'POST /staff/rates/:id/void — cancelling a scheduled rate reopens the predecessor (no gap)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app } = staffApp();
    // Schedule a change from 2026-07-01 on the seeded evaluation @fay (since 2025-01-01).
    const scheduled = await postRate({
      app,
      idempotencyKey: `sr-vsched-${randomUUID()}`,
      payload: evaluationRate('fayetteville', { effective_from: '2026-07-01' }),
    });
    const scheduledId = (scheduled.json() as { id: string }).id;

    const res = await voidRate(app, scheduledId);
    assert.equal(res.statusCode, 200, res.body);

    const live = (await rowsForTrack('evaluation', 'fayetteville')).filter(
      (r) => r.voidedAt === null,
    );
    assert.equal(live.length, 1, 'only the original window remains');
    assert.equal(live[0]!.effectiveFrom, '2025-01-01');
    assert.equal(live[0]!.effectiveTo, null, 'predecessor reopened to open-ended (no pricing gap)');
  },
);

/** PAY-74's own track, so nothing here moves a seeded rate. Returns ids in the order given. */
async function seedPrivateLessonTrack(
  rows: readonly { effectiveFrom: string; effectiveTo: string | null }[],
): Promise<string[]> {
  await clearPrivateLessonTrack();
  const ids: string[] = [];
  for (const row of rows) {
    const [inserted] = await db
      .insert(serviceRates)
      .values({
        category: 'private-lesson',
        location: 'bentonville',
        amountCents: 5000 + ids.length,
        unit: 'flat',
        effectiveFrom: row.effectiveFrom,
        effectiveTo: row.effectiveTo,
      })
      .returning({ id: serviceRates.id });
    assert.ok(inserted);
    ids.push(inserted.id);
  }
  return ids;
}

async function clearPrivateLessonTrack(): Promise<void> {
  await db
    .delete(serviceRates)
    .where(
      and(eq(serviceRates.category, 'private-lesson'), eq(serviceRates.location, 'bentonville')),
    );
}

test(
  'POST /staff/rates/:id/void — a row begun before today with a predecessor is 409 conflict, and nothing moves',
  SKIP_WHEN_NO_DB,
  async () => {
    const [olderId, pastId] = await seedPrivateLessonTrack([
      { effectiveFrom: '2026-01-01', effectiveTo: '2026-03-01' },
      { effectiveFrom: '2026-03-01', effectiveTo: null },
    ]);
    assert.ok(pastId);
    const { app } = staffApp();

    const res = await voidRate(app, pastId);

    assert.equal(res.statusCode, 409, res.body);
    assert.equal((res.json() as { error: { code: string } }).error.code, 'conflict');
    const rows = await rowsForTrack('private-lesson', 'bentonville');
    const older = rows.find((r) => r.id === olderId);
    const past = rows.find((r) => r.id === pastId);
    assert.equal(older?.effectiveTo, '2026-03-01', 'the old price does not reopen over past dates');
    assert.equal(past?.voidedAt, null, 'and the row stands');
    await clearPrivateLessonTrack();
  },
);

test(
  'POST /staff/rates/:id/void — a row begun before today with no predecessor stays voidable',
  SKIP_WHEN_NO_DB,
  async () => {
    const [onlyId] = await seedPrivateLessonTrack([
      { effectiveFrom: '2026-03-01', effectiveTo: null },
    ]);
    assert.ok(onlyId);
    const { app } = staffApp();

    const res = await voidRate(app, onlyId);

    assert.equal(res.statusCode, 200, res.body);
    const [row] = await rowsForTrack('private-lesson', 'bentonville');
    assert.notEqual(row?.voidedAt, null);
    await clearPrivateLessonTrack();
  },
);

test(
  'POST /staff/rates/:id/void — a row begun today, or scheduled, voids and reopens its predecessor',
  SKIP_WHEN_NO_DB,
  async () => {
    for (const effectiveFrom of ['2026-05-19', '2026-05-20']) {
      const [olderId, rowId] = await seedPrivateLessonTrack([
        { effectiveFrom: '2026-01-01', effectiveTo: effectiveFrom },
        { effectiveFrom, effectiveTo: null },
      ]);
      assert.ok(rowId);
      const { app } = staffApp();

      const res = await voidRate(app, rowId);

      assert.equal(res.statusCode, 200, res.body);
      const older = (await rowsForTrack('private-lesson', 'bentonville')).find(
        (r) => r.id === olderId,
      );
      assert.equal(older?.effectiveTo, null, `reopened over ${effectiveFrom} onward`);
    }
    await clearPrivateLessonTrack();
  },
);

test(
  'POST /staff/rates/:id/void — "before today" is a Chicago day: at 03:00Z on 2 Jun, 1 Jun is still today',
  SKIP_WHEN_NO_DB,
  async () => {
    const [, rowId] = await seedPrivateLessonTrack([
      { effectiveFrom: '2026-01-01', effectiveTo: '2026-06-01' },
      { effectiveFrom: '2026-06-01', effectiveTo: null },
    ]);
    assert.ok(rowId);
    const { app, authenticate } = makeContractApp(FIXTURE_MANAGER_PRINCIPAL);
    registerStaffRatesRoute(app, {
      authenticate,
      now: () => new Date('2026-06-02T03:00:00Z'),
    });

    const res = await voidRate(app, rowId);

    assert.equal(res.statusCode, 200, res.body);
    await clearPrivateLessonTrack();
  },
);

test(
  'POST /staff/rates/:id/void — voiding the only rate is recoverable (not a trap)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app } = staffApp();
    const [seed] = await rowsForTrack('evaluation', 'bentonville');
    assert.ok(seed);
    assert.equal((await voidRate(app, seed.id)).statusCode, 200);
    assert.equal(
      (await rowsForTrack('evaluation', 'bentonville')).filter((r) => r.voidedAt === null).length,
      0,
      'no live rate after voiding the only entry',
    );

    // Not trapped: a fresh rate can be set right back.
    const again = await postRate({
      app,
      idempotencyKey: `sr-vonly2-${randomUUID()}`,
      payload: evaluationRate('bentonville', { note: 'set back' }),
    });
    assert.equal(again.statusCode, 200, again.body);
    const live = (await rowsForTrack('evaluation', 'bentonville')).filter(
      (r) => r.voidedAt === null,
    );
    assert.equal(live.length, 1);
    assert.equal(live[0]!.note, 'set back');
  },
);

test('POST /staff/rates/:id/void — unknown id → 404', SKIP_WHEN_NO_DB, async () => {
  const { app } = staffApp();
  const res = await voidRate(app, randomUUID());
  assert.equal(res.statusCode, 404, res.body);
});

test('POST /staff/rates/:id/void — owner principal → 403', SKIP_WHEN_NO_DB, async () => {
  const { app } = staffApp(FIXTURE_OWNER_PRINCIPAL);
  const res = await voidRate(app, randomUUID());
  assert.equal(res.statusCode, 403, res.body);
});

// ──────────────────────────────────────────────────────────────────────────
// History — the append-only rows ARE the change log
// ──────────────────────────────────────────────────────────────────────────

test(
  'GET /staff/rates/history — logs every entry incl. voided, with who/when, newest first',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app } = staffApp();
    // set today → schedule a future row → same-day correct (voids the first).
    await postRate({
      app,
      idempotencyKey: `sr-h1-${randomUUID()}`,
      payload: evaluationRate('fayetteville', { note: 'first' }),
    });
    await postRate({
      app,
      idempotencyKey: `sr-h2-${randomUUID()}`,
      payload: evaluationRate('fayetteville', { note: 'scheduled', effective_from: '2026-08-01' }),
    });
    await postRate({
      app,
      idempotencyKey: `sr-h3-${randomUUID()}`,
      payload: evaluationRate('fayetteville', { note: 'corrected' }),
    });

    const res = await getHistory(app, 'evaluation', 'fayetteville');
    assert.equal(res.statusCode, 200, res.body);
    const log = (
      res.json() as Array<{
        note: string | null;
        voided_at: string | null;
        voided_by_staff_id: string | null;
        created_by_staff_id: string | null;
        created_at: string;
      }>
    ).filter((e) => e.created_by_staff_id !== null);
    assert.equal(log.length, 3, 'all three entries present (incl. the voided one)');
    for (const entry of log) assert.equal(entry.created_by_staff_id, STAFF_ID, 'who created');
    const voided = log.find((e) => e.note === 'first')!;
    assert.ok(voided.voided_at !== null, 'the corrected entry is voided, not gone');
    assert.equal(voided.voided_by_staff_id, STAFF_ID, 'who voided');
    // The catalog (active+scheduled) hides the voided entry.
    const catalog = (await app
      .inject({ method: 'GET', url: '/staff/rates' })
      .then((r) => r.json())) as Array<{ note: string | null }>;
    assert.ok(!catalog.some((r) => r.note === 'first'));
  },
);

// ──────────────────────────────────────────────────────────────────────────
// Validation + auth
// ──────────────────────────────────────────────────────────────────────────

test('POST /staff/rates — back-dated effective_from → 422', SKIP_WHEN_NO_DB, async () => {
  const { app } = staffApp();
  const res = await postRate({
    app,
    idempotencyKey: `sr-back-${randomUUID()}`,
    payload: evaluationRate('fayetteville', { effective_from: '2026-01-01' }),
  });
  assert.equal(res.statusCode, 422, res.body);
  assert.match((res.json() as { error: { message: string } }).error.message, /back-dated|past/);
});

test('POST /staff/rates — bad enum / missing key', SKIP_WHEN_NO_DB, async () => {
  const { app } = staffApp();
  const bad = async (payload: Record<string, unknown>) =>
    (await postRate({ app, idempotencyKey: `sr-bad-${randomUUID()}`, payload })).statusCode;
  assert.equal(await bad({ ...evaluationRate('fayetteville'), category: 'dog-grooming' }), 400);
  assert.equal(await bad({ ...evaluationRate('fayetteville'), location: 'tulsa' }), 400);
  assert.equal(await bad({ ...evaluationRate('fayetteville'), unit: 'per-moon' }), 400);
  const noKey = await postRate({ app, payload: evaluationRate('fayetteville') });
  assert.equal(noKey.statusCode, 400, 'missing idempotency key');
});

test('POST /staff/rates — owner principal → 403', SKIP_WHEN_NO_DB, async () => {
  const { app } = staffApp(FIXTURE_OWNER_PRINCIPAL);
  const res = await postRate({
    app,
    idempotencyKey: `sr-403-${randomUUID()}`,
    payload: evaluationRate('fayetteville'),
  });
  assert.equal(res.statusCode, 403, res.body);
});

// ──────────────────────────────────────────────────────────────────────────
// Idempotency + concurrency
// ──────────────────────────────────────────────────────────────────────────

test(
  'POST /staff/rates — idempotent replay returns the same row, no double write',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app } = staffApp();
    const key = `sr-idemp-${randomUUID()}`;
    const payload = evaluationRate('fayetteville');
    const a = await postRate({ app, idempotencyKey: key, payload });
    const b = await postRate({ app, idempotencyKey: key, payload });
    assert.equal(a.statusCode, 200, a.body);
    assert.equal(b.statusCode, 200, b.body);
    assert.deepEqual(a.json(), b.json(), 'replay returns identical body');
    assert.equal(
      (await rowsForTrack('evaluation', 'fayetteville')).length,
      2,
      'the seed and one new row, no second',
    );
  },
);

test(
  'POST /staff/rates — concurrent edits to one track serialize (one live open window)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app } = staffApp();
    const [a, b] = await Promise.all([
      postRate({
        app,
        idempotencyKey: `sr-race1-${randomUUID()}`,
        payload: evaluationRate('fayetteville', { note: 'one' }),
      }),
      postRate({
        app,
        idempotencyKey: `sr-race2-${randomUUID()}`,
        payload: evaluationRate('fayetteville', { note: 'two' }),
      }),
    ]);
    assert.equal(a.statusCode, 200, a.body);
    assert.equal(b.statusCode, 200, b.body);
    // The advisory lock serializes them: the second voids the first's same-day
    // row and inserts its own → exactly one LIVE open window (no two open rows).
    const liveOpen = await db
      .select({ id: serviceRates.id })
      .from(serviceRates)
      .where(
        and(
          eq(serviceRates.category, 'evaluation'),
          eq(serviceRates.location, 'fayetteville'),
          isNull(serviceRates.voidedAt),
          isNull(serviceRates.effectiveTo),
        ),
      );
    assert.equal(liveOpen.length, 1, 'exactly one live open window after concurrent edits');
  },
);

// ──────────────────────────────────────────────────────────────────────────
// STAFF-U07 (design §2.1:2080-2091): the legacy rate editor is
// requireStaffRole('owner', 'manager') whole. The shared (category, campus)
// track on service_rates is owner/manager because the table has no trainer
// axis; a trainer's own `pl.lesson_price_cents` (STAFF-30) is STAFF-U23's
// per-trainer row, later.
// ──────────────────────────────────────────────────────────────────────────

test(
  'STAFF-U07: the trainer is refused POST /staff/rates — 403 forbidden, nothing written',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app } = staffApp(FIXTURE_STAFF_PRINCIPAL);
    const res = await postRate({
      app,
      idempotencyKey: `sr-trainer-${randomUUID()}`,
      payload: evaluationRate('bentonville'),
    });
    assert.equal(res.statusCode, 403, res.body);
    assert.equal(res.json().error.code, 'forbidden');
    assert.equal(
      (await rowsForTrack('evaluation', 'bentonville')).length,
      1,
      'the refused post wrote a row',
    );
  },
);

test(
  'STAFF-U07: the trainer is refused POST /staff/rates/:id/void — 403 before any lookup',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app } = staffApp(FIXTURE_STAFF_PRINCIPAL);
    const res = await voidRate(app, randomUUID());
    assert.equal(res.statusCode, 403, res.body);
    assert.equal(res.json().error.code, 'forbidden');
  },
);

test(
  'STAFF-U07: the trainer still reads GET /staff/rates (any role)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app } = staffApp(FIXTURE_STAFF_PRINCIPAL);
    const res = await app.inject({ method: 'GET', url: '/staff/rates' });
    assert.equal(res.statusCode, 200, res.body);
  },
);

test('STAFF-U07: the manager and the owner role post a rate (200)', SKIP_WHEN_NO_DB, async () => {
  for (const principal of [FIXTURE_MANAGER_PRINCIPAL, FIXTURE_OWNER_ROLE_PRINCIPAL]) {
    const { app } = staffApp(principal);
    const res = await postRate({
      app,
      idempotencyKey: `sr-role-${randomUUID()}`,
      payload: evaluationRate('bentonville', {
        effective_from: principal === FIXTURE_MANAGER_PRINCIPAL ? '2026-06-01' : '2026-07-01',
      }),
    });
    assert.equal(res.statusCode, 200, res.body);
  }
});
