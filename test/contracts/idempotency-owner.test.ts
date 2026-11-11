import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, test } from 'node:test';
import { eq, inArray, isNotNull, like, sql } from 'drizzle-orm';
import type { Principal } from '../../src/auth/principal.js';
import { db } from '../../src/db/client.js';
import {
  claimIdempotencyKey,
  peekCompletedIdempotency,
  type IdempotencyClaim,
} from '../../src/db/idempotency.js';
import { invoicesRepository } from '../../src/db/repositories/invoicesRepository.js';
import {
  charges,
  creditLedger,
  dogs,
  idempotencyKeys,
  invoices,
  orders,
  owners,
  scheduledNotifications,
} from '../../src/db/schema/schema.js';
import { withActor } from '../../src/db/tx.js';
import { ApiError } from '../../src/lib/errors.js';
import { registerCreditPackagesRoute } from '../../src/routes/creditPackages.js';
import { registerDogsRoute } from '../../src/routes/dogs.js';
import { registerInvoicesRoute } from '../../src/routes/invoices.js';
import { registerStaffSettingsRoute } from '../../src/routes/staffSettings.js';
import { clearInvoiceReferrers, FIXTURE_IDS, FIXTURE_NOW } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_OWNER_ROLE_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';
import { clearOrderRows } from './_orderFixture.js';
import { makeStripeStub } from './_stripeStub.js';

/**
 * An Idempotency-Key is the principal's who made it (P19 fix 1 F1; Fable L2 = Opus L1, P15
 * Opus L7's class). Another household presenting a key it did not make, with the very
 * body the first sent, is told `idempotency_mismatch` and reads nothing of the first
 * answer: not on the order engine's claim, not on `withMutation`'s, and not on the peek
 * a route runs before either. Staff claims carry no owner (`idempotency_keys.owner_id`
 * NULL), so a staff route's key keeps replaying for staff.
 */

registerFixtureHooks();

const OWNER = FIXTURE_IDS.ownerId;
const REGULAR = 'school-2x-weekly-fayetteville';
const plantedOwners: string[] = [];

afterEach(async () => {
  await db.delete(creditLedger).where(isNotNull(creditLedger.chargeId));
  await clearOrderRows();
  await db.delete(orders).where(eq(orders.ownerId, OWNER));
  await db.delete(scheduledNotifications).where(eq(scheduledNotifications.ownerId, OWNER));
  await clearInvoiceReferrers();
  await db.delete(invoices).where(eq(invoices.ownerId, OWNER));
  await db.delete(idempotencyKeys).where(like(idempotencyKeys.key, 'idem-owner-%'));
  if (plantedOwners.length > 0) {
    await db.delete(owners).where(inArray(owners.id, plantedOwners.splice(0)));
  }
});

type OwnerPrincipal = Extract<Principal, { kind: 'owner' }>;

/** A second household. It holds no card, so nothing it sends can reach Stripe. */
async function plantOwner(): Promise<OwnerPrincipal> {
  const id = randomUUID();
  const supabaseUid = randomUUID();
  plantedOwners.push(id);
  await db.insert(owners).values({
    id,
    supabaseUid,
    name: 'Another Household',
    email: `idem-${id.slice(0, 8)}@example.com`,
  });
  return { kind: 'owner', ownerId: id, supabaseUid };
}

function purchaseApp(principal: Principal = FIXTURE_OWNER_PRINCIPAL) {
  const { app, authenticate } = makeContractApp(principal);
  const stripe = makeStripeStub();
  registerCreditPackagesRoute(app, { authenticate, stripe, now: FIXTURE_NOW });
  return { app, stripe };
}

/** A's body, byte for byte: her own card. */
function buy(world: ReturnType<typeof purchaseApp>, key: string) {
  return world.app.inject({
    method: 'POST',
    url: `/credit-packages/${REGULAR}/purchase`,
    headers: { 'idempotency-key': key },
    payload: { payment_method_id: FIXTURE_IDS.paymentMethod1Id },
  });
}

function assertMismatch(res: { statusCode: number; body: string }): void {
  assert.equal(res.statusCode, 422, res.body);
  const { error } = JSON.parse(res.body) as { error: Record<string, unknown> };
  assert.equal(error['code'], 'idempotency_mismatch');
  assert.equal('details' in error, false, 'no details');
}

async function countFor(ownerId: string) {
  const n = async (q: Promise<unknown[]>) => (await q).length;
  return {
    orders: await n(db.select({ id: orders.id }).from(orders).where(eq(orders.ownerId, ownerId))),
    charges: await n(
      db.select({ id: charges.id }).from(charges).where(eq(charges.ownerId, ownerId)),
    ),
    ledger: await n(
      db
        .select({ id: creditLedger.id })
        .from(creditLedger)
        .where(eq(creditLedger.ownerId, ownerId)),
    ),
  };
}

