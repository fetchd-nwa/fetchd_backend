import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Principal } from '../../src/auth/principal.js';
import type { ApiErrorEnvelope, RefundWire, StaffPaymentWire } from '../../src/contracts/wire.js';
import { db } from '../_poolBoundDb.js';
import { creditLedgerRepository } from '../../src/db/repositories/creditLedgerRepository.js';
import { charges, creditLedger, creditPackages, refunds } from '../../src/db/schema/schema.js';
import { registerCreditsRoute } from '../../src/routes/credits.js';
import { registerStaffOwnersRoute } from '../../src/routes/staffOwners.js';
import { registerStaffRefundsRoute } from '../../src/routes/staffRefunds.js';
import { registerStripeWebhookRoute } from '../../src/routes/stripeWebhook.js';
import { at, makeClock, type Clock } from './_checkinFixture.js';
import { FIXTURE_IDS } from './_fixture.js';
import { makeContractApp, type LogCapture } from './_harness.js';
import { verifyingSignatures, type SignedEvent } from './_signedEvents.js';
import { makeStripeStub, type StripeStub } from './_stripeStub.js';

/**
 * P22 go 2's world (B-6, B-7): Tomi's two payments of s17 as go 1 planted them
 * (`staff-refunds.test.ts`), a year on so `lot_is_live` reads them live; the four staff
 * refund routes, the owner's payment history, Tomi's credits, and the REAL webhook route
 * with signatures verified by the production `constructWebhookEvent`, so every event below
 * is real bytes projected by `projectStripeEvent`.
 */

export const OWNER = FIXTURE_IDS.ownerId;
export const SAT = at('2027-10-23', '09:00');

export interface Bought {
  chargeId: string;
  lotId: string;
  paymentIntentId: string;
}

async function packageIdOf(key: string): Promise<string> {
  const [row] = await db
    .select({ id: creditPackages.id })
    .from(creditPackages)
    .where(and(eq(creditPackages.key, key), eq(creditPackages.effectiveFrom, '2026-01-01')));
  assert.ok(row, `the catalog row ${key}`);
  return row.id;
}

async function plantPurchase(args: {
  key: 'school-2x-weekly-bentonville' | 'single-day-school-bentonville';
  amountCents: number;
  credits: number;
  boughtAt: Date;
  expiresAt: Date;
  stripe: StripeStub;
}): Promise<Bought> {
  const packageId = await packageIdOf(args.key);
  const paymentIntentId = `pi_test_p22g2_${randomUUID().replace(/-/g, '')}`;
  const [charge] = await db
    .insert(charges)
    .values({
      ownerId: OWNER,
      amountCents: args.amountCents,
      status: 'succeeded',
      purpose: 'package',
      packageId,
      stripePaymentIntentId: paymentIntentId,
      createdAt: args.boughtAt.toISOString(),
    })
    .returning({ id: charges.id });
  const lotId = randomUUID();
  await db.insert(creditLedger).values({
    id: lotId,
    ownerId: OWNER,
    location: 'bentonville',
    mode: 'school',
    tier: 'regular',
    delta: args.credits,
    reason: 'purchase',
    chargeId: charge!.id,
    packageId,
    expiresAt: args.expiresAt.toISOString(),
    createdAt: args.boughtAt.toISOString(),
  });
  // Stripe holds what the charge took, so it refuses a refund past it.
  args.stripe.setRefundableBalance(paymentIntentId, args.amountCents);
  return { chargeId: charge!.id, lotId, paymentIntentId };
}

/** Lot P: *Bentonville 2x Weekly*, 8 credits, $456.00, $57.00 a credit. */
export const lotP = (stripe: StripeStub): Promise<Bought> =>
  plantPurchase({
    key: 'school-2x-weekly-bentonville',
    amountCents: 45600,
    credits: 8,
    boughtAt: at('2027-10-09', '20:28'),
    expiresAt: at('2027-11-09', '20:28'),
    stripe,
  });

