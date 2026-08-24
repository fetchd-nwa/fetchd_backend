import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { and, asc, eq } from 'drizzle-orm';
import Stripe from 'stripe';
import { db } from '../../src/db/client.js';
import {
  bookings as bookingsTable,
  charges as chargesTable,
  cohorts as cohortsTable,
  dogs as dogsTable,
  dogCompletedClasses as dogCompletedClassesTable,
  dogVaccines as dogVaccinesTable,
  idempotencyKeys as idempotencyKeysTable,
  invoices as invoicesTable,
  paymentMethods,
  requiredVaccines,
} from '../../src/db/schema/schema.js';
import { bookingsRepository } from '../../src/db/repositories/bookingsRepository.js';
import type { GroupClassKey } from '../../src/db/repositories/groupClassesRepository.js';
import { invoicesRepository } from '../../src/db/repositories/invoicesRepository.js';
import { settleInvoiceCharge } from '../../src/lib/settleInvoiceCharge.js';
import { withActor } from '../../src/db/tx.js';
import { updateStoredResponse } from '../../src/db/idempotency.js';
import {
  amendStoredEnvelopeAfterCapture,
  captureHeldDogs,
} from '../../src/lib/enrollmentPartial.js';
import { registerEnrollmentsRoute } from '../../src/routes/enrollments.js';
import type { StripeClient } from '../../src/lib/stripe.js';
import {
  runCaptureReconcilerOnce,
  CAPTURE_GRACE_MINUTES,
} from '../../src/workers/captureReconciler.js';
import { runSchedulerTickOnce } from '../../src/workers/scheduler.js';
import { FIXTURE_IDS, FIXTURE_NOW } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';
import { makeStripeStub } from './_stripeStub.js';

/**
 * Per-dog partial success on POST /enrollments (wire 1.11.0) + the
 * manual-capture money layer underneath it —
 * `designs/partial-success-enrollment.md` §9.
 *
 * Allison, 2026-08-12: "it shoudl report per dog. make as granular as
 * possible. the idea is to book in bulk, but if one dog fails a check, that
 * should be surfaced, not transactional where we fail the entire ting" —
 * plus the standing money rule: "i dont want money charged on accident or
 * things not getting charged".
 *
 * The file opens with the STUB's own honesty, because every money assertion
 * below is only worth what the stub's model of Stripe is worth. A stub that
 * answers `succeeded` to a manual-capture authorize would make the whole
 * authorize→enroll→capture protocol untestable while every test passed.
 */

// ──────────────────────────────────────────────────────────────────────────
// Group 0 — the stub models manual capture honestly (§9 preamble)
// ──────────────────────────────────────────────────────────────────────────

test('stub — a manual-capture authorize rests at requires_capture and moves no money', async () => {
  const stripe = makeStripeStub();
  const authorized = await stripe.createAndConfirmPaymentIntent(
    {
      customerId: 'cus_x',
      paymentMethodId: 'pm_x',
      amountCents: 12_000,
      currency: 'usd',
      metadata: { purpose: 'group-class' },
      captureMethod: 'manual',
    },
    'k-auth-1',
  );
  assert.equal(
    authorized.status,
    'requires_capture',
    'a manual-capture confirm AUTHORIZES; succeeded here would mean the stub captured money the route never asked to capture',
  );

  // The same call without `captureMethod` is unchanged — the default path
  // every other confirm site in this system still travels.
  const auto = await stripe.createAndConfirmPaymentIntent(
    {
      customerId: 'cus_x',
      paymentMethodId: 'pm_x',
      amountCents: 12_000,
      currency: 'usd',
      metadata: { purpose: 'package' },
    },
    'k-auth-auto',
  );
  assert.equal(auto.status, 'succeeded');
});

test('stub — capture flips the held intent to succeeded, and only then', async () => {
  const stripe = makeStripeStub();
  const held = await stripe.createAndConfirmPaymentIntent(
    {
      customerId: 'cus_x',
      paymentMethodId: 'pm_x',
      amountCents: 12_000,
      currency: 'usd',
      metadata: {},
      captureMethod: 'manual',
    },
    'k-cap-1',
  );
  const before = await stripe.retrievePaymentIntent(held.id);
  assert.equal(before.status, 'requires_capture', 'still only a hold before capture');

  const captured = await stripe.capturePaymentIntent(held.id, 'k-cap-1:capture');
  assert.equal(captured.status, 'succeeded');
  const after = await stripe.retrievePaymentIntent(held.id);
  assert.equal(
    after.status,
    'succeeded',
    'the capture moved the money at Stripe, not just in the reply',
  );
});

test('stub — a same-key capture REPLAYS; a fresh-key re-capture is refused', async () => {
  const stripe = makeStripeStub();
  const held = await stripe.createAndConfirmPaymentIntent(
    {
      customerId: 'cus_x',
      paymentMethodId: 'pm_x',
      amountCents: 9_900,
      currency: 'usd',
      metadata: {},
      captureMethod: 'manual',
    },
    'k-cap-2',
  );
  const first = await stripe.capturePaymentIntent(held.id, 'k-cap-2:capture');
  assert.equal(first.replayed, false, 'the first capture EXECUTED');

  const replayed = await stripe.capturePaymentIntent(held.id, 'k-cap-2:capture');
  assert.equal(
    replayed.replayed,
    true,
    'a same-key capture is a replay, not a second money movement',
  );
  assert.equal(replayed.id, first.id);

  // A DIFFERENT key against an already-captured intent is what Stripe refuses
  // outright — the second defence under the reconciler's "already captured is
  // success-after-retrieve" rule.
  await assert.rejects(
    () => stripe.capturePaymentIntent(held.id, `k-cap-2:capture-other-${randomUUID()}`),
    /unexpected state|already/i,
    'capturing an already-captured intent under a new key must fail loudly',
  );
});

test('stub — a CANCELLED hold cannot be captured', async () => {
  const stripe = makeStripeStub();
  const held = await stripe.createAndConfirmPaymentIntent(
    {
      customerId: 'cus_x',
      paymentMethodId: 'pm_x',
      amountCents: 5_000,
      currency: 'usd',
      metadata: {},
      captureMethod: 'manual',
    },
    'k-cap-3',
  );
  await stripe.cancelPaymentIntent(held.id);
  await assert.rejects(
    () => stripe.capturePaymentIntent(held.id, 'k-cap-3:capture'),
    /unexpected state|cancel/i,
    'a released hold holds nothing to capture',
  );
});

test('stub — throwOnCapture() makes exactly the next capture fail', async () => {
  const stripe = makeStripeStub();
  const held = await stripe.createAndConfirmPaymentIntent(
    {
      customerId: 'cus_x',
      paymentMethodId: 'pm_x',
      amountCents: 5_000,
      currency: 'usd',
      metadata: {},
      captureMethod: 'manual',
    },
    'k-cap-4',
  );
  stripe.throwOnCapture();
  await assert.rejects(() => stripe.capturePaymentIntent(held.id, 'k-cap-4:capture'));
  // The hold is untouched by a capture that failed — that is why the honest
  // answer to a failed capture is "pending", not "declined".
  const after = await stripe.retrievePaymentIntent(held.id);
  assert.equal(after.status, 'requires_capture');
  // And the lever is single-shot: the retry succeeds.
  const retried = await stripe.capturePaymentIntent(held.id, 'k-cap-4:capture');
  assert.equal(retried.status, 'succeeded');
});

test('stub — throwOnCapture(n) fails the next n captures, so the route’s retry can be outlasted', async () => {
  // The route retries a failed capture ONCE before answering `pending`. A
  // single-shot lever therefore cannot produce the pending tail at all — the
  // retry always succeeds — so the tail would be untestable and the reconciler
  // would have nothing to reconcile in any test.
  const stripe = makeStripeStub();
  const held = await stripe.createAndConfirmPaymentIntent(
    {
      customerId: 'cus_x',
      paymentMethodId: 'pm_x',
      amountCents: 5_000,
      currency: 'usd',
      metadata: {},
      captureMethod: 'manual',
    },
    'k-cap-5',
  );
  stripe.throwOnCapture(2);
  await assert.rejects(() => stripe.capturePaymentIntent(held.id, 'k-cap-5:capture'));
  await assert.rejects(() => stripe.capturePaymentIntent(held.id, 'k-cap-5:capture'));
  const after = await stripe.retrievePaymentIntent(held.id);
  assert.equal(after.status, 'requires_capture', 'two failed captures moved no money');
  const third = await stripe.capturePaymentIntent(held.id, 'k-cap-5:capture');
  assert.equal(third.status, 'succeeded', 'the lever is exhausted after n');
});

test('stub — per-KEY outcomes let a multi-dog request decline exactly one dog', async () => {
  // The queue lever (`queueIntentOutcomes`) binds outcomes to CALL ORDER, which
  // silently mis-targets the moment the route stops authorizing every dog it
  // was handed — which is exactly what the advisory pre-flight does: dogs that
  // fail a check never reach Stripe at all. Keying the outcome to the per-dog
  // idempotency key names the dog instead of counting the calls.
  const stripe = makeStripeStub();
  stripe.setIntentOutcomeForKey('K:dog:B', {
    kind: 'cardError',
    status: 'requires_payment_method',
  });

  const a = await stripe.createAndConfirmPaymentIntent(
    {
      customerId: 'c',
      paymentMethodId: 'p',
      amountCents: 100,
      currency: 'usd',
      metadata: {},
      captureMethod: 'manual',
    },
    'K:dog:A',
  );
  const b = await stripe.createAndConfirmPaymentIntent(
    {
      customerId: 'c',
      paymentMethodId: 'p',
      amountCents: 100,
      currency: 'usd',
      metadata: {},
      captureMethod: 'manual',
    },
    'K:dog:B',
  );
  const c = await stripe.createAndConfirmPaymentIntent(
    {
      customerId: 'c',
      paymentMethodId: 'p',
      amountCents: 100,
      currency: 'usd',
      metadata: {},
      captureMethod: 'manual',
    },
    'K:dog:C',
  );

  assert.equal(a.status, 'requires_capture', 'dog A authorized');
  assert.equal(
    b.status,
    'requires_payment_method',
    'dog B declined — named by key, not by position',
  );
  assert.equal(b.blocker, 'declined');
  assert.equal(c.status, 'requires_capture', 'dog C authorized');
});

// ──────────────────────────────────────────────────────────────────────────
// §9 matrix — the route, against real Postgres
// ──────────────────────────────────────────────────────────────────────────

registerFixtureHooks();

const SIX_WEEKS_OUT_UTC = '2026-07-06T23:00:00Z';
const PUPPY_PRICE_PER_DOG_CENTS = 12_000;
const MANNERS2_PRICE_PER_DOG_CENTS = 20_000;

/**
 * A vaccine expiry the DDL trigger will accept. `assert_vaccines_current`
 * compares `expires_at` to REAL `now()` — the injected FIXTURE_TODAY clock
 * cannot reach a trigger — so this is computed off the wall clock and can
 * never rot (the 2026-08-19 lesson, where a hard-coded expiry took 830 tests
 * down at once).
 */
