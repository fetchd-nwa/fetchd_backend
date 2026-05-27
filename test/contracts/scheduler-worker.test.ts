import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq, lt, sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { scheduledNotificationsRepository } from '../../src/db/repositories/scheduledNotificationsRepository.js';
import { withActor } from '../../src/db/tx.js';
import { enqueueBookingReminders } from '../../src/lib/enqueueBookingReminders.js';
import {
  deviceTokens,
  idempotencyKeys,
  notificationDogs,
  notifications,
  scheduledNotifications,
} from '../../src/db/schema/schema.js';
import { runSchedulerTickOnce } from '../../src/workers/scheduler.js';
import { FIXTURE_IDS } from './_fixture.js';
import { SKIP_WHEN_NO_DB, registerFixtureHooks } from './_harness.js';
import { makeExpoPushStub } from './_expoPushStub.js';

registerFixtureHooks();

/**
 * Day-16 contract suite. Exercises:
 *   - `runSchedulerTickOnce` end-to-end (claim → INSERT notifications →
 *     markSent → post-commit push dispatch)
 *   - `enqueueBookingReminders` helper rows
 *   - `dedupe_key` UNIQUE idempotency
 *   - `idempotency_keys` TTL sweep composition
 *   - Race: SKIP LOCKED divides the queue across concurrent ticks
 *
 * Per-test cleanup: each test that seeds rows scopes its own teardown
 * before/after the assertion so file order doesn't matter.
 */

const BOOKING_ID = FIXTURE_IDS.booking1Id;
const OWNER_ID = FIXTURE_IDS.ownerId;
const DOG_ID = FIXTURE_IDS.dog1Id;

async function clearScheduled(): Promise<void> {
  // Drop FK ref to notifications first, then delete notifications, then
  // scheduled rows for this owner.
  await db
    .update(scheduledNotifications)
    .set({ emittedNotificationId: null })
    .where(eq(scheduledNotifications.ownerId, OWNER_ID));
  await db.delete(notifications).where(eq(notifications.ownerId, OWNER_ID));
  await db.delete(scheduledNotifications).where(eq(scheduledNotifications.ownerId, OWNER_ID));
  await db.delete(deviceTokens).where(eq(deviceTokens.ownerId, OWNER_ID));
}

async function seedDeviceToken(token: string): Promise<void> {
  await db.insert(deviceTokens).values({
    ownerId: OWNER_ID,
    expoPushToken: token,
    platform: 'ios',
  });
}

async function seedDueScheduledRow(opts: {
  scheduledFor: Date;
  dedupeKey?: string;
  title?: string;
}): Promise<string> {
  const row = await db.transaction(async (tx) =>
    scheduledNotificationsRepository.enqueueIdempotent(tx, {
      ownerId: OWNER_ID,
      type: 'booking-reminder',
      trigger: 'booking-reminder',
      dedupeKey: opts.dedupeKey ?? `test:${randomUUID()}`,
      scheduledFor: opts.scheduledFor,
      title: opts.title ?? 'Reminder: Day School tomorrow',
      body: 'Your booking is coming up.',
      deepLinkPath: `/bookings/${BOOKING_ID}`,
      bookingId: BOOKING_ID,
      dogId: DOG_ID,
    }),
  );
  if (row === undefined) {
    throw new Error('seedDueScheduledRow: expected INSERT to succeed but ON CONFLICT fired');
  }
  return row.id;
}

test(
  'runSchedulerTickOnce — empty queue returns scanned=0 and sent=0',
  SKIP_WHEN_NO_DB,
  async () => {
    await clearScheduled();
    const expoPush = makeExpoPushStub();
    const result = await runSchedulerTickOnce({ expoPush });
    assert.equal(result.scheduledNotifications.scanned, 0);
    assert.equal(result.scheduledNotifications.sent, 0);
    assert.equal(expoPush.calls.length, 0);
  },
);

