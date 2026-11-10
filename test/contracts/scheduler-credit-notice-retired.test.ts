import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { creditLedger, scheduledNotifications } from '../../src/db/schema/schema.js';
import { runSchedulerTickOnce } from '../../src/workers/scheduler.js';
import { makeExpoPushStub } from './_expoPushStub.js';
import { FIXTURE_IDS } from './_fixture.js';
import { makeR2Stub } from './_r2Stub.js';
import { makeStripeStub } from './_stripeStub.js';
import { SKIP_WHEN_NO_DB, registerFixtureHooks } from './_harness.js';

/**
 * **The 60-day credit notice stops at 2.0.0** (design §2.1, design.md:1845-1848;
 * S01, r3-fable #2).
 *
 * From 2.0.0 a lot's warning lead is `cred.expiry_warning_lead_days` (`{7}`, on
 * `credit_settings`), and a lot bought today expires one month out
 * (`cred.package_expiry_months` 1). The legacy scan read another store, seeded 60
 * and dropped at M4.07, so the moment a
 * family buys a pack, its whole one-month lot already sits inside a 60-day
 * window and the scheduler queues a `credits-expiring` notice for it. That is
 * a notice the 7-day setting governs, sent seven weeks early by a store no
 * registry key names. The scheduler stopped calling the scan, S25 deleted it, and
 * CRED-U13 builds the real notice at 7.1.0.
 *
 * The test drives the whole tick, because the claim is about what the scheduler DOES.
 */

registerFixtureHooks();

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

test(
  'a lot stamped today enqueues no credits-expiring row on the next scheduler tick',
  SKIP_WHEN_NO_DB,
  async () => {
    const lotId = randomUUID();
    const dedupeKey = `credits-expiring:${lotId}`;
    // Real clock: the scan's live-lot floor is Postgres `now()`, so a pinned
    // past instant would let the lot fall out of the scan and pass vacuously.
    const now = new Date();
    try {
      await db.insert(creditLedger).values({
        id: lotId,
        ownerId: FIXTURE_IDS.ownerId,
        mode: 'school',
        location: 'fayetteville',
        delta: 8,
        reason: 'purchase',
        // Bought now, one calendar month of life — inside the legacy 60-day lead.
        expiresAt: new Date(now.getTime() + 30 * ONE_DAY_MS).toISOString(),
        lotId: null,
      });

      const tick = await runSchedulerTickOnce({
        now,
        expoPush: makeExpoPushStub(),
        stripe: makeStripeStub(),
        r2: makeR2Stub(),
      });

      const queued = await db
        .select({ id: scheduledNotifications.id })
        .from(scheduledNotifications)
        .where(eq(scheduledNotifications.dedupeKey, dedupeKey));
      assert.equal(
        queued.length,
        0,
        'the scheduler queued a credits-expiring notice for a lot bought today',
      );
      assert.deepEqual(tick.creditExpiryWarnings, { scanned: 0, enqueued: 0 });
    } finally {
      await db
        .delete(scheduledNotifications)
        .where(eq(scheduledNotifications.dedupeKey, dedupeKey));
      await db.delete(creditLedger).where(eq(creditLedger.id, lotId));
    }
  },
);
