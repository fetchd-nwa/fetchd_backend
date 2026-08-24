import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import {
  bookings as bookingsTable,
  charges as chargesTable,
  cohorts as cohortsTable,
  invoices as invoicesTable,
  refunds as refundsTable,
} from '../../src/db/schema/schema.js';
import { bookingsRepository } from '../../src/db/repositories/bookingsRepository.js';
import { chargesRepository } from '../../src/db/repositories/chargesRepository.js';
import { enrollmentsRepository } from '../../src/db/repositories/enrollmentsRepository.js';
import { withActor } from '../../src/db/tx.js';
import type { EnrollmentWithdrawResultWire } from '../../src/contracts/wire.js';
import {
  chargeBelongsToEnrollment,
  enrollmentIdentityOf,
} from '../../src/lib/enrollmentIdentity.js';
import { registerEnrollmentsRoute } from '../../src/routes/enrollments.js';
import {
  runCaptureReconcilerOnce,
  CAPTURE_GRACE_MINUTES,
} from '../../src/workers/captureReconciler.js';
import { FIXTURE_IDS, FIXTURE_NOW } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';
import { makeStripeStub } from './_stripeStub.js';

/**
 * ADDENDUM 3 §A3.17 — **a (cohort, dog) is not an enrollment.**
 *
 * §A3.16 unified "is this enrollment paid" into ONE read
 * (`chargesRepository.findUnsettledSucceededCharge`), and that read keyed on
 * (cohort, dog) — so a withdraw + re-enroll, which mints a SECOND enrollment
 * under the same key, made every consumer answer for the WRONG one. Measured
 * end-to-end by the R4-3 probes: an enrolled dog resting on a live hold had
 * that hold CANCELLED because a previous enrollment's charge — a NULL-PI
 * `refund_manual` row, or a refund the bank terminally failed — still carried
 * a positive remainder and therefore still said "money in hand".
 *
 * §A3.17's ruling is identity, not time: every group-class charge stamps
 * `charges.booking_id` with its enrollment's **anchor** (the earliest-scheduled
 * booking row minted in the same tx/savepoint), a charge belongs to the current
 * enrollment iff its anchor is in the current live booking set — or, for rows
 * minted before this landed, iff `created_at >= ` the enrollment's birth — and
 * no consumer ever falls through from one enrollment to another.
 *
 * Every test below was RUN against the pre-§A3.17 working tree first. The ones
 * marked **RED FIRST** failed there, on the assertion named in the comment; the
 * ones marked **PIN** passed there and must keep passing. A test that passes
 * before the fix measures nothing.
 */

registerFixtureHooks();

const SIX_WEEKS_OUT_UTC = '2026-07-06T23:00:00Z';
const PRICE = 12_000;
const ACTOR = `owner:${FIXTURE_IDS.ownerId}`;

// ──────────────────────────────────────────────────────────────────────────
// Fixture machinery (adapted from the R4-3 probes, which were session-scoped)
// ──────────────────────────────────────────────────────────────────────────

async function makeCohort(): Promise<{ id: string }> {
  const id = randomUUID();
  await db.insert(cohortsTable).values({
    id,
    classKey: 'puppy',
    location: 'fayetteville',
    startDate: SIX_WEEKS_OUT_UTC,
    endDate: null,
    weeklyTime: '6:00 PM',
    weeks: 4,
    capacity: 6,
    filled: 0,
  });
  return { id };
}

type Stub = ReturnType<typeof makeStripeStub>;
type App = ReturnType<typeof makeContractApp>['app'];

function enrollApp(capture?: { stream: { write(msg: string): void } }): {
  app: App;
  stripe: Stub;
} {
  const stripe = makeStripeStub();
  const { app, authenticate } = makeContractApp(
    FIXTURE_OWNER_PRINCIPAL,
    capture as Parameters<typeof makeContractApp>[1],
  );
  registerEnrollmentsRoute(app, { authenticate, stripe, now: FIXTURE_NOW });
  return { app, stripe };
}

interface Injected {
  statusCode: number;
  json: () => unknown;
  body: string;
}

async function enroll(opts: { app: App; cohortId: string; payLater?: boolean }): Promise<Injected> {
  return opts.app.inject({
    method: 'POST',
    url: '/enrollments',
    headers: { 'idempotency-key': `enr-${randomUUID()}` },
    payload: {
      cohort_id: opts.cohortId,
      dog_ids: [FIXTURE_IDS.dog1Id],
      payment_method_id: FIXTURE_IDS.paymentMethod1Id,
      pay_later: opts.payLater ?? false,
      allow_partial: true,
    },
  });
}

async function withdraw(opts: { app: App; cohortId: string }): Promise<Injected> {
  return opts.app.inject({
    method: 'POST',
    url: `/enrollments/${opts.cohortId}/withdraw`,
    headers: { 'idempotency-key': `wdr-${randomUUID()}` },
    payload: { dog_id: FIXTURE_IDS.dog1Id },
  });
}

interface ChargeSnapshot {
  id: string;
  status: string;
  amountCents: number;
  pi: string | null;
  bookingId: string | null;
  createdAt: string;
}

async function chargeRows(cohortId: string): Promise<ChargeSnapshot[]> {
  return db
    .select({
      id: chargesTable.id,
      status: chargesTable.status,
      amountCents: chargesTable.amountCents,
      pi: chargesTable.stripePaymentIntentId,
      bookingId: chargesTable.bookingId,
      createdAt: chargesTable.createdAt,
    })
    .from(chargesTable)
    .where(eq(chargesTable.cohortId, cohortId));
}

/** The `requires_payment` charge with a PaymentIntent — the live hold this
 *  request left behind. Asserted non-undefined at every call site. */
async function liveHold(cohortId: string): Promise<ChargeSnapshot> {
  const rows = await chargeRows(cohortId);
  const hold = rows.find((r) => r.status === 'requires_payment' && r.pi !== null);
  assert.ok(hold, 'expected a capture-pending charge row carrying a PaymentIntent');
  return hold;
}

async function refundRowsFor(cohortId: string): Promise<
  { id: string; chargeId: string; amountCents: number; status: string }[]
> {
  const out: { id: string; chargeId: string; amountCents: number; status: string }[] = [];
  for (const c of await chargeRows(cohortId)) {
    const rows = await db
      .select({
        id: refundsTable.id,
        chargeId: refundsTable.chargeId,
        amountCents: refundsTable.amountCents,
        status: refundsTable.status,
      })
      .from(refundsTable)
      .where(eq(refundsTable.chargeId, c.id));
    out.push(...rows);
  }
  return out;
}

async function liveBookings(cohortId: string): Promise<{ id: string; createdAtUs: string }[]> {
  return db
    .select({
      id: bookingsTable.id,
      createdAtUs: sql<string>`((EXTRACT(EPOCH FROM ${bookingsTable.createdAt})::numeric * 1000000)::bigint)::text`,
    })
    .from(bookingsTable)
    .where(
      and(
        eq(bookingsTable.cohortId, cohortId),
        eq(bookingsTable.leadDogId, FIXTURE_IDS.dog1Id),
        eq(bookingsTable.status, 'upcoming'),
      ),
    )
    .orderBy(asc(bookingsTable.scheduledAt));
}

/** Every fixture this file writes is deleted by cohort id — the fixture hooks
 *  are per-file and a leftover charge row would be claimed by the NEXT test's
 *  reconciler tick. */
async function cleanup(cohortId: string): Promise<void> {
  for (const row of await chargeRows(cohortId)) {
    await db.delete(refundsTable).where(eq(refundsTable.chargeId, row.id));
  }
  await db.delete(chargesTable).where(eq(chargesTable.cohortId, cohortId));
  await db.delete(invoicesTable).where(eq(invoicesTable.cohortId, cohortId));
}

