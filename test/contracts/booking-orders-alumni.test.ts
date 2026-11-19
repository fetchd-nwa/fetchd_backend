import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, beforeEach, test } from 'node:test';
import { eq, sql } from 'drizzle-orm';
import type {
  AlumniCreditsShortDetails,
  CreditExpiredBeforeDateDetails,
  CreditsShortDetails,
  CreditTier,
  PoolDrawWire,
  PostBookingOrdersCheckResponse,
  PostBookingOrdersResponse,
} from '../../src/contracts/wire.js';
import { db } from '../../src/db/client.js';
import { creditPackages } from '../../src/db/schema/schema.js';
import { registerStaffCreditPackagesRoute } from '../../src/routes/staffCreditPackages.js';
import { at } from './_checkinFixture.js';
import {
  D,
  buy,
  checkThenPost,
  checkThenPostBoth,
  clearOrderWorld,
  dogDatesOf,
  dropFixtureBentonvilleCare,
  orderApp,
  part,
  refused,
  rowCounts,
  type OrderApp,
} from './_bookingOrderFixture.js';
import { createAlumniDog, createBookableDog, removeDogs } from './_dayFixture.js';
import { FIXTURE_IDS, resetCatalogSeed } from './_fixture.js';
import {
  FIXTURE_MANAGER_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';
import { plantLot, poolBalance } from './_poolFixture.js';

/**
 * `POST /booking-orders`' alumni question, patch (B) of plan one-off O-CREDITS: these cases need
 * M5.25's catalog, where "Alumni Bentonville 10 Visits" ($320.00 for 10) is live beside the
 * $35.00 single day care day, so an alumni dog's day her alumni lots do not pay can be askable
 * (her 562 (a); design §3.2 step 8, Amendment A1 and its revision 2; the brief's B4, B5, B13,
 * B22, B22b, B23, and B8 on each). Every case runs the check first and the POST after it
 * (`checkThenPost`), so each is also B8's "check = the POST, rows unchanged".
 *
 * Catalog edits are the staff route's (`expiry_months`) or a row's own price, and
 * `resetCatalogSeed` puts the months and the windows back after each test; a price edit is put
 * back in its own `finally`.
 */

registerFixtureHooks();
const created: string[] = [];
beforeEach(dropFixtureBentonvilleCare);
afterEach(async () => {
  await clearOrderWorld();
  await resetCatalogSeed();
});
after(async () => {
  await clearOrderWorld();
  await removeDogs(created);
});

const ALUMNI_PACK = 'daycare-alumni-10-bentonville';
const SINGLE_CARE = 'single-day-daycare-bentonville';
const MON_TO_WED = [D.MON, D.TUE, D.WED];
/** Inside the clock's month: a lot that pays November and early December only. */
const ENDS_10_DEC = '2037-12-10T18:00:00.000Z';
const ENDS_31_DEC = '2037-12-31T18:00:00.000Z';

const care = (args: { credits: number; tier?: 'regular' | 'alumni'; expiresAt?: string }) =>
  plantLot({
    credits: args.credits,
    expiresAt: args.expiresAt ?? ENDS_31_DEC,
    location: 'bentonville',
    mode: 'daycare',
    tier: args.tier ?? 'regular',
  });

const careBalance = (tier: 'regular' | 'alumni' = 'regular') =>
  poolBalance({ location: 'bentonville', mode: 'daycare', tier });

async function wafflesAndLola(): Promise<{ waffles: string; lola: string }> {
  return { waffles: await createAlumniDog(created), lola: await createBookableDog(created) };
}

/** A staff manager's expiry edit, as `package-expiry-stamp.test.ts:99` makes it. */
async function setMonths(o: OrderApp, key: string, months: number): Promise<void> {
  const staff = makeContractApp(FIXTURE_MANAGER_PRINCIPAL);
  registerStaffCreditPackagesRoute(staff.app, {
    authenticate: staff.authenticate,
    now: o.clock.now,
  });
  const res = await staff.app.inject({
    method: 'PATCH',
    url: `/staff/credit-packages/${key}`,
    headers: { 'idempotency-key': `months-${randomUUID()}` },
    payload: { expiry_months: months },
  });
  assert.equal(res.statusCode, 200, res.body);
}

const consent = (count: number) => [
  { location: 'bentonville' as const, mode: 'daycare' as const, count },
];

function alumniPool(res: { statusCode: number; body: string }) {
  const details = refused<AlumniCreditsShortDetails>(res, 'alumni_credits_short');
  assert.equal(details.pools.length, 1, JSON.stringify(details));
  return details.pools[0]!;
}

function planOf(res: { statusCode: number; body: string; json(): unknown }) {
  assert.equal(res.statusCode, 201, res.body);
  return (res.json() as PostBookingOrdersResponse).plan;
}

async function spentCents(): Promise<number> {
  const { rows } = await db.execute(sql`
    SELECT coalesce(sum(amount_cents), 0)::int AS cents FROM charges
     WHERE owner_id = ${FIXTURE_IDS.ownerId} AND status = 'succeeded'`);
  return (rows[0] as { cents: number }).cents;
}

// ── B4: case B ──────────────────────────────────────────────────────────────────

test(
  'B4 (case B): 1 alumni / 6 day care: `alumni_credits_short` 2, `consentable` 2, the Bentonville pack; `count: 2` books case B2; 1 or 3 is refused afresh; a stale 2 after a desk grant is ignored and books on alumni',
  SKIP_WHEN_NO_DB,
  async () => {
    const { waffles, lola } = await wafflesAndLola();
    await care({ credits: 1, tier: 'alumni' });
    await care({ credits: 6 });
    const { app } = orderApp();
    const order = { parts: [part({ dogs: [waffles, lola], dates: MON_TO_WED })] };

    const asked = alumniPool(await checkThenPost(app, order));
    assert.deepEqual(asked, {
      location: 'bentonville',
      mode: 'daycare',
      tier: 'alumni',
      balance: 1,
      required: 3,
      shortfall: 2,
      dog_ids: [waffles],
      short_dates: [
        { date: D.TUE, dog_id: waffles, reason: 'no_credit' },
        { date: D.WED, dog_id: waffles, reason: 'no_credit' },
      ],
      package_key: ALUMNI_PACK,
      consentable: 2,
    });

    for (const count of [1, 3]) {
      const again = alumniPool(
        await checkThenPost(app, { ...order, alumni_on_regular: consent(count) }),
      );
      assert.deepEqual(
        [again.shortfall, again.consentable],
        [2, 2],
        `count ${count} is refused afresh`,
      );
    }

    const booked = await checkThenPost(app, { ...order, alumni_on_regular: consent(2) });
    assert.deepEqual(planOf(booked), [
      // `CREDIT_TIERS` order within a dog (mechanic 8): regular, then alumni.
      { dog_id: waffles, location: 'bentonville', mode: 'daycare', tier: 'regular', count: 2 },
      { dog_id: waffles, location: 'bentonville', mode: 'daycare', tier: 'alumni', count: 1 },
      { dog_id: lola, location: 'bentonville', mode: 'daycare', tier: 'regular', count: 3 },
    ]);
    assert.deepEqual([await careBalance('alumni'), await careBalance('regular')], [0, 1]);

    // The desk grants alumni credits after her yes: the same entry now has nothing to ask.
    await care({ credits: 2, tier: 'alumni' });
    const stale = await checkThenPost(app, {
      parts: [part({ dogs: [waffles], dates: [D.THU, D.FRI] })],
      alumni_on_regular: consent(2),
    });
    assert.deepEqual(planOf(stale), [
      { dog_id: waffles, location: 'bentonville', mode: 'daycare', tier: 'alumni', count: 2 },
    ]);
    assert.deepEqual([await careBalance('alumni'), await careBalance('regular')], [0, 1]);
  },
);

// ── B5: day care credits spent unasked, because no cheaper alumni pack reaches ────
// Each variant first shows the same order asked while the pack is live, cheaper and reaching,
// so the variant's own edit is what turns the question off.

const REGULAR_FOR_BOTH = (waffles: string, lola: string) => [
  { dog_id: waffles, location: 'bentonville', mode: 'daycare', tier: 'regular', count: 3 },
  { dog_id: lola, location: 'bentonville', mode: 'daycare', tier: 'regular', count: 3 },
];

test(
  'B5: regular credits pay an alumni dog unasked once the alumni pack is closed (no live row); while it was live she was asked',
  SKIP_WHEN_NO_DB,
  async () => {
    const { waffles, lola } = await wafflesAndLola();
    await care({ credits: 6 });
    const { app } = orderApp();
    const order = { parts: [part({ dogs: [waffles, lola], dates: MON_TO_WED })] };
    assert.equal(alumniPool(await checkThenPost(app, order)).shortfall, 3, 'asked while live');

    await db
      .update(creditPackages)
      .set({ effectiveTo: sql`${creditPackages.effectiveFrom}` })
      .where(eq(creditPackages.key, ALUMNI_PACK));
    assert.deepEqual(planOf(await checkThenPost(app, order)), REGULAR_FOR_BOTH(waffles, lola));
  },
);

test(
  'B5: regular credits pay an alumni dog unasked on a day six weeks out when the alumni pack gives 1 month and the single day 3 (the pack does not reach it); at 3 months she was asked',
  SKIP_WHEN_NO_DB,
  async () => {
    const waffles = await createAlumniDog(created);
    await care({ credits: 1, expiresAt: '2038-02-10T18:00:00.000Z' });
    const o = orderApp();
    const order = { parts: [part({ dogs: [waffles], dates: [D.WED_30_DEC] })] };
    await setMonths(o, SINGLE_CARE, 3);
    await setMonths(o, ALUMNI_PACK, 3);
    assert.equal(
      alumniPool(await checkThenPost(o.app, order)).shortfall,
      1,
      'asked while it reaches',
    );

    await setMonths(o, ALUMNI_PACK, 1);
    assert.deepEqual(planOf(await checkThenPost(o.app, order)), [
      { dog_id: waffles, location: 'bentonville', mode: 'daycare', tier: 'regular', count: 1 },
    ]);
  },
);

test(
  'B5: regular credits pay an alumni dog unasked once the alumni pack is not cheaper than the single day ($350.00 for 10 against $35.00); at $320.00 she was asked',
  SKIP_WHEN_NO_DB,
  async () => {
    const { waffles, lola } = await wafflesAndLola();
    await care({ credits: 6 });
    const { app } = orderApp();
    const order = { parts: [part({ dogs: [waffles, lola], dates: MON_TO_WED })] };
    assert.equal(alumniPool(await checkThenPost(app, order)).shortfall, 3, 'asked at $320.00');

    await db
      .update(creditPackages)
      .set({ priceCents: 35000 })
      .where(eq(creditPackages.key, ALUMNI_PACK));
    try {
      assert.deepEqual(planOf(await checkThenPost(app, order)), REGULAR_FOR_BOTH(waffles, lola));
    } finally {
      await db
        .update(creditPackages)
        .set({ priceCents: 32000 })
        .where(eq(creditPackages.key, ALUMNI_PACK));
    }
  },
);

// ── B13: case E, and the reach of each pass ───────────────────────────────────────

test(
  "B13 (case E): Waffles' 5 alumni credits last until Tue 24: `alumni_credits_short` 1 on Wed, credits expiring first; her yes books Waffles 2 alumni + 1 day care, Lola 3, ending 3 / 2",
  SKIP_WHEN_NO_DB,
  async () => {
    const { waffles, lola } = await wafflesAndLola();
    const endsTue = at(D.TUE, '17:00').toISOString();
    await care({ credits: 5, tier: 'alumni', expiresAt: endsTue });
    await care({ credits: 6, expiresAt: ENDS_10_DEC });
    const { app } = orderApp();
    const order = { parts: [part({ dogs: [waffles, lola], dates: MON_TO_WED })] };

    const asked = alumniPool(await checkThenPost(app, order));
    assert.deepEqual(
      [asked.shortfall, asked.consentable, asked.short_dates],
      [
        1,
        1,
        [{ date: D.WED, dog_id: waffles, reason: 'credits_expire_first', expires_at: endsTue }],
      ],
    );

    assert.deepEqual(
      planOf(await checkThenPost(app, { ...order, alumni_on_regular: consent(1) })),
      [
        // `CREDIT_TIERS` order within a dog (mechanic 8): regular, then alumni.
        { dog_id: waffles, location: 'bentonville', mode: 'daycare', tier: 'regular', count: 1 },
        { dog_id: waffles, location: 'bentonville', mode: 'daycare', tier: 'alumni', count: 2 },
        { dog_id: lola, location: 'bentonville', mode: 'daycare', tier: 'regular', count: 3 },
      ],
    );
    assert.deepEqual([await careBalance('alumni'), await careBalance('regular')], [3, 2]);
  },
);

test(
  'B13: case E with the alumni pack at 3 months and the single day at 1, plus a day six weeks out: `shortfall` 2 (Wed credits expiring first, and the late day), `consentable` 1',
  SKIP_WHEN_NO_DB,
  async () => {
    const { waffles, lola } = await wafflesAndLola();
    const endsTue = at(D.TUE, '17:00').toISOString();
    await care({ credits: 5, tier: 'alumni', expiresAt: endsTue });
    await care({ credits: 6, expiresAt: ENDS_10_DEC });
    const o = orderApp();
    await setMonths(o, ALUMNI_PACK, 3);

    const asked = alumniPool(
      await checkThenPost(o.app, {
        parts: [
          part({ dogs: [waffles, lola], dates: MON_TO_WED }),
          part({ dogs: [waffles], dates: [D.WED_30_DEC] }),
        ],
      }),
    );

    assert.deepEqual(asked, {
      location: 'bentonville',
      mode: 'daycare',
      tier: 'alumni',
      balance: 5,
      required: 4,
      shortfall: 2,
      dog_ids: [waffles],
      short_dates: [
        { date: D.WED, dog_id: waffles, reason: 'credits_expire_first', expires_at: endsTue },
        {
          date: D.WED_30_DEC,
          dog_id: waffles,
          reason: 'credits_expire_first',
          expires_at: endsTue,
        },
      ],
      package_key: ALUMNI_PACK,
      consentable: 1,
    });
  },
);

// ── B22: A1, diverged expiries ────────────────────────────────────────────────────

test(
  'B22 (A1): alumni pack 3 months, single day 1: Wed 25 Nov and Mon 18 Jan give `shortfall` 2, `consentable` 1; `count: 2` is refused afresh, `count: 1` gets the same refusal with nothing written; after the pack is bought it books on alumni, the entry ignored',
  SKIP_WHEN_NO_DB,
  async () => {
    const waffles = await createAlumniDog(created);
    await care({ credits: 3, expiresAt: ENDS_10_DEC });
    const o = orderApp();
    await setMonths(o, ALUMNI_PACK, 3);
    const order = { parts: [part({ dogs: [waffles], dates: [D.WED, D.MON_18_JAN] })] };

    const first = alumniPool(await checkThenPost(o.app, order));
    assert.deepEqual([first.shortfall, first.consentable, first.package_key], [2, 1, ALUMNI_PACK]);
    assert.deepEqual(
      first.short_dates.map((s) => s.date),
      [D.WED, D.MON_18_JAN],
    );

    const two = alumniPool(await checkThenPost(o.app, { ...order, alumni_on_regular: consent(2) }));
    assert.deepEqual([two.shortfall, two.consentable], [2, 1], '`count: 2` is refused afresh');

    const before = await rowCounts();
    const one = alumniPool(await checkThenPost(o.app, { ...order, alumni_on_regular: consent(1) }));
    assert.deepEqual(
      [one.shortfall, one.consentable],
      [2, 1],
      'her yes taken, the rest still asks',
    );
    assert.deepEqual(await rowCounts(), before, 'nothing written');

    await buy(o, ALUMNI_PACK);
    const booked = await checkThenPost(o.app, { ...order, alumni_on_regular: consent(1) });
    assert.deepEqual(planOf(booked), [
      { dog_id: waffles, location: 'bentonville', mode: 'daycare', tier: 'alumni', count: 2 },
    ]);
    assert.equal(await careBalance('regular'), 3, 'no day care credit spent');
    assert.equal(await spentCents(), 32000);
  },
);

test(
  'B22 (A1): only Mon 18 Jan, which no day care credit can reach: `consentable` 0, any entry ignored, and never `credits_short`',
  SKIP_WHEN_NO_DB,
  async () => {
    const waffles = await createAlumniDog(created);
    await care({ credits: 3, expiresAt: ENDS_10_DEC });
    const o = orderApp();
    await setMonths(o, ALUMNI_PACK, 3);
    const order = { parts: [part({ dogs: [waffles], dates: [D.MON_18_JAN] })] };

    for (const body of [order, { ...order, alumni_on_regular: consent(1) }]) {
      const asked = alumniPool(await checkThenPost(o.app, body));
      assert.deepEqual([asked.shortfall, asked.consentable], [1, 0]);
    }
  },
);

// ── B22b: A1 revision 2, the three tiers ──────────────────────────────────────────

/** Six weekdays early in December, and six from Mon 4 to Mon 11 January. */
const EARLY_DECEMBER = [
  '2037-12-01',
  '2037-12-02',
  '2037-12-03',
  '2037-12-04',
  '2037-12-07',
  '2037-12-08',
];
const EARLY_JANUARY = [
  '2038-01-04',
  '2038-01-05',
  '2038-01-06',
  '2038-01-07',
  '2038-01-08',
  '2038-01-11',
];

test(
  'B22b (A1 revision 2): twelve days, 0 alumni and 6 day care credits ending 18 Dec, the pack at 3 months: asked 12 / 6, one pack bought, asked again 2 / 2, `count: 2` books with 4 day care credits left and $320.00 spent',
  SKIP_WHEN_NO_DB,
  async () => {
    const waffles = await createAlumniDog(created);
    await care({ credits: 6, expiresAt: '2037-12-18T18:00:00.000Z' });
    const o = orderApp();
    await setMonths(o, ALUMNI_PACK, 3);
    const order = {
      parts: [part({ dogs: [waffles], dates: [...EARLY_DECEMBER, ...EARLY_JANUARY] })],
    };

    const first = alumniPool(await checkThenPost(o.app, order));
    assert.deepEqual([first.shortfall, first.consentable], [12, 6]);

    await buy(o, ALUMNI_PACK);
    const second = alumniPool(await checkThenPost(o.app, order));
    assert.deepEqual([second.shortfall, second.consentable], [2, 2], 'one pack, then her yes');
    assert.deepEqual(
      second.short_dates.map((s) => s.date),
      EARLY_DECEMBER.slice(4),
      "the pack paid January first, and the last December days are her day care credits'",
    );

    const booked = await checkThenPost(o.app, { ...order, alumni_on_regular: consent(2) });
    assert.deepEqual(planOf(booked), [
      // `CREDIT_TIERS` order within a dog (mechanic 8): regular, then alumni.
      { dog_id: waffles, location: 'bentonville', mode: 'daycare', tier: 'regular', count: 2 },
      { dog_id: waffles, location: 'bentonville', mode: 'daycare', tier: 'alumni', count: 10 },
    ]);
    assert.equal(await careBalance('regular'), 4);
    assert.equal(await careBalance('alumni'), 0);
    assert.equal(await spentCents(), 32000, 'one pack, never two');
  },
);

// ── B23: A1 revision 2, the regular pass's order beyond the single's reach ────────

test(
  'B23 (A1 revision 2): Lola holds one day care credit ending 10 Feb; Waffles is askable on 5 Jan and Lola books 12 Jan: Waffles stays with the alumni question after her yes, and Lola never gets `credit_expired_before_date`',
  SKIP_WHEN_NO_DB,
  async () => {
    const { waffles, lola } = await wafflesAndLola();
    await care({ credits: 1, expiresAt: '2038-02-10T18:00:00.000Z' });
    const o = orderApp();
    await setMonths(o, ALUMNI_PACK, 3);
    const order = {
      parts: [
        part({ dogs: [waffles], dates: ['2038-01-05'] }),
        part({ dogs: [lola], dates: ['2038-01-12'] }),
      ],
    };

    for (const body of [order, { ...order, alumni_on_regular: consent(1) }]) {
      const asked = alumniPool(await checkThenPost(o.app, body));
      assert.deepEqual([asked.shortfall, asked.consentable], [1, 0]);
    }

    await buy(o, ALUMNI_PACK);
    assert.deepEqual(
      planOf(await checkThenPost(o.app, { ...order, alumni_on_regular: consent(1) })),
      [
        { dog_id: waffles, location: 'bentonville', mode: 'daycare', tier: 'alumni', count: 1 },
        { dog_id: lola, location: 'bentonville', mode: 'daycare', tier: 'regular', count: 1 },
      ],
    );
  },
);

// ── O-AFTERCOUNT (wire 9.2.0-pre.1): each pool's draw ───────────────────────────────
// designs/review-after-count.md §2 and §4 BA1-BA4, BA8; her #37 and ruling 677(2): "the credits
// should go down so i know how many ive used". Every case runs `checkThenPost`, so each also
// pins check = POST on `draws`, and the Σ invariant on every credit refusal (L4).

/** Her alumni pack as she holds it in her screenshot: 10 credits, ending Fri 18 Dec (680). */
const ENDS_18_DEC = '2037-12-18T18:00:00.000Z';
const DEC = {
  MON_7: '2037-12-07',
  MON_14: '2037-12-14',
  TUE_15: '2037-12-15',
  WED_16: '2037-12-16',
};

/** One Bentonville day care pool's entry. */
const careDraw = (
  tier: CreditTier,
  balance: number,
  draw: number,
  short: number,
  expiresAt?: string,
): PoolDrawWire => ({
  location: 'bentonville',
  mode: 'daycare',
  tier,
  balance,
  draw,
  short,
  ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}),
});

