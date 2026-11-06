import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { serviceRates } from '../../src/db/schema/schema.js';
import { registerStaffRatesRoute } from '../../src/routes/staffRates.js';
import { FIXTURE_IDS, FIXTURE_NOW } from './_fixture.js';
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
 * FIXTURE_TODAY = 2026-05-19. Fixture seeds: day-school @fay $75 (open from
 * 2026-01-01), day-school @null $70, day-care @null $45 (→2026-06-01) then $50,
 * boarding @fay $85, day-care @bentonville $40 (expired 2026-04-01). The staff
 * principal is the manager, `staffAmberId` (P02): the rate editor is owner and
 * manager since STAFF-U07, and the trainer's 403 is pinned at the end.
 */

registerFixtureHooks();

const STAFF_ID = FIXTURE_IDS.staffAmberId;

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
      unit: serviceRates.unit,
      effectiveFrom: serviceRates.effectiveFrom,
      effectiveTo: serviceRates.effectiveTo,
      voidedAt: serviceRates.voidedAt,
      createdByStaffId: serviceRates.createdByStaffId,
    })
    .from(serviceRates)
    .where(
      and(
        eq(serviceRates.category, category as 'day-school'),
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
    const { app } = staffApp();
    const res = await app.inject({ method: 'GET', url: '/staff/rates' });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as Array<{
      category: string;
      location: string | null;
      amount_cents: number;
      effective_to: string | null;
      created_by_staff_id: string | null;
    }>;
    const daySchoolFay = body.find(
      (r) => r.category === 'day-school' && r.location === 'fayetteville',
    );
    assert.ok(daySchoolFay, 'day-school fayetteville present');
    assert.equal(daySchoolFay.amount_cents, 7500);
    assert.equal(daySchoolFay.effective_to, null);
    assert.equal(daySchoolFay.created_by_staff_id, null, 'seed rows have no creator');
    assert.equal(
      body.find((r) => r.category === 'day-care' && r.location === 'bentonville'),
      undefined,
      'expired bentonville day-care excluded',
    );
    assert.ok(
      body.some((r) => r.category === 'day-school' && r.location === null),
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
      payload: {
        category: 'private-lesson',
        location: 'fayetteville',
        amount_cents: 7_550.5,
        unit: 'flat',
      },
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
  'POST /staff/rates — first rate for a fresh track inserts an open row, stamps created_by',
  SKIP_WHEN_NO_DB,
  async () => {
    // A manager's private-lesson rate (design §2.1:2086-2091): kept green at
    // 2.0.0 and deleted by DAY-U23 at design 4.0.0. The shared (category,
    // campus) track is owner/manager — service_rates has no trainer axis; a
    // trainer's own lesson price is STAFF-U23's per-trainer row, later.
    const { app } = staffApp();
    const res = await postRate({
      app,
      idempotencyKey: `sr-insert-${randomUUID()}`,
      payload: {
        category: 'private-lesson',
        location: 'bentonville',
        amount_cents: 11000,
        unit: 'flat',
      },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as {
      amount_cents: number;
      effective_from: string;
      effective_to: null;
      created_by_staff_id: string;
    };
    assert.equal(body.amount_cents, 11000);
    assert.equal(body.effective_to, null);
    assert.equal(body.effective_from, '2026-05-19', 'defaults to today (Chicago)');
    assert.equal(body.created_by_staff_id, STAFF_ID, 'stamps the acting staff');

    const rows = await rowsForTrack('private-lesson', 'bentonville');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.voidedAt, null);
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
      payload: {
        category: 'private-lesson',
        location: 'fayetteville',
        amount_cents: 10000,
        unit: 'flat',
      },
    });
    const second = await postRate({
      app,
      idempotencyKey: `sr-c2-${randomUUID()}`,
      payload: {
        category: 'private-lesson',
        location: 'fayetteville',
        amount_cents: 12000,
        unit: 'flat',
      },
    });
    assert.equal(second.statusCode, 200, second.body);
    assert.equal((second.json() as { amount_cents: number }).amount_cents, 12000);

    const rows = await rowsForTrack('private-lesson', 'fayetteville');
    assert.equal(rows.length, 2, 'append-only: old entry kept (voided), new inserted');
    const voided = rows.filter((r) => r.voidedAt !== null);
    const live = rows.filter((r) => r.voidedAt === null);
    assert.equal(voided.length, 1, 'the prior $100 entry is voided, not overwritten');
    assert.equal(voided[0]!.amountCents, 10000, 'old value preserved on the voided row');
    assert.equal(live.length, 1);
    assert.equal(live[0]!.amountCents, 12000, 'the new value is a fresh row');
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
      payload: {
        category: 'day-school',
        location: 'fayetteville',
        amount_cents: 8000,
        unit: 'per-day',
        effective_from: '2026-07-01',
      },
    });
    assert.equal(res.statusCode, 200, res.body);
    const rows = await rowsForTrack('day-school', 'fayetteville');
    assert.equal(rows.length, 2, 'old window + new window');
    const old = rows.find((r) => r.amountCents === 7500)!;
    const next = rows.find((r) => r.amountCents === 8000)!;
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
      payload: {
        category: 'boarding',
        location: 'bentonville',
        amount_cents: 9000,
        unit: 'per-night',
        effective_from: '2026-09-01',
      },
    });
    assert.equal(future.statusCode, 200, future.body);
    const current = await postRate({
      app,
      idempotencyKey: `sr-slot2-${randomUUID()}`,
      payload: {
        category: 'boarding',
        location: 'bentonville',
        amount_cents: 8000,
        unit: 'per-night',
      },
    });
    assert.equal(current.statusCode, 200, current.body);
    const body = current.json() as {
      amount_cents: number;
      effective_from: string;
      effective_to: string | null;
    };
    assert.equal(body.amount_cents, 8000);
    assert.equal(body.effective_from, '2026-05-19');
    assert.equal(
      body.effective_to,
      '2026-09-01',
      'current window ends where the scheduled one begins',
    );

    const live = (await rowsForTrack('boarding', 'bentonville')).filter((r) => r.voidedAt === null);
    assert.equal(live.length, 2, 'current + scheduled coexist, no overlap');
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
    // Schedule $90 from 2026-07-01 on the seeded boarding @fay ($85 since 2026-01-01).
    const scheduled = await postRate({
      app,
      idempotencyKey: `sr-vsched-${randomUUID()}`,
      payload: {
        category: 'boarding',
        location: 'fayetteville',
        amount_cents: 9000,
        unit: 'per-night',
        effective_from: '2026-07-01',
      },
    });
    const scheduledId = (scheduled.json() as { id: string }).id;

    const res = await voidRate(app, scheduledId);
    assert.equal(res.statusCode, 200, res.body);

    const live = (await rowsForTrack('boarding', 'fayetteville')).filter(
      (r) => r.voidedAt === null,
    );
    assert.equal(live.length, 1, 'only the original window remains');
    assert.equal(live[0]!.amountCents, 8500);
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
    const set = await postRate({
      app,
      idempotencyKey: `sr-vonly-${randomUUID()}`,
      payload: {
        category: 'group-class',
        location: 'bentonville',
        amount_cents: 30000,
        unit: 'flat',
      },
    });
    const id = (set.json() as { id: string }).id;
    assert.equal((await voidRate(app, id)).statusCode, 200);
    assert.equal(
      (await rowsForTrack('group-class', 'bentonville')).filter((r) => r.voidedAt === null).length,
      0,
      'no live rate after voiding the only entry',
    );

    // Not trapped: a fresh rate can be set right back.
    const again = await postRate({
      app,
      idempotencyKey: `sr-vonly2-${randomUUID()}`,
      payload: {
        category: 'group-class',
        location: 'bentonville',
        amount_cents: 32000,
        unit: 'flat',
      },
    });
    assert.equal(again.statusCode, 200, again.body);
    const live = (await rowsForTrack('group-class', 'bentonville')).filter(
      (r) => r.voidedAt === null,
    );
    assert.equal(live.length, 1);
    assert.equal(live[0]!.amountCents, 32000);
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
    const track = { category: 'group-class', location: 'fayetteville' } as const;
    // set $200 today → schedule $220 future → same-day correct to $210 (voids $200).
    await postRate({
      app,
      idempotencyKey: `sr-h1-${randomUUID()}`,
      payload: { ...track, amount_cents: 20000, unit: 'flat' },
    });
    await postRate({
      app,
      idempotencyKey: `sr-h2-${randomUUID()}`,
      payload: { ...track, amount_cents: 22000, unit: 'flat', effective_from: '2026-08-01' },
    });
    await postRate({
      app,
      idempotencyKey: `sr-h3-${randomUUID()}`,
      payload: { ...track, amount_cents: 21000, unit: 'flat' },
    });

    const res = await getHistory(app, 'group-class', 'fayetteville');
    assert.equal(res.statusCode, 200, res.body);
    const log = res.json() as Array<{
      amount_cents: number;
      voided_at: string | null;
      voided_by_staff_id: string | null;
      created_by_staff_id: string | null;
      created_at: string;
    }>;
    assert.equal(log.length, 3, 'all three entries present (incl. the voided $200)');
    for (const entry of log) assert.equal(entry.created_by_staff_id, STAFF_ID, 'who created');
    const voided = log.find((e) => e.amount_cents === 20000)!;
    assert.ok(voided.voided_at !== null, 'the corrected entry is voided, not gone');
    assert.equal(voided.voided_by_staff_id, STAFF_ID, 'who voided');
    // The catalog (active+scheduled) hides the voided entry.
    const catalog = (await app
      .inject({ method: 'GET', url: '/staff/rates' })
      .then((r) => r.json())) as Array<{
      category: string;
      location: string | null;
      amount_cents: number;
    }>;
    assert.ok(!catalog.some((r) => r.category === 'group-class' && r.amount_cents === 20000));
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
    payload: {
      category: 'day-care',
      location: 'fayetteville',
      amount_cents: 5000,
      unit: 'per-day',
      effective_from: '2026-01-01',
    },
  });
  assert.equal(res.statusCode, 422, res.body);
  assert.match((res.json() as { error: { message: string } }).error.message, /back-dated|past/);
});