/** A pre-Stripe-wire seed charge: succeeded, NULL PaymentIntent, NULL anchor,
 *  never refundable by machine — the §A3.2 row-3 / §A3.15 `refund_manual`
 *  state, which is remainder-positive forever because nothing ever mints
 *  against it. Aged so it is unambiguously a PREVIOUS enrollment's money. */
async function seedNullPiCharge(cohortId: string, ageDays: number): Promise<string> {
  const id = randomUUID();
  await db.insert(chargesTable).values({
    id,
    ownerId: FIXTURE_IDS.ownerId,
    stripePaymentIntentId: null,
    amountCents: PRICE,
    status: 'succeeded',
    purpose: 'group-class',
    cohortId,
    dogId: FIXTURE_IDS.dog1Id,
    createdAt: new Date(Date.now() - ageDays * 24 * 3600 * 1000).toISOString(),
  });
  return id;
}

/** A succeeded charge with an explicit anchor + birth instant, for the
 *  membership matrix. `refundCents` writes one refund row against it. */
async function seedSucceededCharge(args: {
  cohortId: string;
  bookingId: string | null;
  createdAt: Date;
  refundCents?: number;
  refundStatus?: 'pending' | 'failed' | 'succeeded';
}): Promise<string> {
  const id = randomUUID();
  await db.insert(chargesTable).values({
    id,
    ownerId: FIXTURE_IDS.ownerId,
    stripePaymentIntentId: `pi_seed_${randomUUID().slice(0, 18)}`,
    amountCents: PRICE,
    status: 'succeeded',
    purpose: 'group-class',
    cohortId: args.cohortId,
    dogId: FIXTURE_IDS.dog1Id,
    bookingId: args.bookingId,
    createdAt: args.createdAt.toISOString(),
  });
  if (args.refundCents !== undefined && args.refundCents > 0) {
    await db.insert(refundsTable).values({
      id: randomUUID(),
      ownerId: FIXTURE_IDS.ownerId,
      chargeId: id,
      amountCents: args.refundCents,
      reason: 'cancel',
      status: args.refundStatus ?? 'pending',
    });
  }
  return id;
}

/** Insert `weeks` live group-class booking rows by hand — an enrollment
 *  without a payment, so the membership matrix can pin the READ without
 *  routing money through it. Returns them oldest-session first. */
async function seedEnrollmentBookings(
  cohortId: string,
  opts: { createdAt?: Date } = {},
): Promise<{ id: string; createdAtUs: string }[]> {
  const created = (opts.createdAt ?? new Date()).toISOString();
  const ids: string[] = [];
  for (let week = 0; week < 4; week += 1) {
    const id = randomUUID();
    await db.insert(bookingsTable).values({
      id,
      ownerId: FIXTURE_IDS.ownerId,
      leadDogId: FIXTURE_IDS.dog1Id,
      category: 'group-class',
      status: 'upcoming',
      scheduledAt: new Date(
        new Date(SIX_WEEKS_OUT_UTC).getTime() + week * 7 * 24 * 3600 * 1000,
      ).toISOString(),
      durationMinutes: 60,
      location: 'fayetteville',
      notes: null,
      cohortId,
      createdAt: created,
    });
    ids.push(id);
  }
  return db
    .select({
      id: bookingsTable.id,
      createdAtUs: sql<string>`((EXTRACT(EPOCH FROM ${bookingsTable.createdAt})::numeric * 1000000)::bigint)::text`,
    })
    .from(bookingsTable)
    .where(and(eq(bookingsTable.cohortId, cohortId), eq(bookingsTable.status, 'upcoming')))
    .orderBy(asc(bookingsTable.scheduledAt))
    .then((rows) => rows.filter((r) => ids.includes(r.id)));
}

/** THE read under test, asked with an explicit enrollment identity. */
async function readForEnrollment(
  cohortId: string,
  live: { id: string; createdAtUs: string }[],
): Promise<{ id: string; remainingCents: number } | undefined> {
  return withActor(ACTOR, (tx) =>
    chargesRepository.findUnsettledSucceededCharge(tx, {
      cohortId,
      dogId: FIXTURE_IDS.dog1Id,
      enrollment: enrollmentIdentityOf(live),
    }),
  );
}

/**
 * Stripe verbs aimed since `mark` (`stripe.calls.length` taken before the act
 * under test). **Deltas, never totals** — the stub records ATTEMPTS, and an
 * enroll driven by `throwOnCapture(2)` has already recorded two failed
 * captures against its own hold before a reconciler tick ever runs. Asserting
 * on the total makes "the tick captured nothing" unwritable.
 */
const capturedIntentsSince = (stripe: Stub, mark: number): string[] =>
  stripe.calls
    .slice(mark)
    .filter((c) => c.method === 'capturePaymentIntent')
    .map((c) => (c as { args: { paymentIntentId: string } }).args.paymentIntentId);
const cancelledIntentsSince = (stripe: Stub, mark: number): string[] =>
  stripe.calls
    .slice(mark)
    .filter((c) => c.method === 'cancelPaymentIntent')
    .map((c) => (c as { args: { paymentIntentId: string } }).args.paymentIntentId);
const cancelledIntents = (stripe: Stub): string[] => cancelledIntentsSince(stripe, 0);
const refundCalls = (stripe: Stub): number =>
  stripe.calls.filter((c) => c.method === 'createRefund').length;

/** A tick well past the grace window, driven off the wall clock because
 *  `charges.created_at` is DB `now()`. */
function tickNow(): Date {
  return new Date(Date.now() + (CAPTURE_GRACE_MINUTES + 5) * 60 * 1000);
}

interface AlarmLog {
  errors: { chargeId: unknown; msg: string }[];
  infos: { chargeId: unknown; msg: string }[];
  log: {
    info: (obj: unknown, msg?: string) => void;
    warn: (obj: unknown, msg?: string) => void;
    error: (obj: unknown, msg?: string) => void;
  };
}

function alarmLog(): AlarmLog {
  const errors: { chargeId: unknown; msg: string }[] = [];
  const infos: { chargeId: unknown; msg: string }[] = [];
  const at = (obj: unknown): unknown => (obj as { chargeId?: unknown }).chargeId;
  return {
    errors,
    infos,
    log: {
      info: (obj, msg) => infos.push({ chargeId: at(obj), msg: msg ?? '' }),
      warn: () => undefined,
      error: (obj, msg) => errors.push({ chargeId: at(obj), msg: msg ?? '' }),
    },
  };
}

// ══════════════════════════════════════════════════════════════════════════
// 1 — the respecified read: the membership matrix (§A3.17.4 item 5, R43-D
//     recast). Asked directly, with an explicit enrollment identity.
// ══════════════════════════════════════════════════════════════════════════

test(
  '§A3.17-M1 a STAMPED charge from a previous enrollment is never returned, whatever remainder it holds — RED FIRST',
  SKIP_WHEN_NO_DB,
  async () => {
    // RED against the pre-§A3.17 tree: the read keyed on (cohort, dog) alone,
    // so the foreign row came back and every consumer read "money in hand".
    const cohort = await makeCohort();
    try {
      const live = await seedEnrollmentBookings(cohort.id);
      // A booking row that is NOT in the live set — the previous enrollment's
      // anchor, cancelled by its withdraw.
      const deadAnchor = randomUUID();
      await db.insert(bookingsTable).values({
        id: deadAnchor,
        ownerId: FIXTURE_IDS.ownerId,
        leadDogId: FIXTURE_IDS.dog1Id,
        category: 'group-class',
        status: 'cancelled',
        scheduledAt: SIX_WEEKS_OUT_UTC,
        durationMinutes: 60,
        location: 'fayetteville',
        notes: null,
        cohortId: cohort.id,
      });
      const foreign = await seedSucceededCharge({
        cohortId: cohort.id,
        bookingId: deadAnchor,
        // NEWER than this enrollment's birth, so nothing but the anchor can
        // exclude it — the time rule must not be doing the work here.
        createdAt: new Date(Date.now() + 1000),
      });

      const picked = await readForEnrollment(cohort.id, live);
      assert.equal(
        picked,
        undefined,
        `the previous enrollment's charge (${foreign}) is not this enrollment's money`,
      );
    } finally {
      await cleanup(cohort.id);
    }
  },
);