/** Her screenshot (#37): Waffles Dec 7, 14, 15, 16; Lola Dec 7, 14, 15. */
const herScreenshot = (waffles: string, lola: string, wafflesMore: string[] = []) => ({
  parts: [
    part({ dogs: [waffles, lola], dates: [DEC.MON_7, DEC.MON_14, DEC.TUE_15] }),
    part({ dogs: [waffles], dates: [DEC.WED_16, ...wafflesMore] }),
  ],
});

test(
  'BA1 (her screenshot, #37): 10 alumni ending 18 Dec and no day care; Waffles Dec 7, 14, 15, 16 and Lola Dec 7, 14, 15: `credits_short`, with `draws` day care {0, 0, 3} and alumni {10, 4, 0} (check = POST)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { waffles, lola } = await wafflesAndLola();
    await care({ credits: 10, tier: 'alumni', expiresAt: ENDS_18_DEC });
    const { app } = orderApp();

    const details = refused<CreditsShortDetails>(
      await checkThenPost(app, herScreenshot(waffles, lola)),
      'credits_short',
    );

    assert.deepEqual(
      details.pools.map((p) => [p.tier, p.balance, p.required, p.shortfall, p.dog_ids]),
      [['regular', 0, 3, 3, [lola]]],
      '`pools` is the refusal’s own list, unchanged',
    );
    assert.deepEqual(details.draws, [careDraw('regular', 0, 0, 3), careDraw('alumni', 10, 4, 0)]);
  },
);