function farFutureExpiry(): string {
  return new Date(Date.now() + 5 * 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function makeCohort(args: {
  classKey: GroupClassKey;
  capacity: number;
  filled?: number;
  weeks?: number;
  location?: 'fayetteville' | 'bentonville';
}): Promise<{ id: string; weeks: number }> {
  const id = randomUUID();
  const weeks = args.weeks ?? 4;
  await db.insert(cohortsTable).values({
    id,
    classKey: args.classKey,
    location: args.location ?? 'fayetteville',
    startDate: SIX_WEEKS_OUT_UTC,
    endDate: null,
    weeklyTime: '6:00 PM',
    weeks,
    capacity: args.capacity,
    filled: args.filled ?? 0,
  });
  return { id, weeks };
}

/** An extra dog for the fixture owner. Teardown drops every dog by owner id,
 *  so these clean themselves up with the fixture. */
async function makeDog(name: string): Promise<string> {
  const id = randomUUID();
  await db.insert(dogsTable).values({
    id,
    ownerId: FIXTURE_IDS.ownerId,
    name,
    breed: 'Test Breed',
    birthdate: '2023-01-01',
    specialNotes: '',
    evaluationStatus: 'passed',
    evaluationDate: '2024-03-01T15:00:00Z',
    profileImagePath: null,
  });
  return id;
}

async function giveVaccine(dogId: string, requirementKey: string): Promise<void> {
  await db.insert(dogVaccinesTable).values({
    id: randomUUID(),
    dogId,
    name: requirementKey,
    requirementKey,
    expiresAt: farFutureExpiry(),
  });
}

async function completeClass(dogId: string, classKey: GroupClassKey): Promise<void> {
  await db.insert(dogCompletedClassesTable).values({
    id: randomUUID(),
    dogId,
    classKey,
    completedAt: '2025-09-01T17:00:00Z',
  });
}

interface DogResult {
  dog_id: string;
  enrolled: boolean;
  reason?: string;
  missing_prereq_alternatives?: string[];
  missing_vaccines?: { requirement_key: string; label: string }[];
  seats_remaining?: number;
  charge_blocker?: string;
  payment_state?: string;
  amount_cents?: number;
}
interface Envelope {
  cohort_id: string;
  results: DogResult[];
  bookings: { id: string; dog_id: string }[];
  total_captured_cents: number;
  payment: 'now' | 'later';
}

function enrollApp(stripeOverride?: StripeClient): {
  app: ReturnType<typeof makeContractApp>['app'];
  stripe: ReturnType<typeof makeStripeStub>;
} {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  const stripe = makeStripeStub();
  registerEnrollmentsRoute(app, {
    authenticate,
    stripe: stripeOverride ?? stripe,
    now: FIXTURE_NOW,
  });
  return { app, stripe };
}

async function postPartial(opts: {
  app: ReturnType<typeof makeContractApp>['app'];
  cohortId: string;
  dogIds: string[];
  idempotencyKey: string;
  payLater?: boolean;
  allowPartial?: boolean;
}): Promise<{ statusCode: number; json: () => unknown; body: string }> {
  return opts.app.inject({
    method: 'POST',
    url: '/enrollments',
    headers: { 'idempotency-key': opts.idempotencyKey },
    payload: {
      cohort_id: opts.cohortId,
      dog_ids: opts.dogIds,
      payment_method_id: FIXTURE_IDS.paymentMethod1Id,
      pay_later: opts.payLater ?? false,
      ...(opts.allowPartial === false ? {} : { allow_partial: true }),
    },
  });
}

const confirms = (stripe: ReturnType<typeof makeStripeStub>): string[] =>
  stripe.calls
    .filter((c) => c.method === 'createAndConfirmPaymentIntent')
    .map((c) => c.idempotencyKey);
const captures = (stripe: ReturnType<typeof makeStripeStub>): string[] =>
  stripe.calls.filter((c) => c.method === 'capturePaymentIntent').map((c) => c.idempotencyKey);
const cancels = (stripe: ReturnType<typeof makeStripeStub>): number =>
  stripe.calls.filter((c) => c.method === 'cancelPaymentIntent').length;
const refunds = (stripe: ReturnType<typeof makeStripeStub>): number =>
  stripe.calls.filter((c) => c.method === 'createRefund').length;
const cancelledIntentIds = (stripe: ReturnType<typeof makeStripeStub>): string[] =>
  stripe.calls
    .filter((c) => c.method === 'cancelPaymentIntent')
    .map((c) => (c as { args: { paymentIntentId: string } }).args.paymentIntentId);

/**
 * The enrollments app plus a memo of `<K>:dog:<id>` → the PaymentIntent id
 * Stripe answered with. The stub records the ARGS of every call but not the
 * ids it minted, and several ADDENDUM-1 assertions are about WHICH intent a
 * verb was aimed at, not how many times it fired.
 */
function enrollAppTrackingIntents(): {
  app: ReturnType<typeof makeContractApp>['app'];
  stripe: ReturnType<typeof makeStripeStub>;
  intentIdByKey: Map<string, string>;
} {
  const stripe = makeStripeStub();
  const intentIdByKey = new Map<string, string>();
  const tracking: StripeClient = {
    ...stripe,
    async createAndConfirmPaymentIntent(args, idempotencyKey) {
      const result = await stripe.createAndConfirmPaymentIntent(args, idempotencyKey);
      intentIdByKey.set(idempotencyKey, result.id);
      return result;
    },
  };
  const { app } = enrollApp(tracking);
  return { app, stripe, intentIdByKey };
}

// ── §9.1 mixed checks ─────────────────────────────────────────────────────

test(
  '§9.1 four dogs, one ineligible + one vaccine-gapped → 201, two enrolled, per-dog reasons, ZERO Stripe traffic for the failed dogs',
  SKIP_WHEN_NO_DB,
  async () => {
    const cohort = await makeCohort({
      classKey: 'manners-2',
      capacity: 6,
      location: 'bentonville',
    });
    const vaxKey = `test-gc-vax-${randomUUID().slice(0, 8)}`;
    await db.insert(requiredVaccines).values({
      key: vaxKey,
      label: 'Group-Class Test Vaccine',
      gatesCategories: ['group-class'],
    });
    try {
      // dog1 (fixture) already has manners-1 completed.
      const clean = await makeDog('Clean');
      const gapped = await makeDog('Gapped');
      const ineligible = await makeDog('Ineligible');
      await completeClass(clean, 'manners-1');
      await completeClass(gapped, 'manners-1');
      // `ineligible` deliberately has no manners-1.
      await giveVaccine(FIXTURE_IDS.dog1Id, vaxKey);
      await giveVaccine(clean, vaxKey);
      await giveVaccine(ineligible, vaxKey);
      // `gapped` deliberately has no row for the group-class-gating vaccine.

      const { app, stripe } = enrollApp();
      const res = await postPartial({
        app,
        cohortId: cohort.id,
        dogIds: [FIXTURE_IDS.dog1Id, gapped, clean, ineligible],
        idempotencyKey: `p1-${randomUUID()}`,
      });
      assert.equal(res.statusCode, 201, res.body);
      const body = res.json() as Envelope;

      // Request order is the wire contract — not sorted order, not work order.
      assert.deepEqual(
        body.results.map((r) => r.dog_id),
        [FIXTURE_IDS.dog1Id, gapped, clean, ineligible],
        'results are in the order the owner picked their dogs',
      );

      const byDog = new Map(body.results.map((r) => [r.dog_id, r]));
      assert.equal(byDog.get(FIXTURE_IDS.dog1Id)?.enrolled, true);
      assert.equal(byDog.get(clean)?.enrolled, true);
      assert.equal(byDog.get(clean)?.payment_state, 'paid');
      assert.equal(byDog.get(clean)?.amount_cents, MANNERS2_PRICE_PER_DOG_CENTS);

      const gappedResult = byDog.get(gapped);
      assert.equal(gappedResult?.enrolled, false);
      assert.equal(gappedResult?.reason, 'vaccine_missing');
      assert.deepEqual(
        gappedResult?.missing_vaccines?.map((v) => v.requirement_key),
        [vaxKey],
        'the gap names the exact requirement the FE deep-links to',
      );

      const ineligibleResult = byDog.get(ineligible);
      assert.equal(ineligibleResult?.enrolled, false);
      assert.equal(ineligibleResult?.reason, 'eligibility_missing');
      assert.deepEqual(ineligibleResult?.missing_prereq_alternatives, ['manners-1']);

      // Two dogs × weeks bookings, and only for the two that enrolled.
      assert.equal(body.bookings.length, 2 * cohort.weeks);
      const bookingRows = await db
        .select({ leadDogId: bookingsTable.leadDogId })
        .from(bookingsTable)
        .where(eq(bookingsTable.cohortId, cohort.id));
      assert.equal(bookingRows.length, 2 * cohort.weeks);
      assert.equal(
        bookingRows.filter((b) => b.leadDogId === gapped || b.leadDogId === ineligible).length,
        0,
        'a dog that failed a check has no bookings',
      );

      const [updated] = await db
        .select({ filled: cohortsTable.filled })
        .from(cohortsTable)
        .where(eq(cohortsTable.id, cohort.id));
      assert.equal(updated?.filled, 2, 'filled counts dogs actually seated');

      // THE money assertion: a dog we already knew could not enroll never
      // touched the owner's card. This is what keeps failed checks off a
      // statement entirely.
      const confirmKeys = confirms(stripe);
      assert.equal(confirmKeys.length, 2, 'one authorize per PASSING dog, and no others');
      assert.ok(confirmKeys.some((k) => k.endsWith(`:dog:${FIXTURE_IDS.dog1Id}`)));
      assert.ok(confirmKeys.some((k) => k.endsWith(`:dog:${clean}`)));
      assert.equal(
        confirmKeys.filter((k) => k.includes(gapped) || k.includes(ineligible)).length,
        0,
        'ZERO Stripe traffic for the failed dogs',
      );
      assert.equal(captures(stripe).length, 2);
      assert.equal(refunds(stripe), 0);
      assert.equal(
        body.total_captured_cents,
        2 * MANNERS2_PRICE_PER_DOG_CENTS,
        'the money line counts only what was actually captured',
      );
    } finally {
      // dog_vaccines FK-references required_vaccines, so the rows go first.
      // Getting this backwards leaks a group-class-GATING requirement into
      // every later test in the file, which fails them all with a
      // vaccine_missing nobody asked for.
      await db.delete(dogVaccinesTable).where(eq(dogVaccinesTable.requirementKey, vaxKey));
      await db.delete(requiredVaccines).where(eq(requiredVaccines.key, vaxKey));
    }
  },
);

// ── §9.2 one decline among three, ZERO unwind ─────────────────────────────

test(
  '§9.2 one declined dog fails ALONE — siblings enroll and captured, and NO cancel or refund verb ever fires',
  SKIP_WHEN_NO_DB,
  async () => {
    const cohort = await makeCohort({ classKey: 'puppy', capacity: 6 });
    const dogB = await makeDog('Bravo');
    const dogC = await makeDog('Charlie');
    const key = `p2-${randomUUID()}`;
    const { app, stripe } = enrollApp();
    // Named by KEY, not by call order — the declined dog is dogB whatever
    // position it lands in.
    stripe.setIntentOutcomeForKey(`${key}:dog:${dogB}`, {
      kind: 'recorded',
      scenario: 'saved-card-declined',
    });

    const res = await postPartial({
      app,
      cohortId: cohort.id,
      dogIds: [FIXTURE_IDS.dog1Id, dogB, dogC],
      idempotencyKey: key,
    });
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json() as Envelope;
    const byDog = new Map(body.results.map((r) => [r.dog_id, r]));

    assert.equal(byDog.get(dogB)?.enrolled, false);
    assert.equal(byDog.get(dogB)?.reason, 'charge_failed');
    assert.equal(byDog.get(dogB)?.charge_blocker, 'declined');
    assert.equal(byDog.get(FIXTURE_IDS.dog1Id)?.enrolled, true);
    assert.equal(byDog.get(dogC)?.enrolled, true);

    // The zero-unwind claim, asserted rather than narrated.
    assert.equal(cancels(stripe), 0, 'a declined sibling costs nobody a cancel');
    assert.equal(refunds(stripe), 0, 'and nothing is ever refunded from an enrollment path');
    assert.equal(captures(stripe).length, 2, 'exactly the two enrolled dogs were captured');
    assert.equal(body.total_captured_cents, 2 * PUPPY_PRICE_PER_DOG_CENTS);

    const chargeRows = await db
      .select({ dogId: chargesTable.dogId, status: chargesTable.status })
      .from(chargesTable)
      .where(eq(chargesTable.cohortId, cohort.id));
    assert.equal(chargeRows.length, 2, 'no charge row for the declined dog');
    for (const row of chargeRows) {
      assert.equal(row.status, 'succeeded', 'captured money is recorded as succeeded');
    }
    const [updated] = await db
      .select({ filled: cohortsTable.filled })
      .from(cohortsTable)
      .where(eq(cohortsTable.id, cohort.id));
    assert.equal(updated?.filled, 2);
  },
);

// ── §9.3 processing authorize ─────────────────────────────────────────────

test(
  '§9.3 an authorize still PROCESSING reports charge_unverified, is never cancelled, and costs the siblings nothing',
  SKIP_WHEN_NO_DB,
  async () => {
    const cohort = await makeCohort({ classKey: 'puppy', capacity: 6 });
    const dogB = await makeDog('Processing');
    const key = `p3-${randomUUID()}`;
    const { app, stripe } = enrollApp();
    stripe.setIntentOutcomeForKey(`${key}:dog:${dogB}`, { kind: 'status', status: 'processing' });

    const res = await postPartial({
      app,
      cohortId: cohort.id,
      dogIds: [FIXTURE_IDS.dog1Id, dogB],
      idempotencyKey: key,
    });
    assert.equal(res.statusCode, 201, res.body);
    const byDog = new Map((res.json() as Envelope).results.map((r) => [r.dog_id, r]));

    assert.equal(byDog.get(dogB)?.enrolled, false);
    assert.equal(
      byDog.get(dogB)?.reason,
      'charge_unverified',
      'an in-flight authorization is NOT a decline — its copy must refuse a retry, not send the owner to another card',
    );
    assert.equal(
      byDog.get(dogB)?.charge_blocker,
      undefined,
      'charge_unverified carries no blocker',
    );
    assert.equal(byDog.get(FIXTURE_IDS.dog1Id)?.enrolled, true);

    // The verb that used to require a `log.fatal` is simply never called.
    assert.equal(cancels(stripe), 0, 'no cancel is attempted on a processing intent');
    assert.equal(refunds(stripe), 0);
    assert.equal(captures(stripe).length, 1, 'only the enrolled dog is captured');
  },
);

// ── §9.4 capacity: the server never auto-picks ────────────────────────────

test(
  '§9.4a three passing dogs, two seats → 200, nobody seated, seat_shortfall ×3, and NOT ONE Stripe call',
  SKIP_WHEN_NO_DB,
  async () => {
    const cohort = await makeCohort({ classKey: 'puppy', capacity: 2, filled: 0 });
    const dogB = await makeDog('Bravo');
    const dogC = await makeDog('Charlie');
    const { app, stripe } = enrollApp();
    const res = await postPartial({
      app,
      cohortId: cohort.id,
      dogIds: [FIXTURE_IDS.dog1Id, dogB, dogC],
      idempotencyKey: `p4a-${randomUUID()}`,
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as Envelope;
    assert.equal(body.results.filter((r) => r.enrolled).length, 0, 'nobody is seated');
    for (const result of body.results) {
      assert.equal(result.reason, 'seat_shortfall');
      assert.equal(result.seats_remaining, 2, 'the owner is told the real number and chooses');
    }
    assert.equal(body.bookings.length, 0);
    assert.equal(body.total_captured_cents, 0);
    assert.equal(
      stripe.calls.length,
      0,
      'the choice does not require the owner’s card — the advisory seat check refuses before Stripe',
    );
    const [updated] = await db
      .select({ filled: cohortsTable.filled })
      .from(cohortsTable)
      .where(eq(cohortsTable.id, cohort.id));
    assert.equal(updated?.filled, 0);
  },
);

test(
  '§9.4b seats SHRINK between the advisory read and the cohort lock → every hold is released, nothing captured',
  SKIP_WHEN_NO_DB,
  async () => {
    // The race the advisory check cannot catch. The seat count is read without
    // a lock, so a concurrent enrollment can take the seats while this request
    // is at Stripe. Simulated deterministically by having the FIRST authorize
    // fill the cohort — the same interleaving, placed by hand.
    const cohort = await makeCohort({ classKey: 'puppy', capacity: 2, filled: 0 });
    const dogB = await makeDog('Bravo');
    const base = makeStripeStub();
    let filledYet = false;
    const racing: StripeClient = {
      ...base,
      async createAndConfirmPaymentIntent(args, idempotencyKey) {
        if (!filledYet) {
          filledYet = true;
          await db.update(cohortsTable).set({ filled: 2 }).where(eq(cohortsTable.id, cohort.id));
        }
        return base.createAndConfirmPaymentIntent(args, idempotencyKey);
      },
    };
    const { app } = enrollApp(racing);
    const res = await postPartial({
      app,
      cohortId: cohort.id,
      dogIds: [FIXTURE_IDS.dog1Id, dogB],
      idempotencyKey: `p4b-${randomUUID()}`,
    });

    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as Envelope;
    for (const result of body.results) {
      assert.equal(result.reason, 'seat_shortfall');
      assert.equal(result.seats_remaining, 0);
    }
    assert.equal(confirms(base).length, 2, 'both dogs were authorized before the race was seen');
    assert.equal(cancels(base), 2, 'EVERY hold is released — the money never left the card');
    assert.equal(captures(base).length, 0, 'nothing is captured when nothing is seated');
    assert.equal(refunds(base), 0);
    // The stub's live state is the authority, not our call count.
    for (const call of base.calls.filter((c) => c.method === 'cancelPaymentIntent')) {
      const live = await base.retrievePaymentIntent(call.args.paymentIntentId);
      assert.equal(
        live.status,
        'canceled',
        'the hold is really gone at Stripe, not just attempted',
      );
    }
    const bookingRows = await db
      .select({ id: bookingsTable.id })
      .from(bookingsTable)
      .where(eq(bookingsTable.cohortId, cohort.id));
    assert.equal(bookingRows.length, 0);
  },
);

// ── §9.5 replay after commit ──────────────────────────────────────────────

test(
  '§9.5 a same-key resubmit replays the stored envelope byte-for-byte with ZERO new Stripe calls',
  SKIP_WHEN_NO_DB,
  async () => {
    const cohort = await makeCohort({ classKey: 'puppy', capacity: 6 });
    const dogB = await makeDog('Bravo');
    const key = `p5-${randomUUID()}`;
    const { app, stripe } = enrollApp();
    const first = await postPartial({
      app,
      cohortId: cohort.id,
      dogIds: [FIXTURE_IDS.dog1Id, dogB],
      idempotencyKey: key,
    });
    assert.equal(first.statusCode, 201, first.body);
    const callsAfterFirst = stripe.calls.length;

    const second = await postPartial({
      app,
      cohortId: cohort.id,
      dogIds: [FIXTURE_IDS.dog1Id, dogB],
      idempotencyKey: key,
    });
    assert.equal(second.statusCode, 201, second.body);
    assert.deepEqual(second.json(), first.json(), 'the replay is the same envelope');
    assert.equal(
      stripe.calls.length,
      callsAfterFirst,
      'the peek runs BEFORE any Stripe call — a retry mints no holds',
    );
    // And the money truth in the replayed body is post-capture, not the
    // in-transaction snapshot.
    const replayed = second.json() as Envelope;
    assert.equal(replayed.total_captured_cents, 2 * PUPPY_PRICE_PER_DOG_CENTS);
    for (const result of replayed.results) assert.equal(result.payment_state, 'paid');
  },
);

// ── §9.6 crash-window adoption ────────────────────────────────────────────

test(
  '§9.6 a hold created by a crashed attempt is ADOPTED, not duplicated — one authorize execution, one capture',
  SKIP_WHEN_NO_DB,
  async () => {
    // The interleaving: an earlier attempt authorized and then died before its
    // transaction. Stripe still holds the funds under `<K>:dog:<id>`. The
    // retry's confirm REPLAYS that hold; the route must retrieve current truth,
    // adopt it, enroll, and capture exactly once.
    const cohort = await makeCohort({ classKey: 'puppy', capacity: 6 });
    const key = `p6-${randomUUID()}`;
    const { app, stripe } = enrollApp();

    // Pre-seed the stub's replay store with the crashed attempt's authorize.
    // The params must be byte-identical to what the route sends, or Stripe's
    // own idempotency layer would reject the retry — which is itself the
    // guarantee this test rests on.
    await stripe.createAndConfirmPaymentIntent(
      {
        customerId: FIXTURE_IDS.stripeCustomerId,
        paymentMethodId: 'pm_fixture_test_visa',
        amountCents: PUPPY_PRICE_PER_DOG_CENTS,
        currency: 'usd',
        metadata: {
          owner_id: FIXTURE_IDS.ownerId,
          dog_id: FIXTURE_IDS.dog1Id,
          cohort_id: cohort.id,
          purpose: 'group-class',
        },
        captureMethod: 'manual',
      },
      `${key}:dog:${FIXTURE_IDS.dog1Id}`,
    );
    const executedConfirms = confirms(stripe).length;
    assert.equal(executedConfirms, 1, 'the crashed attempt left exactly one hold');

    const res = await postPartial({
      app,
      cohortId: cohort.id,
      dogIds: [FIXTURE_IDS.dog1Id],
      idempotencyKey: key,
    });
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json() as Envelope;
    assert.equal(body.results[0]?.enrolled, true);
    assert.equal(body.results[0]?.payment_state, 'paid');
    assert.equal(body.total_captured_cents, PUPPY_PRICE_PER_DOG_CENTS);

    assert.equal(captures(stripe).length, 1, 'the adopted hold is captured exactly once');
    assert.equal(refunds(stripe), 0);
    assert.equal(cancels(stripe), 0);
    const chargeRows = await db
      .select({ status: chargesTable.status, intentId: chargesTable.stripePaymentIntentId })
      .from(chargesTable)
      .where(eq(chargesTable.cohortId, cohort.id));
    assert.equal(
      chargeRows.length,
      1,
      'one charge for one dog — the adoption did not double-write',
    );
    assert.equal(chargeRows[0]?.status, 'succeeded');
  },
);

// ── §9.7 capture-failure tail + the reconciler ────────────────────────────

test(
  '§9.7 a capture that fails leaves the dog ENROLLED and PENDING; the reconciler captures, flips the row, and amends the stored replay',
  SKIP_WHEN_NO_DB,
  async () => {
    const cohort = await makeCohort({ classKey: 'puppy', capacity: 6 });
    const key = `p7-${randomUUID()}`;
    const { app, stripe } = enrollApp();
    // Two failures: the route retries once before answering honestly.
    stripe.throwOnCapture(2);

    const res = await postPartial({
      app,
      cohortId: cohort.id,
      dogIds: [FIXTURE_IDS.dog1Id],
      idempotencyKey: key,
    });
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json() as Envelope;
    assert.equal(body.results[0]?.enrolled, true, 'the enrollment committed — that part is real');
    assert.equal(
      body.results[0]?.payment_state,
      'pending',
      'and the money is reported as pending, never as paid and never as a decline',
    );
    assert.equal(
      body.total_captured_cents,
      0,
      'the confirmation line must not announce money that has not moved',
    );

    const before = await db
      .select({ id: chargesTable.id, status: chargesTable.status })
      .from(chargesTable)
      .where(eq(chargesTable.cohortId, cohort.id));
    assert.equal(before[0]?.status, 'requires_payment', 'the charge row tells the same truth');
    // The hold is NOT released. Once the transaction commits, nothing may
    // cancel an authorization for a dog that is enrolled — releasing it here
    // would convert a recoverable "capture is pending" into "enrolled and
    // never charged", which is the exact half of Allison's rule a hold-based
    // protocol does not fix by itself.
    assert.equal(cancels(stripe), 0, 'a failed capture never releases the hold it still needs');
    assert.equal(refunds(stripe), 0);

    // The reconciler owns it from here. `now` is pushed past the grace window
    // rather than pinning `created_at`, because a touch trigger owns that
    // column and the DDL compares to real `now()`.
    const tick = await runCaptureReconcilerOnce({
      stripe,
      now: new Date(Date.now() + (CAPTURE_GRACE_MINUTES + 1) * 60 * 1000),
    });
    const ours = tick.results.find((r) => r.chargeId === before[0]?.id);
    assert.equal(ours?.outcome, 'captured', 'the reconciler captured the held funds');
    assert.equal(tick.lostHolds, 0);

    const after = await db
      .select({ status: chargesTable.status })
      .from(chargesTable)
      .where(eq(chargesTable.cohortId, cohort.id));
    assert.equal(after[0]?.status, 'succeeded');
  },
);

test(
  '§9.7b the reconciler treats an ALREADY-captured intent as success, and never captures twice',
  SKIP_WHEN_NO_DB,
  async () => {
    // The other half of the tail: Stripe took the money and only OUR flip was
    // lost. Re-capturing would be a second charge if Stripe allowed it; the
    // retrieve-first rule is what makes that unreachable.
    const cohort = await makeCohort({ classKey: 'puppy', capacity: 6 });
    const key = `p7b-${randomUUID()}`;
    const { app, stripe } = enrollApp();
    stripe.throwOnCapture(2);
    const res = await postPartial({
      app,
      cohortId: cohort.id,
      dogIds: [FIXTURE_IDS.dog1Id],
      idempotencyKey: key,
    });
    assert.equal(res.statusCode, 201, res.body);
    const [row] = await db
      .select({ id: chargesTable.id, intentId: chargesTable.stripePaymentIntentId })
      .from(chargesTable)
      .where(eq(chargesTable.cohortId, cohort.id));
    assert.ok(row?.intentId);

    // Stripe captured it out of band (a late webhook, a manual capture).
    stripe.setIntentState(row.intentId, 'succeeded');
    const capturesBefore = captures(stripe).length;

    const tick = await runCaptureReconcilerOnce({
      stripe,
      now: new Date(Date.now() + (CAPTURE_GRACE_MINUTES + 1) * 60 * 1000),
    });
    assert.equal(tick.results.find((r) => r.chargeId === row.id)?.outcome, 'already-captured');
    assert.equal(captures(stripe).length, capturesBefore, 'no second capture was attempted');
    const after = await db
      .select({ status: chargesTable.status })
      .from(chargesTable)
      .where(eq(chargesTable.id, row.id));
    assert.equal(after[0]?.status, 'succeeded', 'the missing flip is written');
  },
);

test(
  '§9.7c a LOST hold on an enrolled dog is an ERROR alarm, not a silent uncollected charge',
  SKIP_WHEN_NO_DB,
  async () => {
    const cohort = await makeCohort({ classKey: 'puppy', capacity: 6 });
    const key = `p7c-${randomUUID()}`;
    const { app, stripe } = enrollApp();
    stripe.throwOnCapture(2);
    const res = await postPartial({
      app,
      cohortId: cohort.id,
      dogIds: [FIXTURE_IDS.dog1Id],
      idempotencyKey: key,
    });
    assert.equal(res.statusCode, 201, res.body);
    const [row] = await db
      .select({ id: chargesTable.id, intentId: chargesTable.stripePaymentIntentId })
      .from(chargesTable)
      .where(eq(chargesTable.cohortId, cohort.id));
    assert.ok(row?.intentId);

    // The hold expired or was released by something else. The dog is still
    // enrolled: this is money we will never collect for a class we will
    // deliver, and it is the one state here that needs a human.
    stripe.setIntentState(row.intentId, 'canceled');
    // Counted as a DELTA: the route already attempted (and failed) two captures
    // above, and those recorded calls are not the reconciler's.
    const captureAttemptsBefore = captures(stripe).length;
    const errors: string[] = [];
    const tick = await runCaptureReconcilerOnce({
      stripe,
      now: new Date(Date.now() + (CAPTURE_GRACE_MINUTES + 1) * 60 * 1000),
      log: {
        info: () => undefined,
        warn: () => undefined,
        error: (_obj, msg) => errors.push(msg ?? ''),
      },
    });
    assert.equal(tick.results.find((r) => r.chargeId === row.id)?.outcome, 'lost-hold');
    assert.equal(tick.lostHolds, 1);
    assert.ok(
      errors.some((m) => m.includes('LOST HOLD')),
      'the operator is told, at ERROR, in a sentence naming what to do',
    );
    assert.equal(
      captures(stripe).length,
      captureAttemptsBefore,
      'a cancelled hold is never captured — the reconciler retrieved, saw canceled, and stopped',
    );
    assert.equal(refunds(stripe), 0);
    const after = await db
      .select({ status: chargesTable.status })
      .from(chargesTable)
      .where(eq(chargesTable.id, row.id));
    assert.equal(
      after[0]?.status,
      'requires_payment',
      'and the row is NOT flipped to succeeded — no money moved, so claiming it did would be the lie',
    );
  },
);

test(
  '§9.7d the reconciler is WIRED — a composed scheduler tick finishes the capture, not just a direct call',
  SKIP_WHEN_NO_DB,
  async () => {
    // Testing the module proves the module. The phase only protects anybody if
    // `runSchedulerTickOnce` actually runs it, and "I added it to the file" is
    // not evidence — this is the call that would go red if the wiring were
    // missing.
    const cohort = await makeCohort({ classKey: 'puppy', capacity: 6 });
    const { app, stripe } = enrollApp();
    stripe.throwOnCapture(2);
    const res = await postPartial({
      app,
      cohortId: cohort.id,
      dogIds: [FIXTURE_IDS.dog1Id],
      idempotencyKey: `p7d-${randomUUID()}`,
    });
    assert.equal(res.statusCode, 201, res.body);
    const [row] = await db
      .select({ id: chargesTable.id, status: chargesTable.status })
      .from(chargesTable)
      .where(eq(chargesTable.cohortId, cohort.id));
    assert.equal(row?.status, 'requires_payment');

    const tick = await runSchedulerTickOnce({
      stripe,
      now: new Date(Date.now() + (CAPTURE_GRACE_MINUTES + 1) * 60 * 1000),
    });
    assert.ok(
      tick.captureReconciler.results.some((r) => r.chargeId === row.id && r.outcome === 'captured'),
      'the composed tick reached the capture-reconciler phase',
    );
    const after = await db
      .select({ status: chargesTable.status })
      .from(chargesTable)
      .where(eq(chargesTable.id, row.id));
    assert.equal(after[0]?.status, 'succeeded');
  },
);

// ── §9.8 the self-healing resubmit ────────────────────────────────────────

test(
  '§9.8 resubmitting the whole roster under a FRESH key reports already_enrolled per dog and never charges twice',
  SKIP_WHEN_NO_DB,
  async () => {
    const cohort = await makeCohort({ classKey: 'puppy', capacity: 6 });
    const dogB = await makeDog('Bravo');
    const dogC = await makeDog('Charlie');
    const firstKey = `p8a-${randomUUID()}`;
    const { app, stripe } = enrollApp();
    // dogC's card declines on the first attempt.
    stripe.setIntentOutcomeForKey(`${firstKey}:dog:${dogC}`, {
      kind: 'recorded',
      scenario: 'saved-card-declined',
    });
    const first = await postPartial({
      app,
      cohortId: cohort.id,
      dogIds: [FIXTURE_IDS.dog1Id, dogB, dogC],
      idempotencyKey: firstKey,
    });
    assert.equal(first.statusCode, 201, first.body);
    const capturesAfterFirst = captures(stripe).length;
    assert.equal(capturesAfterFirst, 2);

    // The owner fixes the card and resubmits the WHOLE roster — the shape the
    // "Fix and retry" CTA produces — under a new key.
    const second = await postPartial({
      app,
      cohortId: cohort.id,
      dogIds: [FIXTURE_IDS.dog1Id, dogB, dogC],
      idempotencyKey: `p8b-${randomUUID()}`,
    });
    assert.equal(second.statusCode, 201, second.body);
    const byDog = new Map((second.json() as Envelope).results.map((r) => [r.dog_id, r]));
    assert.equal(byDog.get(FIXTURE_IDS.dog1Id)?.reason, 'already_enrolled');
    assert.equal(byDog.get(dogB)?.reason, 'already_enrolled');
    assert.equal(byDog.get(dogC)?.enrolled, true, 'only the fixed dog enrolls');

    assert.equal(
      captures(stripe).length,
      capturesAfterFirst + 1,
      'exactly one more capture — the already-enrolled dogs are never charged again',
    );
    const confirmKeys = confirms(stripe);
    assert.equal(
      confirmKeys.filter((k) => k.includes(FIXTURE_IDS.dog1Id)).length,
      1,
      'an already-enrolled dog never reaches Stripe on the resubmit',
    );
    const chargeRows = await db
      .select({ dogId: chargesTable.dogId })
      .from(chargesTable)
      .where(eq(chargesTable.cohortId, cohort.id));
    assert.equal(chargeRows.length, 3, 'one charge per dog, never two for one dog');
    const [updated] = await db
      .select({ filled: cohortsTable.filled })
      .from(cohortsTable)
      .where(eq(cohortsTable.id, cohort.id));
    assert.equal(updated?.filled, 3);
  },
);

// ── §9.9 per-dog isolation inside the transaction ─────────────────────────

test(
  '§9.9a Drizzle nested transactions really are SAVEPOINTs — one child rolls back and its siblings survive',
  SKIP_WHEN_NO_DB,
  async () => {
    // §12 of the design labelled this an ASSUMPTION. It is the mechanism the
    // whole "this dog fails alone" promise rests on inside one transaction, so
    // it is verified against the real driver and the real database rather than
    // taken on faith.
    const cohort = await makeCohort({ classKey: 'puppy', capacity: 6 });
    const survivorId = randomUUID();
    await withActor(`owner:${FIXTURE_IDS.ownerId}`, async (tx) => {
      await tx.transaction(async (sp) => {
        await sp.insert(cohortsTable).values({
          id: survivorId,
          classKey: 'puppy',
          location: 'fayetteville',
          startDate: SIX_WEEKS_OUT_UTC,
          endDate: null,
          weeklyTime: '6:00 PM',
          weeks: 4,
          capacity: 6,
          filled: 0,
        });
      });
      await assert.rejects(
        tx.transaction(async (sp) => {
          await sp.update(cohortsTable).set({ filled: 5 }).where(eq(cohortsTable.id, cohort.id));
          throw new Error('per-dog failure');
        }),
        /per-dog failure/,
      );
      // The outer transaction is STILL USABLE after the inner rollback — which
      // is the property a plain aborted transaction would not have.
      const [row] = await tx
        .select({ filled: cohortsTable.filled })
        .from(cohortsTable)
        .where(eq(cohortsTable.id, cohort.id));
      assert.equal(row?.filled, 0, 'the failed child’s write is gone');
    });
    const [survivor] = await db
      .select({ id: cohortsTable.id })
      .from(cohortsTable)
      .where(eq(cohortsTable.id, survivorId));
    assert.ok(survivor, 'the earlier child’s write committed with the outer transaction');
  },
);

test(
  '§9.9b a dog that becomes ineligible BETWEEN the advisory read and the cohort lock fails alone under the lock',
  SKIP_WHEN_NO_DB,
  async () => {
    // The authoritative re-check (§3.5.1) exists for exactly this window. The
    // race is placed by hand: the first authorize enrolls dogB into the cohort
    // behind our back, so the re-check under the lock sees a duplicate that the
    // advisory phase could not have seen.
    const cohort = await makeCohort({ classKey: 'puppy', capacity: 6 });
    const dogB = await makeDog('Bravo');
    const base = makeStripeStub();
    let raced = false;
    const racing: StripeClient = {
      ...base,
      async createAndConfirmPaymentIntent(args, idempotencyKey) {
        if (!raced) {
          raced = true;
          await withActor(`owner:${FIXTURE_IDS.ownerId}`, async (tx) => {
            await bookingsRepository.create(tx, {
              ownerId: FIXTURE_IDS.ownerId,
              leadDogId: dogB,
              category: 'group-class',
              scheduledAt: new Date(SIX_WEEKS_OUT_UTC),
              location: 'fayetteville',
              notes: null,
              cancelDeadlineAt: new Date(SIX_WEEKS_OUT_UTC),
              additionalDogIds: [],
              cohortId: cohort.id,
              sessionReportId: null,
            });
          });
        }
        return base.createAndConfirmPaymentIntent(args, idempotencyKey);
      },
    };
    const { app } = enrollApp(racing);
    const res = await postPartial({
      app,
      cohortId: cohort.id,
      dogIds: [FIXTURE_IDS.dog1Id, dogB],
      idempotencyKey: `p9b-${randomUUID()}`,
    });

    assert.equal(res.statusCode, 201, res.body);
    const byDog = new Map((res.json() as Envelope).results.map((r) => [r.dog_id, r]));
    assert.equal(byDog.get(dogB)?.enrolled, false);
    assert.equal(byDog.get(dogB)?.reason, 'already_enrolled', 'the race is caught under the lock');
    assert.equal(byDog.get(FIXTURE_IDS.dog1Id)?.enrolled, true, 'the sibling still enrolls');

    assert.equal(cancels(base), 1, 'the raced dog’s hold is released after the transaction');
    assert.equal(captures(base).length, 1, 'only the enrolled dog is captured');
    assert.equal(refunds(base), 0);
  },
);

// ── §9.10 the old path is still the old path ──────────────────────────────

test(
  '§9.10 without allow_partial the response is still a bare BookingWire[] and one failing dog fails them all',
  SKIP_WHEN_NO_DB,
  async () => {
    const cohort = await makeCohort({
      classKey: 'manners-2',
      capacity: 6,
      location: 'bentonville',
    });
    const ineligible = await makeDog('NoPrereq');
    const { app, stripe } = enrollApp();
    const res = await postPartial({
      app,
      cohortId: cohort.id,
      dogIds: [FIXTURE_IDS.dog1Id, ineligible],
      idempotencyKey: `p10-${randomUUID()}`,
      allowPartial: false,
    });
    assert.equal(res.statusCode, 422, res.body);
    assert.equal((res.json() as { error: { code: string } }).error.code, 'eligibility_missing');
    assert.equal(cancels(stripe), 2, 'both holds released — the whole request failed');
    assert.equal(refunds(stripe), 0);
    assert.equal(captures(stripe).length, 0);

    const ok = await postPartial({
      app,
      cohortId: cohort.id,
      dogIds: [FIXTURE_IDS.dog1Id],
      idempotencyKey: `p10b-${randomUUID()}`,
      allowPartial: false,
    });
    assert.equal(ok.statusCode, 201, ok.body);
    assert.ok(Array.isArray(ok.json()), 'the old response is an ARRAY, never an envelope');
  },
);

// ── §9.11 whole-request arms under allow_partial ──────────────────────────

test(
  '§9.11a no card on file → 422 payment_required with ZERO Stripe calls (owner-level gates stay whole-request)',
  SKIP_WHEN_NO_DB,
  async () => {
    const cohort = await makeCohort({ classKey: 'puppy', capacity: 6 });
    await db
      .update(paymentMethods)
      .set({ expiredAt: new Date().toISOString() })
      .where(eq(paymentMethods.id, FIXTURE_IDS.paymentMethod1Id));
    try {
      const { app, stripe } = enrollApp();
      const res = await postPartial({
        app,
        cohortId: cohort.id,
        dogIds: [FIXTURE_IDS.dog1Id],
        idempotencyKey: `p11a-${randomUUID()}`,
      });
      assert.equal(res.statusCode, 422, res.body);
      assert.equal((res.json() as { error: { code: string } }).error.code, 'payment_required');
      assert.equal(
        stripe.calls.length,
        0,
        'no dog can enroll without a card, so there is no per-dog story and no reason to ask Stripe anything',
      );
    } finally {
      await db
        .update(paymentMethods)
        .set({ expiredAt: null })
        .where(eq(paymentMethods.id, FIXTURE_IDS.paymentMethod1Id));
    }
  },
);

test(
  '§9.11b unknown cohort → 404, and a same-key body change → 422 idempotency_mismatch',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, stripe } = enrollApp();
    const missing = await postPartial({
      app,
      cohortId: randomUUID(),
      dogIds: [FIXTURE_IDS.dog1Id],
      idempotencyKey: `p11b-${randomUUID()}`,
    });
    assert.equal(missing.statusCode, 404, missing.body);
    assert.equal(stripe.calls.length, 0);

    const cohort = await makeCohort({ classKey: 'puppy', capacity: 6 });
    const dogB = await makeDog('Bravo');
    const key = `p11c-${randomUUID()}`;
    const first = await postPartial({
      app,
      cohortId: cohort.id,
      dogIds: [FIXTURE_IDS.dog1Id],
      idempotencyKey: key,
    });
    assert.equal(first.statusCode, 201, first.body);
    const drifted = await postPartial({
      app,
      cohortId: cohort.id,
      dogIds: [dogB],
      idempotencyKey: key,
    });
    assert.equal(drifted.statusCode, 422, drifted.body);
    assert.equal(
      (drifted.json() as { error: { code: string } }).error.code,
      'idempotency_mismatch',
      'the peek catches a reused key at the boundary, before any Stripe call',
    );
  },
);

// ── pay-later under allow_partial ─────────────────────────────────────────

test(
  'pay-later + allow_partial: per-dog invoices, per-dog reasons, and no Stripe call anywhere',
  SKIP_WHEN_NO_DB,
  async () => {
    const cohort = await makeCohort({
      classKey: 'manners-2',
      capacity: 6,
      location: 'bentonville',
    });
    const ineligible = await makeDog('NoPrereq');
    const { app, stripe } = enrollApp();
    const res = await postPartial({
      app,
      cohortId: cohort.id,
      dogIds: [FIXTURE_IDS.dog1Id, ineligible],
      idempotencyKey: `plater-${randomUUID()}`,
      payLater: true,
    });
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json() as Envelope;
    assert.equal(body.payment, 'later');
    assert.equal(body.total_captured_cents, 0, 'pay-later captures nothing, ever');
    const byDog = new Map(body.results.map((r) => [r.dog_id, r]));
    assert.equal(byDog.get(FIXTURE_IDS.dog1Id)?.payment_state, 'pay-later');
    assert.equal(byDog.get(ineligible)?.reason, 'eligibility_missing');
    assert.equal(stripe.calls.length, 0);

    const invs = await db
      .select({ dogId: invoicesTable.dogId, status: invoicesTable.status })
      .from(invoicesTable)
      .where(eq(invoicesTable.cohortId, cohort.id));
    assert.equal(invs.length, 1, 'one open invoice for the ONE dog that enrolled');
    assert.equal(invs[0]?.dogId, FIXTURE_IDS.dog1Id);
    assert.equal(invs[0]?.status, 'open');
  },
);

// ──────────────────────────────────────────────────────────────────────────
// §9.12–§9.21 — ADDENDUM 1 (round-1 panel, 2026-08-20). Each of these was
// RED against the round-1 build before the fix that makes it green; the
// failure each one produced is quoted at the test.
// ──────────────────────────────────────────────────────────────────────────

/**
 * A Stripe seam that authorizes normally until the Nth confirm, which throws a
 * NON-card transport error — "we could not reach Stripe", the one class the
 * confirm seam rethrows untouched. Written as a wrapper rather than a stub
 * lever because the single-shot levers arm "the next confirm", and what this
 * needs is "the confirm for the second dog of N", mid-loop.
 */
function transportFailingAt(
  base: ReturnType<typeof makeStripeStub>,
  nth: number,
): StripeClient {
  let confirms = 0;
  return {
    ...base,
    async createAndConfirmPaymentIntent(args, idempotencyKey) {
      confirms += 1;
      if (confirms === nth) {
        // The request never reaches Stripe: no intent, no live key. The
        // dangerous half (it LANDS and only the response is lost) is a
        // separate, unclosed residual — see the module note in
        // `enrollmentPartial.ts`.
        throw new Stripe.errors.StripeConnectionError({
          type: 'api_connection_error',
          message: 'stub: connection dropped mid-authorize',
        } as never);
      }
      return base.createAndConfirmPaymentIntent(args, idempotencyKey);
    },
  };
}

test(
  '§9.12a R1 — a transport failure on the SECOND authorize releases the FIRST dog’s hold (partial path)',
  SKIP_WHEN_NO_DB,
  async () => {
    // RED against the round-1 build: `{"status":500,"cancels":0}` — the
    // authorize block sat outside `runPartialEnrollment`'s try, so dog 1's
    // live `requires_capture` authorization was left on the owner's card with
    // nothing in the system that knew its id.
    const cohort = await makeCohort({ classKey: 'puppy', capacity: 6 });
    const dogB = await makeDog('Bravo');
    const base = makeStripeStub();
    const { app } = enrollApp(transportFailingAt(base, 2));

    const res = await postPartial({
      app,
      cohortId: cohort.id,
      dogIds: [FIXTURE_IDS.dog1Id, dogB],
      idempotencyKey: `p12a-${randomUUID()}`,
    });

    assert.equal(res.statusCode, 500, res.body);
    assert.equal(confirms(base).length, 1, 'only the first dog reached Stripe');
    assert.equal(cancels(base), 1, 'the hold the first dog got is RELEASED, not stranded');
    assert.equal(captures(base).length, 0, 'a request that never committed captures nothing');
    assert.equal(refunds(base), 0, 'and never refunds — nothing was captured to give back');

    // The stub's live state is the authority, not the call count.
    const cancelled = base.calls.filter((c) => c.method === 'cancelPaymentIntent');
    assert.equal(cancelled.length, 1);
    const live = await base.retrievePaymentIntent(
      (cancelled[0] as { args: { paymentIntentId: string } }).args.paymentIntentId,
    );
    assert.equal(live.status, 'canceled', 'the hold is really gone at Stripe');

    const bookingRows = await db
      .select({ id: bookingsTable.id })
      .from(bookingsTable)
      .where(eq(bookingsTable.cohortId, cohort.id));
    assert.equal(bookingRows.length, 0, 'nothing enrolled');
  },
);

test(
  '§9.12b R1 — the same transport failure releases the same hold on the ALL-OR-NOTHING path',
  SKIP_WHEN_NO_DB,
  async () => {
    // RED against the round-1 build for a different reason, same result:
    // `obtained` is assigned only after the helper RETURNS, so the catch
    // called `releaseHolds({holds: []})` — a vacuous no-op that read as
    // coverage.
    const cohort = await makeCohort({ classKey: 'puppy', capacity: 6 });
    const dogB = await makeDog('Bravo');
    const base = makeStripeStub();
    const { app } = enrollApp(transportFailingAt(base, 2));

    const res = await postPartial({
      app,
      cohortId: cohort.id,
      dogIds: [FIXTURE_IDS.dog1Id, dogB],
      idempotencyKey: `p12b-${randomUUID()}`,
      allowPartial: false,
    });

    assert.equal(res.statusCode, 500, res.body);
    assert.equal(confirms(base).length, 1);
    assert.equal(cancels(base), 1, 'the first dog’s hold is released');
    assert.equal(captures(base).length, 0);
    assert.equal(refunds(base), 0);
  },
);

test(
  '§9.13 R2 — a refused authorization resting at requires_action is CANCELLED; a declined one is not',
  SKIP_WHEN_NO_DB,
  async () => {
    // RED against the round-1 build: `cancels === 0`. §3.4's "there is nothing
    // to unwind" is true at the instant of refusal and was asserted
    // permanently — under manual capture a `requires_action` intent that moves
    // on its own lands at `requires_capture`, i.e. a live HOLD nobody owns.
    const cohort = await makeCohort({ classKey: 'puppy', capacity: 6 });
    const dog3ds = await makeDog('NeedsVerification');
    const dogDeclined = await makeDog('Declined');
    const key = `p13-${randomUUID()}`;
    const { app, stripe, intentIdByKey } = enrollAppTrackingIntents();
    stripe.setIntentOutcomeForKey(`${key}:dog:${dog3ds}`, {
      kind: 'status',
      status: 'requires_action',
    });
    stripe.setIntentOutcomeForKey(`${key}:dog:${dogDeclined}`, {
      kind: 'recorded',
      scenario: 'saved-card-declined',
    });

    const res = await postPartial({
      app,
      cohortId: cohort.id,
      dogIds: [FIXTURE_IDS.dog1Id, dog3ds, dogDeclined],
      idempotencyKey: key,
    });
    assert.equal(res.statusCode, 201, res.body);
    const byDog = new Map((res.json() as Envelope).results.map((r) => [r.dog_id, r]));
    assert.equal(byDog.get(dog3ds)?.reason, 'charge_failed');
    assert.equal(byDog.get(dog3ds)?.charge_blocker, 'authentication_required');
    assert.equal(byDog.get(dogDeclined)?.charge_blocker, 'declined');
    assert.equal(byDog.get(FIXTURE_IDS.dog1Id)?.enrolled, true);

    assert.equal(
      cancels(stripe),
      1,
      'exactly one cancel: the requires_action intent that could still park a hold',
    );
    assert.deepEqual(
      cancelledIntentIds(stripe),
      [intentIdByKey.get(`${key}:dog:${dog3ds}`)],
      'and it is that dog’s intent — the declined dog’s is left alone (nothing was ever held for it)',
    );
    assert.equal(captures(stripe).length, 1, 'only the enrolled dog is captured');
    assert.equal(refunds(stripe), 0);
  },
);

test(
  '§9.14 R5 — a hold someone ELSE released reports charge_failed with NO blocker; a decline is never invented',
  SKIP_WHEN_NO_DB,
  async () => {
    // RED against the round-1 build: `charge_blocker === 'declined'`. The
    // canonical producer of a retrieved `canceled` is a same-key sibling's
    // failure path or Stripe's own expiry — the card was never asked, so
    // "your card was declined, try another" is a fabricated cause.
    const cohort = await makeCohort({ classKey: 'puppy', capacity: 6 });
    const dogB = await makeDog('ReleasedElsewhere');
    const key = `p14-${randomUUID()}`;
    const { app, stripe } = enrollApp();
    stripe.setIntentOutcomeForKey(`${key}:dog:${dogB}`, { kind: 'status', status: 'canceled' });

    const res = await postPartial({
      app,
      cohortId: cohort.id,
      dogIds: [FIXTURE_IDS.dog1Id, dogB],
      idempotencyKey: key,
    });
    assert.equal(res.statusCode, 201, res.body);
    const byDog = new Map((res.json() as Envelope).results.map((r) => [r.dog_id, r]));
    assert.equal(byDog.get(dogB)?.reason, 'charge_failed');
    assert.equal(
      byDog.get(dogB)?.charge_blocker,
      undefined,
      'no blocker is asserted for a hold that was released rather than refused',
    );
    assert.equal(byDog.get(FIXTURE_IDS.dog1Id)?.enrolled, true, 'the sibling still enrolls');
  },
);

test(
  '§9.15 R4 — adopting a SUCCEEDED intent whose money is already on a charges row refuses the dog; it never 500s and never enrolls on it',
  SKIP_WHEN_NO_DB,
  async () => {
    // Design §4 row 6 / row 9, walked for real: enroll + capture, withdraw
    // (which refunds), let the idempotency row age out of the 24h sweep while
    // Stripe's key window is still open, then replay the SAME key. The
    // authorize replays a `succeeded` intent, which the round-1 build adopted
    // as `state: 'captured'` and then wrote a second charges row for — the
    // `stripe_payment_intent_id UNIQUE` insert threw inside the per-dog
    // savepoint and `perDogGateFlipResult` rethrew it. RED: `500`.
    const cohort = await makeCohort({ classKey: 'puppy', capacity: 6 });
    const key = `p15-${randomUUID()}`;
    const { app, stripe } = enrollApp();

    const first = await postPartial({
      app,
      cohortId: cohort.id,
      dogIds: [FIXTURE_IDS.dog1Id],
      idempotencyKey: key,
    });
    assert.equal(first.statusCode, 201, first.body);
    const [charged] = await db
      .select({ id: chargesTable.id, intentId: chargesTable.stripePaymentIntentId })
      .from(chargesTable)
      .where(eq(chargesTable.cohortId, cohort.id));
    assert.ok(charged?.intentId, 'the first enrollment captured');

    const withdrawn = await app.inject({
      method: 'POST',
      url: `/enrollments/${cohort.id}/withdraw`,
      headers: { 'idempotency-key': `p15w-${randomUUID()}` },
      payload: { dog_id: FIXTURE_IDS.dog1Id },
    });
    assert.equal(withdrawn.statusCode, 200, withdrawn.body);

    // The 24h idempotency sweep ran; Stripe's key window has not closed.
    await db.delete(idempotencyKeysTable).where(eq(idempotencyKeysTable.key, key));

    const replay = await postPartial({
      app,
      cohortId: cohort.id,
      dogIds: [FIXTURE_IDS.dog1Id],
      idempotencyKey: key,
    });
    assert.equal(replay.statusCode, 200, replay.body);
    const result = (replay.json() as Envelope).results[0];
    assert.equal(result?.enrolled, false, 'the dog is NOT enrolled on money it did not move');
    assert.equal(result?.reason, 'charge_failed');
    assert.equal(
      result?.charge_blocker,
      undefined,
      'nothing about the card failed, so no blocker is asserted',
    );
    assert.equal((replay.json() as Envelope).total_captured_cents, 0);

    const chargeRows = await db
      .select({ id: chargesTable.id })
      .from(chargesTable)
      .where(eq(chargesTable.cohortId, cohort.id));
    assert.equal(chargeRows.length, 1, 'still exactly ONE charges row for that PaymentIntent');
    const liveBookings = await withActor(`owner:${FIXTURE_IDS.ownerId}`, (tx) =>
      bookingsRepository.findLiveBookingsForCohortDog(tx, cohort.id, FIXTURE_IDS.dog1Id),
    );
    assert.equal(liveBookings.length, 0, 'and the dog is not re-seated');
    assert.equal(captures(stripe).length, 1, 'the money moved exactly once, in the first request');
  },
);

test(
  '§9.16 R10 — an advisory-phase refusal is idempotency-recorded, so a same-key duplicate replays it instead of charging',
  SKIP_WHEN_NO_DB,
  async () => {
    // RED against the round-1 build: the second call returned `201` and
    // captured a card. Those three early-return arms answered 200 before
    // `withMutation` ever ran, so nothing recorded the answer — and a
    // same-key duplicate arriving after the state changed diverged from
    // "nobody enrolled, nothing charged" into a real enrollment and a real
    // charge, behind a screen that had said nothing was charged.
    const cohort = await makeCohort({ classKey: 'manners-2', capacity: 6, location: 'bentonville' });
    const dogB = await makeDog('NoPrereqYet');
    const key = `p16-${randomUUID()}`;
    const { app, stripe } = enrollApp();

    const refused = await postPartial({
      app,
      cohortId: cohort.id,
      dogIds: [dogB],
      idempotencyKey: key,
    });
    assert.equal(refused.statusCode, 200, refused.body);
    assert.equal((refused.json() as Envelope).results[0]?.reason, 'eligibility_missing');
    assert.equal(stripe.calls.length, 0, 'an advisory refusal never touches the card');

    // The gap closes between the two calls — the divergence window.
    await completeClass(dogB, 'manners-1');

    const duplicate = await postPartial({
      app,
      cohortId: cohort.id,
      dogIds: [dogB],
      idempotencyKey: key,
    });
    assert.equal(duplicate.statusCode, 200, duplicate.body);
    assert.deepEqual(
      duplicate.json(),
      refused.json(),
      'same key, same answer — the duplicate replays the refusal',
    );
    assert.equal(stripe.calls.length, 0, 'and still no Stripe traffic');
    const bookingRows = await db
      .select({ id: bookingsTable.id })
      .from(bookingsTable)
      .where(eq(bookingsTable.cohortId, cohort.id));
    assert.equal(bookingRows.length, 0, 'nothing was enrolled behind the "nothing charged" answer');
  },
);

/**
 * Seed a `charges` row directly, with `created_at` / `updated_at` under the
 * test's control. Needed because the `charges_touch` BEFORE-UPDATE trigger
 * rewrites `updated_at` on every UPDATE, so a lease-rotation test cannot stage
 * distinct lease ages after the fact — only at INSERT.
 */
async function seedGroupClassCharge(args: {
  cohortId: string;
  dogId: string;
  createdAt: Date;
  updatedAt: Date;
  purpose?: 'group-class' | 'package';
}): Promise<string> {
  const id = randomUUID();
  await db.insert(chargesTable).values({
    id,
    ownerId: FIXTURE_IDS.ownerId,
    stripePaymentIntentId: `pi_seed_${randomUUID().slice(0, 12)}`,
    amountCents: PUPPY_PRICE_PER_DOG_CENTS,
    status: 'requires_payment',
    purpose: args.purpose ?? 'group-class',
    cohortId: args.cohortId,
    dogId: args.dogId,
    createdAt: args.createdAt.toISOString(),
    updatedAt: args.updatedAt.toISOString(),
  });
  return id;
}

test(
  '§9.17 R3 — the worklist rotates by LEASE: three ticks at limit 1 reach three different rows, oldest-lease first',
  SKIP_WHEN_NO_DB,
  async () => {
    // RED against the round-1 build: the same chargeId three times. The claim
    // ordered by `created_at` ASC with no lease, so the oldest row was
    // re-scanned every tick — and a row with no exit state (a `lost-hold`, or
    // another lane's `requires_payment` row) starves every newer stuck capture
    // behind it, silently.
    const cohort = await makeCohort({ classKey: 'puppy', capacity: 6 });
    const dogC = await makeDog('Rotator');
    const now = new Date();
    // Hours, not minutes: every other row in this file was written during this
    // run, so these three are unambiguously the oldest by BOTH keys and the
    // comparison cannot be decided by how long the suite happened to take.
    const hours = (n: number): Date => new Date(now.getTime() - n * 60 * 60 * 1000);
    // `oldestCreated` is the row the OLD ordering always picks; it carries the
    // NEWEST lease of the three, so the new ordering picks it last.
    const oldestCreated = await seedGroupClassCharge({
      cohortId: cohort.id,
      dogId: FIXTURE_IDS.dog1Id,
      createdAt: hours(12),
      updatedAt: hours(4),
    });
    const middleLease = await seedGroupClassCharge({
      cohortId: cohort.id,
      dogId: FIXTURE_IDS.dog2Id,
      createdAt: hours(10),
      updatedAt: hours(5),
    });
    const oldestLease = await seedGroupClassCharge({
      cohortId: cohort.id,
      dogId: dogC,
      createdAt: hours(8),
      updatedAt: hours(6),
    });

    const stripe = makeStripeStub();
    const claimed: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const tick = await runCaptureReconcilerOnce({ stripe, limit: 1, now });
      assert.equal(tick.results.length, 1, `tick ${i} claimed exactly one row`);
      claimed.push(tick.results[0]!.chargeId);
    }
    assert.deepEqual(
      claimed,
      [oldestLease, middleLease, oldestCreated],
      'the lease IS the rotation — every row gets a turn, so no row can starve the queue',
    );
  },
);

test(
  '§9.18 R3 — a row past the 24h abandon window leaves the worklist and is reported ONCE, loudly',
  SKIP_WHEN_NO_DB,
  async () => {
    // RED against the round-1 build: the row was claimed forever (`lost-hold`
    // wrote nothing, so it never left `requires_payment`) and
    // `tick.abandoned` did not exist. §3.7 never specified an exit state.
    const cohort = await makeCohort({ classKey: 'puppy', capacity: 6 });
    const key = `p18-${randomUUID()}`;
    const { app, stripe } = enrollApp();
    stripe.throwOnCapture(2);
    const res = await postPartial({
      app,
      cohortId: cohort.id,
      dogIds: [FIXTURE_IDS.dog1Id],
      idempotencyKey: key,
    });
    assert.equal(res.statusCode, 201, res.body);
    const [row] = await db
      .select({ id: chargesTable.id })
      .from(chargesTable)
      .where(eq(chargesTable.cohortId, cohort.id));
    assert.ok(row?.id);

    // The row has been stuck for a day. `created_at` is writable — only
    // `updated_at` is trigger-owned.
    await db
      .update(chargesTable)
      .set({ createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() })
      .where(eq(chargesTable.id, row.id));

    const errors: string[] = [];
    const log = {
      info: () => undefined,
      warn: () => undefined,
      error: (_obj: Record<string, unknown>, msg?: string) => errors.push(msg ?? ''),
    };
    const first = await runCaptureReconcilerOnce({ stripe, now: new Date(), log });
    assert.equal(
      first.results.some((r) => r.chargeId === row.id),
      false,
      'the abandoned row no longer occupies the worklist’s attention',
    );
    assert.equal(first.abandoned, 1, 'and it is COUNTED, not silently dropped');
    assert.equal(first.abandonedUncollected, 1, 'this one is money we still have not collected');
    assert.equal(
      errors.filter((m) => m.includes('ABANDONED')).length,
      1,
      'a human is told once, in a sentence naming what to do',
    );

    const second = await runCaptureReconcilerOnce({ stripe, now: new Date(), log });
    assert.equal(second.abandoned, 1, 'the standing condition stays visible on the tick result');
    assert.equal(
      errors.filter((m) => m.includes('ABANDONED')).length,
      1,
      'and is NOT re-shouted every tick — that is how the next real incident gets buried',
    );
  },
);

test(
  '§9.19 R6 — no LOST HOLD page when the money for that (cohort, dog) was already collected',
  SKIP_WHEN_NO_DB,
  async () => {
    // RED against the round-1 build: `outcome === 'lost-hold'` plus the ERROR
    // line. `owed` asked "enrolled?" and "no open invoice?" and never asked
    // the money question. Ordinary producer: pay-later enroll → Pay now →
    // 3DS/decline (row written at requires_payment, intent cancelled) → the
    // owner retries on another card and the invoice is paid.
    const cohort = await makeCohort({ classKey: 'puppy', capacity: 6 });
    const key = `p19-${randomUUID()}`;
    const { app, stripe } = enrollApp();
    stripe.throwOnCapture(2);
    const res = await postPartial({
      app,
      cohortId: cohort.id,
      dogIds: [FIXTURE_IDS.dog1Id],
      idempotencyKey: key,
    });
    assert.equal(res.statusCode, 201, res.body);
    const [row] = await db
      .select({ id: chargesTable.id, intentId: chargesTable.stripePaymentIntentId })
      .from(chargesTable)
      .where(eq(chargesTable.cohortId, cohort.id));
    assert.ok(row?.intentId);
    stripe.setIntentState(row.intentId, 'canceled');

    // The money for this (cohort, dog) is in the bank, on another row.
    await db.insert(chargesTable).values({
      id: randomUUID(),
      ownerId: FIXTURE_IDS.ownerId,
      stripePaymentIntentId: `pi_collected_${randomUUID().slice(0, 12)}`,
      amountCents: PUPPY_PRICE_PER_DOG_CENTS,
      status: 'succeeded',
      purpose: 'group-class',
      cohortId: cohort.id,
      dogId: FIXTURE_IDS.dog1Id,
    });

    // Scoped to OUR charge id: earlier tests in this file leave their own
    // stuck rows behind (the fixture hooks are per-file), and a global count
    // would assert something this test does not control.
    const alarms: { chargeId: unknown; msg: string }[] = [];
    const tick = await runCaptureReconcilerOnce({
      stripe,
      now: new Date(Date.now() + (CAPTURE_GRACE_MINUTES + 1) * 60 * 1000),
      log: {
        info: () => undefined,
        warn: () => undefined,
        error: (obj, msg) =>
          alarms.push({ chargeId: (obj as { chargeId?: unknown }).chargeId, msg: msg ?? '' }),
      },
    });
    assert.equal(tick.results.find((r) => r.chargeId === row.id)?.outcome, 'released');
    assert.equal(
      alarms.filter((a) => a.chargeId === row.id && a.msg.includes('LOST HOLD')).length,
      0,
      'firing this alarm for money already in the bank is how it stops being read',
    );
  },
);

test(
  '§9.20 R9 — the claim never touches another purpose’s requires_payment rows',
  SKIP_WHEN_NO_DB,
  async () => {
    // Not red-first: the `purpose = 'group-class'` predicate was already in
    // the round-1 build. This pins it, because R9 is the one addendum item a
    // future widening of the worklist could quietly undo.
    const cohort = await makeCohort({ classKey: 'puppy', capacity: 6 });
    const now = new Date();
    const foreign = await seedGroupClassCharge({
      cohortId: cohort.id,
      dogId: FIXTURE_IDS.dog1Id,
      createdAt: new Date(now.getTime() - 60 * 60 * 1000),
      updatedAt: new Date(now.getTime() - 60 * 60 * 1000),
      purpose: 'package',
    });
    const tick = await runCaptureReconcilerOnce({ stripe: makeStripeStub(), now });
    assert.equal(
      tick.results.some((r) => r.chargeId === foreign),
      false,
      'a package charge is not an enrollment hold and is never claimed as one',
    );
  },
);

test(
  '§9.21 R8 — a post-commit charge-row flip that FAILS never throws; the dog reports pending and keeps its money',
  SKIP_WHEN_NO_DB,
  async () => {
    // RED against the round-1 build: `captureHeldDogs` rejected, which on the
    // route becomes a 500 for an enrollment that COMMITTED and money that
    // MOVED — and mobile's submit catch renders "nothing enrolled, nothing
    // charged", which is false. Driven with a charge id Postgres refuses
    // (`22P02 invalid input syntax for type uuid`) so the failure is a real
    // one raised by the real statement, not a mocked rejection.
    const stripe = makeStripeStub();
    const authorized = await stripe.createAndConfirmPaymentIntent(
      {
        customerId: 'cus_test',
        paymentMethodId: 'pm_test',
        amountCents: PUPPY_PRICE_PER_DOG_CENTS,
        currency: 'usd',
        metadata: {},
        captureMethod: 'manual',
      },
      `p21-${randomUUID()}:dog:${FIXTURE_IDS.dog1Id}`,
    );
    assert.equal(authorized.status, 'requires_capture');

    const errors: string[] = [];
    const outcomes = await captureHeldDogs({
      stripe,
      actor: `owner:${FIXTURE_IDS.ownerId}`,
      holds: [
        {
          dogId: FIXTURE_IDS.dog1Id,
          intentId: authorized.id,
          amountCents: authorized.amountCents,
          state: 'held',
          createdByThisRequest: true,
        },
      ],
      chargeIdByDog: new Map([[FIXTURE_IDS.dog1Id, 'not-a-uuid']]),
      idempotencyKey: `p21-${randomUUID()}`,
      log: { error: (_obj, msg) => errors.push(msg ?? '') },
    });

    assert.equal(captures(stripe).length, 1, 'the capture itself succeeded — money moved');
    assert.equal(outcomes.length, 1);
    assert.equal(
      outcomes[0]?.state,
      'pending',
      'the honest report for money whose row we could not write is pending, never paid',
    );
    assert.equal(outcomes[0]?.capturedCents, 0, 'and it contributes nothing to the captured total');
    assert.ok(
      errors.some((m) => m.includes('charge row')),
      'the failure reaches a log line the reconciler’s alarm can be correlated with',
    );
    const live = await stripe.retrievePaymentIntent(authorized.id);
    assert.equal(live.status, 'succeeded', 'the money really is captured at Stripe');
  },
);

// ── §9.22 R8, second statement (round-2 panel, 2026-08-20) ────────────────

/**
 * A jsonb value Postgres genuinely refuses. `response_body` is `jsonb`
 * (`schema.sql:1469`) and jsonb cannot hold a NUL codepoint inside a string:
 * the server answers `22P05 unsupported Unicode escape sequence`. Same
 * technique as §9.21's invalid uuid — a real fault raised by the REAL
 * statement, never a mocked rejection — chosen here because the amend's only
 * typed column is the body.
 */
const POSTGRES_REFUSES = { poisoned: `a${String.fromCharCode(0)}b` };

test(
  '§9.22 R8 — the post-capture amend of the stored response cannot throw: the raw statement DOES, the guarded one reports it',
  SKIP_WHEN_NO_DB,
  async () => {
    // The defect: `updateStoredResponse` was called bare at
    // `routes/enrollments.ts`, post-commit and post-CAPTURE, with nothing
    // between it and the route's `catch` — which on `committed === true`
    // resolves the registry and RETHROWS. A DB fault on that one statement
    // therefore answered a committed enrollment holding captured money with a
    // 500, and mobile's submit catch renders a thrown enroll as "nothing
    // enrolled, nothing charged" — false in both halves. It also defeated R8
    // in the case R8 is FOR: a persistent fault fails the charge-row flip,
    // `captureHeldDogs` downgrades the dogs to `pending` and returns, and then
    // the amend carrying that downgraded envelope hit the same fault and 500'd
    // anyway.
    //
    // DISCLOSED (round-2 builder): there is no honest ROUTE-level red for
    // this. Every string in the stored envelope is DB-sourced, and a Postgres
    // text column cannot hold the codepoint jsonb refuses, so no request-shaped
    // input can poison the body the route stores. What is pinned instead is
    // the seam: the real statement throws, the guard the route now calls does
    // not, and the route no longer imports the raw one.
    const key = `p22-${randomUUID()}`;
    const endpoint = 'POST /enrollments';
    const requestHash = 'p22-hash';
    await db.insert(idempotencyKeysTable).values({
      key,
      ownerId: FIXTURE_IDS.ownerId,
      endpoint,
      requestHash,
      responseStatus: 201,
      responseBody: { total_captured_cents: 0 },
      completedAt: new Date().toISOString(),
    });

    try {
      // 1. RED, on the landed line: this is the call the route used to make.
      await assert.rejects(
        () => updateStoredResponse({ key, endpoint, requestHash, body: POSTGRES_REFUSES }),
        (err: unknown) => {
          assert.equal(
            (err as { code?: string }).code,
            '22P05',
            'Postgres itself refused the value — the fault is real, not simulated',
          );
          return true;
        },
        'the bare statement the route used to call post-commit really does throw',
      );

      // 2. GREEN: identical arguments through the guard the route calls now.
      const errors: { obj: Record<string, unknown>; msg: string }[] = [];
      const warns: string[] = [];
      const log = {
        warn: (_obj: Record<string, unknown>, msg?: string) => warns.push(msg ?? ''),
        error: (obj: Record<string, unknown>, msg?: string) => errors.push({ obj, msg: msg ?? '' }),
      };
      const failed = await amendStoredEnvelopeAfterCapture({
        key,
        endpoint,
        requestHash,
        body: POSTGRES_REFUSES,
        logContext: { idempotencyKey: key },
        log,
      });
      assert.equal(failed, 'failed', 'the failure is REPORTED, not raised');
      assert.equal(errors.length, 1, 'and it is loud — a human can find it');
      assert.ok(
        errors[0]?.msg.includes('CAPTURED'),
        'the log line says the money moved, which is the fact a reader needs',
      );
      assert.ok(errors[0]?.obj.err !== undefined, 'and carries the underlying error');

      // 3. The ordinary amend still amends, and really writes.
      const amended = await amendStoredEnvelopeAfterCapture({
        key,
        endpoint,
        requestHash,
        body: { total_captured_cents: PUPPY_PRICE_PER_DOG_CENTS },
        logContext: { idempotencyKey: key },
        log,
      });
      assert.equal(amended, 'amended');
      const [stored] = await db
        .select({ body: idempotencyKeysTable.responseBody })
        .from(idempotencyKeysTable)
        .where(eq(idempotencyKeysTable.key, key));
      assert.deepEqual(
        stored?.body,
        { total_captured_cents: PUPPY_PRICE_PER_DOG_CENTS },
        'the guard did not turn the amend into a no-op',
      );

      // 4. A no-match is still distinguishable from a fault, and still warns.
      const missing = await amendStoredEnvelopeAfterCapture({
        key,
        endpoint,
        requestHash: 'a-different-hash',
        body: { total_captured_cents: 1 },
        logContext: { idempotencyKey: key },
        log,
      });
      assert.equal(missing, 'not-found');
      assert.equal(warns.length, 1, 'the pre-existing warn is unchanged');
      assert.equal(errors.length, 1, 'and a no-match is not escalated to an alarm');
    } finally {
      await db.delete(idempotencyKeysTable).where(eq(idempotencyKeysTable.key, key));
    }
  },
);

test(
  '§9.22b the amend still lands end-to-end: a same-key replay after capture reads post-capture money truth',
  SKIP_WHEN_NO_DB,
  async () => {
    // The guard must not have quietly turned the amend off. Not red-first —
    // this pins the behavior the wrap could regress, since the transaction
    // stores `pending` / `0` and only the post-commit amend makes the stored
    // body agree with the charge rows.
    const cohort = await makeCohort({ classKey: 'puppy', capacity: 6 });
    const key = `p22b-${randomUUID()}`;
    const { app } = enrollApp();

    const first = await postPartial({
      app,
      cohortId: cohort.id,
      dogIds: [FIXTURE_IDS.dog1Id],
      idempotencyKey: key,
    });
    assert.equal(first.statusCode, 201, first.body);
    assert.equal((first.json() as Envelope).total_captured_cents, PUPPY_PRICE_PER_DOG_CENTS);

    const replay = await postPartial({
      app,
      cohortId: cohort.id,
      dogIds: [FIXTURE_IDS.dog1Id],
      idempotencyKey: key,
    });
    assert.equal(replay.statusCode, 201, replay.body);
    const body = replay.json() as Envelope;
    assert.equal(
      body.total_captured_cents,
      PUPPY_PRICE_PER_DOG_CENTS,
      'the replay reads the AMENDED body, not the pre-capture snapshot',
    );
    assert.equal(body.results[0]?.payment_state, 'paid');
  },
);

// ── §9.23 the abandon report's growth re-alarm (round-2 panel, 2026-08-20) ─

/** ERROR lines from one tick, INFO lines that are about GROWTH rather than the
 *  per-tick summary, and a reset so each step measures only its own tick. */
function abandonAlarmRecorder(): {
  log: {
    info: (o: Record<string, unknown>, m?: string) => void;
    warn: () => void;
    error: (o: Record<string, unknown>, m?: string) => void;
  };
  errors: string[];
  growthInfos: Record<string, unknown>[];
  reset: () => void;
} {
  const errors: string[] = [];
  const growthInfos: Record<string, unknown>[] = [];
  return {
    errors,
    growthInfos,
    reset: () => {
      errors.length = 0;
      growthInfos.length = 0;
    },
    log: {
      info: (obj, msg) => {
        // The per-tick summary is INFO too; only the growth line is a report.
        if ((msg ?? '').includes('grew')) growthInfos.push(obj);
      },
      warn: () => undefined,
      error: (_obj, msg) => errors.push(msg ?? ''),
    },
  };
}

test(
  '§9.23 — aged BOOKKEEPING rows never page a human, however many arrive; growth with no money in it is INFO',
  SKIP_WHEN_NO_DB,
  async () => {
    // RED against the round-1-fixed build, and proved executably by the
    // round-2 panel first: the growth re-alarm compared the LANE-AGNOSTIC
    // total against a high-water seeded from the same total, while the rows
    // it names are only ever the UNCOLLECTED ones. So a population with zero
    // uncollected money fired
    //   "MORE ABANDONED ENROLLMENT HOLDS than this process has named…"
    // — a false sentence — and every further aged bookkeeping row bought
    // another ERROR. The ordinary producer of those rows is documented at
    // `chargesRepository.ts:290-296`: `POST /invoices/:id/pay` writes a
    // group-class `requires_payment` row on an automatic-capture intent it
    // then cancels, and that row is bookkeeping for the rest of its life.
    const cohort = await makeCohort({ classKey: 'puppy', capacity: 6 });
    const stripe = makeStripeStub();
    const rec = abandonAlarmRecorder();
    const aged = (): Date => new Date(Date.now() - 25 * 60 * 60 * 1000);

    // Baseline tick. Earlier tests in this file leave their own abandoned rows
    // and their own entries in this process's alarm memory; this settles them
    // so every count below is a DELTA this test produced.
    const base = await runCaptureReconcilerOnce({ stripe, now: new Date(), log: rec.log });
    rec.reset();

    // Three aged group-class holds for dogs that were never seated. No live
    // booking → `enrollmentStillOwesMoney` is false → pure bookkeeping.
    for (const name of ['Bookkeeping A', 'Bookkeeping B', 'Bookkeeping C']) {
      const dogId = await makeDog(name);
      await seedGroupClassCharge({
        cohortId: cohort.id,
        dogId,
        createdAt: aged(),
        updatedAt: aged(),
      });
    }

    const tick1 = await runCaptureReconcilerOnce({ stripe, now: new Date(), log: rec.log });
    assert.equal(
      tick1.abandoned,
      base.abandoned + 3,
      'the three rows are counted as abandoned — the population really did grow',
    );
    assert.equal(
      tick1.abandonedUncollected,
      base.abandonedUncollected,
      'and NONE of the growth is money: not one of them owes anything',
    );
    assert.equal(
      rec.errors.filter((m) => m.includes('ABANDONED')).length,
      0,
      'a growth made entirely of bookkeeping rows must not spend the alarm that means "go and collect money"',
    );
    assert.equal(rec.growthInfos.length, 1, 'it is reported once, at INFO');
    assert.equal(rec.growthInfos[0]?.newlyAbandonedCount, 3);

    // A second tick with nothing changed says nothing at all.
    rec.reset();
    await runCaptureReconcilerOnce({ stripe, now: new Date(), log: rec.log });
    assert.equal(rec.errors.filter((m) => m.includes('ABANDONED')).length, 0);
    assert.equal(rec.growthInfos.length, 0, 'a standing population is not re-announced every tick');

    // One MORE bookkeeping row — the arm that used to buy an extra ERROR each
    // time — is one more INFO and still no page.
    rec.reset();
    const extraDog = await makeDog('Bookkeeping D');
    await seedGroupClassCharge({
      cohortId: cohort.id,
      dogId: extraDog,
      createdAt: aged(),
      updatedAt: aged(),
    });
    const tick3 = await runCaptureReconcilerOnce({ stripe, now: new Date(), log: rec.log });
    assert.equal(tick3.abandoned, base.abandoned + 4);
    assert.equal(
      rec.errors.filter((m) => m.includes('ABANDONED')).length,
      0,
      'and it never becomes an ERROR by accumulation either',
    );
    assert.equal(rec.growthInfos.length, 1);
    assert.equal(rec.growthInfos[0]?.newlyAbandonedCount, 1);
  },
);

test(
  '§9.23b — a genuinely UNCOLLECTED abandoned hold still pages a human, loudly and once',
  SKIP_WHEN_NO_DB,
  async () => {
    // The other half of the fix: quieting the false alarm must not quiet the
    // true one. This is the §9.18 condition arriving into a process whose
    // abandoned population is already full of bookkeeping rows the tick before
    // it — the exact situation the old high-water made indistinguishable.
    const cohort = await makeCohort({ classKey: 'puppy', capacity: 6 });
    const key = `p23b-${randomUUID()}`;
    const { app, stripe } = enrollApp();
    stripe.throwOnCapture(2);
    const res = await postPartial({
      app,
      cohortId: cohort.id,
      dogIds: [FIXTURE_IDS.dog1Id],
      idempotencyKey: key,
    });
    assert.equal(res.statusCode, 201, res.body);
    const [row] = await db
      .select({ id: chargesTable.id })
      .from(chargesTable)
      .where(eq(chargesTable.cohortId, cohort.id));
    assert.ok(row?.id);

    const rec = abandonAlarmRecorder();
    const base = await runCaptureReconcilerOnce({ stripe, now: new Date(), log: rec.log });
    rec.reset();

    // The dog is enrolled, no invoice covers it, no succeeded charge covers
    // it — and the hold has resisted capture for a day.
    await db
      .update(chargesTable)
      .set({ createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() })
      .where(eq(chargesTable.id, row.id));

    const tick = await runCaptureReconcilerOnce({ stripe, now: new Date(), log: rec.log });
    assert.equal(
      tick.abandonedUncollected,
      base.abandonedUncollected + 1,
      'this one IS money we have not collected',
    );
    assert.equal(
      rec.errors.filter((m) => m.includes('ABANDONED')).length,
      1,
      'and a human is paged for it — the quiet arm above did not swallow the loud one',
    );
    assert.equal(rec.growthInfos.length, 0, 'money growth is not demoted to INFO');

    rec.reset();
    await runCaptureReconcilerOnce({ stripe, now: new Date(), log: rec.log });
    assert.equal(
      rec.errors.filter((m) => m.includes('ABANDONED')).length,
      0,
      'once, not once a minute',
    );
  },
);

// ── §9.24 the enrollment ANCHOR (ADDENDUM 3 §A3.17, 2026-08-22) ────────────

/**
 * `charges.booking_id` on a group-class charge is the enrollment's ANCHOR: the
 * earliest-scheduled booking row minted in the same tx/savepoint. It is what
 * lets every money read tell THIS enrollment's charge from a previous one's —
 * a withdraw + re-enroll mints a second enrollment under the same
 * (cohort, dog), and before §A3.17 every consumer answered for whichever one it
 * happened to reach. The behavioral consequences live in
 * `enrollment-paid-predicate.test.ts`; these three pin the STAMP itself, which
 * is the input all of them share.
 *
 * RED against the round-1..4 build: both mint sites wrote NULL.
 */

/** The dog's booking rows in this cohort, earliest session first. */
async function sessionRowsFor(
  cohortId: string,
  dogId: string,
): Promise<{ id: string; scheduledAt: string }[]> {
  return db
    .select({ id: bookingsTable.id, scheduledAt: bookingsTable.scheduledAt })
    .from(bookingsTable)
    .where(and(eq(bookingsTable.cohortId, cohortId), eq(bookingsTable.leadDogId, dogId)))
    .orderBy(asc(bookingsTable.scheduledAt));
}

test(
  '§9.24a the ALL-OR-NOTHING enroll stamps each charge with that dog’s FIRST session row',
  SKIP_WHEN_NO_DB,
  async () => {
    const cohort = await makeCohort({ classKey: 'puppy', capacity: 6, weeks: 4 });
    const { app } = enrollApp();
    const res = await postPartial({
      app,
      cohortId: cohort.id,
      dogIds: [FIXTURE_IDS.dog1Id, FIXTURE_IDS.dog2Id],
      idempotencyKey: `p24a-${randomUUID()}`,
      allowPartial: false,
    });
    assert.equal(res.statusCode, 201, res.body);

    for (const dogId of [FIXTURE_IDS.dog1Id, FIXTURE_IDS.dog2Id]) {
      const sessions = await sessionRowsFor(cohort.id, dogId);
      assert.equal(sessions.length, 4, 'four weekly rows, one enrollment');
      const [charge] = await db
        .select({ id: chargesTable.id, bookingId: chargesTable.bookingId })
        .from(chargesTable)
        .where(and(eq(chargesTable.cohortId, cohort.id), eq(chargesTable.dogId, dogId)));
      assert.ok(charge, 'the dog has a charge row');
      assert.equal(
        charge.bookingId,
        sessions[0]!.id,
        'the anchor is the EARLIEST-scheduled row this tx inserted for THIS dog',
      );
    }
  },
);

test(
  '§9.24b the PARTIAL (savepoint) enroll stamps the same anchor, per dog, inside each savepoint',
  SKIP_WHEN_NO_DB,
  async () => {
    const cohort = await makeCohort({ classKey: 'puppy', capacity: 6, weeks: 4 });
    const { app } = enrollApp();
    const res = await postPartial({
      app,
      cohortId: cohort.id,
      dogIds: [FIXTURE_IDS.dog1Id, FIXTURE_IDS.dog2Id],
      idempotencyKey: `p24b-${randomUUID()}`,
    });
    assert.equal(res.statusCode, 201, res.body);

    for (const dogId of [FIXTURE_IDS.dog1Id, FIXTURE_IDS.dog2Id]) {
      const sessions = await sessionRowsFor(cohort.id, dogId);
      const [charge] = await db
        .select({ bookingId: chargesTable.bookingId })
        .from(chargesTable)
        .where(and(eq(chargesTable.cohortId, cohort.id), eq(chargesTable.dogId, dogId)));
      assert.equal(charge?.bookingId, sessions[0]!.id);
      // The negative that makes it an identity rather than a coincidence: the
      // OTHER dog's rows are never this dog's anchor.
      const otherDog = dogId === FIXTURE_IDS.dog1Id ? FIXTURE_IDS.dog2Id : FIXTURE_IDS.dog1Id;
      const otherIds = (await sessionRowsFor(cohort.id, otherDog)).map((s) => s.id);
      assert.equal(otherIds.includes(charge!.bookingId as string), false);
    }
  },
);

test(
  '§9.24c the INVOICE carries its OWN enrollment’s anchor, and every invoice-lane charge copies it',
  SKIP_WHEN_NO_DB,
  async () => {
    // **This test's premise was REVERSED by ADDENDUM 3 §A3.18 D1.** §A3.17
    // ruled that invoices themselves stay unstamped and the charge would
    // RESOLVE its anchor from the live set at settle time. The adversary
    // executed the cost: the webhook settle lane deliberately settles VOIDED
    // invoices, so a settle landing after a withdraw + re-enroll filed the OLD
    // enrollment's money under the NEW one — and stamping NULL instead was no
    // better, because a late settle post-dates the new enrollment's birth and
    // the legacy time rule then claims it by construction.
    //
    // So the invoice learns its own enrollment at MINT time, inside the enroll
    // tx that created those bookings, and the charge simply COPIES it. The
    // asserted direction below is the exact inverse of what this test asserted
    // when it was written, which is the honest way to record a reversal.
    const cohort = await makeCohort({ classKey: 'puppy', capacity: 6, weeks: 4 });
    const { app } = enrollApp();
    const res = await postPartial({
      app,
      cohortId: cohort.id,
      dogIds: [FIXTURE_IDS.dog1Id],
      idempotencyKey: `p24c-${randomUUID()}`,
      payLater: true,
    });
    assert.equal(res.statusCode, 201, res.body);
    const sessions = await sessionRowsFor(cohort.id, FIXTURE_IDS.dog1Id);

    // The enrollment is GONE before the settle lands — the R11 worker/withdraw
    // race, and the shape the webhook's void-settle arm exists for. The anchor
    // must NOT follow the world; it must name the enrollment this money was for.
    await db
      .update(bookingsTable)
      .set({ status: 'cancelled' })
      .where(eq(bookingsTable.cohortId, cohort.id));

    const settled = await withActor(`owner:${FIXTURE_IDS.ownerId}`, async (tx) => {
      const [invoiceRow] = await db
        .select({ id: invoicesTable.id, bookingId: invoicesTable.bookingId })
        .from(invoicesTable)
        .where(eq(invoicesTable.cohortId, cohort.id));
      assert.ok(invoiceRow, 'the pay-later enroll wrote an invoice');
      assert.equal(
        invoiceRow.bookingId,
        sessions[0]!.id,
        'the INVOICE is stamped with its own enrollment’s anchor (§A3.18 D1)',
      );
      const invoice = await invoicesRepository.findById(tx, invoiceRow.id);
      assert.ok(invoice);
      return settleInvoiceCharge(tx, {
        invoice,
        paymentIntentId: `pi_paylater_${randomUUID().slice(0, 12)}`,
        amountCents: PUPPY_PRICE_PER_DOG_CENTS,
        purpose: 'group-class',
        notifyOwner: false,
      });
    });
    const [paid] = await db
      .select({ bookingId: chargesTable.bookingId })
      .from(chargesTable)
      .where(eq(chargesTable.id, settled.chargeId));
    assert.equal(
      paid?.bookingId,
      sessions[0]!.id,
      'the charge copies it — a CANCELLED anchor, which is exactly right: this money belongs to the enrollment that no longer exists',
    );

    // **An unstamped invoice is no longer a silent NULL (§A3.19 F2 re-pin.)**
    // This invoice is minted by its own transaction with no bookings written in
    // it, so the same-transaction witness finds nothing — the fallback's
    // FAILURE arm — and that is the only remaining way a post-deploy
    // group-class charge is minted unanchored. It mints NULL, over the legacy
    // time rule as the net, and WARNs naming the invoice so a human can find it.
    const warns: { obj: Record<string, unknown>; msg: string }[] = [];
    const legacy = await withActor(`owner:${FIXTURE_IDS.ownerId}`, async (tx) => {
      const invoice = await invoicesRepository.createOpen(tx, {
        ownerId: FIXTURE_IDS.ownerId,
        amountCents: PUPPY_PRICE_PER_DOG_CENTS,
        purpose: 'group-class',
        paymentMethodId: FIXTURE_IDS.paymentMethod1Id,
        dueAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
        cohortId: cohort.id,
        dogId: FIXTURE_IDS.dog1Id,
      });
      assert.equal(invoice.bookingId, null);
      return settleInvoiceCharge(tx, {
        invoice,
        paymentIntentId: `pi_legacy_${randomUUID().slice(0, 12)}`,
        amountCents: PUPPY_PRICE_PER_DOG_CENTS,
        purpose: 'group-class',
        notifyOwner: false,
        log: { warn: (obj, msg) => warns.push({ obj, msg }) },
      });
    });
    const [legacyCharge] = await db
      .select({ bookingId: chargesTable.bookingId })
      .from(chargesTable)
      .where(eq(chargesTable.id, legacy.chargeId));
    assert.equal(
      legacyCharge?.bookingId,
      null,
      'no witness, so nothing is claimed — the legacy time rule is the net',
    );
    assert.ok(
      warns.some((w) => w.obj.invoiceId !== undefined && /anchor/i.test(w.msg)),
      'and the mint is not silent: the WARN names the invoice',
    );
  },
);
