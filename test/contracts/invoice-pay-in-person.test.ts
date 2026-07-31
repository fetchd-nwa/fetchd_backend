import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { invoicesRepository } from '../../src/db/repositories/invoicesRepository.js';
import { scheduledNotificationsRepository } from '../../src/db/repositories/scheduledNotificationsRepository.js';
import { bookings, invoices, scheduledNotifications } from '../../src/db/schema/schema.js';
import { pgTimestampToDate } from '../../src/lib/pgTimestamp.js';
import { registerInvoicesRoute } from '../../src/routes/invoices.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';
import { makeStripeStub } from './_stripeStub.js';
import type { Principal } from '../../src/auth/principal.js';

/**
 * R3 contract tests for `POST /invoices/:id/pay-in-person` — the cash/check
 * flag flip. The verb charges nothing: it flips `payment_expected` → 'in-person'
 * and enqueues a `payment-due` reminder anchored 24h before the linked booking's
 * drop-off (or 24h before the invoice's due time when unlinked; past-due → now).
 */

registerFixtureHooks();

const ONE_DAY_MS = 86_400_000;
const REAL_NOW_MS = Date.now();

function buildApp(principal: Principal = FIXTURE_OWNER_PRINCIPAL): {
  app: ReturnType<typeof makeContractApp>['app'];
} {
  const { app, authenticate } = makeContractApp(principal);
  registerInvoicesRoute(app, { authenticate, stripe: makeStripeStub() });
  return { app };
}

/** Track seeded booking ids per test so cleanup can drop exactly them. */
async function cleanup(bookingIds: string[] = []): Promise<void> {
  await db
    .delete(scheduledNotifications)
    .where(eq(scheduledNotifications.ownerId, FIXTURE_IDS.ownerId));
  await db.delete(invoices).where(eq(invoices.ownerId, FIXTURE_IDS.ownerId));
  if (bookingIds.length > 0) {
    await db.delete(bookings).where(inArray(bookings.id, bookingIds));
  }
}

/** A card-backed open invoice, optionally linked to a booking. */
async function seedOpenInvoice(opts: {
  amountCents?: number;
  dueAt?: string;
  bookingId?: string | null;
}): Promise<string> {
  const row = await db.transaction((tx) =>
    invoicesRepository.createOpen(tx, {
      ownerId: FIXTURE_IDS.ownerId,
      amountCents: opts.amountCents ?? 12_000,
      purpose: 'board-train',
      paymentMethodId: FIXTURE_IDS.paymentMethod1Id,
      dueAt: opts.dueAt ?? '2026-06-15T00:00:00Z',
      bookingId: opts.bookingId ?? null,
    }),
  );
  return row.id;
}

/** A board-and-train booking with a distinct drop-off vs scheduled_at, so the
 *  reminder anchor test proves drop-off is preferred over scheduled_at. */
async function seedBoardTrainBooking(opts: {
  scheduledAt: Date;
  dropoffAt: Date;
  leadDogId?: string;
}): Promise<string> {
  const id = randomUUID();
  await db.insert(bookings).values({
    id,
    ownerId: FIXTURE_IDS.ownerId,
    leadDogId: opts.leadDogId ?? FIXTURE_IDS.dog1Id,
    category: 'board-and-train',
    status: 'upcoming',
    scheduledAt: opts.scheduledAt.toISOString(),
    dropoffAt: opts.dropoffAt.toISOString(),
    location: 'fayetteville',
  });
  return id;
}

async function payInPerson(opts: {
  app: ReturnType<typeof buildApp>['app'];
  invoiceId: string;
  idempotencyKey?: string;
}) {
  return opts.app.inject({
    method: 'POST',
    url: `/invoices/${opts.invoiceId}/pay-in-person`,
    headers: { 'idempotency-key': opts.idempotencyKey ?? `pip-${randomUUID()}` },
    payload: {},
  });
}

test(
  'POST /invoices/:id/pay-in-person — booking anchor: flags in-person + enqueues payment-due at drop-off − 24h',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    // Drop-off 10 days out, scheduled_at 9 days out (distinct) — proves the
    // anchor uses drop-off, not scheduled_at, and stays in the future so no clamp.
    const scheduledAt = new Date(REAL_NOW_MS + 9 * ONE_DAY_MS);
    const dropoffAt = new Date(REAL_NOW_MS + 10 * ONE_DAY_MS);
    const bookingId = await seedBoardTrainBooking({ scheduledAt, dropoffAt });
    const invoiceId = await seedOpenInvoice({ amountCents: 12_000, bookingId });

    const { app } = buildApp();
    const res = await payInPerson({ app, invoiceId });
    assert.equal(res.statusCode, 204, res.body);

    const [inv] = await db
      .select({ paymentExpected: invoices.paymentExpected })
      .from(invoices)
      .where(eq(invoices.id, invoiceId));
    assert.equal(inv?.paymentExpected, 'in-person', 'invoice flagged pay-in-person');

    const scheduled = await scheduledNotificationsRepository.findByDedupeKey(
      db,
      `payment-due:${invoiceId}`,
    );
    assert.ok(scheduled !== undefined, 'payment-due reminder enqueued');
    assert.equal(scheduled?.type, 'payment-due');
    assert.equal(scheduled?.title, 'Payment due at drop-off');
    assert.equal(scheduled?.deepLinkPath, `/account/invoices?invoiceId=${invoiceId}`);
    assert.equal(scheduled?.deepLinkKind, 'invoice');
    assert.equal(scheduled?.dogId, FIXTURE_IDS.dog1Id, 'tagged the booking lead dog');
    assert.match(scheduled!.body, /\$120/);
    assert.match(scheduled!.body, /Board & Train/);
    assert.equal(
      pgTimestampToDate(scheduled!.scheduledFor).getTime(),
      dropoffAt.getTime() - ONE_DAY_MS,
      'scheduled_for = drop-off − 24h',
    );

    await cleanup([bookingId]);
  },
);

