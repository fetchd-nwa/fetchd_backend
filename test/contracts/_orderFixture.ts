import { randomUUID } from 'node:crypto';
import { eq, inArray, isNotNull } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { bookingsRepository } from '../../src/db/repositories/bookingsRepository.js';
import {
  creditLedgerRepository,
  findLiveLots,
} from '../../src/db/repositories/creditLedgerRepository.js';
import { invoicesRepository } from '../../src/db/repositories/invoicesRepository.js';
import {
  bookings,
  charges,
  creditLedger,
  idempotencyKeys,
  invoices,
  notifications,
  orders,
  refunds,
  scheduledNotifications,
} from '../../src/db/schema/schema.js';
import type { StripePaymentIntentStatus } from '../../src/lib/stripe.js';
import { computeDayProgramScheduledAt } from '../../src/lib/bookingSchedule.js';
import { enqueueBookingReminders } from '../../src/lib/enqueueBookingReminders.js';
import { clearInvoiceReferrers, FIXTURE_IDS } from './_fixture.js';
import type { StripeStub } from './_stripeStub.js';

/**
 * Seeded orders (P15, DECISIONS 142(d)). Before P18 nothing on the wire can leave a
 * booking row `payment-pending`, so the cancel side of the engine runs on rows laid
 * down here: an order, its rows, its debits, its charge and its open claim. Each is
 * exactly what tx1 commits (design §2.7:3832-3845), nothing more.
 */

export const STRIPE_BUDGET = { timeoutMs: 30_000 };

/** A worker logger for a test that asserts on rows, not on alarms. */
export const QUIET_LOG = {
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined,
};

const A_MINUTE_MS = 60_000;

export interface SeededOrder {
  orderId: string;
  chargeId: string;
  claimKey: string;
  intentId: string | null;
  bookingIds: string[];
}

/** Mint the charge's intent in the stub, at this status, as an engine create would. */
async function mintIntent(
  stripe: StripeStub,
  args: {
    amountCents: number;
    orderId: string;
    chargeId: string;
    status: StripePaymentIntentStatus;
  },
): Promise<string> {
  const intent = await stripe.createUnconfirmedPaymentIntent(
    {
      customerId: FIXTURE_IDS.stripeCustomerId,
      paymentMethodId: 'pm_fixture_test_visa',
      amountCents: args.amountCents,
      currency: 'usd',
      metadata: { order_id: args.orderId, charge_id: args.chargeId },
    },
    `order:${args.orderId}`,
    STRIPE_BUDGET,
  );
  stripe.setIntentState(intent.id, args.status);
  return intent.id;
}

async function seedChargeAndClaim(
  stripe: StripeStub,
  args: {
    orderId: string;
    amountCents: number;
    intentStatus: StripePaymentIntentStatus | null;
    chargeStatus: 'requires_payment' | 'succeeded' | 'failed';
    attemptingUntil: Date;
    endpoint: string;
    purpose: 'package' | 'board-train';
    attemptCount: number;
    paymentMethodId?: string;
    packageId?: string;
    creditsCount?: number;
  },
): Promise<{ chargeId: string; claimKey: string; intentId: string | null }> {
  const chargeId = randomUUID();
  const intentId =
    args.intentStatus === null
      ? null
      : await mintIntent(stripe, {
          amountCents: args.amountCents,
          orderId: args.orderId,
          chargeId,
          status: args.intentStatus,
        });
  await db.insert(charges).values({
    id: chargeId,
    ownerId: FIXTURE_IDS.ownerId,
    amountCents: args.amountCents,
    status: args.chargeStatus,
    purpose: args.purpose,
    orderId: args.orderId,
    stripePaymentIntentId: intentId,
    stripeIdempotencyKey: `order:${args.orderId}`,
    stripeCustomerId: FIXTURE_IDS.stripeCustomerId,
    stripePaymentMethodId: 'pm_fixture_test_visa',
    paymentMethodId: args.paymentMethodId ?? FIXTURE_IDS.paymentMethod1Id,
    attemptCount: args.attemptCount,
    attemptingUntil: args.attemptingUntil.toISOString(),
    ...(args.packageId !== undefined ? { packageId: args.packageId } : {}),
    ...(args.creditsCount !== undefined ? { creditsCount: args.creditsCount } : {}),
  });
  const claimKey = `seeded-claim-${randomUUID()}`;
  await db.insert(idempotencyKeys).values({
    key: claimKey,
    ownerId: FIXTURE_IDS.ownerId,
    endpoint: args.endpoint,
    requestHash: 'seeded',
    orderId: args.orderId,
  });
  return { chargeId, claimKey, intentId };
}

