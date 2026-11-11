import assert from 'node:assert/strict';
import { test } from 'node:test';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import {
  invoicesRepository,
  type InvoiceRow,
} from '../../src/db/repositories/invoicesRepository.js';
import { scheduledNotificationsRepository } from '../../src/db/repositories/scheduledNotificationsRepository.js';
import {
  charges,
  invoices,
  notifications,
  refunds,
  scheduledNotifications,
} from '../../src/db/schema/schema.js';
import { withActor } from '../../src/db/tx.js';
import { settleChargeAgainstInvoice } from '../../src/lib/settleInvoiceCharge.js';
import { clearInvoiceReferrers, FIXTURE_IDS } from './_fixture.js';
import { settleWithNewCharge } from './_invoiceSettle.js';
import { SKIP_WHEN_NO_DB, registerFixtureHooks } from './_harness.js';

registerFixtureHooks();

const ACTOR = 'system:stripe-webhook';

async function seedOpenInvoice(amountCents = 200_000): Promise<InvoiceRow> {
  return db.transaction((tx) =>
    invoicesRepository.createOpen(tx, {
      ownerId: FIXTURE_IDS.ownerId,
      amountCents,
      purpose: 'board-train',
      paymentMethodId: FIXTURE_IDS.paymentMethod1Id,
      dueAt: '2026-06-15T00:00:00Z',
    }),
  );
}

async function cleanup(): Promise<void> {
  await db.delete(refunds).where(eq(refunds.ownerId, FIXTURE_IDS.ownerId));
  await clearInvoiceReferrers();
  await db.delete(invoices).where(eq(invoices.ownerId, FIXTURE_IDS.ownerId));
  await db.delete(charges).where(eq(charges.ownerId, FIXTURE_IDS.ownerId));
  await db
    .delete(scheduledNotifications)
    .where(eq(scheduledNotifications.ownerId, FIXTURE_IDS.ownerId));
  await db
    .delete(notifications)
    .where(
      and(
        eq(notifications.ownerId, FIXTURE_IDS.ownerId),
        inArray(notifications.type, ['payment-succeeded', 'payment-failed']),
      ),
    );
}

/** A succeeded tender of its own, settled through the production entry (`_invoiceSettle.ts`). */
async function settle(
  invoice: InvoiceRow,
  paymentIntentId: string,
  notifyOwner: boolean,
): ReturnType<typeof settleWithNewCharge> {
  return withActor(ACTOR, (tx) =>
    settleWithNewCharge(tx, {
      invoice,
      paymentIntentId,
      amountCents: invoice.amountCents,
      purpose: invoice.purpose,
      notifyOwner,
    }),
  );
}

async function countPaymentSucceeded(): Promise<number> {
  const rows = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(
        eq(notifications.ownerId, FIXTURE_IDS.ownerId),
        eq(notifications.type, 'payment-succeeded'),
      ),
    );
  return rows.length;
}

// ──────────────────────────────────────────────────────────────────────────
// THE CRUX: two settle paths both succeed at Stripe for the SAME open invoice
// and both call the primitive. The conditional markPaid claim makes exactly
// one win; the loser's charge is refunded. Net: ONE charge to the customer,
// invoice paid ONCE, no duplicate receipt.
// ──────────────────────────────────────────────────────────────────────────

test(
  'settleChargeAgainstInvoice — concurrent settle: one wins, the loser charge is refunded (no double-charge)',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const invoice = await seedOpenInvoice();

    // Two tenders reach Stripe and succeed with DIFFERENT PaymentIntents, each under
    // its own request's key. They settle sequentially against the same open invoice —
    // the second sees flipped=0.
    const winnerPi = 'pi_test_winner_settle';
    const loserPi = 'pi_test_loser_settle';
    const winner = await settle(invoice, winnerPi, /* notifyOwner */ true);
    const loser = await settle(invoice, loserPi, /* notifyOwner */ true);

    assert.equal(winner.outcome, 'settled', 'first path to flip open->paid wins');
    assert.equal(loser.outcome, 'refunded', 'second path lost the claim — duplicate refunded');

    // Invoice settled exactly once, linked to the WINNER charge.
    const [inv] = await db
      .select({ status: invoices.status, paidChargeId: invoices.paidChargeId })
      .from(invoices)
      .where(eq(invoices.id, invoice.id));
    assert.equal(inv?.status, 'paid');
    assert.equal(inv?.paidChargeId, winner.chargeId, 'invoice links the winning charge');

    // Both charges exist (both PIs really captured at Stripe) — the refund,
    // not a missing charge row, is what makes the customer net-charged once.
    const chargeRows = await db
      .select({ id: charges.id, status: charges.status })
      .from(charges)
      .where(eq(charges.ownerId, FIXTURE_IDS.ownerId));
    assert.equal(chargeRows.length, 2, 'both succeeded charges recorded (honest financial record)');

    // Exactly ONE pending refund row, for the LOSER charge, full amount.
    const refundRows = await db
      .select({
        chargeId: refunds.chargeId,
        amountCents: refunds.amountCents,
        status: refunds.status,
      })
      .from(refunds)
      .where(eq(refunds.ownerId, FIXTURE_IDS.ownerId));
    assert.equal(refundRows.length, 1, 'exactly one refund — the duplicate');
    assert.equal(refundRows[0]?.chargeId, loser.chargeId, 'the LOSER charge is refunded');
    assert.equal(refundRows[0]?.amountCents, invoice.amountCents, 'full duplicate amount refunded');
    assert.equal(refundRows[0]?.status, 'pending', 'refund queued for post-commit Stripe fire');
    assert.notEqual(refundRows[0]?.chargeId, winner.chargeId, 'the winning charge is NOT refunded');

    // Net charge to the customer: winner amount, minus the loser's full refund
    // = one invoice's worth. (Both charges captured; one fully reversed.)
    const netCents = invoice.amountCents * chargeRows.length - (refundRows[0]?.amountCents ?? 0);
    assert.equal(netCents, invoice.amountCents, 'customer is net-charged exactly once');

    // No DUPLICATE receipt: the winner emitted one payment-succeeded; the
    // loser (refund branch) emitted none, even though notifyOwner=true.
    assert.equal(
      await countPaymentSucceeded(),
      1,
      'exactly one receipt — only the winner notifies',
    );

    await cleanup();
  },
);

