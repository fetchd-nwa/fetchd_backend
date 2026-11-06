import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, afterEach, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { eq, inArray, sql } from 'drizzle-orm';
import ts from 'typescript';
import { db } from '../../src/db/client.js';
import { paymentMethodsRepository } from '../../src/db/repositories/paymentMethodsRepository.js';
import {
  bookings,
  charges,
  creditLedger,
  dogs,
  invoices,
  orders,
} from '../../src/db/schema/schema.js';
import { CHARGE_BLOCKERS } from '../../src/contracts/wire.js';
import type {
  ApiErrorEnvelope,
  InsufficientCreditsDetails,
  PostBookingsResponse,
} from '../../src/contracts/wire.js';
import type { Equal, Expect } from '../../src/contracts/typeAsserts.js';
import { registerBookingsRoute } from '../../src/routes/bookings.js';
import { createBookableDog, removeDogs } from './_dayFixture.js';
import { FIXTURE_IDS, FIXTURE_NOW, futureWeekday, topUpCredits } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';
import { clearOrderRows } from './_orderFixture.js';
import { makeStripeStub } from './_stripeStub.js';

/**
 * Credits are the only tender (R1; wire 4.0.0, P16). `POST /bookings` has no
 * pay-as-you-go and no card arm, `top_up` is typed and refused until P18, and a
 * booking opens no invoice. `design.md:3816`: "`payg` is never written by v1".
 */

const createdDogs: string[] = [];
after(async () => {
  await clearOrderRows();
  await removeDogs(createdDogs);
});
registerFixtureHooks();
afterEach(clearOrderRows);

function buildApp() {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  const stripe = makeStripeStub();
  registerBookingsRoute(app, { authenticate, stripe, now: FIXTURE_NOW });
  return { app, stripe };
}

type App = ReturnType<typeof buildApp>['app'];

function bodyFor(dogIds: readonly string[], dates: readonly string[]) {
  const [lead, ...additional] = dogIds;
  return {
    category: 'day-school',
    lead_dog_id: lead,
    ...(additional.length > 0 ? { additional_dog_ids: additional } : {}),
    dates,
    location: 'fayetteville',
  };
}

function post(app: App, payload: object, key = `credits-only-${randomUUID()}`) {
  return app.inject({
    method: 'POST',
    url: '/bookings',
    headers: { 'idempotency-key': key },
    payload,
  });
}

function insufficient(res: { body: string; statusCode: number }): InsufficientCreditsDetails {
  assert.equal(res.statusCode, 422, res.body);
  const { error } = JSON.parse(res.body) as ApiErrorEnvelope;
  assert.equal(error.code, 'insufficient_credits', res.body);
  return error.details as InsufficientCreditsDetails;
}

async function fundedDog(credits: number): Promise<string> {
  const dogId = await createBookableDog(createdDogs);
  if (credits > 0) await topUpCredits(dogId, 'school', credits, 'fayetteville');
  return dogId;
}

async function balanceOf(dogId: string): Promise<number> {
  const rows = await db
    .select({ delta: creditLedger.delta })
    .from(creditLedger)
    .where(eq(creditLedger.dogId, dogId));
  return rows.reduce((sum, row) => sum + row.delta, 0);
}

async function assertNothingWritten(dogId: string, credits: number): Promise<void> {
  assert.equal(await balanceOf(dogId), credits, 'no debit');
  const rows = await db.select().from(bookings).where(eq(bookings.leadDogId, dogId));
  assert.equal(rows.length, 0, 'no booking');
  const orderRows = await db.select().from(orders).where(eq(orders.ownerId, FIXTURE_IDS.ownerId));
  assert.equal(orderRows.length, 0, 'no order');
}

const TOP_UP = {
  count: 1,
  payment_method_id: FIXTURE_IDS.paymentMethod1Id,
  expected_total_cents: 6_000,
};

// ── The shape of `payment` ──────────────────────────────────────────────────