test(
  "§A3.17-M2 a NULL-anchor legacy charge minted BEFORE this enrollment's birth is never returned — RED FIRST",
  SKIP_WHEN_NO_DB,
  async () => {
    // RED against the pre-§A3.17 tree: returned, remainder and all.
    const cohort = await makeCohort();
    try {
      const live = await seedEnrollmentBookings(cohort.id);
      await seedNullPiCharge(cohort.id, 30);
      assert.equal(
        await readForEnrollment(cohort.id, live),
        undefined,
        'a charge that predates the bookings cannot be their money',
      );
    } finally {
      await cleanup(cohort.id);
    }
  },
);

test(
  "§A3.17-M3 the legacy boundary is INCLUSIVE: a NULL-anchor charge minted AT the enrollment's birth instant IS its money — PIN",
  SKIP_WHEN_NO_DB,
  async () => {
    // Postgres `now()` is transaction-start-stable, so a legacy enroll tx's
    // bookings and its charge carry EQUAL `created_at`. `>=`, not `>`, is what
    // keeps that enrollment's own money attributed to it. Passes before the
    // fix too (the old read had no rule at all) — it is here because the rule
    // is the thing a future edit would break.
    const cohort = await makeCohort();
    try {
      const born = new Date(Date.now() - 60 * 60 * 1000);
      const live = await seedEnrollmentBookings(cohort.id, { createdAt: born });
      const bornAtUs = enrollmentIdentityOf(live)?.bornAtUs;
      assert.ok(bornAtUs, 'a live booking set has a birth instant');
      // The seeded bookings carry millisecond-precision `created_at`, so the
      // birth is an exact multiple of 1000µs and this round-trips losslessly —
      // the charge lands EXACTLY on the boundary, which is the whole pin.
      const sameTx = await seedSucceededCharge({
        cohortId: cohort.id,
        bookingId: null,
        createdAt: new Date(bornAtUs / 1000),
      });
      const picked = await readForEnrollment(cohort.id, live);
      assert.equal(picked?.id, sameTx, 'equal timestamps are inside the enrollment, not outside it');
      assert.equal(picked?.remainingCents, PRICE);
    } finally {
      await cleanup(cohort.id);
    }
  },
);

test(
  '§A3.17-M4 within ONE enrollment a covered newest row still falls through to an older own row that still owes — PIN',
  SKIP_WHEN_NO_DB,
  async () => {
    // §A3.16's within-enrollment fall-through survives §A3.17 untouched: two
    // own rows are the same enrollment's money either way. Only the
    // CROSS-enrollment fall-through is abolished.
    const cohort = await makeCohort();
    try {
      const live = await seedEnrollmentBookings(cohort.id);
      const anchor = live[0]!.id;
      const older = await seedSucceededCharge({
        cohortId: cohort.id,
        bookingId: anchor,
        createdAt: new Date(Date.now() - 2 * 60 * 1000),
        refundCents: PRICE - 500,
      });
      await seedSucceededCharge({
        cohortId: cohort.id,
        bookingId: anchor,
        createdAt: new Date(Date.now() - 60 * 1000),
        refundCents: PRICE,
      });
      const picked = await readForEnrollment(cohort.id, live);
      assert.equal(picked?.id, older, 'the covered newest row yields to the own row that still owes');
      assert.equal(picked?.remainingCents, 500);
    } finally {
      await cleanup(cohort.id);
    }
  },
);

test(
  '§A3.17-M5 a FAILED refund is not coverage — R9 keeps one meaning for "non-failed" — PIN',
  SKIP_WHEN_NO_DB,
  async () => {
    const cohort = await makeCohort();
    try {
      const live = await seedEnrollmentBookings(cohort.id);
      const own = await seedSucceededCharge({
        cohortId: cohort.id,
        bookingId: live[0]!.id,
        createdAt: new Date(),
        refundCents: PRICE,
        refundStatus: 'failed',
      });
      const picked = await readForEnrollment(cohort.id, live);
      assert.equal(picked?.id, own, 'a refund the bank refused returned nothing');
      assert.equal(picked?.remainingCents, PRICE);
    } finally {
      await cleanup(cohort.id);
    }
  },
);

test(
  '§A3.17-M6 every OWN row covered ⇒ undefined, however fat the foreign remainder beside it — RED FIRST',
  SKIP_WHEN_NO_DB,
  async () => {
    // RED against the pre-§A3.17 tree: the foreign row was returned and the
    // enrollment read as PAID. This is R43-A/B's defect at the read itself.
    const cohort = await makeCohort();
    try {
      const live = await seedEnrollmentBookings(cohort.id);
      await seedSucceededCharge({
        cohortId: cohort.id,
        bookingId: live[0]!.id,
        createdAt: new Date(),
        refundCents: PRICE,
      });
      await seedNullPiCharge(cohort.id, 30);
      assert.equal(
        await readForEnrollment(cohort.id, live),
        undefined,
        'this enrollment has been made whole; the older money belongs to another one',
      );
    } finally {
      await cleanup(cohort.id);
    }
  },
);

// ══════════════════════════════════════════════════════════════════════════
// 2 — the capture gate (§A3.17.3 walk item 1)
// ══════════════════════════════════════════════════════════════════════════

test(
  '§A3.17-A (R43-A promoted) enrolled dog + live hold + an old NULL-PI charge that still owes ⇒ the tick CAPTURES — RED FIRST',
  SKIP_WHEN_NO_DB,
  async () => {
    // RED against the pre-§A3.17 tree: `'withdrawn-released'`. The old
    // `refund_manual` row is remainder-positive forever by design, so the
    // predicate answered "collected", the release arm cancelled the CURRENT
    // enrollment's authorization, and the class was delivered for free with no
    // alarm — the alarm lives behind the same predicate that just lied.
    const cohort = await makeCohort();
    const { app, stripe } = enrollApp();
    const alarms = alarmLog();
    try {
      await seedNullPiCharge(cohort.id, 30);
      stripe.throwOnCapture(2);
      const res = await enroll({ app, cohortId: cohort.id });
      assert.equal(res.statusCode, 201, res.body);
      const hold = await liveHold(cohort.id);
      assert.ok((await liveBookings(cohort.id)).length > 0, 'the dog IS enrolled');

      const mark = stripe.calls.length;
      const tick = await runCaptureReconcilerOnce({
        stripe,
        now: tickNow(),
        log: alarms.log,
      });
      assert.equal(
        tick.results.find((r) => r.chargeId === hold.id)?.outcome,
        'captured',
        'the dog is enrolled, the class is delivered, and this enrollment is genuinely unpaid',
      );
      assert.deepEqual(capturedIntentsSince(stripe, mark), [hold.pi]);
      assert.deepEqual(cancelledIntentsSince(stripe, mark), [], 'nothing was released');
      assert.equal(
        (await stripe.retrievePaymentIntent(hold.pi!)).status,
        'succeeded',
        'the money really moved at Stripe',
      );
      assert.equal(
        alarms.errors.filter((e) => e.chargeId === hold.id).length,
        0,
        'an ordinary collection raises no alarm',
      );
    } finally {
      await cleanup(cohort.id);
    }
  },
);

