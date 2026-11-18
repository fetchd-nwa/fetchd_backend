import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { count, eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { bookings, charges, cohorts, invoices, refunds } from '../../src/db/schema/schema.js';
import type { LedgerEntryWire } from '../../src/lib/ledgerWire.js';
import { registerEnrollmentsRoute } from '../../src/routes/enrollments.js';
import { registerGroupClassesRoute } from '../../src/routes/groupClasses.js';
import { registerInvoicesRoute } from '../../src/routes/invoices.js';
import { clearInvoiceReferrers, FIXTURE_IDS, FIXTURE_NOW, FIXTURE_TODAY } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';
import { makeStripeStub } from './_stripeStub.js';

/**
 * P50 #11 (DECISIONS 404, 460). Her words: "In the invoices tab, for group class, it should
 * mention which dog it is for and what group class", and her C2 check, "nope it doesnt tell
 * me the class and dog".
 *
 * Neither side drops them: the rows she saw were seed data with no cohort and no dog. So the
 * server's half is pinned here on rows `POST /enrollments` made, sent as the app sends it
 * (`allow_partial: true`, `mobile/src/repositories/bookingRepository.ts:817-830`), on each
 * money path: pay-now through its capture, pay-later, and pay-later then
 * `POST /invoices/:id/pay`. The only earlier pin (`invoices-ledger.test.ts`, Q16) is on
 * hand-seeded rows. These are green on base; what proves them is the mutants at
 * `ledgerRepository.ts:207`/`:274` (the dog) and `:210`/`:277` (the class name).
 *
 * The second half pins the cohort the seeds now name: ended AND soft-expired. It is not
 * listed, it takes no enrolment (404, nothing written, no Stripe call), and `GET /invoices`
 * still names its class, because the ledger's cohort joins carry no `live()`.
 */

registerFixtureHooks();

const DAY_MS = 24 * 60 * 60 * 1000;
// The fixture's class catalog (`_fixture.ts`): each scenario enrols in a different class, so
// a name read from anywhere but the row's own cohort cannot pass all three.
const CLASS_NAME = {
  puppy: 'Puppy Class (fixture)',
  'manners-1': 'Group Manners 1 (fixture)',
  'manners-2': 'Group Manners 2 (fixture)',
} as const;

function buildApp(): {
  app: ReturnType<typeof makeContractApp>['app'];
  stripe: ReturnType<typeof makeStripeStub>;
} {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  const stripe = makeStripeStub();
  registerEnrollmentsRoute(app, { authenticate, stripe, now: FIXTURE_NOW });
  registerInvoicesRoute(app, { authenticate, stripe, now: FIXTURE_NOW });
  registerGroupClassesRoute(app, { authenticate });
  return { app, stripe };
}

async function cleanupMoney(): Promise<void> {
  await db.delete(refunds).where(eq(refunds.ownerId, FIXTURE_IDS.ownerId));
  await clearInvoiceReferrers();
  await db.delete(invoices).where(eq(invoices.ownerId, FIXTURE_IDS.ownerId));
  await db.delete(charges).where(eq(charges.ownerId, FIXTURE_IDS.ownerId));
}

/** A live cohort six weeks past the fixture clock (the shape `enrollment-partial` uses). */
async function seedLiveCohort(classKey: keyof typeof CLASS_NAME): Promise<string> {
  const id = randomUUID();
  await db.insert(cohorts).values({
    id,
    classKey,
    location: 'fayetteville',
    startDate: '2026-07-06T23:00:00Z',
    endDate: null,
    weeklyTime: '6:00 PM',
    weeks: 4,
    capacity: 6,
    filled: 0,
  });
  return id;
}

/** POST /enrollments exactly as the app sends it: `allow_partial: true`, a boolean pay_later. */
async function enrolAsTheApp(
  app: ReturnType<typeof makeContractApp>['app'],
  args: { cohortId: string; dogId: string; payLater: boolean },
): Promise<{ statusCode: number; body: string; json: () => unknown }> {
  return app.inject({
    method: 'POST',
    url: '/enrollments',
    headers: { 'idempotency-key': `p50-enrol-${randomUUID()}` },
    payload: {
      cohort_id: args.cohortId,
      dog_ids: [args.dogId],
      payment_method_id: FIXTURE_IDS.paymentMethod1Id,
      pay_later: args.payLater,
      allow_partial: true,
    },
  });
}

interface EnrolEnvelope {
  results: { dog_id: string; enrolled: boolean; payment_state?: string; reason?: string }[];
  payment: 'now' | 'later';
}

async function ledger(app: ReturnType<typeof makeContractApp>['app']): Promise<LedgerEntryWire[]> {
  const res = await app.inject({ method: 'GET', url: '/invoices' });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as LedgerEntryWire[];
}

// ── Step 2: rows POST /enrollments made carry the dog and the class ────────────────────────

test(
  'P50 #11 (a) pay-now through its capture: the charge row reads its class and its dog',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanupMoney();
    const cohortId = await seedLiveCohort('puppy');
    const { app, stripe } = buildApp();

    const res = await enrolAsTheApp(app, { cohortId, dogId: FIXTURE_IDS.dog1Id, payLater: false });
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json() as EnrolEnvelope;
    assert.equal(body.results[0]?.enrolled, true, res.body);
    assert.equal(body.results[0]?.payment_state, 'paid', 'captured inside the request');
    assert.equal(
      stripe.calls.filter((c) => c.method === 'capturePaymentIntent').length,
      1,
      'one capture: the hold became money',
    );

    const made = await db
      .select({ id: charges.id, status: charges.status })
      .from(charges)
      .where(eq(charges.cohortId, cohortId));
    assert.deepEqual(
      made.map((c) => c.status),
      ['succeeded'],
      'the enrolment made one charge, captured',
    );

    const row = (await ledger(app)).find((r) => r.id === made[0]!.id);
    assert.ok(row !== undefined, 'the captured charge is an Invoices line');
    assert.equal(row.status, 'paid');
    assert.equal(row.category, 'group-class');
    assert.equal(row.dog_id, FIXTURE_IDS.dog1Id, 'the line names the dog');
    assert.equal(row.group_class_name, CLASS_NAME.puppy, 'the line names the class');
    await cleanupMoney();
  },
);