/**
 * A top-up Confirm caught mid-flight: an order with `payment-pending` rows on these
 * dates, a debit per dog per row, and a `requires_payment` charge. `dates` are
 * Chicago days. `intentStatus: null` is a charge no create has answered for.
 */
export async function seedPendingBookingOrder(
  stripe: StripeStub,
  args: {
    dogId: string;
    dates: readonly string[];
    now: Date;
    amountCents?: number;
    intentStatus?: StripePaymentIntentStatus | null;
    chargeStatus?: 'requires_payment' | 'succeeded' | 'failed';
    rowStatus?: 'payment-pending' | 'upcoming';
    attemptingUntil?: Date;
    createdAt?: Date;
    attemptCount?: number;
  },
): Promise<SeededOrder> {
  const orderId = randomUUID();
  await db.insert(orders).values({
    id: orderId,
    ownerId: FIXTURE_IDS.ownerId,
    ...(args.createdAt !== undefined ? { createdAt: args.createdAt.toISOString() } : {}),
  });

  const bookingIds = await db.transaction(async (tx) => {
    const ids: string[] = [];
    for (const date of args.dates) {
      const scheduledAt = computeDayProgramScheduledAt(date, '07:30');
      const row = await bookingsRepository.create(tx, {
        ownerId: FIXTURE_IDS.ownerId,
        leadDogId: args.dogId,
        category: 'day-school',
        scheduledAt,
        location: 'fayetteville',
        notes: null,
        cancelDeadlineAt: new Date(scheduledAt.getTime() - 24 * 60 * A_MINUTE_MS),
        additionalDogIds: [],
      });
      const pool = {
        ownerId: FIXTURE_IDS.ownerId,
        location: 'fayetteville',
        mode: 'school',
        tier: 'regular',
      } as const;
      const [lot] = await findLiveLots(tx, pool);
      if (lot === undefined) throw new Error('the fixture has no live credit lot to debit');
      await creditLedgerRepository.debitLot(tx, {
        ...pool,
        lotId: lot.id,
        dogId: args.dogId,
        bookingId: row.id,
      });
      await enqueueBookingReminders(tx, {
        bookingId: row.id,
        ownerId: FIXTURE_IDS.ownerId,
        leadDogId: args.dogId,
        category: 'day-school',
        scheduledAt,
      });
      ids.push(row.id);
    }
    return ids;
  });
  await db
    .update(bookings)
    .set({ status: args.rowStatus ?? 'payment-pending', orderId })
    .where(inArray(bookings.id, bookingIds));

  const seeded = await seedChargeAndClaim(stripe, {
    orderId,
    amountCents: args.amountCents ?? 6_000,
    intentStatus: args.intentStatus === undefined ? 'processing' : args.intentStatus,
    chargeStatus: args.chargeStatus ?? 'requires_payment',
    attemptingUntil: args.attemptingUntil ?? new Date(args.now.getTime() + 150_000),
    endpoint: 'POST /bookings',
    purpose: 'package',
    attemptCount: args.attemptCount ?? 1,
  });
  return { orderId, bookingIds, ...seeded };
}