test(
  'runSchedulerTickOnce — due row flips to sent + notification row inserted + push dispatched',
  SKIP_WHEN_NO_DB,
  async () => {
    await clearScheduled();
    await seedDeviceToken('ExponentPushToken[stub-device-1]');
    const scheduledId = await seedDueScheduledRow({
      scheduledFor: new Date('2026-01-01T00:00:00Z'),
    });
    const expoPush = makeExpoPushStub();

    const result = await runSchedulerTickOnce({
      expoPush,
      now: new Date('2026-05-26T12:00:00Z'),
    });

    assert.equal(result.scheduledNotifications.scanned, 1);
    assert.equal(result.scheduledNotifications.sent, 1);
    assert.equal(result.scheduledNotifications.pushTicketsOk, 1);
    assert.equal(result.scheduledNotifications.pushTicketsError, 0);

    // schedule row marked sent + linked to a real notifications row
    const [scheduled] = await db
      .select({
        status: scheduledNotifications.status,
        sentAt: scheduledNotifications.sentAt,
        emittedNotificationId: scheduledNotifications.emittedNotificationId,
      })
      .from(scheduledNotifications)
      .where(eq(scheduledNotifications.id, scheduledId));
    assert.equal(scheduled?.status, 'sent');
    assert.ok(scheduled?.sentAt);
    assert.ok(scheduled?.emittedNotificationId);

    // delivered notifications row landed
    const [delivered] = await db
      .select({
        type: notifications.type,
        title: notifications.title,
        deepLinkPath: notifications.deepLinkPath,
      })
      .from(notifications)
      .where(eq(notifications.id, scheduled!.emittedNotificationId!));
    assert.equal(delivered?.type, 'booking-reminder');
    assert.equal(delivered?.title, 'Reminder: Day School tomorrow');
    assert.equal(delivered?.deepLinkPath, `/bookings/${BOOKING_ID}`);

    // notification_dogs denorm populated
    const dogRows = await db
      .select({ dogId: notificationDogs.dogId })
      .from(notificationDogs)
      .where(eq(notificationDogs.notificationId, scheduled!.emittedNotificationId!));
    assert.deepStrictEqual(dogRows.map((r) => r.dogId).sort(), [DOG_ID]);

    // push tickets dispatched once per device token (1 here)
    assert.equal(expoPush.calls.length, 1);
    assert.equal(expoPush.calls[0]?.messages.length, 1);
    assert.equal(expoPush.calls[0]?.messages[0]?.to, 'ExponentPushToken[stub-device-1]');
    assert.equal(expoPush.calls[0]?.messages[0]?.data?.type, 'booking-reminder');

    await clearScheduled();
  },
);

test(
  'runSchedulerTickOnce — multiple due rows + multiple devices → fans out',
  SKIP_WHEN_NO_DB,
  async () => {
    await clearScheduled();
    await seedDeviceToken('ExponentPushToken[stub-device-A]');
    await seedDeviceToken('ExponentPushToken[stub-device-B]');
    await seedDueScheduledRow({
      scheduledFor: new Date('2026-01-01T00:00:00Z'),
      dedupeKey: 'test:multi-1',
    });
    await seedDueScheduledRow({
      scheduledFor: new Date('2026-01-02T00:00:00Z'),
      dedupeKey: 'test:multi-2',
    });

    const expoPush = makeExpoPushStub();
    const result = await runSchedulerTickOnce({
      expoPush,
      now: new Date('2026-05-26T12:00:00Z'),
    });

    assert.equal(result.scheduledNotifications.scanned, 2);
    assert.equal(result.scheduledNotifications.sent, 2);
    // 2 notifications × 2 devices = 4 push messages in one batch
    assert.equal(expoPush.calls.length, 1);
    assert.equal(expoPush.calls[0]?.messages.length, 4);
    assert.equal(result.scheduledNotifications.pushTicketsOk, 4);

    await clearScheduled();
  },
);

test('runSchedulerTickOnce — future-dated row is not claimed', SKIP_WHEN_NO_DB, async () => {
  await clearScheduled();
  await seedDueScheduledRow({
    scheduledFor: new Date('2030-01-01T00:00:00Z'),
    dedupeKey: 'test:future',
  });
  const expoPush = makeExpoPushStub();

  const result = await runSchedulerTickOnce({
    expoPush,
    now: new Date('2026-05-26T12:00:00Z'),
  });
  assert.equal(result.scheduledNotifications.scanned, 0);
  assert.equal(result.scheduledNotifications.sent, 0);
  await clearScheduled();
});