/** Lot S: one single day, $60.00. */
export const lotS = (stripe: StripeStub): Promise<Bought> =>
  plantPurchase({
    key: 'single-day-school-bentonville',
    amountCents: 6000,
    credits: 1,
    boughtAt: at('2027-10-17', '20:00'),
    expiresAt: at('2027-11-17', '20:00'),
    stripe,
  });

/** A charge with no lot (a class or board-and-train payment), Stripe holding its amount. */
export async function plantCharge(
  stripe: StripeStub,
  args: {
    amountCents: number;
    purpose?: 'package' | 'board-train' | 'group-class';
    status?: 'succeeded' | 'refunded' | 'failed';
  },
): Promise<{ chargeId: string; paymentIntentId: string }> {
  const paymentIntentId = `pi_test_p22g2_${randomUUID().replace(/-/g, '')}`;
  const [charge] = await db
    .insert(charges)
    .values({
      ownerId: OWNER,
      amountCents: args.amountCents,
      status: args.status ?? 'succeeded',
      purpose: args.purpose ?? 'board-train',
      stripePaymentIntentId: paymentIntentId,
    })
    .returning({ id: charges.id });
  stripe.setRefundableBalance(paymentIntentId, args.amountCents);
  return { chargeId: charge!.id, paymentIntentId };
}

/** A refunds row planted by SQL (say so in the test that uses it). */
export async function plantRefundRow(args: {
  chargeId: string;
  amountCents: number;
  status: 'pending' | 'succeeded' | 'failed' | 'unroutable' | 'resolved-external';
  stripeRefundId?: string;
  stripeIdempotencyKey?: string;
  reason?: string;
  issuedByStaffId?: string;
  retryOf?: string;
  outcome?: 'returned' | 'withdrawn';
  createdAt?: Date;
  /** Planted at INSERT: `refunds_touch` sets `updated_at = now()` on every UPDATE. */
  updatedAt?: Date;
}): Promise<string> {
  const [row] = await db
    .insert(refunds)
    .values({
      ownerId: OWNER,
      chargeId: args.chargeId,
      amountCents: args.amountCents,
      status: args.status,
      reason: args.reason ?? 'planted',
      ...(args.stripeRefundId !== undefined ? { stripeRefundId: args.stripeRefundId } : {}),
      ...(args.stripeIdempotencyKey !== undefined
        ? { stripeIdempotencyKey: args.stripeIdempotencyKey }
        : {}),
      ...(args.issuedByStaffId !== undefined ? { issuedByStaffId: args.issuedByStaffId } : {}),
      ...(args.retryOf !== undefined ? { retryOfRefundId: args.retryOf } : {}),
      ...(args.outcome !== undefined ? { resolvedOutcome: args.outcome } : {}),
      ...(args.createdAt !== undefined
        ? { createdAt: args.createdAt.toISOString(), updatedAt: args.createdAt.toISOString() }
        : {}),
      ...(args.updatedAt !== undefined ? { updatedAt: args.updatedAt.toISOString() } : {}),
    })
    .returning({ id: refunds.id });
  return row!.id;
}

export interface World {
  stripe: StripeStub;
  clock: Clock;
}

export function world(): World {
  return { stripe: verifyingSignatures(makeStripeStub()), clock: makeClock(SAT) };
}

/** The staff routes, the owner's reads and the real webhook route, on one app. */
export function appOf(principal: Principal, w: World, capture?: LogCapture): FastifyInstance {
  const { app, authenticate } = makeContractApp(principal, capture);
  registerStaffRefundsRoute(app, { authenticate, stripe: w.stripe, now: w.clock.now });
  registerStaffOwnersRoute(app, { authenticate, now: w.clock.now });
  registerCreditsRoute(app, { authenticate, now: w.clock.now });
  registerStripeWebhookRoute(app, { stripe: w.stripe });
  return app;
}

/** Deliver a signed event through `POST /webhooks/stripe`. */
export async function deliver(
  app: FastifyInstance,
  event: SignedEvent,
): Promise<{ statusCode: number; outcome?: string; body: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/webhooks/stripe',
    headers: { 'content-type': 'application/json', 'stripe-signature': event.signature },
    payload: event.payload,
  });
  const outcome =
    res.statusCode === 200 ? (JSON.parse(res.body) as { outcome?: string }).outcome : undefined;
  return { statusCode: res.statusCode, ...(outcome !== undefined ? { outcome } : {}), body: res.body };
}