test(
  'POST /invoices/:id/pay-in-person — due-date anchor (no booking): scheduled_for = due_at − 24h, no dog tag',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const dueAt = new Date(REAL_NOW_MS + 8 * ONE_DAY_MS);
    const invoiceId = await seedOpenInvoice({ dueAt: dueAt.toISOString(), bookingId: null });

    const { app } = buildApp();
    const res = await payInPerson({ app, invoiceId });
    assert.equal(res.statusCode, 204, res.body);

    const scheduled = await scheduledNotificationsRepository.findByDedupeKey(
      db,
      `payment-due:${invoiceId}`,
    );
    assert.ok(scheduled !== undefined, 'payment-due reminder enqueued');
    assert.equal(scheduled?.dogId, null, 'no booking + no invoice dog → untagged');
    assert.equal(
      pgTimestampToDate(scheduled!.scheduledFor).getTime(),
      dueAt.getTime() - ONE_DAY_MS,
      'scheduled_for = due_at − 24h',
    );

    await cleanup();
  },
);

test(
  'POST /invoices/:id/pay-in-person — past-due anchor clamps scheduled_for to now',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    // due_at already in the past → anchor − 24h is past → clamp to now.
    const invoiceId = await seedOpenInvoice({ dueAt: '2026-06-15T00:00:00Z', bookingId: null });

    const { app } = buildApp();
    const before = Date.now();
    const res = await payInPerson({ app, invoiceId });
    const after = Date.now();
    assert.equal(res.statusCode, 204, res.body);

    const scheduled = await scheduledNotificationsRepository.findByDedupeKey(
      db,
      `payment-due:${invoiceId}`,
    );
    const scheduledMs = pgTimestampToDate(scheduled!.scheduledFor).getTime();
    assert.ok(
      scheduledMs >= before - 1000 && scheduledMs <= after + 1000,
      `past-due clamps to ~now (got ${new Date(scheduledMs).toISOString()})`,
    );

    await cleanup();
  },
);

test(
  'POST /invoices/:id/pay-in-person — second call (new key) 409s once already flagged',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const invoiceId = await seedOpenInvoice({ bookingId: null });
    const { app } = buildApp();

    const first = await payInPerson({ app, invoiceId, idempotencyKey: `pip-1-${randomUUID()}` });
    assert.equal(first.statusCode, 204, first.body);

    const second = await payInPerson({ app, invoiceId, idempotencyKey: `pip-2-${randomUUID()}` });
    assert.equal(second.statusCode, 409, second.body);

    await cleanup();
  },
);

test(
  'POST /invoices/:id/pay-in-person — replay (same key) returns 204, enqueues exactly one reminder',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const invoiceId = await seedOpenInvoice({ bookingId: null });
    const { app } = buildApp();
    const key = `pip-replay-${randomUUID()}`;

    const first = await payInPerson({ app, invoiceId, idempotencyKey: key });
    assert.equal(first.statusCode, 204, first.body);
    const replay = await payInPerson({ app, invoiceId, idempotencyKey: key });
    assert.equal(replay.statusCode, 204, replay.body);

    const rows = await db
      .select({ id: scheduledNotifications.id })
      .from(scheduledNotifications)
      .where(eq(scheduledNotifications.dedupeKey, `payment-due:${invoiceId}`));
    assert.equal(rows.length, 1, 'replay did not enqueue a second reminder');

    await cleanup();
  },
);

test(
  'POST /invoices/:id/pay-in-person — already-paid invoice → 409',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const invoiceId = await seedOpenInvoice({ bookingId: null });
    await db
      .update(invoices)
      .set({ status: 'paid', paidAt: sql`now()` })
      .where(eq(invoices.id, invoiceId));

    const { app } = buildApp();
    const res = await payInPerson({ app, invoiceId });
    assert.equal(res.statusCode, 409, res.body);

    await cleanup();
  },
);

test('POST /invoices/:id/pay-in-person — unknown invoice → 404', SKIP_WHEN_NO_DB, async () => {
  const { app } = buildApp();
  const res = await payInPerson({ app, invoiceId: '00000000-0000-4000-8000-000000000000' });
  assert.equal(res.statusCode, 404, res.body);
});

test('POST /invoices/:id/pay-in-person — staff principal → 403', SKIP_WHEN_NO_DB, async () => {
  const { app } = buildApp(FIXTURE_STAFF_PRINCIPAL);
  const res = await payInPerson({ app, invoiceId: '00000000-0000-4000-8000-000000000000' });
  assert.equal(res.statusCode, 403, res.body);
});

test(
  "POST /invoices/:id/pay-in-person — another owner's invoice → 404",
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const invoiceId = await seedOpenInvoice({ bookingId: null });
    const otherOwner: Principal = {
      kind: 'owner',
      ownerId: randomUUID(),
      supabaseUid: randomUUID(),
    };
    const { app } = buildApp(otherOwner);
    const res = await payInPerson({ app, invoiceId });
    assert.equal(res.statusCode, 404, res.body);

    // The invoice must still be untouched (card-backed, open).
    const [inv] = await db
      .select({ paymentExpected: invoices.paymentExpected, status: invoices.status })
      .from(invoices)
      .where(eq(invoices.id, invoiceId));
    assert.equal(inv?.paymentExpected, 'card', 'cross-owner call did not flip the flag');
    assert.equal(inv?.status, 'open');

    await cleanup();
  },
);