test(
  'P50 #11 (b) pay-later: the open invoice row reads its class and its dog',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanupMoney();
    const cohortId = await seedLiveCohort('manners-2');
    const { app, stripe } = buildApp();

    // dog1 has completed Manners 1 in the fixture, so Manners 2's prerequisite holds.
    const res = await enrolAsTheApp(app, { cohortId, dogId: FIXTURE_IDS.dog1Id, payLater: true });
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json() as EnrolEnvelope;
    assert.equal(body.results[0]?.payment_state, 'pay-later', res.body);
    assert.equal(stripe.calls.length, 0, 'pay-later makes no Stripe call');

    const made = await db
      .select({ id: invoices.id, status: invoices.status })
      .from(invoices)
      .where(eq(invoices.cohortId, cohortId));
    assert.deepEqual(
      made.map((i) => i.status),
      ['open'],
      'the enrolment made one open invoice',
    );

    const row = (await ledger(app)).find((r) => r.id === made[0]!.id);
    assert.ok(row !== undefined, 'the open invoice is an Invoices line');
    assert.equal(row.status, 'open');
    assert.equal(row.category, 'group-class');
    assert.equal(row.payment_expected, 'card');
    assert.equal(row.dog_id, FIXTURE_IDS.dog1Id, 'the line names the dog');
    assert.equal(row.group_class_name, CLASS_NAME['manners-2'], 'the line names the class');
    await cleanupMoney();
  },
);