test(
  '§A3.17-B (R43-B promoted) the same shape reached by an ORDINARY failed refund ⇒ captures, and mints nothing against the old charge — RED FIRST',
  SKIP_WHEN_NO_DB,
  async () => {
    // Pure-ordinary producer — enroll → withdraw → the bank fails the refund →
    // re-enroll → capture fails. No seed money, no anomaly. RED against the
    // pre-§A3.17 tree: `'withdrawn-released'`.
    const cohort = await makeCohort();
    const { app, stripe } = enrollApp();
    try {
      const first = await enroll({ app, cohortId: cohort.id });
      assert.equal(first.statusCode, 201, first.body);
      const oldId = (await chargeRows(cohort.id))[0]!.id;
      const w = await withdraw({ app, cohortId: cohort.id });
      assert.equal((w.json() as EnrollmentWithdrawResultWire).money_outcome, 'refunded');

      // The bank REJECTS it. `charge.refund.updated` flips the row to 'failed',
      // which drops it out of `sumNonFailedForCharge` — the remainder reopens
      // and the old charge says "money in hand" again, forever.
      await db
        .update(refundsTable)
        .set({ status: 'failed' })
        .where(eq(refundsTable.chargeId, oldId));

      stripe.throwOnCapture(2);
      const second = await enroll({ app, cohortId: cohort.id });
      assert.equal(second.statusCode, 201, second.body);
      const hold = await liveHold(cohort.id);
      const refundsBefore = (await refundRowsFor(cohort.id)).length;

      const mark = stripe.calls.length;
      const tick = await runCaptureReconcilerOnce({ stripe, now: tickNow() });
      assert.equal(tick.results.find((r) => r.chargeId === hold.id)?.outcome, 'captured');
      assert.deepEqual(capturedIntentsSince(stripe, mark), [hold.pi]);
      assert.equal(
        (await refundRowsFor(cohort.id)).length,
        refundsBefore,
        'the failed old refund belongs to the stripe-failed HUMAN queue; nothing here re-mints it',
      );
    } finally {
      await cleanup(cohort.id);
    }
  },
);

test(
  '§A3.17-E (R43-E) a WITHDRAWN dog is never captured for, even beside a fully-covered old charge — PIN',
  SKIP_WHEN_NO_DB,
  async () => {
    // The inverse, and the one thing §A3.17 must not break: row-scoped
    // liveness answers NO here too, so the release arm is unchanged.
    const cohort = await makeCohort();
    const { app, stripe } = enrollApp();
    try {
      stripe.throwOnCapture(2);
      const res = await enroll({ app, cohortId: cohort.id });
      assert.equal(res.statusCode, 201, res.body);
      const hold = await liveHold(cohort.id);

      const oldId = await seedNullPiCharge(cohort.id, 30);
      await db.insert(refundsTable).values({
        id: randomUUID(),
        ownerId: FIXTURE_IDS.ownerId,
        chargeId: oldId,
        amountCents: PRICE,
        reason: 'cancel',
        status: 'pending',
      });
      await db
        .update(bookingsTable)
        .set({ status: 'cancelled' })
        .where(eq(bookingsTable.cohortId, cohort.id));

      const mark = stripe.calls.length;
      const tick = await runCaptureReconcilerOnce({ stripe, now: tickNow() });
      assert.equal(
        tick.results.find((r) => r.chargeId === hold.id)?.outcome,
        'withdrawn-released',
      );
      assert.deepEqual(
        capturedIntentsSince(stripe, mark),
        [],
        'a withdrawn dog is never captured for',
      );
      assert.equal((await stripe.retrievePaymentIntent(hold.pi!)).status, 'canceled');
    } finally {
      await cleanup(cohort.id);
    }
  },
);

test(
  '§A3.17-L the release log line states the branch’s ACTUAL basis, not "the dog is not enrolled" — RED FIRST',
  SKIP_WHEN_NO_DB,
  async () => {
    // §A3.17.3 item 8. The old sentence asserted something the branch does not
    // know — it fires for a withdrawn enrollment's stray hold and for a
    // current enrollment whose money is already collected or invoiced, and on
    // R43-A/B it was flatly false about an enrolled dog.
    const cohort = await makeCohort();
    const { app, stripe } = enrollApp();
    const alarms = alarmLog();
    try {
      stripe.throwOnCapture(2);
      const res = await enroll({ app, cohortId: cohort.id });
      assert.equal(res.statusCode, 201, res.body);
      const hold = await liveHold(cohort.id);
      await db
        .update(bookingsTable)
        .set({ status: 'cancelled' })
        .where(eq(bookingsTable.cohortId, cohort.id));

      await runCaptureReconcilerOnce({ stripe, now: tickNow(), log: alarms.log });
      const line = alarms.infos.find((i) => i.chargeId === hold.id);
      assert.ok(line, 'the release writes exactly one line naming the charge');
      assert.equal(
        line.msg,
        'capture-reconciler released an authorization nothing owes — the dog is not enrolled, the hold belongs to a withdrawn enrollment, or the current enrollment’s money is already collected or invoiced; the hold was cancelled instead of captured and the owner is charged nothing',
      );
    } finally {
      await cleanup(cohort.id);
    }
  },
);

test(
  '§A3.17-S the stray hold is RELEASED while the current enrollment’s own hold is CAPTURED — no double collect — RED FIRST',
  SKIP_WHEN_NO_DB,
  async () => {
    // The corner the probes never reached (§A3.17.3 item 1): a withdrawn
    // enrollment's `release_pending` row resolves `requires_capture` while the
    // owner has re-enrolled and genuinely owes. RED against the pre-§A3.17
    // tree: BOTH rows read owed=true and the tick captured BOTH — a second
    // charge for a class nobody is attending.
    const cohort = await makeCohort();
    const { app, stripe } = enrollApp();
    try {
      stripe.throwOnCapture(2);
      const first = await enroll({ app, cohortId: cohort.id });
      assert.equal(first.statusCode, 201, first.body);
      const stray = await liveHold(cohort.id);

      // Mid-flight at withdraw time ⇒ `release_pending` ⇒ the row is left
      // `'requires_payment'` DELIBERATELY, for the reconciler to finish.
      stripe.setIntentState(stray.pi!, 'processing');
      const w = await withdraw({ app, cohortId: cohort.id });
      assert.equal(
        (w.json() as EnrollmentWithdrawResultWire).money_outcome,
        'release_pending',
        w.body,
      );
      // …and then it settles into a live, capturable hold.
      stripe.setIntentState(stray.pi!, 'requires_capture');

      stripe.throwOnCapture(2);
      const second = await enroll({ app, cohortId: cohort.id });
      assert.equal(second.statusCode, 201, second.body);
      const current = (await chargeRows(cohort.id)).find(
        (r) => r.status === 'requires_payment' && r.pi !== null && r.id !== stray.id,
      );
      assert.ok(current?.pi, 'the re-enrollment rests on its own live hold');

      const mark = stripe.calls.length;
      const tick = await runCaptureReconcilerOnce({ stripe, now: tickNow() });
      assert.equal(
        tick.results.find((r) => r.chargeId === stray.id)?.outcome,
        'withdrawn-released',
        'the withdrawn enrollment’s hold is released whatever the CURRENT enrollment owes',
      );
      assert.equal(tick.results.find((r) => r.chargeId === current.id)?.outcome, 'captured');
      assert.deepEqual(
        capturedIntentsSince(stripe, mark),
        [current.pi],
        'exactly one capture, and it is the current enrollment’s',
      );
      assert.deepEqual(cancelledIntentsSince(stripe, mark), [stray.pi]);
    } finally {
      await cleanup(cohort.id);
    }
  },
);