test(
  'BA8 (her screenshot plus Waffles Tue 22 Dec, M1): `credit_expired_before_date` at Bentonville for Dec 22 carries BA1’s `draws`; Dec 22 is in no entry, so they sum to 7 of 8 dog-dates (check = POST)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { waffles, lola } = await wafflesAndLola();
    await care({ credits: 10, tier: 'alumni', expiresAt: ENDS_18_DEC });
    const { app } = orderApp();
    const order = herScreenshot(waffles, lola, ['2037-12-22']);

    const details = refused<CreditExpiredBeforeDateDetails>(
      await checkThenPost(app, order),
      'credit_expired_before_date',
    );

    assert.deepEqual([details.location, details.dates], ['bentonville', ['2037-12-22']]);
    assert.deepEqual(details.draws, [careDraw('regular', 0, 0, 3), careDraw('alumni', 10, 4, 0)]);
    const sum = (details.draws ?? []).reduce((total, e) => total + e.draw + e.short, 0);
    assert.deepEqual([sum, dogDatesOf(order)], [7, 8]);
  },
);

test(
  'BA2 (case E): 5 alumni lasting until Tue 24 and 6 day care: the refusal draws day care {6, 3, 0} and alumni {5, 2, 1, expiring Tue 24}; with her yes the check draws {6, 4, 0} and {5, 2, 0}, and once booked she holds 2 / 3',
  SKIP_WHEN_NO_DB,
  async () => {
    const { waffles, lola } = await wafflesAndLola();
    const endsTue = at(D.TUE, '17:00').toISOString();
    await care({ credits: 5, tier: 'alumni', expiresAt: endsTue });
    await care({ credits: 6, expiresAt: ENDS_10_DEC });
    const { app } = orderApp();
    const order = { parts: [part({ dogs: [waffles, lola], dates: MON_TO_WED })] };

    const asked = refused<AlumniCreditsShortDetails>(
      await checkThenPost(app, order),
      'alumni_credits_short',
    );
    assert.deepEqual(asked.draws, [
      careDraw('regular', 6, 3, 0),
      careDraw('alumni', 5, 2, 1, endsTue),
    ]);

    const yes = await checkThenPostBoth(app, { ...order, alumni_on_regular: consent(1) });
    assert.equal(yes.posted.statusCode, 201, yes.posted.body);
    assert.equal(yes.checked.statusCode, 200, yes.checked.body);
    assert.deepEqual((yes.checked.json() as PostBookingOrdersCheckResponse).draws, [
      careDraw('regular', 6, 4, 0),
      careDraw('alumni', 5, 2, 0),
    ]);
    assert.deepEqual([await careBalance('regular'), await careBalance('alumni')], [2, 3]);
  },
);

