import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inArray } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { refundsRepository } from '../../src/db/repositories/refundsRepository.js';
import { charges, creditLedger, invoices, refunds } from '../../src/db/schema/schema.js';
import type { Principal } from '../../src/auth/principal.js';
import type { LedgerEntryWire, LedgerRefundWire } from '../../src/contracts/wire.js';
import { registerInvoicesRoute } from '../../src/routes/invoices.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  plantFamily,
  registerFixtureHooks,
  removeFamilies,
  type PlantedFamily,
} from './_harness.js';

/**
 * Her #39 part 2 (wire 9.3.0-pre.1; build DECISIONS 702(2), 704(2), 711, 712, 794):
 * "refunds listed on the day they were made". `GET /invoices` carries, on each charge's
 * entry, the refunds of that charge whose money has gone back (`LedgerEntryWire.refunds`).
 * `designs/invoices-calendar.md` §2.2-§2.4 and §8's backend rows B1-B10, by their names.
 *
 * Every row below is planted by SQL, and most refunds are planted at states only a writer
 * reaches (a hand return, an adopted dashboard refund): the read is the unit, not the
 * writers. Two of them no writer makes at all, and they say so where they are planted:
 * a refund on a `failed` charge (B8) and a `succeeded` refund carrying a `resolved_at` (B3).
 *
 * The world is one family's November 2026 (the fixture owner) plus a stranger's family
 * (`plantFamily`), seeded fresh for each test and removed after it.
 */

registerFixtureHooks();

const OWNER = FIXTURE_IDS.ownerId;

const C = {
  /** B1: a shop pack, $350.00, no invoice (so no card on the wire, L6). */
  pack: '3900b100-0000-4000-8000-000000000001',
  /** B2: a class charge refunded in full by two refunds, the later one written first. */
  full: '3900b100-0000-4000-8000-000000000002',
  /** B2 / N5: three refunds, two at one instant and one 500 ms later. */
  tie: '3900b100-0000-4000-8000-000000000003',
  /** B3: one refund of every status, and both `resolved-external` dates. */
  statuses: '3900b100-0000-4000-8000-000000000004',
  /** B9: the surplus road, a hand return then an adopted dashboard refund. */
  surplus: '3900b100-0000-4000-8000-000000000005',
  /** B6: a payment with no refund at all. */
  none: '3900b100-0000-4000-8000-000000000006',
  /** B6: a payment whose refunds are all promises (pending) or nothing (failed). */
  promises: '3900b100-0000-4000-8000-000000000007',
  /** B8: a FAILED charge of hers, which is no ledger line. */
  failed: '3900b100-0000-4000-8000-000000000008',
  /** B10: her charge, carrying a refund row whose `owner_id` is the stranger's. */
  cross: '3900b100-0000-4000-8000-000000000009',
  /** B5: the stranger's own charge. */
  stranger: '3900b100-0000-4000-8000-00000000000a',
} as const;

const R = {
  pack: '3900f100-0000-4000-8000-000000000001',
  // B2: the LATER refund has the SMALLER id and is written first, so neither the id nor
  // the table's order can pass for "oldest first".
  fullLate: '3900f100-0000-4000-8000-000000000002',
  fullEarly: '3900f100-0000-4000-8000-000000000003',
  // N5: tieA and tieB share an instant (the id decides); sub is 500 ms later and has the
  // smallest id. Written tieB, tieA, sub.
  sub: '3900f100-0000-4000-8000-000000000010',
  tieA: '3900f100-0000-4000-8000-000000000011',
  tieB: '3900f100-0000-4000-8000-000000000012',
  // B3
  pending: '3900f100-0000-4000-8000-000000000020',
  failedRow: '3900f100-0000-4000-8000-000000000021',
  unroutable: '3900f100-0000-4000-8000-000000000022',
  withdrawn: '3900f100-0000-4000-8000-000000000023',
  returned: '3900f100-0000-4000-8000-000000000024',
  returnedNoStamp: '3900f100-0000-4000-8000-000000000025',
  succeededStamped: '3900f100-0000-4000-8000-000000000026',
  // B9
  handReturn: '3900f100-0000-4000-8000-000000000030',
  adopted: '3900f100-0000-4000-8000-000000000031',
  // B6
  promisePending: '3900f100-0000-4000-8000-000000000040',
  promiseFailed: '3900f100-0000-4000-8000-000000000041',
  // B8
  onFailedCharge: '3900f100-0000-4000-8000-000000000050',
  // B10: owner_id = the stranger, charge = hers.
  cross: '3900f100-0000-4000-8000-000000000060',
  // B5: the stranger's refund on the stranger's charge, and one row naming HER as owner
  // on the STRANGER's charge (the row a read by `refunds.owner_id` would pick up).
  stranger: '3900f100-0000-4000-8000-000000000070',
  herNameOnStrangersCharge: '3900f100-0000-4000-8000-000000000071',
} as const;