test(
  'P50 #11 (c) pay-later then POST /invoices/:id/pay: the paid line reads its class and its dog',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanupMoney();
    const cohortId = await seedLiveCohort('manners-1');
    const { app } = buildApp();

    // dog2 here, so a dog read from anywhere but the row cannot pass (a), (b) and (c).
    const enrolled = await enrolAsTheApp(app, {
      cohortId,
      dogId: FIXTURE_IDS.dog2Id,
      payLater: true,
    });
    assert.equal(enrolled.statusCode, 201, enrolled.body);
    const [invoice] = await db
      .select({ id: invoices.id })
      .from(invoices)
      .where(eq(invoices.cohortId, cohortId));
    assert.ok(invoice !== undefined, 'the pay-later enrolment wrote an invoice');

    const paid = await app.inject({
      method: 'POST',
      url: `/invoices/${invoice.id}/pay`,
      headers: { 'idempotency-key': `p50-pay-${randomUUID()}` },
      payload: {},
    });
    assert.equal(paid.statusCode, 201, paid.body);
    const tender = paid.json() as { charge_id: string; invoice_status: string };
    assert.equal(tender.invoice_status, 'paid');

    const rows = await ledger(app);
    const row = rows.find((r) => r.id === tender.charge_id);
    assert.ok(row !== undefined, 'the paying charge is an Invoices line');
    assert.equal(row.status, 'paid');
    assert.equal(row.invoice_id, invoice.id, 'the line is the invoice, paid');
    assert.equal(row.dog_id, FIXTURE_IDS.dog2Id, 'the line names the dog');
    assert.equal(row.group_class_name, CLASS_NAME['manners-1'], 'the line names the class');
    assert.equal(
      rows.filter((r) => r.id === invoice.id).length,
      0,
      'a paid invoice is not a line of its own; it shows through its charge',
    );
    await cleanupMoney();
  },
);

// ── Step 3: the cohort the seeds name, ended AND soft-expired ──────────────────────────────

/**
 * The seeded cohort's shape (`SEED.cohortPuppyFayEndedId`), dated off the fixture clock the
 * routes run on: Puppy at Fayetteville, started 60 days back, ended 39 days back, expired at
 * its end.
 */
async function seedEndedCohort(): Promise<string> {
  const id = randomUUID();
  const end = new Date(FIXTURE_TODAY.getTime() - 39 * DAY_MS).toISOString();
  await db.insert(cohorts).values({
    id,
    classKey: 'puppy',
    location: 'fayetteville',
    startDate: new Date(FIXTURE_TODAY.getTime() - 60 * DAY_MS).toISOString(),
    endDate: end,
    weeklyTime: '10:00 am',
    weeks: 4,
    capacity: 15,
    filled: 0,
    expiredAt: end, // P50-MUTANT-SITE: the ended cohort's expiry
  });
  return id;
}

async function ownerRowCounts(): Promise<{ bookings: number; charges: number; invoices: number }> {
  const [b] = await db
    .select({ n: count() })
    .from(bookings)
    .where(eq(bookings.ownerId, FIXTURE_IDS.ownerId));
  const [c] = await db
    .select({ n: count() })
    .from(charges)
    .where(eq(charges.ownerId, FIXTURE_IDS.ownerId));
  const [i] = await db
    .select({ n: count() })
    .from(invoices)
    .where(eq(invoices.ownerId, FIXTURE_IDS.ownerId));
  return { bookings: b!.n, charges: c!.n, invoices: i!.n };
}

test(
  'P50 #11 the ended, expired cohort is not on Puppy’s list and has no page; a live one is',
  SKIP_WHEN_NO_DB,
  async () => {
    const endedId = await seedEndedCohort();
    const { app } = buildApp();

    const res = await app.inject({ method: 'GET', url: '/group-classes/puppy/cohorts' });
    assert.equal(res.statusCode, 200, res.body);
    const ids = (res.json() as { id: string }[]).map((c) => c.id);
    // The control: the list answers, and holds Puppy's live fixture cohort.
    assert.ok(ids.includes(FIXTURE_IDS.cohortPuppyId), `the live Puppy cohort is listed: ${ids}`);
    assert.equal(ids.includes(endedId), false, 'the ended, expired cohort is not listed');

    const page = await app.inject({ method: 'GET', url: `/cohorts/${endedId}` });
    assert.equal(page.statusCode, 404, page.body);
  },
);