test(
  'BA3 (L1): the pack at 3 months and the single day at 1; Waffles Tue 1 Dec and Tue 5 Jan, holding 0 alumni and 6 day care: `pools[0]` says shortfall 2, consentable 1 before and after her yes, while `draws` moves alumni short 2 → 1 and day care {6, 0, 0} → {6, 1, 0}',
  SKIP_WHEN_NO_DB,
  async () => {
    const waffles = await createAlumniDog(created);
    await care({ credits: 6 });
    const o = orderApp();
    await setMonths(o, ALUMNI_PACK, 3);
    const order = { parts: [part({ dogs: [waffles], dates: [D.TUE2, '2038-01-05'] })] };

    const before = refused<AlumniCreditsShortDetails>(
      await checkThenPost(o.app, order),
      'alumni_credits_short',
    );
    assert.deepEqual(
      before.pools.map((p) => [p.shortfall, p.consentable]),
      [[2, 1]],
    );
    assert.deepEqual(before.draws, [careDraw('regular', 6, 0, 0), careDraw('alumni', 0, 0, 2)]);

    const yes = refused<AlumniCreditsShortDetails>(
      await checkThenPost(o.app, { ...order, alumni_on_regular: consent(1) }),
      'alumni_credits_short',
    );
    assert.deepEqual(
      yes.pools.map((p) => [p.shortfall, p.consentable]),
      [[2, 1]],
      '`pools[].shortfall` still counts every askable day',
    );
    assert.deepEqual(yes.draws, [careDraw('regular', 6, 1, 0), careDraw('alumni', 0, 0, 1)]);
  },
);