const REFUSED_SHAPES: readonly (readonly [string, object])[] = [
  ['payment missing', {}],
  ["the string 'credits'", { payment: 'credits' }],
  ["the string 'payg'", { payment: 'payg' }],
  ["kind: 'payg'", { payment: { kind: 'payg' } }],
  ["kind: 'card'", { payment: { kind: 'card' } }],
  [
    'a top-level payment_method_id',
    { payment: { kind: 'credits' }, payment_method_id: randomUUID() },
  ],
  ['an unknown key in payment', { payment: { kind: 'credits', note: 'x' } }],
  ['an unknown key in top_up', { payment: { kind: 'credits', top_up: { ...TOP_UP, note: 'x' } } }],
  ['count 0', { payment: { kind: 'credits', top_up: { ...TOP_UP, count: 0 } } }],
  ['count 1.5', { payment: { kind: 'credits', top_up: { ...TOP_UP, count: 1.5 } } }],
  ['total 0', { payment: { kind: 'credits', top_up: { ...TOP_UP, expected_total_cents: 0 } } }],
  [
    'a total in fractions of a cent',
    { payment: { kind: 'credits', top_up: { ...TOP_UP, expected_total_cents: 6_000.5 } } },
  ],
  [
    'a card that is no uuid',
    { payment: { kind: 'credits', top_up: { ...TOP_UP, payment_method_id: 'pm_1' } } },
  ],
  ['no card', { payment: { kind: 'credits', top_up: { count: 1, expected_total_cents: 6_000 } } }],
  [
    'a package key the catalog could not hold',
    { payment: { kind: 'credits', top_up: { ...TOP_UP, package_key: 'Day Care!' } } },
  ],
  ['an unknown tier', { payment: { kind: 'credits', tier: 'gold' } }],
];

for (const [name, payment] of REFUSED_SHAPES) {
  test(`POST /bookings: ${name} is 400 bad_request, nothing written`, SKIP_WHEN_NO_DB, async () => {
    const dogId = await fundedDog(2);
    const { app, stripe } = buildApp();

    const res = await post(app, { ...bodyFor([dogId], [futureWeekday(1)]), ...payment });

    assert.equal(res.statusCode, 400, res.body);
    assert.equal((res.json() as ApiErrorEnvelope).error.code, 'bad_request');
    await assertNothingWritten(dogId, 2);
    assert.equal(stripe.calls.length, 0);
  });
}

test(
  "POST /bookings: `tier` is accepted and read by nothing, so {kind: 'credits', tier} books as credits",
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await fundedDog(3);
    const { app } = buildApp();

    for (const [offset, tier] of [
      [1, 'regular'],
      [2, 'alumni'],
    ] as const) {
      const res = await post(app, {
        ...bodyFor([dogId], [futureWeekday(offset)]),
        payment: { kind: 'credits', tier },
      });
      assert.equal(res.statusCode, 201, res.body);
    }
    assert.equal(await balanceOf(dogId), 1);
  },
);

test(
  'POST /bookings: `payment` is part of the body the key hashes, so one spelling is one booking',
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await fundedDog(2);
    const { app } = buildApp();
    const key = `credits-only-${randomUUID()}`;
    const body = bodyFor([dogId], [futureWeekday(1)]);

    const first = await post(app, { ...body, payment: { kind: 'credits' } }, key);
    assert.equal(first.statusCode, 201, first.body);
    const replay = await post(app, { ...body, payment: { kind: 'credits' } }, key);
    assert.deepEqual(replay.json(), first.json(), 'the same body replays');
    const other = await post(app, { ...body, payment: { kind: 'credits', tier: 'regular' } }, key);
    assert.equal(other.statusCode, 422, other.body);
    assert.equal((other.json() as ApiErrorEnvelope).error.code, 'idempotency_mismatch');
    assert.equal(await balanceOf(dogId), 1);
  },
);

// ── The refusal ─────────────────────────────────────────────────────────────

test(
  'Biscuit holds 1, Waffles holds 2, three dates: shortfall 3, short_dates d2, d3, d3',
  SKIP_WHEN_NO_DB,
  async () => {
    const biscuit = await fundedDog(1);
    const waffles = await fundedDog(2);
    const { app, stripe } = buildApp();
    const dates = [futureWeekday(1), futureWeekday(2), futureWeekday(3)];
    const [, d2, d3] = dates;

    const details = insufficient(
      await post(app, { ...bodyFor([biscuit, waffles], dates), payment: { kind: 'credits' } }),
    );

    assert.equal(details.shortfall, 3);
    assert.deepEqual(details.short_dates, [
      { date: d2, reason: 'no_credit' },
      { date: d3, reason: 'no_credit' },
      { date: d3, reason: 'no_credit' },
    ]);
    assert.equal(details.short_dates.length, details.shortfall, 'one entry per missing credit');
    assert.equal(details.top_up_offer, null);
    assert.equal('alternative_package_key' in details, false, 'omitted until P18');
    assert.deepEqual(details.gaps, [
      { dog_id: biscuit, mode: 'school', balance: 1, required: 3 },
      { dog_id: waffles, mode: 'school', balance: 2, required: 3 },
    ]);
    assert.equal(stripe.calls.length, 0);
  },
);