const OPEN_INVOICE = '3900a100-0000-4000-8000-000000000001';

const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

type RefundStatus = 'pending' | 'succeeded' | 'failed' | 'unroutable' | 'resolved-external';

function refundRow(args: {
  id: string;
  chargeId: string;
  ownerId?: string;
  amountCents: number;
  status: RefundStatus;
  createdAt: string;
  resolvedAt?: string;
  outcome?: 'returned' | 'withdrawn';
  stripeRefundId?: string;
}): typeof refunds.$inferInsert {
  return {
    id: args.id,
    ownerId: args.ownerId ?? OWNER,
    chargeId: args.chargeId,
    amountCents: args.amountCents,
    status: args.status,
    reason: 'planted (#39 part 2)',
    createdAt: args.createdAt,
    updatedAt: args.createdAt,
    ...(args.resolvedAt !== undefined ? { resolvedAt: args.resolvedAt } : {}),
    ...(args.outcome !== undefined ? { resolvedOutcome: args.outcome } : {}),
    ...(args.outcome === 'returned' ? { returnedInstrument: 'cash' as const } : {}),
    ...(args.status === 'resolved-external'
      ? { resolutionNote: 'planted: returned at the desk' }
      : {}),
    ...(args.stripeRefundId !== undefined ? { stripeRefundId: args.stripeRefundId } : {}),
  };
}