// ══════════════════════════════════════════════════════════════════════════
// 3 — the LOST-HOLD (canceled) arm and the abandon split (walk items 2, 3)
// ══════════════════════════════════════════════════════════════════════════

test(
  '§A3.17-C1 a CANCELED row of a DEAD enrollment is quiet ‘released’ even while the current enrollment owes — RED FIRST',
  SKIP_WHEN_NO_DB,
  async () => {
    // RED against the pre-§A3.17 tree: `'lost-hold'` + a LOST HOLD page for a
    // hold that belongs to an enrollment nobody is delivering — the transient
    // false page when the old row wins worklist order before the current hold
    // captures.
    const cohort = await makeCohort();
    const { app, stripe } = enrollApp();
    const alarms = alarmLog();
    try {
      stripe.throwOnCapture(2);
      const first = await enroll({ app, cohortId: cohort.id });
      assert.equal(first.statusCode, 201, first.body);
      const stray = await liveHold(cohort.id);
      stripe.setIntentState(stray.pi!, 'processing');
      const w = await withdraw({ app, cohortId: cohort.id });
      assert.equal((w.json() as EnrollmentWithdrawResultWire).money_outcome, 'release_pending');

      stripe.throwOnCapture(2);
      const second = await enroll({ app, cohortId: cohort.id });
      assert.equal(second.statusCode, 201, second.body);
      // The stray's hold is GONE (expired on the card network, or released by
      // a crashed sibling) while the current enrollment is genuinely unpaid.
      stripe.setIntentState(stray.pi!, 'canceled');

      const tick = await runCaptureReconcilerOnce({ stripe, now: tickNow(), log: alarms.log });
      assert.equal(tick.results.find((r) => r.chargeId === stray.id)?.outcome, 'released');
      assert.equal(
        alarms.errors.filter((e) => e.chargeId === stray.id && e.msg.includes('LOST HOLD')).length,
        0,
        'nobody is owed for a class nobody is attending',
      );
    } finally {
      await cleanup(cohort.id);
    }
  },
);

test(
  '§A3.17-C2 a CANCELED row of the LIVE enrollment pages LOST HOLD even though an old remainder exists — RED FIRST',
  SKIP_WHEN_NO_DB,
  async () => {
    // The newly-honest class: the current enrollment is unpaid and its hold is
    // dead, while a previous enrollment's remainder sits beside it. RED
    // against the pre-§A3.17 tree: `'released'`, silent — the alarm that means
    // "go and collect money" suppressed by money that is not this
    // enrollment's.
    const cohort = await makeCohort();
    const { app, stripe } = enrollApp();
    const alarms = alarmLog();
    try {
      await seedNullPiCharge(cohort.id, 30);
      stripe.throwOnCapture(2);
      const res = await enroll({ app, cohortId: cohort.id });
      assert.equal(res.statusCode, 201, res.body);
      const hold = await liveHold(cohort.id);
      stripe.setIntentState(hold.pi!, 'canceled');

      const tick = await runCaptureReconcilerOnce({ stripe, now: tickNow(), log: alarms.log });
      assert.equal(tick.results.find((r) => r.chargeId === hold.id)?.outcome, 'lost-hold');
      assert.equal(
        alarms.errors.filter((e) => e.chargeId === hold.id && e.msg.includes('LOST HOLD')).length,
        1,
        'a human is paged exactly once for money genuinely not in hand',
      );
    } finally {
      await cleanup(cohort.id);
    }
  },
);

test(
  '§A3.17-C3 the abandon split is row-scoped: a superseded stray is bookkeeping, the current owed row is uncollected — RED FIRST',
  SKIP_WHEN_NO_DB,
  async () => {
    // RED against the pre-§A3.17 tree: the stray counted as UNCOLLECTED (the
    // current enrollment's debts answered for it), so the ERROR page named
    // money nobody can collect — the exact way the uncollected/bookkeeping
    // split stops being read.
    const cohort = await makeCohort();
    const { app, stripe } = enrollApp();
    try {
      stripe.throwOnCapture(2);
      const first = await enroll({ app, cohortId: cohort.id });
      assert.equal(first.statusCode, 201, first.body);
      const stray = await liveHold(cohort.id);
      stripe.setIntentState(stray.pi!, 'processing');
      const w = await withdraw({ app, cohortId: cohort.id });
      assert.equal((w.json() as EnrollmentWithdrawResultWire).money_outcome, 'release_pending');

      stripe.throwOnCapture(2);
      const second = await enroll({ app, cohortId: cohort.id });
      assert.equal(second.statusCode, 201, second.body);
      const current = (await chargeRows(cohort.id)).find(
        (r) => r.status === 'requires_payment' && r.pi !== null && r.id !== stray.id,
      );
      assert.ok(current?.id);

      // Deltas, not absolutes: the abandon report is a table-wide capped page
      // and earlier tests in this file leave rows of their own behind.
      const base = await runCaptureReconcilerOnce({ stripe, now: new Date() });
      const aged = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      await db.update(chargesTable).set({ createdAt: aged }).where(eq(chargesTable.id, stray.id));
      const withStray = await runCaptureReconcilerOnce({ stripe, now: new Date() });
      assert.equal(
        withStray.abandoned,
        base.abandoned + 1,
        'the stray HAS aged out of the worklist',
      );
      assert.equal(
        withStray.abandonedUncollected,
        base.abandonedUncollected,
        '…and it is bookkeeping: its own enrollment is gone, so there is nothing to collect for it',
      );

      await db.update(chargesTable).set({ createdAt: aged }).where(eq(chargesTable.id, current.id));
      const withBoth = await runCaptureReconcilerOnce({ stripe, now: new Date() });
      assert.equal(withBoth.abandoned, base.abandoned + 2);
      assert.equal(
        withBoth.abandonedUncollected,
        base.abandonedUncollected + 1,
        'the CURRENT enrollment’s aged hold is money a human really can go and collect',
      );
    } finally {
      await cleanup(cohort.id);
    }
  },
);

// ══════════════════════════════════════════════════════════════════════════
// 4 — the withdraw settle (walk items 4 and 5)
// ══════════════════════════════════════════════════════════════════════════