test(
  'P50 #11 an enrolment into the ended, expired cohort is 404: no booking, charge or invoice, no Stripe call',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanupMoney();
    const endedId = await seedEndedCohort();
    for (const payLater of [false, true]) {
      const { app, stripe } = buildApp();
      const before = await ownerRowCounts();

      const res = await enrolAsTheApp(app, {
        cohortId: endedId,
        dogId: FIXTURE_IDS.dog1Id,
        payLater,
      });
      assert.equal(res.statusCode, 404, `pay_later=${payLater}: ${res.body}`);
      assert.equal(
        (res.json() as { error: { code: string } }).error.code,
        'not_found',
        `pay_later=${payLater}`,
      );

      assert.deepEqual(await ownerRowCounts(), before, `pay_later=${payLater}: nothing written`);
      const touching = await Promise.all([
        db.select({ n: count() }).from(bookings).where(eq(bookings.cohortId, endedId)),
        db.select({ n: count() }).from(charges).where(eq(charges.cohortId, endedId)),
        db.select({ n: count() }).from(invoices).where(eq(invoices.cohortId, endedId)),
      ]);
      assert.deepEqual(
        touching.map(([row]) => row!.n),
        [0, 0, 0],
        `pay_later=${payLater}: no booking, charge or invoice names the cohort`,
      );
      assert.deepEqual(stripe.calls, [], `pay_later=${payLater}: no Stripe call`);
    }
    await cleanupMoney();
  },
);

test(
  'P50 #11 GET /invoices still names the expired cohort’s class, and the dog, on the rows the seeds write',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanupMoney();
    const endedId = await seedEndedCohort();
    const rowIds = {
      refundedCharge: randomUUID(),
      paidCharge: randomUUID(),
      paidInvoice: randomUUID(),
      openInvoice: randomUUID(),
    };
    const at = (days: number): string =>
      new Date(FIXTURE_TODAY.getTime() + days * DAY_MS).toISOString();
    const named = { cohortId: endedId, dogId: FIXTURE_IDS.dog1Id };
    // The three shapes the seeds write: the refunded $200.00 charge (`seed-dev.ts`), and the
    // paid $180.00 charge with its invoice and the open in-person $180.00 invoice
    // (`seed-notifications-qa.ts`).
    await db.insert(charges).values([
      {
        id: rowIds.refundedCharge,
        ownerId: FIXTURE_IDS.ownerId,
        amountCents: 20_000,
        status: 'refunded',
        purpose: 'group-class',
        createdAt: at(-25),
        ...named,
      },
      {
        id: rowIds.paidCharge,
        ownerId: FIXTURE_IDS.ownerId,
        amountCents: 18_000,
        status: 'succeeded',
        purpose: 'group-class',
        createdAt: at(-1),
        ...named,
      },
    ]);
    await db.insert(invoices).values([
      {
        id: rowIds.paidInvoice,
        ownerId: FIXTURE_IDS.ownerId,
        amountCents: 18_000,
        status: 'paid',
        purpose: 'group-class',
        paymentMethodId: FIXTURE_IDS.paymentMethod1Id,
        paidChargeId: rowIds.paidCharge,
        issuedAt: at(-2),
        dueAt: at(-1),
        paidAt: at(-1),
        ...named,
      },
      {
        id: rowIds.openInvoice,
        ownerId: FIXTURE_IDS.ownerId,
        amountCents: 18_000,
        status: 'open',
        purpose: 'group-class',
        paymentMethodId: FIXTURE_IDS.paymentMethod1Id,
        paymentExpected: 'in-person',
        issuedAt: at(-1),
        dueAt: at(1),
        ...named,
      },
    ]);

    const { app } = buildApp();
    const rows = await ledger(app);
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const [what, id, status] of [
      ['the refunded charge', rowIds.refundedCharge, 'refunded'],
      ['the paid charge', rowIds.paidCharge, 'paid'],
      ['the open in-person invoice', rowIds.openInvoice, 'open'],
    ] as const) {
      const row = byId.get(id);
      assert.ok(row !== undefined, `${what} is an Invoices line`);
      assert.equal(row.status, status, what);
      assert.equal(row.group_class_name, CLASS_NAME.puppy, `${what} names the class`);
      assert.equal(row.dog_id, FIXTURE_IDS.dog1Id, `${what} names the dog`);
    }
    assert.equal(byId.get(rowIds.paidCharge)?.invoice_id, rowIds.paidInvoice);
    assert.equal(byId.get(rowIds.openInvoice)?.payment_expected, 'in-person');
    assert.equal(byId.has(rowIds.paidInvoice), false, 'the paid invoice shows through its charge');
    await cleanupMoney();
  },
);