test('POST /staff/rates — day-program with a non-per-day unit → 422', SKIP_WHEN_NO_DB, async () => {
  const { app } = staffApp();
  const res = await postRate({
    app,
    idempotencyKey: `sr-unit-${randomUUID()}`,
    payload: {
      category: 'day-school',
      location: 'bentonville',
      amount_cents: 6500,
      unit: 'per-week',
    },
  });
  assert.equal(res.statusCode, 422, res.body);
  assert.match((res.json() as { error: { message: string } }).error.message, /per-day/);
});

test('POST /staff/rates — bad enum / amount / missing key', SKIP_WHEN_NO_DB, async () => {
  const { app } = staffApp();
  const bad = async (payload: Record<string, unknown>) =>
    (await postRate({ app, idempotencyKey: `sr-bad-${randomUUID()}`, payload })).statusCode;
  assert.equal(
    await bad({
      category: 'dog-grooming',
      location: 'fayetteville',
      amount_cents: 5000,
      unit: 'per-day',
    }),
    400,
  );
  assert.equal(
    await bad({ category: 'day-care', location: 'tulsa', amount_cents: 5000, unit: 'per-day' }),
    400,
  );
  assert.equal(
    await bad({ category: 'day-care', location: 'fayetteville', amount_cents: 0, unit: 'per-day' }),
    400,
  );
  assert.equal(
    await bad({
      category: 'day-care',
      location: 'fayetteville',
      amount_cents: 2_000_000,
      unit: 'per-day',
    }),
    400,
  );
  const noKey = await postRate({
    app,
    payload: {
      category: 'day-care',
      location: 'fayetteville',
      amount_cents: 5000,
      unit: 'per-day',
    },
  });
  assert.equal(noKey.statusCode, 400, 'missing idempotency key');
});