async function seedWorld(): Promise<PlantedFamily> {
  const stranger = await plantFamily('The Strangers (#39)');
  const charge = (
    id: string,
    amountCents: number,
    status: 'succeeded' | 'refunded' | 'failed',
    purpose: 'package' | 'board-train' | 'group-class',
    createdAt: string,
    ownerId: string = OWNER,
  ): typeof charges.$inferInsert => ({ id, ownerId, amountCents, status, purpose, createdAt });

  await db
    .insert(charges)
    .values([
      charge(C.pack, 35_000, 'succeeded', 'package', '2026-11-14T16:12:00.000Z'),
      charge(C.full, 20_000, 'refunded', 'group-class', '2026-10-28T14:40:00.000Z'),
      charge(C.tie, 30_000, 'succeeded', 'board-train', '2026-11-02T15:00:00.000Z'),
      charge(C.statuses, 50_000, 'succeeded', 'board-train', '2026-11-01T15:00:00.000Z'),
      charge(C.surplus, 15_000, 'refunded', 'group-class', '2026-10-20T15:00:00.000Z'),
      charge(C.none, 9_000, 'succeeded', 'board-train', '2026-11-10T15:00:00.000Z'),
      charge(C.promises, 8_000, 'succeeded', 'board-train', '2026-11-11T15:00:00.000Z'),
      charge(C.failed, 4_000, 'failed', 'group-class', '2026-11-12T15:00:00.000Z'),
      charge(C.cross, 12_000, 'succeeded', 'board-train', '2026-11-13T15:00:00.000Z'),
      charge(
        C.stranger,
        6_000,
        'succeeded',
        'board-train',
        '2026-11-15T15:00:00.000Z',
        stranger.ownerId,
      ),
    ]);
  // The pack's grant, as a shop purchase writes it: the entry's `mode` comes from it.
  await db.insert(creditLedger).values({
    ownerId: OWNER,
    mode: 'daycare',
    location: 'bentonville',
    delta: 10,
    reason: 'purchase',
    chargeId: C.pack,
    expiresAt: '2036-01-01T00:00:00.000Z',
  });
  await db.insert(invoices).values({
    id: OPEN_INVOICE,
    ownerId: OWNER,
    amountCents: 15_000,
    status: 'open',
    purpose: 'board-train',
    paymentMethodId: FIXTURE_IDS.paymentMethod1Id,
    issuedAt: '2026-11-16T15:00:00.000Z',
    dueAt: '2026-11-21T15:00:00.000Z',
  });

  // One INSERT per row, in this order, so the table's own order is the order written.
  const rows = [
    // B1: Fri Nov 20, 2:05 PM Chicago.
    refundRow({
      id: R.pack,
      chargeId: C.pack,
      amountCents: 15_000,
      status: 'succeeded',
      createdAt: '2026-11-20T20:05:00.000Z',
    }),
    // B2: written late-first.
    refundRow({
      id: R.fullLate,
      chargeId: C.full,
      amountCents: 12_000,
      status: 'succeeded',
      createdAt: '2026-11-09T18:00:00.000Z',
    }),
    refundRow({
      id: R.fullEarly,
      chargeId: C.full,
      amountCents: 8_000,
      status: 'succeeded',
      createdAt: '2026-11-03T20:05:00.000Z',
    }),
    // N5: Postgres prints these `…20:05:00+00` and `…20:05:00.5+00`; a collation compare of
    // that text puts the .5 first, and the instant puts it last.
    refundRow({
      id: R.tieB,
      chargeId: C.tie,
      amountCents: 2_000,
      status: 'succeeded',
      createdAt: '2026-11-05T20:05:00.000Z',
    }),
    refundRow({
      id: R.tieA,
      chargeId: C.tie,
      amountCents: 1_000,
      status: 'succeeded',
      createdAt: '2026-11-05T20:05:00.000Z',
    }),
    refundRow({
      id: R.sub,
      chargeId: C.tie,
      amountCents: 3_000,
      status: 'succeeded',
      createdAt: '2026-11-05T20:05:00.500Z',
    }),
    // B3: promises and nothing-moved rows, then the three that count.
    refundRow({
      id: R.pending,
      chargeId: C.statuses,
      amountCents: 1_000,
      status: 'pending',
      createdAt: '2026-11-04T15:00:00.000Z',
    }),
    refundRow({
      id: R.failedRow,
      chargeId: C.statuses,
      amountCents: 2_000,
      status: 'failed',
      createdAt: '2026-11-04T15:01:00.000Z',
    }),
    refundRow({
      id: R.unroutable,
      chargeId: C.statuses,
      amountCents: 3_000,
      status: 'unroutable',
      createdAt: '2026-11-04T15:02:00.000Z',
    }),
    refundRow({
      id: R.withdrawn,
      chargeId: C.statuses,
      amountCents: 4_000,
      status: 'resolved-external',
      outcome: 'withdrawn',
      createdAt: '2026-11-04T15:03:00.000Z',
      resolvedAt: '2026-11-06T15:00:00.000Z',
    }),
    // Issued Mon Nov 2, recorded returned Sat Nov 7: listed at the record, never the issue.
    refundRow({
      id: R.returned,
      chargeId: C.statuses,
      amountCents: 5_000,
      status: 'resolved-external',
      outcome: 'returned',
      createdAt: '2026-11-02T15:00:00.000Z',
      resolvedAt: '2026-11-07T21:30:00.000Z',
    }),
    // Closed before 6.0.0: no outcome and no `resolved_at`, so its `created_at`.
    refundRow({
      id: R.returnedNoStamp,
      chargeId: C.statuses,
      amountCents: 6_000,
      status: 'resolved-external',
      createdAt: '2026-11-03T16:00:00.000Z',
    }),
    // No writer stamps `resolved_at` on a `succeeded` row. Planted so the rule is pinned as
    // the wire states it: the STATUS picks the column (a succeeded refund is its issue).
    refundRow({
      id: R.succeededStamped,
      chargeId: C.statuses,
      amountCents: 7_000,
      status: 'succeeded',
      createdAt: '2026-11-08T15:00:00.000Z',
      resolvedAt: '2026-11-01T00:00:00.000Z',
    }),
    // B9 (`refundApply.ts` settleReturnedCoverage's road): the card refund of Oct 27 failed and
    // staff closed it Returned on Nov 4; then Stripe's dashboard refund was adopted on Nov 9.
    refundRow({
      id: R.handReturn,
      chargeId: C.surplus,
      amountCents: 15_000,
      status: 'resolved-external',
      outcome: 'returned',
      createdAt: '2026-10-27T15:00:00.000Z',
      resolvedAt: '2026-11-04T17:00:00.000Z',
    }),
    refundRow({
      id: R.adopted,
      chargeId: C.surplus,
      amountCents: 15_000,
      status: 'succeeded',
      createdAt: '2026-11-09T19:00:00.000Z',
      stripeRefundId: 're_test_39p2_adopted_dashboard',
    }),
    // B6
    refundRow({
      id: R.promisePending,
      chargeId: C.promises,
      amountCents: 3_000,
      status: 'pending',
      createdAt: '2026-11-12T15:00:00.000Z',
    }),
    refundRow({
      id: R.promiseFailed,
      chargeId: C.promises,
      amountCents: 2_000,
      status: 'failed',
      createdAt: '2026-11-12T16:00:00.000Z',
    }),
    // B8: no writer refunds a failed charge; planted so a read by owner would find it.
    refundRow({
      id: R.onFailedCharge,
      chargeId: C.failed,
      amountCents: 4_000,
      status: 'succeeded',
      createdAt: '2026-11-12T17:00:00.000Z',
    }),
    // B10
    refundRow({
      id: R.cross,
      chargeId: C.cross,
      ownerId: stranger.ownerId,
      amountCents: 2_500,
      status: 'succeeded',
      createdAt: '2026-11-15T15:00:00.000Z',
    }),
    // B5
    refundRow({
      id: R.stranger,
      chargeId: C.stranger,
      ownerId: stranger.ownerId,
      amountCents: 6_000,
      status: 'succeeded',
      createdAt: '2026-11-16T15:00:00.000Z',
    }),
    refundRow({
      id: R.herNameOnStrangersCharge,
      chargeId: C.stranger,
      amountCents: 1_000,
      status: 'succeeded',
      createdAt: '2026-11-16T14:00:00.000Z',
    }),
  ];
  for (const row of rows) await db.insert(refunds).values(row);
  return stranger;
}