test(
  '§A3.17-W (R43-C promoted) withdraw #2 after a re-enroll speaks for the CURRENT enrollment: ‘released’, one cancel, zero mints, zero manual-refund pages — RED FIRST',
  SKIP_WHEN_NO_DB,
  async () => {
    // RED against the pre-§A3.17 tree: `'refund_manual'` + `owed_cents` off a
    // 30-day-old NULL-PI row whose refund is already being arranged by hand —
    // a SECOND page for the same money — while the live hold this withdraw was
    // actually about went unmentioned and uncancelled.
    const cohort = await makeCohort();
    const capture = { lines: [] as Record<string, unknown>[], stream: { write: () => undefined } };
    capture.stream.write = ((msg: string) => {
      capture.lines.push(JSON.parse(msg) as Record<string, unknown>);
    }) as never;
    const { app, stripe } = enrollApp(capture);
    try {
      await seedNullPiCharge(cohort.id, 30);

      const first = await enroll({ app, cohortId: cohort.id });
      assert.equal(first.statusCode, 201, first.body);
      const w1 = await withdraw({ app, cohortId: cohort.id });
      assert.equal(
        (w1.json() as EnrollmentWithdrawResultWire).money_outcome,
        'refunded',
        'control: withdraw #1 returns the money this enrollment actually paid',
      );

      stripe.throwOnCapture(2);
      const second = await enroll({ app, cohortId: cohort.id });
      assert.equal(second.statusCode, 201, second.body);
      const hold = await liveHold(cohort.id);

      const cancelsBefore = cancelledIntents(stripe).length;
      const mintsBefore = (await refundRowsFor(cohort.id)).length;
      const pagesBefore = capture.lines.filter(
        (l) => l.level === 50 && String(l.msg).includes('no PaymentIntent'),
      ).length;

      const w2 = await withdraw({ app, cohortId: cohort.id });
      const body = w2.json() as EnrollmentWithdrawResultWire;
      assert.equal(body.money_outcome, 'released', w2.body);
      assert.equal(body.released_cents, PRICE, 'and it says how much came off the card');
      assert.equal(body.refunded_cents, 0);
      assert.equal(
        cancelledIntents(stripe).length - cancelsBefore,
        1,
        'exactly one cancel — the live hold this withdraw is about',
      );
      assert.equal((await stripe.retrievePaymentIntent(hold.pi!)).status, 'canceled');
      assert.equal(
        (await refundRowsFor(cohort.id)).length,
        mintsBefore,
        'a bank-failed or hand-owed OLD remainder is never re-minted by a new withdraw',
      );
      assert.equal(
        capture.lines.filter((l) => l.level === 50 && String(l.msg).includes('no PaymentIntent'))
          .length - pagesBefore,
        0,
        'and the manual-refund page fires only for the CURRENT enrollment’s own NULL-PI charge',
      );
    } finally {
      await cleanup(cohort.id);
    }
  },
);

// ══════════════════════════════════════════════════════════════════════════
// 5 — the post-withdraw refund (walk item 6) and payment_status (item 7)
// ══════════════════════════════════════════════════════════════════════════

test(
  '§A3.17-P an old release_pending capture that completes AFTER a re-enroll REFUNDS, it does not pay for the new class — RED FIRST',
  SKIP_WHEN_NO_DB,
  async () => {
    // RED against the pre-§A3.17 tree: `'already-captured'` — the NEW
    // enrollment's bookings answered for the OLD charge, so the withdrawn
    // class's money was silently redirected to a different purchase and the
    // `release_pending` promise ("you won't pay for this class") broke. Q-E,
    // default YES: Q-B's ruling extended to the re-enrolled case.
    const cohort = await makeCohort();
    const { app, stripe } = enrollApp();
    try {
      stripe.throwOnCapture(2);
      const first = await enroll({ app, cohortId: cohort.id });
      assert.equal(first.statusCode, 201, first.body);
      const old = await liveHold(cohort.id);
      stripe.setIntentState(old.pi!, 'processing');
      const w = await withdraw({ app, cohortId: cohort.id });
      assert.equal((w.json() as EnrollmentWithdrawResultWire).money_outcome, 'release_pending');

      // The re-enroll pays its own way (capture succeeds), so the only row the
      // worklist can claim is the withdrawn enrollment's.
      const second = await enroll({ app, cohortId: cohort.id });
      assert.equal(second.statusCode, 201, second.body);
      assert.ok((await liveBookings(cohort.id)).length > 0, 'the dog IS enrolled again');

      // …and the in-flight payment turns out to have been a capture completing.
      stripe.setIntentState(old.pi!, 'succeeded');
      const refundsBefore = refundCalls(stripe);

      const tick = await runCaptureReconcilerOnce({ stripe, now: tickNow() });
      assert.equal(
        tick.results.find((r) => r.chargeId === old.id)?.outcome,
        'refunded-post-withdraw',
      );
      assert.equal(refundCalls(stripe) - refundsBefore, 1, 'one refund, fired unattended');
      const minted = (await refundRowsFor(cohort.id)).filter((r) => r.chargeId === old.id);
      assert.equal(minted.length, 1);
      assert.equal(minted[0]?.amountCents, PRICE, 'the whole withdrawn class’s money comes back');
    } finally {
      await cleanup(cohort.id);
    }
  },
);

test(
  '§A3.17-PS payment_status is enrollment-scoped: a re-enrolled dog resting on a pending hold reads ‘pending’, not ‘paid’ — RED FIRST',
  SKIP_WHEN_NO_DB,
  async () => {
    // The sixth consumer, which no round had named. RED against the
    // pre-§A3.17 tree: `'paid'`, off the PREVIOUS enrollment's charge — and
    // mobile's withdraw confirm dialog branches its money sentence on this
    // field, so the owner was told their money was collected when what they
    // actually have is an uncaptured hold.
    const cohort = await makeCohort();
    const { app, stripe } = enrollApp();
    try {
      const first = await enroll({ app, cohortId: cohort.id });
      assert.equal(first.statusCode, 201, first.body);
      const w = await withdraw({ app, cohortId: cohort.id });
      assert.equal((w.json() as EnrollmentWithdrawResultWire).money_outcome, 'refunded');

      stripe.throwOnCapture(2);
      const second = await enroll({ app, cohortId: cohort.id });
      assert.equal(second.statusCode, 201, second.body);
      await liveHold(cohort.id);

      const rows = await enrollmentsRepository.listForOwner(FIXTURE_IDS.ownerId);
      const mine = rows.find((r) => r.cohortId === cohort.id && r.dogId === FIXTURE_IDS.dog1Id);
      assert.ok(mine, 'the dog is listed as currently enrolled');
      assert.equal(
        mine.paymentStatus,
        'pending',
        'the previous enrollment’s succeeded charge is not this enrollment’s money',
      );

      // Belt and braces: the HTTP surface says the same thing.
      const res = await app.inject({ method: 'GET', url: '/enrollments' });
      assert.equal(res.statusCode, 200);
      const wire = (res.json() as { cohort_id: string; payment_status: string }[]).find(
        (r) => r.cohort_id === cohort.id,
      );
      assert.equal(wire?.payment_status, 'pending');
    } finally {
      await cleanup(cohort.id);
    }
  },
);

test(
  '§A3.17-PS2 the paid row still reads ‘paid’ — the fix narrows the clause, it does not empty it — PIN',
  SKIP_WHEN_NO_DB,
  async () => {
    const cohort = await makeCohort();
    const { app } = enrollApp();
    try {
      const res = await enroll({ app, cohortId: cohort.id });
      assert.equal(res.statusCode, 201, res.body);
      const rows = await enrollmentsRepository.listForOwner(FIXTURE_IDS.ownerId);
      const mine = rows.find((r) => r.cohortId === cohort.id && r.dogId === FIXTURE_IDS.dog1Id);
      assert.equal(mine?.paymentStatus, 'paid', 'this enrollment’s own captured charge');
    } finally {
      await cleanup(cohort.id);
    }
  },
);

test(
  '§A3.17-PS3 a LEGACY (NULL-anchor) charge minted with the enrollment still reads ‘paid’ — PIN',
  SKIP_WHEN_NO_DB,
  async () => {
    // The time rule, in the SQL clause: rows minted before §A3.17 landed carry
    // no anchor, and they must not all fall to 'pending' on deploy day.
    const cohort = await makeCohort();
    try {
      const live = await seedEnrollmentBookings(cohort.id);
      const bornAtUs = enrollmentIdentityOf(live)?.bornAtUs;
      assert.ok(bornAtUs);
      await seedSucceededCharge({
        cohortId: cohort.id,
        bookingId: null,
        createdAt: new Date(bornAtUs / 1000),
      });
      const rows = await enrollmentsRepository.listForOwner(FIXTURE_IDS.ownerId);
      const mine = rows.find((r) => r.cohortId === cohort.id && r.dogId === FIXTURE_IDS.dog1Id);
      assert.equal(mine?.paymentStatus, 'paid');
    } finally {
      await cleanup(cohort.id);
    }
  },
);