test(
  'BA4 (short behind the question): 0 / 0, both dogs Mon-Wed: `alumni_credits_short` names only the alumni pool, and `draws` still carries the day care pool short 3 (check = POST)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { waffles, lola } = await wafflesAndLola();
    const { app } = orderApp();

    const details = refused<AlumniCreditsShortDetails>(
      await checkThenPost(app, { parts: [part({ dogs: [waffles, lola], dates: MON_TO_WED })] }),
      'alumni_credits_short',
    );

    assert.deepEqual(
      details.pools.map((p) => [p.tier, p.shortfall, p.consentable]),
      [['alumni', 3, 3]],
    );
    assert.deepEqual(details.draws, [careDraw('regular', 0, 0, 3), careDraw('alumni', 0, 0, 3)]);
  },
);

test(
  'L4 (B5 at $350.00, a refusing road): 5 day care credits for 6 dog-dates, the pack not cheaper: `credits_short`, and the day care short 1 is Waffles’ unasked Wed (check = POST, Σ 6)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { waffles, lola } = await wafflesAndLola();
    await care({ credits: 5 });
    const { app } = orderApp();
    await db
      .update(creditPackages)
      .set({ priceCents: 35000 })
      .where(eq(creditPackages.key, ALUMNI_PACK));
    try {
      const details = refused<CreditsShortDetails>(
        await checkThenPost(app, { parts: [part({ dogs: [waffles, lola], dates: MON_TO_WED })] }),
        'credits_short',
      );
      assert.deepEqual(
        details.pools.map((p) => [p.tier, p.balance, p.required, p.shortfall, p.dog_ids]),
        [['regular', 5, 6, 1, [waffles]]],
      );
      assert.deepEqual(details.draws, [careDraw('regular', 5, 5, 1), careDraw('alumni', 0, 0, 0)]);
    } finally {
      await db
        .update(creditPackages)
        .set({ priceCents: 32000 })
        .where(eq(creditPackages.key, ALUMNI_PACK));
    }
  },
);