async function cleanupWorld(): Promise<void> {
  await db.delete(refunds).where(inArray(refunds.id, Object.values(R)));
  await db.delete(creditLedger).where(inArray(creditLedger.chargeId, [C.pack]));
  await db.delete(invoices).where(inArray(invoices.id, [OPEN_INVOICE]));
  await db.delete(charges).where(inArray(charges.id, Object.values(C)));
  await removeFamilies();
}

async function withWorld(fn: (stranger: PlantedFamily) => Promise<void>): Promise<void> {
  await cleanupWorld();
  const stranger = await seedWorld();
  try {
    await fn(stranger);
  } finally {
    await cleanupWorld();
  }
}

async function ledgerOf(principal: Principal): Promise<{ rows: LedgerEntryWire[]; body: string }> {
  const { app, authenticate } = makeContractApp(principal);
  registerInvoicesRoute(app, { authenticate });
  const res = await app.inject({ method: 'GET', url: '/invoices' });
  assert.equal(res.statusCode, 200, res.body);
  return { rows: res.json() as LedgerEntryWire[], body: res.body };
}

function entryOf(rows: LedgerEntryWire[], id: string): LedgerEntryWire {
  const found = rows.filter((row) => row.id === id);
  // One line per charge: a refund is never a second ledger line (a join on `refunds` would be).
  assert.equal(found.length, 1, `exactly one ledger line for ${id}, got ${found.length}`);
  return found[0]!;
}

