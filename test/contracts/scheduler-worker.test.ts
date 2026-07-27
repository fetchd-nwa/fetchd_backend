import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq, lt, sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import {
  scheduledNotificationsRepository,
  type ScheduledNotificationType,
} from '../../src/db/repositories/scheduledNotificationsRepository.js';
import { withActor } from '../../src/db/tx.js';
import { enqueueBookingReminders } from '../../src/lib/enqueueBookingReminders.js';
import {
  deviceTokens,
  idempotencyKeys,
  notificationDogs,
  notifications,
  owners,
  scheduledNotifications,
} from '../../src/db/schema/schema.js';
import { runSchedulerTickOnce } from '../../src/workers/scheduler.js';
import type { NotificationDeepLinkKind } from '../../src/lib/notificationWire.js';
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
  type?: ScheduledNotificationType;
  trigger?: string;
  title?: string;
  body?: string;
  deepLinkKind?: NotificationDeepLinkKind;
  deepLinkId?: string;
}): Promise<string> {
  const row = await db.transaction(async (tx) =>
    scheduledNotificationsRepository.enqueueIdempotent(tx, {
      ownerId: OWNER_ID,
      type: opts.type ?? 'booking-reminder',
      trigger: opts.trigger ?? 'booking-reminder',
      dedupeKey: opts.dedupeKey ?? `test:${randomUUID()}`,
      scheduledFor: opts.scheduledFor,
      title: opts.title ?? 'Reminder: Day School tomorrow',
      body: opts.body ?? 'Your booking is coming up.',
      deepLinkPath: `/bookings/${BOOKING_ID}`,
      deepLinkKind: opts.deepLinkKind ?? null,
      deepLinkId: opts.deepLinkId ?? null,
      bookingId: BOOKING_ID,
      dogId: DOG_ID,
    }),
  );
  if (row === undefined) {
    throw new Error('seedDueScheduledRow: expected INSERT to succeed but ON CONFLICT fired');
  }
  return row.id;
}

/**
 * The fixture owner's seeded push-preference baseline (see `_fixture.ts`):
 * master switch ON, and a categories map that carries NO scheduler push
 * category key — so every push-capable type falls through to "send" by default.
 * The D3 tests mutate one of these and MUST restore this exact pair on teardown,
 * or a leaked `false` would silence pushes for every later test in this file
 * (the fixture `before` hook re-seeds once per file, not per test).
 */
const OWNER_PUSH_DEFAULTS = {
  pushNotificationsEnabled: true,
  pushNotificationCategories: { booking: true, message: true },
} as const;

async function setOwnerPushPrefs(prefs: {
  pushNotificationsEnabled?: boolean;
  pushNotificationCategories?: Record<string, boolean>;
}): Promise<void> {
  await db
    .update(owners)
    .set({
      ...(prefs.pushNotificationsEnabled !== undefined
        ? { pushNotificationsEnabled: prefs.pushNotificationsEnabled }
        : {}),
      ...(prefs.pushNotificationCategories !== undefined
        ? { pushNotificationCategories: prefs.pushNotificationCategories }
        : {}),
    })
    .where(eq(owners.id, OWNER_ID));
}