// ══════════════════════════════════════════════════════════════════════════
// 6 — the advisory read's pending-capture preference (walk item 5)
// ══════════════════════════════════════════════════════════════════════════

test(
  '§A3.17-PC findPendingCaptureForCohortDog skips a STAMPED row belonging to another enrollment — RED FIRST',
  SKIP_WHEN_NO_DB,
  async () => {
    // The advisory read cannot tell an enrollment hold from the invoice lane's
    // bookkeeping row, and newest-first is the tie-break. What it CAN now tell
    // is that a stamped row belongs to a DIFFERENT enrollment — so a withdraw
    // never settles the previous enrollment's hold at Stripe and reports on it.
    const cohort = await makeCohort();
    try {
      const live = await seedEnrollmentBookings(cohort.id);
      const deadAnchor = randomUUID();
      await db.insert(bookingsTable).values({
        id: deadAnchor,
        ownerId: FIXTURE_IDS.ownerId,
        leadDogId: FIXTURE_IDS.dog1Id,
        category: 'group-class',
        status: 'cancelled',
        scheduledAt: SIX_WEEKS_OUT_UTC,
        durationMinutes: 60,
        location: 'fayetteville',
        notes: null,
        cohortId: cohort.id,
      });
      const foreign = randomUUID();
      await db.insert(chargesTable).values({
        id: foreign,
        ownerId: FIXTURE_IDS.ownerId,
        stripePaymentIntentId: `pi_foreign_${randomUUID().slice(0, 18)}`,
        amountCents: PRICE,
        status: 'requires_payment',
        purpose: 'group-class',
        cohortId: cohort.id,
        dogId: FIXTURE_IDS.dog1Id,
        bookingId: deadAnchor,
      });
      const mine = randomUUID();
      await db.insert(chargesTable).values({
        id: mine,
        ownerId: FIXTURE_IDS.ownerId,
        stripePaymentIntentId: `pi_mine_${randomUUID().slice(0, 18)}`,
        amountCents: PRICE,
        status: 'requires_payment',
        purpose: 'group-class',
        cohortId: cohort.id,
        dogId: FIXTURE_IDS.dog1Id,
        bookingId: live[0]!.id,
        // OLDER than the foreign row, so newest-first alone would pick wrong.
        createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      });

      const picked = await withActor(ACTOR, (tx) =>
        chargesRepository.findPendingCaptureForCohortDog(tx, {
          cohortId: cohort.id,
          dogId: FIXTURE_IDS.dog1Id,
          enrollment: enrollmentIdentityOf(live),
        }),
      );
      assert.equal(picked?.id, mine, 'the previous enrollment’s hold is not this withdraw’s to settle');
    } finally {
      await cleanup(cohort.id);
    }
  },
);

// ══════════════════════════════════════════════════════════════════════════
// 7 — the live-booking projection the predicate now depends on
// ══════════════════════════════════════════════════════════════════════════

test(
  '§A3.17-LB findLiveBookingsForCohortDog carries created_at — the legacy rule’s only input — RED FIRST',
  SKIP_WHEN_NO_DB,
  async () => {
    const cohort = await makeCohort();
    try {
      const seeded = await seedEnrollmentBookings(cohort.id);
      const rows = await withActor(ACTOR, (tx) =>
        bookingsRepository.findLiveBookingsForCohortDog(tx, cohort.id, FIXTURE_IDS.dog1Id),
      );
      assert.equal(rows.length, seeded.length);
      for (const row of rows) {
        assert.ok(
          typeof row.createdAtUs === 'string' && /^\d+$/.test(row.createdAtUs),
          'the legacy time rule needs DB MICROSECONDS, not a truncated timestamp (§A3.18 D3)',
        );
      }
      const identity = enrollmentIdentityOf(rows);
      assert.equal(identity?.bookingIds.length, seeded.length);
      assert.equal(typeof identity?.bornAtUs, 'number');
      assert.ok(Number.isSafeInteger(identity?.bornAtUs));
    } finally {
      await cleanup(cohort.id);
    }
  },
);

// ══════════════════════════════════════════════════════════════════════════
// 8 — ADDENDUM 3 §A3.18: the adversary's three surviving money findings
// ══════════════════════════════════════════════════════════════════════════

test(
  '§A3.18-D3 (OP-11) a legacy charge microseconds BEFORE the birth is a member in NEITHER layer — RED FIRST',
  SKIP_WHEN_NO_DB,
  async () => {
    // OP-11 executed the split: a charge at `…10.1875+00` against a birth of
    // `…10.1879+00`. Postgres says the charge PREDATES the enrollment; JS said
    // MEMBER, because `new Date()` truncates microseconds to milliseconds and
    // `bornAt` was floored the same way — so the two layers disagreed about the
    // same two rows, and the reconciler released a live hold on a dog with four
    // live sessions.
    //
    // §A3.17's "the failure direction is money-not-taken" defence is RETRACTED
    // for this class: money-not-taken is round 4's blocker shape, not an
    // acceptable direction. The rule is now one precision — the DATABASE's
    // microseconds, end to end, with `new Date()` off the membership path.
    const cohort = await makeCohort();
    const { app, stripe } = enrollApp();
    try {
      stripe.throwOnCapture(2);
      const res = await enroll({ app, cohortId: cohort.id });
      assert.equal(res.statusCode, 201, res.body);
      const hold = await liveHold(cohort.id);

      // ONE base instant, read once, reused for both writes — so the ordering
      // is constructed, not hoped for.
      const baseRow = await db.execute(
        sql`SELECT date_trunc('milliseconds', now())::text AS t`,
      );
      const base = (baseRow.rows[0] as { t: string }).t;
      await db
        .update(bookingsTable)
        .set({ createdAt: sql`${base}::timestamptz + interval '900 microseconds'` })
        .where(eq(bookingsTable.cohortId, cohort.id));
      const legacyId = randomUUID();
      await db.insert(chargesTable).values({
        id: legacyId,
        ownerId: FIXTURE_IDS.ownerId,
        stripePaymentIntentId: null,
        amountCents: PRICE,
        status: 'succeeded',
        purpose: 'group-class',
        cohortId: cohort.id,
        dogId: FIXTURE_IDS.dog1Id,
        bookingId: null,
        createdAt: sql`${base}::timestamptz + interval '500 microseconds'`,
      });

      // Confirm the intended state LANDED before trusting anything it says.
      const ordering = await db.execute(
        sql`SELECT (SELECT created_at FROM charges WHERE id = ${legacyId}) <
                   (SELECT min(created_at) FROM bookings WHERE cohort_id = ${cohort.id}
                      AND status <> 'cancelled' AND expired_at IS NULL) AS charge_is_older`,
      );
      assert.equal(
        (ordering.rows[0] as { charge_is_older: boolean }).charge_is_older,
        true,
        'the µs-before-birth state did not land',
      );

      // Layer 1 — JS. The row is read with BOTH spellings so this call is valid
      // against the pre-fix tree (which read `createdAt`) and the fixed one
      // (which reads `createdAtUs`); only the ANSWER changes.
      const [legacy] = await db
        .select({
          bookingId: chargesTable.bookingId,
          createdAt: chargesTable.createdAt,
          createdAtUs: sql<string>`((EXTRACT(EPOCH FROM ${chargesTable.createdAt})::numeric * 1000000)::bigint)::text`,
        })
        .from(chargesTable)
        .where(eq(chargesTable.id, legacyId));
      const identity = await withActor(ACTOR, async (tx) =>
        enrollmentIdentityOf(
          await bookingsRepository.findLiveBookingsForCohortDog(tx, cohort.id, FIXTURE_IDS.dog1Id),
        ),
      );
      assert.equal(
        chargeBelongsToEnrollment(legacy as never, identity),
        false,
        'a charge Postgres says predates the enrollment is not the enrollment’s money',
      );

      // Layer 2 — SQL. The `payment_status` CASE compares native timestamptz and
      // has always been right here; the point is that the two layers now AGREE.
      const listed = await enrollmentsRepository.listForOwner(FIXTURE_IDS.ownerId);
      assert.equal(
        listed.find((r) => r.cohortId === cohort.id)?.paymentStatus,
        'pending',
        'both layers exclude it — one precision, one answer',
      );

      // And the consequence that made it a money defect rather than a curiosity.
      const mark = stripe.calls.length;
      const tick = await runCaptureReconcilerOnce({ stripe, now: tickNow() });
      assert.equal(
        tick.results.find((r) => r.chargeId === hold.id)?.outcome,
        'captured',
        'four live sessions and no money of its own — this enrollment is owed',
      );
      assert.deepEqual(cancelledIntentsSince(stripe, mark), [], 'nothing was released');
    } finally {
      await cleanup(cohort.id);
    }
  },
);