// ── the order engine's claim (Opus p6, Fable P1) ─────────────────────────────

test(
  "POST /credit-packages/:key/purchase: another household re-sending a completed key with the first's exact body is 422 idempotency_mismatch, and nothing of the first answer reaches it",
  SKIP_WHEN_NO_DB,
  async () => {
    const key = `idem-owner-p6-${randomUUID()}`;
    const first = await buy(purchaseApp(), key);
    assert.equal(first.statusCode, 201, first.body);
    const stored = first.json() as Record<string, unknown>;

    const householdB = await plantOwner();
    const b = purchaseApp(householdB);
    const second = await buy(b, key);

    assertMismatch(second);
    for (const field of ['charge_id', 'stripe_payment_intent_id', 'client_secret']) {
      assert.equal(
        second.body.includes(String(stored[field])),
        false,
        `B never reads A's ${field}`,
      );
    }
    assert.deepEqual(await countFor(householdB.ownerId), { orders: 0, charges: 0, ledger: 0 });
    assert.equal(b.stripe.calls.length, 0, "B's Stripe stub saw no call");
  },
);

test(
  'the household that made the key still replays its stored 201 under it, byte for byte',
  SKIP_WHEN_NO_DB,
  async () => {
    const world = purchaseApp();
    const key = `idem-owner-replay-${randomUUID()}`;
    const first = await buy(world, key);
    assert.equal(first.statusCode, 201, first.body);
    const again = await buy(world, key);
    assert.equal(again.statusCode, 201, again.body);
    assert.equal(again.body, first.body);
    const creates = world.stripe.calls.filter((c) => c.method === 'createUnconfirmedPaymentIntent');
    assert.equal(creates.length, 1, 'the replay tried no card');
  },
);

test(
  'an open claim answers 409 idempotency_inflight to the household that holds it, and 422 idempotency_mismatch to another',
  SKIP_WHEN_NO_DB,
  async () => {
    const world = purchaseApp();
    world.stripe.setNextIntentStatus('processing');
    const key = `idem-owner-open-${randomUUID()}`;
    const first = await buy(world, key);
    assert.equal(first.statusCode, 201, first.body);
    assert.equal((first.json() as { charge_blocker?: string }).charge_blocker, 'processing');

    const own = await buy(world, key);
    assert.equal(own.statusCode, 409, own.body);
    assert.equal((own.json() as { error: { code: string } }).error.code, 'idempotency_inflight');

    assertMismatch(await buy(purchaseApp(await plantOwner()), key));
  },
);

// ── withMutation's claim ─────────────────────────────────────────────────────

test(
  "PATCH /dogs/:id (withMutation): another household re-sending a completed key is 422, and never reads the first household's dog",
  SKIP_WHEN_NO_DB,
  async () => {
    const patchAs = (principal: Principal, key: string) => {
      const { app, authenticate } = makeContractApp(principal);
      registerDogsRoute(app, { authenticate });
      return app.inject({
        method: 'PATCH',
        url: `/dogs/${FIXTURE_IDS.dog1Id}`,
        headers: { 'idempotency-key': key },
        payload: { special_notes: 'Idempotency probe note' },
      });
    };
    const [before] = await db
      .select({ specialNotes: dogs.specialNotes })
      .from(dogs)
      .where(eq(dogs.id, FIXTURE_IDS.dog1Id));
    assert.ok(before, "the fixture's Waffles");
    const key = `idem-owner-dog-${randomUUID()}`;
    try {
      const first = await patchAs(FIXTURE_OWNER_PRINCIPAL, key);
      assert.equal(first.statusCode, 200, first.body);

      const second = await patchAs(await plantOwner(), key);
      assertMismatch(second);
      assert.equal(second.body.includes('Waffles'), false, "B never reads A's dog");

      const own = await patchAs(FIXTURE_OWNER_PRINCIPAL, key);
      assert.equal(own.statusCode, 200, own.body);
      // A stored answer is jsonb, so a replay is the same value with its keys reordered.
      assert.deepEqual(own.json(), first.json(), 'her own replay is her stored answer');
    } finally {
      await db
        .update(dogs)
        .set({ specialNotes: before.specialNotes })
        .where(eq(dogs.id, FIXTURE_IDS.dog1Id));
    }
  },
);

// ── the peek a route runs before any claim ───────────────────────────────────