test('POST /staff/rates — owner principal → 403', SKIP_WHEN_NO_DB, async () => {
  const { app } = staffApp(FIXTURE_OWNER_PRINCIPAL);
  const res = await postRate({
    app,
    idempotencyKey: `sr-403-${randomUUID()}`,
    payload: {
      category: 'day-care',
      location: 'fayetteville',
      amount_cents: 5000,
      unit: 'per-day',
    },
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
    const payload = {
      category: 'board-and-train',
      location: 'fayetteville',
      amount_cents: 200000,
      unit: 'flat',
    };
    const a = await postRate({ app, idempotencyKey: key, payload });
    const b = await postRate({ app, idempotencyKey: key, payload });
    assert.equal(a.statusCode, 200, a.body);
    assert.equal(b.statusCode, 200, b.body);
    assert.deepEqual(a.json(), b.json(), 'replay returns identical body');
    assert.equal(
      (await rowsForTrack('board-and-train', 'fayetteville')).length,
      1,
      'no second row',
    );
  },
);

test(
  'POST /staff/rates — concurrent edits to one track serialize (one live open window)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app } = staffApp();
    const payload = (cents: number) => ({
      category: 'day-care' as const,
      location: 'fayetteville' as const,
      amount_cents: cents,
      unit: 'per-day' as const,
    });
    const [a, b] = await Promise.all([
      postRate({ app, idempotencyKey: `sr-race1-${randomUUID()}`, payload: payload(5100) }),
      postRate({ app, idempotencyKey: `sr-race2-${randomUUID()}`, payload: payload(5200) }),
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
          eq(serviceRates.category, 'day-care'),
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
// per-trainer row, later. Until design 4.0.0 (DAY-U23) narrows the route, a
// manager's rate post is accepted — harmless: no family exists before §2.11,
// and the preflight catches any rate off its seed.
// ──────────────────────────────────────────────────────────────────────────

test(
  'STAFF-U07: the trainer is refused POST /staff/rates — 403 forbidden, nothing written',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app } = staffApp(FIXTURE_STAFF_PRINCIPAL);
    const res = await postRate({
      app,
      idempotencyKey: `sr-trainer-${randomUUID()}`,
      payload: {
        category: 'boarding',
        location: 'bentonville',
        amount_cents: 1,
        unit: 'per-night',
      },
    });
    assert.equal(res.statusCode, 403, res.body);
    assert.equal(res.json().error.code, 'forbidden');
    const written = (await rowsForTrack('boarding', 'bentonville')).filter(
      (r) => r.amountCents === 1,
    );
    assert.deepEqual(written, [], 'the refused post wrote a row');
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
      payload: {
        category: 'boarding',
        location: 'bentonville',
        amount_cents: principal === FIXTURE_MANAGER_PRINCIPAL ? 9100 : 9200,
        unit: 'per-night',
        effective_from: principal === FIXTURE_MANAGER_PRINCIPAL ? '2026-06-01' : '2026-07-01',
      },
    });
    assert.equal(res.statusCode, 200, res.body);
  }
});