test(
  '§A3.18-D5 (OP-4) a PREVIOUS enrollment’s legacy hold is never this withdraw’s released_cents — RED FIRST',
  SKIP_WHEN_NO_DB,
  async () => {
    // RED against the gated tree: `'released'` with `released_cents: 5000` — a
    // two-day-old foreign hold, for a different amount than this class costs,
    // reported to the owner as THIS withdraw's money, and cancelled at Stripe
    // by a withdraw it had nothing to do with.
    //
    // §A3.17 gave the pending-capture read a membership rule for STAMPED rows
    // only, leaving legacy NULL-anchor rows on plain newest-first. With D1
    // closing the last producer of new NULL anchors, the residue is true-legacy
    // rows and they join the same rule — the time rule, at D3 precision.
    const cohort = await makeCohort();
    const { app, stripe } = enrollApp();
    const LEGACY_AMOUNT = 5_000;
    try {
      const legacyPi = `pi_legacy_${randomUUID().slice(0, 12)}`;
      const legacyId = randomUUID();
      await db.insert(chargesTable).values({
        id: legacyId,
        ownerId: FIXTURE_IDS.ownerId,
        stripePaymentIntentId: legacyPi,
        amountCents: LEGACY_AMOUNT,
        status: 'requires_payment',
        purpose: 'group-class',
        cohortId: cohort.id,
        dogId: FIXTURE_IDS.dog1Id,
        bookingId: null,
        // Two HOURS, not two days: old enough to predate this enrollment's
        // birth (so the legacy time rule excludes it) but inside the 24h
        // abandon floor, so the reconciler still CLAIMS it and the second half
        // of this test — that the money nets out — is actually exercised.
        createdAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
      });
      stripe.setIntentState(legacyPi, 'requires_capture');

      // THIS enrollment: paid, then fully refunded out of band, so its own
      // charge carries zero remainder and the succeeded class is skipped
      // (§A3.15) — which is what lets the priority order reach the
      // pending-capture class at all.
      const res = await enroll({ app, cohortId: cohort.id });
      assert.equal(res.statusCode, 201, res.body);
      const current = (await chargeRows(cohort.id)).find((r) => r.status === 'succeeded');
      assert.ok(current, 'the current enrollment captured');
      await db.insert(refundsTable).values({
        id: randomUUID(),
        ownerId: FIXTURE_IDS.ownerId,
        chargeId: current.id,
        amountCents: current.amountCents,
        status: 'succeeded',
        reason: 'cancel',
      });

      const mark = stripe.calls.length;
      const w = await withdraw({ app, cohortId: cohort.id });
      const body = w.json() as EnrollmentWithdrawResultWire;
      assert.equal(
        body.money_outcome,
        'none',
        'this withdraw has no live money of its own, and says so',
      );
      assert.equal(body.released_cents, undefined);
      assert.equal(body.refunded_cents, 0);
      assert.deepEqual(
        cancelledIntentsSince(stripe, mark),
        [],
        'and it cancels nothing belonging to another enrollment',
      );
      assert.equal(
        (await stripe.retrievePaymentIntent(legacyPi)).status,
        'requires_capture',
        'the foreign hold is untouched by this withdraw',
      );

      // The money still nets out — the reconciler's row-scoped arm releases it,
      // because ITS enrollment is not live either. Statement honest, money safe.
      const tick = await runCaptureReconcilerOnce({ stripe, now: tickNow() });
      assert.equal(tick.results.find((r) => r.chargeId === legacyId)?.outcome, 'withdrawn-released');
      assert.equal((await stripe.retrievePaymentIntent(legacyPi)).status, 'canceled');
    } finally {
      await cleanup(cohort.id);
    }
  },
);

test(
  '§A3.18-D4 (OP-5) a capture that beats our release on a live-but-not-owed row REFUNDS the surplus — RED FIRST',
  SKIP_WHEN_NO_DB,
  async () => {
    // RED against the gated tree: `'already-captured'` — 24000c held for one
    // 12000c class, nothing refunded, nothing paged, and `tick.captured`
    // counting it. The tick had just DECIDED this money must not be taken; the
    // capture won the race, and the build kept it purely because the row's own
    // enrollment was still live.
    //
    // Q-F, default shipped: the surplus refunds itself — the no-uncertains /
    // Q-B family ("a payment we decided against returns itself"), R9-capped,
    // D2-locked, and loudly paged because unattended money movement always is.
    const cohort = await makeCohort();
    const { app, stripe } = enrollApp();
    const alarms = alarmLog();
    try {
      stripe.throwOnCapture(2);
      const res = await enroll({ app, cohortId: cohort.id });
      assert.equal(res.statusCode, 201, res.body);
      const hold = await liveHold(cohort.id);
      assert.ok(hold.bookingId, 'the hold is stamped with this enrollment’s anchor');

      // The SAME enrollment also has collected money — a succeeded charge on
      // this enrollment's own anchor. So: rowEnrollmentLive = true, owed = false.
      await db.insert(chargesTable).values({
        id: randomUUID(),
        ownerId: FIXTURE_IDS.ownerId,
        stripePaymentIntentId: `pi_paid_${randomUUID().slice(0, 12)}`,
        amountCents: PRICE,
        status: 'succeeded',
        purpose: 'group-class',
        cohortId: cohort.id,
        dogId: FIXTURE_IDS.dog1Id,
        bookingId: hold.bookingId,
      });

      // Stripe captures between our retrieve and our cancel: the release loses.
      stripe.captureBeforeCancel();
      const refundsBefore = refundCalls(stripe);
      const tick = await runCaptureReconcilerOnce({ stripe, now: tickNow(), log: alarms.log });

      assert.equal(
        tick.results.find((r) => r.chargeId === hold.id)?.outcome,
        'refunded-surplus',
        'we decided not to charge it; the race does not change that decision',
      );
      assert.equal(tick.refundedSurplus, 1, 'and the tick counts it');
      assert.equal(refundCalls(stripe) - refundsBefore, 1, 'one refund, fired unattended');
      const minted = (await refundRowsFor(cohort.id)).filter((r) => r.chargeId === hold.id);
      assert.equal(minted.length, 1, 'exactly one refund row against the race-won capture');
      assert.equal(minted[0]?.amountCents, PRICE, 'the whole surplus comes back');
      assert.equal(
        alarms.errors.filter((e) => e.chargeId === hold.id).length,
        1,
        'unattended money movement is always paged, once',
      );
    } finally {
      await cleanup(cohort.id);
    }
  },
);