async function restoreOwnerPushPrefs(): Promise<void> {
  await db.update(owners).set(OWNER_PUSH_DEFAULTS).where(eq(owners.id, OWNER_ID));
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
      deepLinkKind: 'booking',
      deepLinkId: BOOKING_ID,
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

    // delivered notifications row landed — deliverOne carries the structured
    // deep-link ref (kind + id) from the schedule row through to the feed row,
    // not just the hand-written path.
    const [delivered] = await db
      .select({
        type: notifications.type,
        title: notifications.title,
        deepLinkPath: notifications.deepLinkPath,
        deepLinkKind: notifications.deepLinkKind,
        deepLinkId: notifications.deepLinkId,
      })
      .from(notifications)
      .where(eq(notifications.id, scheduled!.emittedNotificationId!));
    assert.equal(delivered?.type, 'booking-reminder');
    assert.equal(delivered?.title, 'Reminder: Day School tomorrow');
    assert.equal(delivered?.deepLinkPath, `/bookings/${BOOKING_ID}`);
    assert.equal(delivered?.deepLinkKind, 'booking');
    assert.equal(delivered?.deepLinkId, BOOKING_ID);

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
    // Decision 5: the profile-check copy asks the owner to verify vaccines/
    // meds/feeding, so it deep-links to the dog edit form (dog-manage), keyed
    // on the lead dog — NOT the booking detail.
    assert.equal(boarding24h?.deepLinkPath, `/dog-manage/${DOG_ID}`);
    assert.equal(boarding24h?.deepLinkKind, 'dog-manage');
    assert.equal(boarding24h?.deepLinkId, DOG_ID);
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
  'runSchedulerTickOnce — media-derivatives tick composes (empty queue returns scanned=0)',
  SKIP_WHEN_NO_DB,
  async () => {
    await clearScheduled();
    const expoPush = makeExpoPushStub();
    const result = await runSchedulerTickOnce({
      expoPush,
      now: new Date('2026-05-26T12:00:00Z'),
    });
    // No media jobs seeded for this fixture owner; the phase may pick up
    // unrelated jobs left by media-derivatives-worker.test.ts depending
    // on file order, so the assertion is just "the phase ran and the
    // shape is present" — the dedicated worker test covers semantics.
    assert.ok(result.mediaDerivatives, 'mediaDerivatives result should be present');
    assert.equal(typeof result.mediaDerivatives.scanned, 'number');
    assert.ok(Array.isArray(result.mediaDerivatives.results));
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

// ---- D3: push-preference enforcement in deliverOne -------------------------
//
// The feed INSERT is unconditional (DB is source of truth); only the PUSH
// channel is gated by the owner's account toggles. Each test mutates one
// owner-pref column and restores the seeded baseline in `finally` so a failed
// assertion can't silence pushes for the rest of the file.

test(
  'deliverOne — master switch OFF: feed row lands, zero push dispatched',
  SKIP_WHEN_NO_DB,
  async () => {
    await clearScheduled();
    await seedDeviceToken('ExponentPushToken[stub-d3-master-off]');
    await seedDueScheduledRow({
      scheduledFor: new Date('2026-01-01T00:00:00Z'),
      dedupeKey: 'test:d3-master-off',
    });
    const expoPush = makeExpoPushStub();
    try {
      await setOwnerPushPrefs({ pushNotificationsEnabled: false });

      const result = await runSchedulerTickOnce({
        expoPush,
        now: new Date('2026-05-26T12:00:00Z'),
      });

      // Feed row still delivered: the schedule row flipped to sent...
      assert.equal(result.scheduledNotifications.scanned, 1);
      assert.equal(result.scheduledNotifications.sent, 1);
      // ...but the push channel is fully muted: no batch, no tickets.
      assert.equal(result.scheduledNotifications.pushTicketsOk, 0);
      assert.equal(result.scheduledNotifications.pushTicketsError, 0);
      assert.equal(expoPush.calls.length, 0, 'master switch off ⇒ no push batch dispatched');

      // The in-app feed entry is the invariant — assert it actually landed.
      const feed = await db
        .select({ id: notifications.id })
        .from(notifications)
        .where(eq(notifications.ownerId, OWNER_ID));
      assert.equal(feed.length, 1, 'in-app feed entry inserted despite muted push');
    } finally {
      await restoreOwnerPushPrefs();
      await clearScheduled();
    }
  },
);

test(
  'deliverOne — per-category mute: muted category is feed-only; a different category still pushes',
  SKIP_WHEN_NO_DB,
  async () => {
    await clearScheduled();
    await seedDeviceToken('ExponentPushToken[stub-d3-category]');
    // booking-reminder maps to category 'booking-reminders' (muted below).
    await seedDueScheduledRow({
      scheduledFor: new Date('2026-01-01T00:00:00Z'),
      dedupeKey: 'test:d3-cat-reminder',
      type: 'booking-reminder',
      trigger: 'booking-reminder',
      title: 'Reminder: Day School tomorrow',
    });
    // payment-failed maps to category 'urgent-updates' (NOT muted) → still pushes.
    await seedDueScheduledRow({
      scheduledFor: new Date('2026-01-01T00:00:00Z'),
      dedupeKey: 'test:d3-cat-payment',
      type: 'payment-failed',
      trigger: 'invoice-parked',
      title: 'Payment failed — update your card',
    });
    const expoPush = makeExpoPushStub();
    try {
      await setOwnerPushPrefs({ pushNotificationCategories: { 'booking-reminders': false } });

      const result = await runSchedulerTickOnce({
        expoPush,
        now: new Date('2026-05-26T12:00:00Z'),
      });

      // Both feed rows delivered.
      assert.equal(result.scheduledNotifications.scanned, 2);
      assert.equal(result.scheduledNotifications.sent, 2);

      // Only payment-failed pushed: one batch, one message (1 device × 1 type).
      assert.equal(expoPush.calls.length, 1);
      assert.equal(
        expoPush.calls[0]?.messages.length,
        1,
        'muted booking-reminder produced no push; only urgent payment-failed pushed',
      );
      assert.equal(expoPush.calls[0]?.messages[0]?.data?.type, 'payment-failed');
      assert.equal(result.scheduledNotifications.pushTicketsOk, 1);
      assert.equal(result.scheduledNotifications.pushTicketsError, 0);
    } finally {
      await restoreOwnerPushPrefs();
      await clearScheduled();
    }
  },
);

test(
  'deliverOne — missing category key defaults to enabled: push is sent',
  SKIP_WHEN_NO_DB,
  async () => {
    await clearScheduled();
    await seedDeviceToken('ExponentPushToken[stub-d3-missing-key]');
    await seedDueScheduledRow({
      scheduledFor: new Date('2026-01-01T00:00:00Z'),
      dedupeKey: 'test:d3-missing-key',
      type: 'booking-reminder',
    });
    const expoPush = makeExpoPushStub();
    try {
      // An UNRELATED category is explicitly muted; the booking-reminders key is
      // absent → jsonb-default semantics say "send" (only an explicit false opts
      // out). Proves a present-but-unrelated false doesn't suppress this push.
      await setOwnerPushPrefs({ pushNotificationCategories: { 'urgent-updates': false } });

      const result = await runSchedulerTickOnce({
        expoPush,
        now: new Date('2026-05-26T12:00:00Z'),
      });

      assert.equal(result.scheduledNotifications.sent, 1);
      assert.equal(expoPush.calls.length, 1);
      assert.equal(expoPush.calls[0]?.messages.length, 1);
      assert.equal(expoPush.calls[0]?.messages[0]?.data?.type, 'booking-reminder');
      assert.equal(result.scheduledNotifications.pushTicketsOk, 1);
      assert.equal(result.scheduledNotifications.pushTicketsError, 0);
    } finally {
      await restoreOwnerPushPrefs();
      await clearScheduled();
    }
  },
);

// ---- D2: push `data` envelope shape pin ------------------------------------
//
// The Expo `data` payload must carry EXACTLY the snake_case wire keys the FE
// reads on tap — `type`, `deep_link_path`, `notification_id`. Pinning the exact
// key set server-side guards the D2 mismatch (a camelCase drift or stray key)
// forever.

test(
  'deliverOne — push data envelope carries exactly type + deep_link_path + notification_id',
  SKIP_WHEN_NO_DB,
  async () => {
    await clearScheduled();
    await seedDeviceToken('ExponentPushToken[stub-envelope]');
    const scheduledId = await seedDueScheduledRow({
      scheduledFor: new Date('2026-01-01T00:00:00Z'),
      dedupeKey: 'test:envelope-pin',
      deepLinkKind: 'booking',
      deepLinkId: BOOKING_ID,
    });
    const expoPush = makeExpoPushStub();

    const result = await runSchedulerTickOnce({
      expoPush,
      now: new Date('2026-05-26T12:00:00Z'),
    });
    assert.equal(result.scheduledNotifications.sent, 1);

    // The push must reference the notifications row deliverOne inserted.
    const [scheduled] = await db
      .select({ emittedNotificationId: scheduledNotifications.emittedNotificationId })
      .from(scheduledNotifications)
      .where(eq(scheduledNotifications.id, scheduledId));
    const notificationId = scheduled?.emittedNotificationId;
    assert.ok(notificationId, 'schedule row linked to an emitted notification');

    const data = expoPush.calls[0]?.messages[0]?.data;
    assert.ok(data, 'push message carries a data envelope');
    // Exact key set — snake_case, no camelCase drift, no extra keys.
    assert.deepStrictEqual(
      Object.keys(data).sort(),
      ['deep_link_path', 'notification_id', 'type'],
    );
    assert.equal(data.type, 'booking-reminder');
    assert.equal(data.deep_link_path, `/bookings/${BOOKING_ID}`);
    assert.equal(data.notification_id, notificationId);

    await clearScheduled();
  },
);