function refundIds(entry: LedgerEntryWire): string[] {
  return (entry.refunds ?? []).map((refund) => refund.id);
}

const sumOf = (list: readonly LedgerRefundWire[] | undefined): number =>
  (list ?? []).reduce((total, refund) => total + refund.amount_cents, 0);

/** Her listed charges: every charge entry the fixture owner's ledger carries. */
const HER_LISTED: readonly string[] = [
  C.pack,
  C.full,
  C.tie,
  C.statuses,
  C.surplus,
  C.none,
  C.promises,
  C.cross,
];

test(
  'B1 partial: a shop pack with one $150.00 refund stays paid at $350.00, names no card or invoice, and lists the refund at its moment',
  SKIP_WHEN_NO_DB,
  async () => {
    await withWorld(async () => {
      const { rows } = await ledgerOf(FIXTURE_OWNER_PRINCIPAL);
      const entry = entryOf(rows, C.pack);
      assert.deepEqual(entry, {
        id: C.pack,
        kind: 'credit-pack',
        status: 'paid',
        amount_cents: 35_000,
        date: '2026-11-14T16:12:00.000Z',
        mode: 'daycare',
        settled_method: 'card',
        settled_at: '2026-11-14T16:12:00.000Z',
        refunds: [{ id: R.pack, amount_cents: 15_000, refunded_at: '2026-11-20T20:05:00.000Z' }],
      });
      // As the server sends a pack bought in the shop (L6): no card, no invoice.
      assert.equal('settled_card' in entry, false);
      assert.equal('invoice_id' in entry, false);
    });
  },
);

test(
  'B2 full, two refunds: a refunded entry lists both rows oldest first (refunded_at, then id), by the instant and never its text',
  SKIP_WHEN_NO_DB,
  async () => {
    await withWorld(async () => {
      const { rows } = await ledgerOf(FIXTURE_OWNER_PRINCIPAL);
      assert.deepEqual(entryOf(rows, C.full), {
        id: C.full,
        kind: 'session',
        status: 'refunded',
        amount_cents: 20_000,
        date: '2026-10-28T14:40:00.000Z',
        category: 'group-class',
        refunds: [
          { id: R.fullEarly, amount_cents: 8_000, refunded_at: '2026-11-03T20:05:00.000Z' },
          { id: R.fullLate, amount_cents: 12_000, refunded_at: '2026-11-09T18:00:00.000Z' },
        ],
      });
      // One instant: the smaller id first. 500 ms later: last, although its id is the
      // smallest and its Postgres text collates first (N5).
      assert.deepEqual(entryOf(rows, C.tie).refunds, [
        { id: R.tieA, amount_cents: 1_000, refunded_at: '2026-11-05T20:05:00.000Z' },
        { id: R.tieB, amount_cents: 2_000, refunded_at: '2026-11-05T20:05:00.000Z' },
        { id: R.sub, amount_cents: 3_000, refunded_at: '2026-11-05T20:05:00.500Z' },
      ]);
      assert.equal(entryOf(rows, C.tie).status, 'paid', 'a partial refund leaves the entry paid');
    });
  },
);

test(
  'B3 statuses: pending, failed, unroutable and withdrawn are not listed; a hand return is listed at resolved_at, or created_at when it has none',
  SKIP_WHEN_NO_DB,
  async () => {
    await withWorld(async () => {
      const { rows } = await ledgerOf(FIXTURE_OWNER_PRINCIPAL);
      const entry = entryOf(rows, C.statuses);
      assert.deepEqual(entry.refunds, [
        { id: R.returnedNoStamp, amount_cents: 6_000, refunded_at: '2026-11-03T16:00:00.000Z' },
        { id: R.returned, amount_cents: 5_000, refunded_at: '2026-11-07T21:30:00.000Z' },
        { id: R.succeededStamped, amount_cents: 7_000, refunded_at: '2026-11-08T15:00:00.000Z' },
      ]);
      for (const absent of [R.pending, R.failedRow, R.unroutable, R.withdrawn]) {
        assert.equal(refundIds(entry).includes(absent), false, `${absent} is not money back`);
      }
      // Facts only: no reason, issuer, instrument or status on a refund line.
      for (const refund of entry.refunds ?? []) {
        assert.deepEqual(Object.keys(refund).sort(), ['amount_cents', 'id', 'refunded_at']);
      }
    });
  },
);