test(
  'a dog owing credits is one per date nothing pays: short_dates never outruns the dates',
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await fundedDog(0);
    await db.insert(creditLedger).values({
      dogId,
      mode: 'school',
      location: 'fayetteville',
      delta: -2,
      reason: 'adjustment',
    });
    const { app } = buildApp();
    const dates = [futureWeekday(1), futureWeekday(2)];

    const details = insufficient(
      await post(app, { ...bodyFor([dogId], dates), payment: { kind: 'credits' } }),
    );

    assert.equal(details.gaps[0]?.balance, -2, 'gaps keeps what the ledger reads');
    assert.equal(details.shortfall, 2, 'a date nothing pays is one credit, however deep the debt');
    assert.equal(details.short_dates.length, 2);
  },
);

// ── `top_up`, typed and refused (ruling 2) ──────────────────────────────────

test(
  'a body with top_up and credits enough: 422, shortfall 0, no order, no debit, no card lookup, and a foreign card is not a 404',
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await fundedDog(3);
    const { app, stripe } = buildApp();
    const dates = [futureWeekday(1), futureWeekday(2)];
    const lookup = mock.method(paymentMethodsRepository, 'findLiveByIdForOwner');

    let res;
    try {
      res = await post(app, {
        ...bodyFor([dogId], dates),
        payment: { kind: 'credits', top_up: { ...TOP_UP, payment_method_id: randomUUID() } },
      });
    } finally {
      lookup.mock.restore();
    }

    assert.deepEqual(insufficient(res), {
      kind: 'insufficient_credits',
      gaps: [],
      shortfall: 0,
      short_dates: [],
      top_up_offer: null,
    });
    assert.equal(lookup.mock.callCount(), 0, 'the card is not read');
    await assertNothingWritten(dogId, 3);
    assert.equal(stripe.calls.length, 0);

    // What the client does with shortfall 0, under a fresh key.
    const resend = await post(app, { ...bodyFor([dogId], dates), payment: { kind: 'credits' } });
    assert.equal(resend.statusCode, 201, resend.body);
  },
);

test(
  'a body with top_up and short: 422 with the current shortfall and top_up_offer null, no order',
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await fundedDog(1);
    const { app, stripe } = buildApp();
    const [d1, d2, d3] = [futureWeekday(1), futureWeekday(2), futureWeekday(3)];

    const details = insufficient(
      await post(app, {
        ...bodyFor([dogId], [d1, d2, d3]),
        payment: { kind: 'credits', top_up: { ...TOP_UP, count: 2 } },
      }),
    );

    assert.equal(details.shortfall, 2);
    assert.deepEqual(
      details.short_dates.map((s) => s.date),
      [d2, d3],
    );
    assert.equal(details.top_up_offer, null);
    await assertNothingWritten(dogId, 1);
    assert.equal(stripe.calls.length, 0);
  },
);

test(
  'top_up refuses past the gates: a gated dog answers the gate, not the credit check',
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await fundedDog(3);
    await db.update(dogs).set({ evaluationStatus: 'not-evaluated' }).where(eq(dogs.id, dogId));
    const { app } = buildApp();

    const res = await post(app, {
      ...bodyFor([dogId], [futureWeekday(1)]),
      payment: { kind: 'credits', top_up: TOP_UP },
    });

    assert.equal(res.statusCode, 422, res.body);
    assert.equal((res.json() as ApiErrorEnvelope).error.code, 'evaluation_required');
  },
);

// ── A booking opens no invoice ──────────────────────────────────────────────

test(
  'a credits-only Confirm is one transaction, charge_status none, and writes no invoice and no charge',
  SKIP_WHEN_NO_DB,
  async () => {
    const biscuit = await fundedDog(2);
    const waffles = await fundedDog(2);
    const { app, stripe } = buildApp();
    const key = `credits-only-${randomUUID()}`;
    const invoicesBefore = await db.select({ id: invoices.id }).from(invoices);

    const res = await post(
      app,
      {
        ...bodyFor([biscuit, waffles], [futureWeekday(1), futureWeekday(2)]),
        payment: { kind: 'credits' },
      },
      key,
    );

    assert.equal(res.statusCode, 201, res.body);
    const { order, sessions } = res.json() as PostBookingsResponse;
    assert.equal(order.charge_status, 'none');
    assert.equal(stripe.calls.length, 0, 'never reaches the engine');
    const invoicesAfter = await db.select({ id: invoices.id }).from(invoices);
    assert.equal(invoicesAfter.length, invoicesBefore.length, 'no invoices row');
    assert.equal(
      (await db.select().from(charges).where(eq(charges.orderId, order.id))).length,
      0,
      'no charges row',
    );

    // Every row a Postgres transaction writes carries that transaction's id.
    const bookingIds = sessions.map((s) => s.id);
    const written = await db.execute<{ writer: string }>(sql`
      SELECT xmin::text AS writer FROM orders WHERE id = ${order.id}
      UNION ALL SELECT xmin::text FROM bookings WHERE order_id = ${order.id}
      UNION ALL SELECT xmin::text FROM credit_ledger
        WHERE booking_id IN (${sql.join(
          bookingIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
      UNION ALL SELECT xmin::text FROM idempotency_keys WHERE key = ${key}
    `);
    assert.equal(written.rows.length, 1 + 2 + 4 + 1, 'order, sessions, debits, claim');
    assert.equal(new Set(written.rows.map((r) => r.writer)).size, 1, 'one transaction wrote them');
    const debits = await db
      .select({ id: creditLedger.id })
      .from(creditLedger)
      .where(inArray(creditLedger.bookingId, bookingIds));
    assert.equal(debits.length, 4, 'two dogs, two dates');
  },
);