export function postRefund(
  app: FastifyInstance,
  body: { payment_id: string; amount_cents: number; credits_to_remove?: number; reason?: string },
  key?: string,
) {
  return app.inject({
    method: 'POST',
    url: '/staff/refunds',
    headers: { 'idempotency-key': key ?? `p22g2-refund-${randomUUID()}` },
    payload: { instrument: 'original_card', reason: 'Pepper died; the unused pack', ...body },
  });
}

export function retry(app: FastifyInstance, refundId: string, key?: string) {
  return app.inject({
    method: 'POST',
    url: `/staff/refunds/${refundId}/retry`,
    headers: { 'idempotency-key': key ?? `p22g2-retry-${randomUUID()}` },
  });
}

export function resolveExternal(
  app: FastifyInstance,
  refundId: string,
  body: Record<string, unknown>,
) {
  return app.inject({
    method: 'POST',
    url: `/staff/refunds/${refundId}/resolve-external`,
    headers: { 'idempotency-key': `p22g2-resolve-${randomUUID()}` },
    payload: body,
  });
}

export function created(res: { statusCode: number; body: string }): RefundWire {
  assert.equal(res.statusCode, 201, res.body);
  return JSON.parse(res.body) as RefundWire;
}

export function codeOf(res: { statusCode: number; body: string }, status: number, code: string): void {
  assert.equal(res.statusCode, status, res.body);
  assert.equal((JSON.parse(res.body) as ApiErrorEnvelope).error.code, code, res.body);
}

export async function payments(app: FastifyInstance): Promise<StaffPaymentWire[]> {
  const res = await app.inject({ method: 'GET', url: `/staff/owners/${OWNER}/payments` });
  assert.equal(res.statusCode, 200, res.body);
  return JSON.parse(res.body) as StaffPaymentWire[];
}

/** `refundable_cents` as the family's payment history reads it. */
export async function refundableOf(app: FastifyInstance, chargeId: string): Promise<number> {
  const row = (await payments(app)).find((p) => p.payment_id === chargeId);
  assert.ok(row, `charge ${chargeId} is on the payment history`);
  return row.refundable_cents;
}

export async function unspent(lotId: string): Promise<number> {
  return db.transaction((tx) => creditLedgerRepository.lotUnspentInTx(tx, lotId));
}

export async function refundRows(chargeId: string) {
  return db
    .select()
    .from(refunds)
    .where(eq(refunds.chargeId, chargeId))
    .orderBy(refunds.createdAt, refunds.id);
}

export async function rowOf(refundId: string) {
  const [row] = await db.select().from(refunds).where(eq(refunds.id, refundId));
  assert.ok(row, `refund ${refundId}`);
  return row;
}

export async function chargeStatusOf(chargeId: string): Promise<string> {
  const [row] = await db
    .select({ status: charges.status })
    .from(charges)
    .where(eq(charges.id, chargeId));
  return row!.status;
}

/** The ledger rows that name a refund on this owner. */
export async function refundLedgerCount(): Promise<number> {
  const { rows } = await db.execute(
    sql`SELECT count(*)::int AS n FROM credit_ledger WHERE owner_id = ${OWNER} AND refund_id IS NOT NULL`,
  );
  return (rows[0] as { n: number }).n;
}

/** Tomi's refunds and charges, gone after each test. */
export async function clearRefundWorld(extraCharges: string[] = []): Promise<void> {
  await db.delete(creditLedger).where(and(eq(creditLedger.ownerId, OWNER), sql`refund_id IS NOT NULL`));
  await db.delete(refunds).where(eq(refunds.ownerId, OWNER));
  if (extraCharges.length > 0) await db.delete(refunds).where(inArray(refunds.chargeId, extraCharges));
  await db.delete(creditLedger).where(and(eq(creditLedger.ownerId, OWNER), sql`charge_id IS NOT NULL`));
  await db.delete(charges).where(eq(charges.ownerId, OWNER));
}

export const jitter = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 7)));