test(
  'runSchedulerTickOnce — push transport failure: in-app feed lands, schedule row still sent',
  SKIP_WHEN_NO_DB,
  async () => {
    await clearScheduled();
    await seedDeviceToken('ExponentPushToken[stub-device-fail]');
    const scheduledId = await seedDueScheduledRow({
      scheduledFor: new Date('2026-01-01T00:00:00Z'),
      dedupeKey: 'test:push-fail',
    });
    const expoPush = makeExpoPushStub();
    expoPush.throwOnNextBatch();

    const result = await runSchedulerTickOnce({
      expoPush,
      now: new Date('2026-05-26T12:00:00Z'),
    });

    // DB-as-source-of-truth: schedule + notifications still landed
    assert.equal(result.scheduledNotifications.scanned, 1);
    assert.equal(result.scheduledNotifications.sent, 1);
    assert.equal(result.scheduledNotifications.pushTicketsOk, 0);
    assert.equal(result.scheduledNotifications.pushTicketsError, 1);

    const [scheduled] = await db
      .select({ status: scheduledNotifications.status })
      .from(scheduledNotifications)
      .where(eq(scheduledNotifications.id, scheduledId));
    assert.equal(scheduled?.status, 'sent');
    await clearScheduled();
  },
);

test(
  'runSchedulerTickOnce — per-message push ticket error is counted, not thrown',
  SKIP_WHEN_NO_DB,
  async () => {
    await clearScheduled();
    await seedDeviceToken('ExponentPushToken[stub-device-bad]');
    await seedDueScheduledRow({
      scheduledFor: new Date('2026-01-01T00:00:00Z'),
      dedupeKey: 'test:ticket-error',
    });
    const expoPush = makeExpoPushStub();
    expoPush.setNextBatchTickets([
      {
        status: 'error',
        message: 'DeviceNotRegistered',
        details: { error: 'DeviceNotRegistered' },
      },
    ]);

    const result = await runSchedulerTickOnce({
      expoPush,
      now: new Date('2026-05-26T12:00:00Z'),
    });

    assert.equal(result.scheduledNotifications.sent, 1);
    assert.equal(result.scheduledNotifications.pushTicketsOk, 0);
    assert.equal(result.scheduledNotifications.pushTicketsError, 1);
    await clearScheduled();
  },
);

test(
  'scheduledNotificationsRepository.enqueueIdempotent — dedupe_key UNIQUE no-ops on replay',
  SKIP_WHEN_NO_DB,
  async () => {
    await clearScheduled();
    const dedupeKey = 'test:replay-key';
    const firstId = await seedDueScheduledRow({
      scheduledFor: new Date('2030-01-01T00:00:00Z'),
      dedupeKey,
      title: 'Original',
    });

    // Second enqueue under the same dedupe_key returns undefined; the
    // original row is untouched.
    const replay = await db.transaction(async (tx) =>
      scheduledNotificationsRepository.enqueueIdempotent(tx, {
        ownerId: OWNER_ID,
        type: 'booking-reminder',
        trigger: 'booking-reminder',
        dedupeKey,
        scheduledFor: new Date('2030-02-01T00:00:00Z'),
        title: 'Replay (should not land)',
        body: 'should not overwrite',
      }),
    );
    assert.equal(replay, undefined);

    const [row] = await db
      .select({ id: scheduledNotifications.id, title: scheduledNotifications.title })
      .from(scheduledNotifications)
      .where(eq(scheduledNotifications.id, firstId));
    assert.equal(row?.title, 'Original');
    await clearScheduled();
  },
);