test(
  "POST /invoices/:id/pay-in-person (it peeks before its claim): another household re-sending a completed key is 422, never the first's 204",
  SKIP_WHEN_NO_DB,
  async () => {
    const invoice = await db.transaction((tx) =>
      invoicesRepository.createOpen(tx, {
        ownerId: OWNER,
        amountCents: 12_000,
        purpose: 'board-train',
        paymentMethodId: FIXTURE_IDS.paymentMethod1Id,
        dueAt: '2026-06-15T00:00:00Z',
        bookingId: null,
      }),
    );
    const flag = (principal: Principal, key: string) => {
      const { app, authenticate } = makeContractApp(principal);
      registerInvoicesRoute(app, { authenticate, stripe: makeStripeStub() });
      return app.inject({
        method: 'POST',
        url: `/invoices/${invoice.id}/pay-in-person`,
        headers: { 'idempotency-key': key },
        payload: {},
      });
    };
    const key = `idem-owner-inperson-${randomUUID()}`;
    const first = await flag(FIXTURE_OWNER_PRINCIPAL, key);
    assert.equal(first.statusCode, 204, first.body);

    assertMismatch(await flag(await plantOwner(), key));
    assert.equal((await flag(FIXTURE_OWNER_PRINCIPAL, key)).statusCode, 204, 'hers replays');
  },
);

// ── staff keys: no owner, and they keep working ──────────────────────────────

test(
  'a staff route keeps its keys: owner_id stays NULL, and the same key replays its stored 200 for staff',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_ROLE_PRINCIPAL);
    registerStaffSettingsRoute(app, { authenticate });
    const key = `idem-owner-staff-${randomUUID()}`;
    const send = () =>
      app.inject({
        method: 'PATCH',
        url: '/staff/settings/cred',
        headers: { 'idempotency-key': key },
        payload: { single_day_purchase_max_count: 29 },
      });
    try {
      const first = await send();
      assert.equal(first.statusCode, 200, first.body);
      const [row] = await db
        .select({ ownerId: idempotencyKeys.ownerId })
        .from(idempotencyKeys)
        .where(eq(idempotencyKeys.key, key));
      assert.deepEqual(row, { ownerId: null }, 'a staff claim names no owner');
      const again = await send();
      assert.equal(again.statusCode, 200, again.body);
      // The stored jsonb, so the same value (its `updated_at` included) with keys reordered.
      assert.deepEqual(again.json(), first.json());
    } finally {
      await db.execute(sql`UPDATE credit_settings SET single_day_purchase_max_count = 30`);
    }
  },
);

/** One completed claim, written as the given. */
async function completedClaim(claim: IdempotencyClaim): Promise<void> {
  await withActor('system:idempotency-test', async (tx) => {
    const result = await claimIdempotencyKey(tx, claim);
    assert.equal(result.won, true);
    await tx
      .update(idempotencyKeys)
      .set({ responseStatus: 200, responseBody: { ok: true }, completedAt: sql`now()` })
      .where(eq(idempotencyKeys.key, claim.key));
  });
}

async function mismatchOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (err) {
    return err instanceof ApiError ? err.code : String(err);
  }
}

test(
  'claimIdempotencyKey and peekCompletedIdempotency: a key answers only the principal that made it, staff (NULL) included',
  SKIP_WHEN_NO_DB,
  async () => {
    const householdB = await plantOwner();
    const endpoint = 'PATCH /test/idempotency-owner';
    const requestHash = 'h';
    const claimFor = (key: string, ownerId: string | null): IdempotencyClaim => ({
      key,
      ownerId,
      endpoint,
      requestHash,
    });
    const claimAs = (key: string, ownerId: string | null) =>
      withActor('system:idempotency-test', (tx) => claimIdempotencyKey(tx, claimFor(key, ownerId)));

    const ownersKey = `idem-owner-unit-a-${randomUUID()}`;
    await completedClaim(claimFor(ownersKey, OWNER));
    assert.equal(
      await mismatchOf(() => claimAs(ownersKey, householdB.ownerId)),
      'idempotency_mismatch',
    );
    assert.equal(await mismatchOf(() => claimAs(ownersKey, null)), 'idempotency_mismatch');
    assert.equal(
      await mismatchOf(() =>
        peekCompletedIdempotency(ownersKey, endpoint, requestHash, householdB.ownerId),
      ),
      'idempotency_mismatch',
    );
    const hers = await claimAs(ownersKey, OWNER);
    assert.equal(hers.won, false);
    assert.deepEqual(hers.won ? undefined : hers.stored, {
      status: 200,
      body: { ok: true },
      replayed: true,
    });

    const staffKey = `idem-owner-unit-staff-${randomUUID()}`;
    await completedClaim(claimFor(staffKey, null));
    assert.equal(await mismatchOf(() => claimAs(staffKey, OWNER)), 'idempotency_mismatch');
    const staffs = await claimAs(staffKey, null);
    assert.equal(staffs.won, false, 'a staff key still replays for staff');
    assert.deepEqual(await peekCompletedIdempotency(staffKey, endpoint, requestHash, null), {
      status: 200,
      body: { ok: true },
      replayed: true,
    });
    assert.equal(
      await mismatchOf(() => peekCompletedIdempotency(staffKey, endpoint, requestHash, OWNER)),
      'idempotency_mismatch',
    );
  },
);