test(
  'settleChargeAgainstInvoice — refund idempotency: settling the SAME lost charge again mints no second refund',
  SKIP_WHEN_NO_DB,
  async () => {
    // The lost-race arm mints through the one capped helper (`mintCappedPendingRefund`):
    // it sums the charge's non-failed refunds and mints at most the remainder. A fresh
    // duplicate (a distinct PI) refunds in full; the SAME charge settled again, as a
    // redelivered event or a second settler would, finds it already refunded in full.
    await cleanup();
    const invoice = await seedOpenInvoice();
    await settle(invoice, 'pi_test_winner_idem', true); // wins, paid

    const firstLoser = await settle(invoice, 'pi_test_loser_idem', true);
    assert.equal(firstLoser.outcome, 'refunded');
    assert.ok(
      firstLoser.outcome === 'refunded' && firstLoser.pendingStripeRefund !== undefined,
      'the first loss mints a refund to send',
    );

    const again = await withActor(ACTOR, (tx) =>
      settleChargeAgainstInvoice(tx, {
        invoice,
        chargeId: firstLoser.chargeId,
        paymentIntentId: 'pi_test_loser_idem',
        amountCents: invoice.amountCents,
        purpose: invoice.purpose,
        notifyOwner: true,
      }),
    );
    assert.equal(again.outcome, 'refunded', 'still a lost race');
    assert.equal(
      again.outcome === 'refunded' ? again.pendingStripeRefund : 'settled',
      undefined,
      'nothing more to send back',
    );
    const rows = await db
      .select({ amountCents: refunds.amountCents })
      .from(refunds)
      .where(eq(refunds.chargeId, firstLoser.chargeId));
    assert.deepEqual(
      rows.map((r) => r.amountCents),
      [invoice.amountCents],
      'one refund row for the charge, in full',
    );

    await cleanup();
  },
);

test(
  'settleChargeAgainstInvoice — clean win with notifyOwner=false emits no receipt (no caller passes false today)',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const invoice = await seedOpenInvoice();
    const result = await settle(invoice, 'pi_test_manual_clean', /* notifyOwner */ false);
    assert.equal(result.outcome, 'settled');

    const [inv] = await db
      .select({ status: invoices.status })
      .from(invoices)
      .where(eq(invoices.id, invoice.id));
    assert.equal(inv?.status, 'paid');
    // Manual settle: the owner gets the HTTP response, not a push receipt.
    assert.equal(await countPaymentSucceeded(), 0, 'manual settle emits no payment-succeeded push');
    await cleanup();
  },
);

test(
  'settleChargeAgainstInvoice — settling an in-person invoice cancels its pending payment-due reminder (R3)',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const invoice = await seedOpenInvoice();
    // The owner had elected cash/check: flag pay-in-person + enqueue the
    // "bring $… at drop-off" reminder, exactly as the pay-in-person route does.
    await withActor(ACTOR, async (tx) => {
      await invoicesRepository.markPayInPerson(tx, { id: invoice.id });
      await scheduledNotificationsRepository.enqueueIdempotent(tx, {
        ownerId: invoice.ownerId,
        type: 'payment-due',
        trigger: 'payment-due',
        dedupeKey: `payment-due:${invoice.id}`,
        scheduledFor: new Date('2026-06-15T00:00:00Z'),
        title: 'Payment due at drop-off',
        body: 'Please bring $2000 for your Board & Train when you drop off.',
      });
    });

    // Owner reverts to paying on the card — the settle must tear the reminder down
    // so it can't fire "bring $…" after the money is already collected.
    const result = await settle(invoice, 'pi_test_inperson_settle', /* notifyOwner */ false);
    assert.equal(result.outcome, 'settled');

    const scheduled = await scheduledNotificationsRepository.findByDedupeKey(
      db,
      `payment-due:${invoice.id}`,
    );
    assert.equal(scheduled?.status, 'cancelled', 'pending payment-due reminder cancelled on settle');
    await cleanup();
  },
);