test(
  'enqueueBookingReminders — non-boarding category enqueues booking-reminder only',
  SKIP_WHEN_NO_DB,
  async () => {
    await clearScheduled();
    const scheduledAt = new Date('2026-06-10T13:00:00Z');
    await withActor('system:test', async (tx) => {
      await enqueueBookingReminders(tx, {
        bookingId: BOOKING_ID,
        ownerId: OWNER_ID,
        leadDogId: DOG_ID,
        category: 'day-school',
        scheduledAt,
      });
    });

    const reminder = await scheduledNotificationsRepository.findByDedupeKey(
      db,
      `booking-reminder:${BOOKING_ID}`,
    );
    const boarding24h = await scheduledNotificationsRepository.findByDedupeKey(
      db,
      `boarding-24h:${BOOKING_ID}`,
    );
    assert.ok(reminder, 'booking-reminder row enqueued');
    assert.equal(reminder?.type, 'booking-reminder');
    assert.equal(
      new Date(reminder!.scheduledFor).getTime(),
      scheduledAt.getTime() - 24 * 60 * 60 * 1000,
    );
    assert.equal(boarding24h, undefined, 'no boarding-profile-check for day-school');
    await clearScheduled();
  },
);

test(
  'enqueueBookingReminders — boarding category enqueues BOTH rows; dropoffAt anchors profile check',
  SKIP_WHEN_NO_DB,
  async () => {
    await clearScheduled();
    const scheduledAt = new Date('2026-08-01T13:00:00Z');
    const dropoffAt = new Date('2026-08-03T15:00:00Z');
    await withActor('system:test', async (tx) => {
      await enqueueBookingReminders(tx, {
        bookingId: BOOKING_ID,
        ownerId: OWNER_ID,
        leadDogId: DOG_ID,
        category: 'board-and-train',
        scheduledAt,
        dropoffAt,
      });
    });

    const reminder = await scheduledNotificationsRepository.findByDedupeKey(
      db,
      `booking-reminder:${BOOKING_ID}`,
    );
    const boarding24h = await scheduledNotificationsRepository.findByDedupeKey(
      db,
      `boarding-24h:${BOOKING_ID}`,
    );
    assert.ok(reminder);
    assert.ok(boarding24h, 'boarding-profile-check enqueued for board-and-train');
    assert.equal(boarding24h?.type, 'boarding-profile-check');
    // Anchored on dropoffAt, not scheduledAt
    assert.equal(
      new Date(boarding24h!.scheduledFor).getTime(),
      dropoffAt.getTime() - 24 * 60 * 60 * 1000,
    );
    await clearScheduled();
  },
);

test(
  'runSchedulerTickOnce — idempotency_keys TTL sweep prunes old rows, keeps fresh ones',
  SKIP_WHEN_NO_DB,
  async () => {
    // Seed one stale key (older than 24h) + one fresh key. The sweep
    // should drop only the stale one.
    const staleKey = `stale-key-${randomUUID()}`;
    const freshKey = `fresh-key-${randomUUID()}`;
    const now = new Date('2026-05-26T12:00:00Z');
    const stale = new Date(now.getTime() - 48 * 60 * 60 * 1000);

    await db.insert(idempotencyKeys).values([
      {
        key: staleKey,
        endpoint: 'POST /test/stale',
        requestHash: 'hash-stale',
        createdAt: stale.toISOString(),
      },
      {
        key: freshKey,
        endpoint: 'POST /test/fresh',
        requestHash: 'hash-fresh',
      },
    ]);

    const expoPush = makeExpoPushStub();
    const result = await runSchedulerTickOnce({ expoPush, now });
    assert.ok(result.idempotencyKeysSwept >= 1, 'sweep deleted at least the stale row');

    const remainingStale = await db
      .select({ key: idempotencyKeys.key })
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.key, staleKey));
    assert.equal(remainingStale.length, 0, 'stale key pruned');

    const remainingFresh = await db
      .select({ key: idempotencyKeys.key })
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.key, freshKey));
    assert.equal(remainingFresh.length, 1, 'fresh key preserved');

    // Cleanup the fresh key — the next test file's fixture re-seed
    // owner-cascade would handle it, but explicit-is-better.
    await db.delete(idempotencyKeys).where(eq(idempotencyKeys.key, freshKey));
  },
);