/** A pack bought by card, still pending: an order with no rows. */
export async function seedPendingPurchaseOrder(
  stripe: StripeStub,
  args: {
    now: Date;
    amountCents?: number;
    intentStatus?: StripePaymentIntentStatus | null;
    chargeStatus?: 'requires_payment' | 'succeeded' | 'failed';
    createdAt?: Date;
    packageId?: string;
    creditsCount?: number;
  },
): Promise<SeededOrder> {
  const orderId = randomUUID();
  await db.insert(orders).values({
    id: orderId,
    ownerId: FIXTURE_IDS.ownerId,
    ...(args.createdAt !== undefined ? { createdAt: args.createdAt.toISOString() } : {}),
  });
  const seeded = await seedChargeAndClaim(stripe, {
    orderId,
    ...(args.packageId !== undefined ? { packageId: args.packageId } : {}),
    ...(args.creditsCount !== undefined ? { creditsCount: args.creditsCount } : {}),
    amountCents: args.amountCents ?? 30_000,
    intentStatus: args.intentStatus === undefined ? 'processing' : args.intentStatus,
    chargeStatus: args.chargeStatus ?? 'requires_payment',
    attemptingUntil: new Date(args.now.getTime() + 150_000),
    endpoint: 'POST /credit-packages/:key/purchase',
    purpose: 'package',
    attemptCount: 1,
  });
  return { orderId, bookingIds: [], ...seeded };
}

/** An open invoice with a far-off due date. */
export async function seedOpenInvoice(amountCents = 8_500): Promise<string> {
  const row = await db.transaction(async (tx) =>
    invoicesRepository.createOpen(tx, {
      ownerId: FIXTURE_IDS.ownerId,
      amountCents,
      purpose: 'board-train',
      paymentMethodId: FIXTURE_IDS.paymentMethod1Id,
      dueAt: '2099-06-15T00:00:00Z',
    }),
  );
  return row.id;
}

/** An invoice payment caught mid-flight, as tx1 plus an intent would leave it. */
export async function seedInvoiceOrder(
  stripe: StripeStub,
  args: {
    invoiceId: string;
    now: Date;
    amountCents?: number;
    intentStatus: StripePaymentIntentStatus | null;
    attemptingUntil: Date;
    attemptCount?: number;
    paymentMethodId?: string;
  },
): Promise<SeededOrder> {
  const orderId = randomUUID();
  await db
    .insert(orders)
    .values({ id: orderId, ownerId: FIXTURE_IDS.ownerId, invoiceId: args.invoiceId });
  const seeded = await seedChargeAndClaim(stripe, {
    orderId,
    amountCents: args.amountCents ?? 8_500,
    intentStatus: args.intentStatus,
    chargeStatus: 'requires_payment',
    attemptingUntil: args.attemptingUntil,
    endpoint: 'POST /invoices/:id/pay',
    purpose: 'board-train',
    attemptCount: args.attemptCount ?? 1,
    ...(args.paymentMethodId !== undefined ? { paymentMethodId: args.paymentMethodId } : {}),
  });
  return { orderId, bookingIds: [], ...seeded };
}

/** Every row these files leave, in the order the FKs want. */
export async function clearOrderRows(): Promise<void> {
  const rows = await db
    .select({ id: bookings.id })
    .from(bookings)
    .where(isNotNull(bookings.orderId));
  const bookingIds = rows.map((r) => r.id);
  await db.delete(refunds).where(eq(refunds.ownerId, FIXTURE_IDS.ownerId));
  await clearInvoiceReferrers();
  await db.delete(invoices).where(eq(invoices.ownerId, FIXTURE_IDS.ownerId));
  await db
    .delete(scheduledNotifications)
    .where(eq(scheduledNotifications.ownerId, FIXTURE_IDS.ownerId));
  await db.delete(notifications).where(eq(notifications.ownerId, FIXTURE_IDS.ownerId));
  await db.delete(charges).where(eq(charges.ownerId, FIXTURE_IDS.ownerId));
  if (bookingIds.length > 0) {
    await db.delete(creditLedger).where(inArray(creditLedger.bookingId, bookingIds));
    await db.delete(bookings).where(inArray(bookings.id, bookingIds));
  }
}

/** The receipts one charge has enqueued: `scheduled_notifications`, the push queue. */
export async function receiptsFor(chargeId: string): Promise<{ title: string; body: string }[]> {
  return db
    .select({ title: scheduledNotifications.title, body: scheduledNotifications.body })
    .from(scheduledNotifications)
    .where(eq(scheduledNotifications.dedupeKey, `receipt:${chargeId}`));
}