// ── `payg` is never written by v1 (design.md:3816) ──────────────────────────

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

interface Literal {
  file: string;
  /** The four syntax kinds above the literal, nearest first. */
  under: string;
  /** The `name:` of a `name: value` the literal is the value of. */
  property: string | undefined;
}

/** Every string literal equal to `value` in the parsed source of `src/`. Comments are not code. */
function literalsOf(value: string): Literal[] {
  const found: Literal[] = [];
  for (const file of sourceFiles(SRC_ROOT)) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest);
    const visit = (node: ts.Node, chain: readonly ts.Node[]): void => {
      if (ts.isStringLiteralLike(node) && node.text === value) {
        const parent = chain[chain.length - 1];
        found.push({
          file: path.relative(SRC_ROOT, file),
          under: [...chain]
            .reverse()
            .slice(0, 4)
            .map((n) => ts.SyntaxKind[n.kind])
            .join(' < '),
          property:
            parent !== undefined && ts.isPropertyAssignment(parent)
              ? parent.name.getText(source)
              : undefined,
        });
      }
      ts.forEachChild(node, (child) => visit(child, [...chain, node]));
    };
    visit(source, []);
  }
  return found;
}

/**
 * The only places the word may be spelled once its writer is gone: the types, and
 * the readers that keep old rows legible until P17 deletes the lane. A writer has to
 * spell it, so a writer that returns turns up here as a line nobody listed.
 */
const PAYG_READERS: readonly string[] = [
  'contracts/wire.ts',
  'db/repositories/chargesRepository.ts',
  'db/repositories/invoicesRepository.ts',
  'db/repositories/ledgerRepository.ts',
  'db/schema/schema.ts',
  'lib/invoiceReceiptCopy.ts',
];

test('nothing in src/ writes purpose payg: a writer that returns goes red here', () => {
  // The instrument first: it can see a writer, or its silence proves nothing.
  const writers = literalsOf('group-class').filter((l) => l.property === 'purpose');
  assert.ok(
    writers.some((l) => l.file === 'lib/enrollmentPartial.ts'),
    `the walk found no live purpose writer, so it cannot see a dead one: ${JSON.stringify(writers)}`,
  );

  const spelled = literalsOf('payg');
  assert.deepEqual(
    spelled.filter((l) => l.property === 'purpose' || l.property === 'payment'),
    [],
    'nothing sets a purpose, or any payment, to payg',
  );
  assert.deepEqual(
    [...new Set(spelled.map((l) => l.file))].filter((file) => !PAYG_READERS.includes(file)),
    [],
    'and no file outside the readers spells the word',
  );
  for (const literal of spelled.filter((l) => l.file.startsWith('db/repositories/'))) {
    assert.match(
      literal.under,
      /LiteralType|CaseClause|ReturnStatement|CallExpression/,
      `${literal.file}: a type, a case, a mapped return or an eq() reader, not ${literal.under}`,
    );
  }
});

// ── What no type holds (notes mutant mG) ────────────────────────────────────

type ShortDateReason = InsufficientCreditsDetails['short_dates'][number]['reason'];

/** Both members by value. Inline unions have no tuple or §16 pin, so this is their pin. */
const SHORT_DATE_REASONS = {
  no_credit: true,
  credits_expire_first: true,
} as const satisfies Record<ShortDateReason, true>;

export type ShortDateReasonsPin = Expect<Equal<ShortDateReason, keyof typeof SHORT_DATE_REASONS>>;

test('both short_dates reasons, and both new blockers, are the words the wire says', () => {
  assert.deepEqual(Object.keys(SHORT_DATE_REASONS).sort(), ['credits_expire_first', 'no_credit']);
  assert.deepEqual([...CHARGE_BLOCKERS].sort(), [
    'authentication_required',
    'declined',
    'expired_card',
    'insufficient_funds',
    'processing',
  ]);
});