test(
  'runSchedulerTickOnce — invoice auto-charge tick composes (empty queue returns scanned=0)',
  SKIP_WHEN_NO_DB,
  async () => {
    await clearScheduled();
    const expoPush = makeExpoPushStub();
    const result = await runSchedulerTickOnce({
      expoPush,
      now: new Date('2026-05-26T12:00:00Z'),
    });
    // No invoices seeded → invoice phase reports empty scan, no throws.
    // The composition contract is the assertion: scheduler tick returns
    // a non-undefined invoiceAutoCharge result.
    assert.ok(result.invoiceAutoCharge);
    assert.equal(typeof result.invoiceAutoCharge.scanned, 'number');
  },
);

test(
  'runSchedulerTickOnce — concurrent ticks divide queue via SKIP LOCKED (no double-send)',
  SKIP_WHEN_NO_DB,
  async () => {
    await clearScheduled();
    const past = new Date('2026-01-01T00:00:00Z');
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      ids.push(
        await seedDueScheduledRow({
          scheduledFor: past,
          dedupeKey: `test:race-${i}`,
        }),
      );
    }
    const expoPush1 = makeExpoPushStub();
    const expoPush2 = makeExpoPushStub();

    const [a, b] = await Promise.all([
      runSchedulerTickOnce({
        expoPush: expoPush1,
        now: new Date('2026-05-26T12:00:00Z'),
      }),
      runSchedulerTickOnce({
        expoPush: expoPush2,
        now: new Date('2026-05-26T12:00:00Z'),
      }),
    ]);

    // Union of sent counts = 4; no double-counting.
    const totalSent = a.scheduledNotifications.sent + b.scheduledNotifications.sent;
    assert.equal(totalSent, 4, 'each row sent exactly once across concurrent ticks');

    // Every row now has status='sent'
    const remaining = await db
      .select({ id: scheduledNotifications.id, status: scheduledNotifications.status })
      .from(scheduledNotifications)
      .where(eq(scheduledNotifications.ownerId, OWNER_ID));
    for (const row of remaining) {
      assert.equal(row.status, 'sent', `row ${row.id} marked sent`);
    }
    await clearScheduled();
  },
);

// Belt-and-suspenders: the SQL the schema's worker-pattern note prescribes
// matches our Drizzle path. Validates the cutoff filter compiles.
test('lockDueForSend — explicit now cutoff drives the filter', SKIP_WHEN_NO_DB, async () => {
  await clearScheduled();
  const earlyId = await seedDueScheduledRow({
    scheduledFor: new Date('2026-01-01T00:00:00Z'),
    dedupeKey: 'test:cutoff-early',
  });
  await seedDueScheduledRow({
    scheduledFor: new Date('2030-01-01T00:00:00Z'),
    dedupeKey: 'test:cutoff-late',
  });

  const claimed = await db.transaction(async (tx) =>
    scheduledNotificationsRepository.lockDueForSend(tx, {
      now: new Date('2026-05-26T12:00:00Z'),
      limit: 50,
    }),
  );
  // Only the early row is due at the cutoff
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0]?.id, earlyId);
  await clearScheduled();
});

// Verify the sweep helper directly — pinned for the contract.
test(
  'sweepExpiredIdempotencyKeys — older-than cutoff applies precisely',
  SKIP_WHEN_NO_DB,
  async () => {
    const { sweepExpiredIdempotencyKeys } = await import('../../src/db/idempotency.js');
    const cutoff = new Date('2026-05-26T12:00:00Z');
    const seedKey = `sweep-direct-${randomUUID()}`;
    await db.insert(idempotencyKeys).values({
      key: seedKey,
      endpoint: 'POST /test/sweep-direct',
      requestHash: 'hash-direct',
      createdAt: new Date(cutoff.getTime() - 1000).toISOString(),
    });
    const swept = await sweepExpiredIdempotencyKeys({ olderThan: cutoff });
    assert.ok(swept >= 1);
    // Make sure leftover from earlier failures don't poison this test
    await db.delete(idempotencyKeys).where(lt(idempotencyKeys.createdAt, sql`now()`));
  },
);