test(
  'B4 raw form: every refunded_at in the response body is toISOString() form, never the Postgres text (STATE trap 12.2)',
  SKIP_WHEN_NO_DB,
  async () => {
    await withWorld(async () => {
      const { body } = await ledgerOf(FIXTURE_OWNER_PRINCIPAL);
      // The raw bytes, not the parsed shape: what the phone's `new Date(...)` is handed.
      const stamps = [...body.matchAll(/"refunded_at":"([^"]*)"/g)].map((match) => match[1]!);
      // 1 (pack) + 2 (full) + 3 (tie) + 3 (statuses) + 2 (surplus) + 1 (cross).
      assert.equal(stamps.length, 12, body);
      for (const stamp of stamps) assert.match(stamp, ISO_MS);
      // A sub-second moment and a `resolved_at` moment both come through in that form.
      assert.ok(stamps.includes('2026-11-05T20:05:00.500Z'), body);
      assert.ok(stamps.includes('2026-11-07T21:30:00.000Z'), body);
    });
  },
);

test(
  "B5 scope: another family's refunds never reach her ledger, hers never reach theirs, and staff get []",
  SKIP_WHEN_NO_DB,
  async () => {
    await withWorld(async (stranger) => {
      const her = await ledgerOf(FIXTURE_OWNER_PRINCIPAL);
      for (const foreign of [C.stranger, R.stranger, R.herNameOnStrangersCharge]) {
        assert.equal(her.body.includes(foreign), false, `${foreign} is not on her ledger`);
      }

      // Their ledger: their charge with BOTH rows on it, the one naming her as owner too (the
      // money is their charge's), and nothing of hers, R.cross (their name, her charge) included.
      const theirs = await ledgerOf(stranger.principal);
      assert.deepEqual(
        theirs.rows.map((row) => row.id),
        [C.stranger],
      );
      assert.deepEqual(refundIds(entryOf(theirs.rows, C.stranger)), [
        R.herNameOnStrangersCharge,
        R.stranger,
      ]);
      assert.equal(theirs.body.includes(R.cross), false, 'a row on her charge stays on hers');

      // The read itself, handed her listed charges: only their rows can come back.
      const read = await refundsRepository.findReturnedRowsForCharges(db, HER_LISTED);
      for (const row of read) assert.ok(HER_LISTED.includes(row.chargeId), row.id);
      assert.deepEqual(
        read.map((row) => row.id).sort(),
        [
          R.pack,
          R.fullLate,
          R.fullEarly,
          R.sub,
          R.tieA,
          R.tieB,
          R.returned,
          R.returnedNoStamp,
          R.succeededStamped,
          R.handReturn,
          R.adopted,
          R.cross,
        ].sort(),
      );
      assert.deepEqual(await refundsRepository.findReturnedRowsForCharges(db, []), []);

      // Unchanged: an owner-app endpoint answers staff with nothing.
      const staff = await ledgerOf(FIXTURE_STAFF_PRINCIPAL);
      assert.deepEqual(staff.rows, []);
    });
  },
);

test(
  'B6 omit: no refunds, only promises or failures, or an open invoice → the field is absent, never []',
  SKIP_WHEN_NO_DB,
  async () => {
    await withWorld(async () => {
      const { rows } = await ledgerOf(FIXTURE_OWNER_PRINCIPAL);
      assert.deepEqual(entryOf(rows, C.none), {
        id: C.none,
        kind: 'session',
        status: 'paid',
        amount_cents: 9_000,
        date: '2026-11-10T15:00:00.000Z',
        category: 'board-and-train',
        settled_method: 'card',
        settled_at: '2026-11-10T15:00:00.000Z',
      });
      for (const id of [C.none, C.promises, OPEN_INVOICE]) {
        assert.equal('refunds' in entryOf(rows, id), false, `${id} carries no refunds key`);
      }
      assert.equal(entryOf(rows, OPEN_INVOICE).status, 'open');
    });
  },
);

test(
  'B7 parity: on every entry of hers, Σ refunds[].amount_cents = refundsRepository.sumReturnedCoverageForCharge',
  SKIP_WHEN_NO_DB,
  async () => {
    await withWorld(async () => {
      const { rows } = await ledgerOf(FIXTURE_OWNER_PRINCIPAL);
      const charged = rows.filter((row) => row.status !== 'open');
      assert.deepEqual(charged.map((row) => row.id).sort(), [...HER_LISTED].sort());
      for (const entry of charged) {
        assert.equal(
          sumOf(entry.refunds),
          await refundsRepository.sumReturnedCoverageForCharge(db, entry.id),
          `parity on ${entry.id}`,
        );
      }
      // Not vacuous: the parity holds where something counts, and where something is left out.
      assert.equal(sumOf(entryOf(rows, C.statuses).refunds), 18_000);
      assert.equal(sumOf(entryOf(rows, C.promises).refunds), 0);
    });
  },
);

test(
  'B8 hidden charge: a refund on a failed charge of hers is listed nowhere',
  SKIP_WHEN_NO_DB,
  async () => {
    await withWorld(async () => {
      const { rows, body } = await ledgerOf(FIXTURE_OWNER_PRINCIPAL);
      assert.equal(
        rows.some((row) => row.id === C.failed),
        false,
        'a failed charge is no ledger line',
      );
      assert.equal(body.includes(R.onFailedCharge), false, 'nor is its refund');
      const read = await refundsRepository.findReturnedRowsForCharges(db, HER_LISTED);
      assert.equal(
        read.some((row) => row.id === R.onFailedCharge),
        false,
        'the read is by listed charge, so it cannot reach it',
      );
      // It is money back by the server's own sum; it simply belongs to no listed charge.
      assert.equal(await refundsRepository.sumReturnedCoverageForCharge(db, C.failed), 4_000);
    });
  },
);

test(
  'B9 surplus: a hand return and an adopted dashboard refund on one $150.00 charge are both listed as stored, Σ $300.00 = the coverage',
  SKIP_WHEN_NO_DB,
  async () => {
    await withWorld(async () => {
      const { rows } = await ledgerOf(FIXTURE_OWNER_PRINCIPAL);
      const entry = entryOf(rows, C.surplus);
      assert.deepEqual(entry, {
        id: C.surplus,
        kind: 'session',
        status: 'refunded',
        amount_cents: 15_000,
        date: '2026-10-20T15:00:00.000Z',
        category: 'group-class',
        refunds: [
          { id: R.handReturn, amount_cents: 15_000, refunded_at: '2026-11-04T17:00:00.000Z' },
          { id: R.adopted, amount_cents: 15_000, refunded_at: '2026-11-09T19:00:00.000Z' },
        ],
      });
      assert.equal(sumOf(entry.refunds), 30_000);
      assert.equal(await refundsRepository.sumReturnedCoverageForCharge(db, C.surplus), 30_000);
    });
  },
);

test(
  "B10 keyed by charge: a refund whose owner_id is another family's is listed on her charge it refunds, in parity with the sum",
  SKIP_WHEN_NO_DB,
  async () => {
    await withWorld(async () => {
      const { rows } = await ledgerOf(FIXTURE_OWNER_PRINCIPAL);
      const entry = entryOf(rows, C.cross);
      assert.deepEqual(entry.refunds, [
        { id: R.cross, amount_cents: 2_500, refunded_at: '2026-11-15T15:00:00.000Z' },
      ]);
      assert.equal(
        sumOf(entry.refunds),
        await refundsRepository.sumReturnedCoverageForCharge(db, C.cross),
      );
    });
  },
);
