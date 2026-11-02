import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq, lt, sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { notificationsRepository } from '../../src/db/repositories/notificationsRepository.js';
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
import {
  captureAlarm,
  flushObservability,
  initObservability,
  IDENTICAL_ALLOWANCE,
  type AlarmEvent,
} from '../../src/lib/observability.js';
import { MAX_DELIVERY_ATTEMPTS, runSchedulerTickOnce } from '../../src/workers/scheduler.js';
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
    // A2.1: an EMPTY claim is a healthy queue, not a stopped one. `queueOk`
    // answers "did phase 1 run to the end without taking the systemic branch",
    // and an idle queue did — so the tick refreshes `scheduler:queue_ok_at` and
    // the uptime monitor stays green through a quiet hour.
    assert.equal(result.scheduledNotifications.queueOk, true, 'an empty claim is delivering');
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


// ── phase-1 worker boundary (2026-09-03) ────────────────────────────────────
// The 2026-09-02 production incident: phase 1 threw (`column "deep_link_kind"
// does not exist`) and, being the ONLY phase without a log-and-swallow
// boundary, took the whole tick to a 500 — phases 2–12 never ran, 27 times.
// This pins the boundary the other eleven phases already have. Proven RED
// before the boundary existed: `runSchedulerTickOnce` rejected with the
// injected error and no alarm line carried `phase: 'scheduled-notifications'`.
test(
  'runSchedulerTickOnce — phase 1 throwing is caught at the worker boundary: the tick completes, the other phases run, and exactly one error-level alarm names the phase',
  SKIP_WHEN_NO_DB,
  async () => {
    await clearScheduled();
    const expoPush = makeExpoPushStub();
    const errors: Array<{ obj: Record<string, unknown>; msg: string | undefined }> = [];
    const log = {
      info: () => undefined,
      warn: () => undefined,
      error: (obj: Record<string, unknown>, msg?: string) => {
        errors.push({ obj, msg });
      },
    };
    const original = scheduledNotificationsRepository.lockDueForSend;
    // The exact production failure shape: the claim SELECT itself throws, so
    // no row-level handling can catch it — only a phase boundary can.
    scheduledNotificationsRepository.lockDueForSend = async () => {
      throw new Error('column "deep_link_kind" does not exist');
    };
    try {
      const result = await runSchedulerTickOnce({ expoPush, log });
      // Phase 1 reports the empty result rather than poisoning the tick.
      assert.deepStrictEqual(result.scheduledNotifications, {
        scanned: 0,
        sent: 0,
        failed: 0,
        parked: 0,
        // `null`, not 0: the phase threw before it could COUNT the parked rows,
        // and the route must not publish a zero it never measured (A1.6).
        parkedTotal: null,
        // `false` (A2.1): a phase that THREW is a phase that did not deliver.
        // Step 1's boundary is what stopped this from being a 500 — and a 500
        // was what used to make the uptime monitor go red on heartbeat
        // staleness. This leaf is how that red comes back without the 500.
        queueOk: false,
        pushTicketsOk: 0,
        pushTicketsError: 0,
      });
      // The phases BEHIND it ran: the TTL sweep is the last phase and always
      // reports a count, and the money phases each report a scan.
      assert.equal(typeof result.idempotencyKeysSwept, 'number');
      assert.equal(typeof result.invoiceAutoCharge.scanned, 'number');
      assert.equal(typeof result.captureReconciler.scanned, 'number');
      // Exactly one alarm, and it names the phase — the alarm channel is the
      // logger (workersTick.ts hands `request.log`), so this IS the page.
      const boundary = errors.filter(
        (e) => e.obj.workerTick === 'scheduler' && e.obj.phase === 'scheduled-notifications',
      );
      assert.equal(
        boundary.length,
        1,
        `expected exactly one phase-1 boundary alarm; error lines were: ${JSON.stringify(errors)}`,
      );
      assert.match(String(boundary[0].obj.err), /deep_link_kind/);
      assert.match(boundary[0].msg ?? '', /worker boundary/);
      assert.equal(expoPush.calls.length, 0);
    } finally {
      scheduledNotificationsRepository.lockDueForSend = original;
    }
  },
);


// ── phase-1 poison-row isolation (2026-09-03) ───────────────────────────────
// designs/phase-1-poison-row-isolation.md. The boundary above keeps ONE broken
// phase from taking the tick down; these keep ONE broken ROW from taking its
// batch down. Before this, twelve rows claimed in one transaction meant one
// throw rolled back all twelve — and since the next tick re-claims the same
// twelve, none of those owners was ever notified again.

/** The title `poisonDelivery` breaks delivery on. Nothing else uses it. */
const POISON_TITLE = 'POISON — deliverOne must throw for this row';
/** Substring of the Postgres error the poison row raises. */
const POISON_ERROR = 'fetchd_poison_no_such_column';

/**
 * Break delivery for exactly the poison row, leaving every other row (this
 * file's, and the ones other phases enqueue during the same tick) on the real
 * implementation. Returns the restore function; call it in `finally`, like the
 * `lockDueForSend` patch above.
 *
 * Two things this does deliberately, in this order:
 *
 *  1. It lets the row's feed INSERT actually LAND first, so the test can prove
 *     the partial write is undone — that is what ROLLBACK TO SAVEPOINT buys and
 *     a bare `continue` would not.
 *  2. It then fails at the SERVER (a bad column reference — the exact class of
 *     the 2026-09-02 incident, `column "deep_link_kind" does not exist`), not
 *     with a bare JS `throw`. A JS-only throw leaves the Postgres transaction
 *     perfectly healthy, so the batch would survive it WITHOUT a savepoint and
 *     the test would pass against the very defect it exists to catch. Only a
 *     real server error puts the tx in the aborted state that nothing but a
 *     savepoint can get back out of.
 */
function poisonDelivery(): () => void {
  const original = notificationsRepository.enqueue;
  notificationsRepository.enqueue = async (tx, values) => {
    if (values.title !== POISON_TITLE) {
      return original(tx, values);
    }
    const inserted = await original(tx, values);
    await tx.execute(sql`SELECT ${sql.raw(POISON_ERROR)} FROM notifications LIMIT 1`);
    return inserted; // unreachable — the statement above always throws
  };
  return () => {
    notificationsRepository.enqueue = original;
  };
}

interface ErrorLine {
  obj: Record<string, unknown>;
  msg: string | undefined;
}

/** A logger that keeps the error lines — the tick's alarm channel. */
function makeErrorLog(sink: ErrorLine[]): {
  info: () => undefined;
  warn: () => undefined;
  error: (obj: Record<string, unknown>, msg?: string) => void;
} {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: (obj: Record<string, unknown>, msg?: string) => {
      sink.push({ obj, msg });
    },
  };
}

/** The parking columns for one schedule row. */
async function readParking(id: string): Promise<{
  status: string;
  attempts: number;
  lastError: string | null;
  failedAt: string | null;
}> {
  const [row] = await db
    .select({
      status: scheduledNotifications.status,
      attempts: scheduledNotifications.attempts,
      lastError: scheduledNotifications.lastError,
      failedAt: scheduledNotifications.failedAt,
    })
    .from(scheduledNotifications)
    .where(eq(scheduledNotifications.id, id));
  assert.ok(row, `schedule row ${id} should still exist`);
  return row;
}

/** Only the phase-1 per-row alarms — other phases log their own errors. */
function phase1Alarms(errors: ErrorLine[], scheduledId?: string): ErrorLine[] {
  return errors.filter(
    (e) =>
      e.obj.workerTick === 'scheduler' &&
      e.obj.phase === 'scheduled-notifications' &&
      (scheduledId === undefined || e.obj.scheduledId === scheduledId),
  );
}

test(
  'runSchedulerTickOnce — a poison row fails ALONE: its batch-mates are delivered, it is left pending with the attempt recorded',
  SKIP_WHEN_NO_DB,
  async () => {
    await clearScheduled();
    const goodEarly = await seedDueScheduledRow({
      scheduledFor: new Date('2026-01-01T00:00:00Z'),
      dedupeKey: 'test:isolation-good-early',
    });
    // MIDDLE by scheduled_for, so the claim hands it to the loop between the
    // two good rows: the row before it is already written when it throws, and
    // the row after it must still be reached.
    const poisonId = await seedDueScheduledRow({
      scheduledFor: new Date('2026-01-02T00:00:00Z'),
      dedupeKey: 'test:isolation-poison',
      title: POISON_TITLE,
    });
    const goodLate = await seedDueScheduledRow({
      scheduledFor: new Date('2026-01-03T00:00:00Z'),
      dedupeKey: 'test:isolation-good-late',
    });
    const expoPush = makeExpoPushStub();
    const errors: ErrorLine[] = [];
    const restore = poisonDelivery();
    try {
      const result = await runSchedulerTickOnce({
        expoPush,
        log: makeErrorLog(errors),
        now: new Date('2026-05-26T12:00:00Z'),
      });

      assert.equal(result.scheduledNotifications.scanned, 3);
      assert.equal(result.scheduledNotifications.sent, 2, 'both healthy rows delivered');
      assert.equal(result.scheduledNotifications.failed, 1);
      assert.equal(result.scheduledNotifications.parked, 0, 'one failure is not three');
      // A2.1: a MIXED batch is a delivering queue. Two owners got their
      // notifications; the broken row has its own parked signal and its own
      // per-row page. Turning the uptime monitor red for it would make the
      // instrument that must survive Sentry dying fire on a single bad row.
      assert.equal(result.scheduledNotifications.queueOk, true, 'a mixed batch is delivering');

      // The batch-mates COMMITTED — status flipped and a real feed row exists
      // for each. This is the assertion the old whole-batch rollback fails.
      for (const id of [goodEarly, goodLate]) {
        const [scheduled] = await db
          .select({
            status: scheduledNotifications.status,
            emittedNotificationId: scheduledNotifications.emittedNotificationId,
          })
          .from(scheduledNotifications)
          .where(eq(scheduledNotifications.id, id));
        assert.equal(scheduled?.status, 'sent', `row ${id} must be sent`);
        assert.ok(scheduled?.emittedNotificationId, `row ${id} must link a feed row`);
        const feed = await db
          .select({ id: notifications.id })
          .from(notifications)
          .where(eq(notifications.id, scheduled!.emittedNotificationId!));
        assert.equal(feed.length, 1, `row ${id}'s feed entry must have committed`);
      }

      // The poison row rolled back to its OWN savepoint: still pending, no feed
      // row of its own, one attempt spent, the cause recorded, not yet parked.
      const parking = await readParking(poisonId);
      assert.equal(parking.status, 'pending');
      assert.equal(parking.attempts, 1);
      assert.match(String(parking.lastError), new RegExp(POISON_ERROR));
      assert.equal(parking.failedAt, null, 'one failure must not park the row');

      // Exactly two feed rows for this owner — the poison row's INSERT was
      // undone by the savepoint rollback rather than left behind.
      const allFeed = await db
        .select({ id: notifications.id })
        .from(notifications)
        .where(eq(notifications.ownerId, OWNER_ID));
      assert.equal(allFeed.length, 2, 'the poison row must leave no orphan feed entry');

      // One alarm, naming the row a human has to go look at.
      const alarms = phase1Alarms(errors);
      assert.equal(
        alarms.length,
        1,
        `expected exactly one phase-1 alarm; got ${JSON.stringify(errors)}`,
      );
      assert.equal(alarms[0]?.obj.scheduledId, poisonId);
      assert.equal(alarms[0]?.obj.dedupeKey, 'test:isolation-poison');
      assert.match(String(alarms[0]?.obj.err), new RegExp(POISON_ERROR));
      assert.match(alarms[0]?.msg ?? '', /left pending for the next tick/);
      // The attempt count rides the SENTENCE, not the merge object (A1.4).
      // Every scalar in that object is an identifying, un-normalised part of
      // the pager fingerprint, so `attempts: n` minted a fresh first-ever
      // condition on every retry; digits in the message normalise to `N`.
      assert.match(alarms[0]?.msg ?? '', /attempt 1 of 3/);
      assert.equal(alarms[0]?.obj.attempts, undefined, 'attempts must not be an identifying scalar');
      assert.equal(alarms[0]?.obj.parked, undefined, 'parked must not be an identifying scalar');
    } finally {
      restore();
      await clearScheduled();
    }
  },
);

test(
  'runSchedulerTickOnce — a row that keeps failing PARKS after MAX_DELIVERY_ATTEMPTS and is no longer claimed',
  SKIP_WHEN_NO_DB,
  async () => {
    await clearScheduled();
    const poisonId = await seedDueScheduledRow({
      scheduledFor: new Date('2026-01-01T00:00:00Z'),
      dedupeKey: 'test:parking-poison',
      title: POISON_TITLE,
    });
    const errors: ErrorLine[] = [];
    const restore = poisonDelivery();
    try {
      for (let attempt = 1; attempt <= MAX_DELIVERY_ATTEMPTS; attempt++) {
        const result = await runSchedulerTickOnce({
          expoPush: makeExpoPushStub(),
          log: makeErrorLog(errors),
          now: new Date('2026-05-26T12:00:00Z'),
        });
        assert.equal(result.scheduledNotifications.scanned, 1, `tick ${attempt} must claim it`);
        assert.equal(result.scheduledNotifications.sent, 0);
        assert.equal(result.scheduledNotifications.failed, 1);
        assert.equal(
          result.scheduledNotifications.parked,
          attempt === MAX_DELIVERY_ATTEMPTS ? 1 : 0,
          `tick ${attempt} parks only on the last attempt`,
        );
        const parking = await readParking(poisonId);
        assert.equal(parking.attempts, attempt);
        assert.equal(
          parking.failedAt === null,
          attempt < MAX_DELIVERY_ATTEMPTS,
          `failed_at must be stamped on attempt ${MAX_DELIVERY_ATTEMPTS} and not before`,
        );
      }

      // Parked, and still 'pending' — the whole point of the nullable column
      // over a fourth status: cancel/revive predicates keep working unchanged.
      const parked = await readParking(poisonId);
      assert.equal(parked.status, 'pending');
      assert.equal(parked.attempts, MAX_DELIVERY_ATTEMPTS);
      assert.ok(parked.failedAt, 'the row must be parked');

      // The tick after parking does not claim it — this is what stops the
      // every-minute-forever alarm the design rejected living with.
      const after = await runSchedulerTickOnce({
        expoPush: makeExpoPushStub(),
        log: makeErrorLog(errors),
        now: new Date('2026-05-26T12:00:00Z'),
      });
      assert.equal(after.scheduledNotifications.scanned, 0, 'a parked row must not be claimed');
      assert.equal(after.scheduledNotifications.failed, 0);
      assert.equal(after.scheduledNotifications.parked, 0);

      // Alarm shape across all six ticks: four "will retry" lines and exactly
      // ONE parked line. The PARKED sentence is distinct text on purpose — it
      // is a different event (nobody is retrying this row again) and must page
      // on its own rather than dedupe into the line that preceded it.
      const alarms = phase1Alarms(errors, poisonId);
      const parkedLines = alarms.filter((e) => /PARKED/.test(e.msg ?? ''));
      const retryLines = alarms.filter((e) => /left pending for the next tick/.test(e.msg ?? ''));
      assert.equal(alarms.length, MAX_DELIVERY_ATTEMPTS, 'one alarm per failed attempt, no more');
      assert.equal(parkedLines.length, 1, 'the PARKED sentence fires exactly once');
      assert.equal(retryLines.length, MAX_DELIVERY_ATTEMPTS - 1);
      assert.equal(parkedLines[0]?.obj.parked, undefined, 'parked must not be an identifying scalar');
      assert.equal(
        parkedLines[0]?.obj.attempts,
        undefined,
        'attempts must not be an identifying scalar',
      );
      assert.match(
        parkedLines[0]?.msg ?? '',
        new RegExp(`PARKED after ${MAX_DELIVERY_ATTEMPTS} attempts`),
        'the count belongs in the sentence, where digit-normalisation collapses it',
      );
      assert.match(parkedLines[0]?.msg ?? '', /needs a human/);
    } finally {
      restore();
      await clearScheduled();
    }
  },
);

test(
  'unparkByDedupeKey — clearing failed_at puts a parked row back in the queue and it delivers',
  SKIP_WHEN_NO_DB,
  async () => {
    await clearScheduled();
    const dedupeKey = 'test:unpark-poison';
    const poisonId = await seedDueScheduledRow({
      scheduledFor: new Date('2026-01-01T00:00:00Z'),
      dedupeKey,
      title: POISON_TITLE,
    });
    const errors: ErrorLine[] = [];
    const restore = poisonDelivery();
    try {
      for (let attempt = 1; attempt <= MAX_DELIVERY_ATTEMPTS; attempt++) {
        await runSchedulerTickOnce({
          expoPush: makeExpoPushStub(),
          log: makeErrorLog(errors),
          now: new Date('2026-05-26T12:00:00Z'),
        });
      }
      assert.ok((await readParking(poisonId)).failedAt, 'precondition: the row is parked');
    } finally {
      // The human fixed the cause; delivery works again from here.
      restore();
    }

    const unparked = await db.transaction(async (tx) =>
      scheduledNotificationsRepository.unparkByDedupeKey(tx, dedupeKey),
    );
    assert.equal(unparked, 1);
    const cleared = await readParking(poisonId);
    assert.equal(cleared.failedAt, null);
    assert.equal(cleared.attempts, 0, 'the retry budget is restored, not left spent');

    const result = await runSchedulerTickOnce({
      expoPush: makeExpoPushStub(),
      now: new Date('2026-05-26T12:00:00Z'),
    });
    assert.equal(result.scheduledNotifications.scanned, 1, 'an unparked row is claimed again');
    assert.equal(result.scheduledNotifications.sent, 1);
    assert.equal(result.scheduledNotifications.failed, 0);
    assert.equal((await readParking(poisonId)).status, 'sent');

    await clearScheduled();
  },
);

test(
  'cancelPendingByDedupePrefix — still cancels a PARKED row (parking does not cost a status)',
  SKIP_WHEN_NO_DB,
  async () => {
    await clearScheduled();
    const dedupeKey = 'spay-neuter:parked-row:2026-09-03';
    const rowId = await seedDueScheduledRow({
      scheduledFor: new Date('2026-01-01T00:00:00Z'),
      dedupeKey,
    });
    // Park it at the repository seam — this test is about what parking does to
    // the OTHER predicates, not about how the worker gets there.
    await db.transaction(async (tx) => {
      for (let i = 0; i < MAX_DELIVERY_ATTEMPTS; i++) {
        await scheduledNotificationsRepository.recordAttemptFailure(tx, {
          id: rowId,
          error: 'parked on purpose',
          maxAttempts: MAX_DELIVERY_ATTEMPTS,
        });
      }
    });
    const parked = await readParking(rowId);
    assert.ok(parked.failedAt, 'precondition: parked');
    assert.equal(parked.status, 'pending', 'a parked row is still pending by design');

    const cancelled = await db.transaction(async (tx) =>
      scheduledNotificationsRepository.cancelPendingByDedupePrefix(tx, 'spay-neuter:parked-row:'),
    );
    assert.equal(cancelled, 1, 'the supersession path must still reach a parked row');
    assert.equal((await readParking(rowId)).status, 'cancelled');

    await clearScheduled();
  },
);


// ── fix round 1 (2026-09-03): what the two attack lanes found ───────────────
// designs/phase-1-poison-row-isolation.md § A1 as corrected by § A1-R. Each of
// these was proven RED against the shipped tree before the fix landed; the
// mutation that reproduces the red is named on each.

test(
  'runSchedulerTickOnce — when EVERY claimed row fails it is SYSTEMIC: no attempt is spent, nothing parks, and the queue comes back when the cause is fixed',
  SKIP_WHEN_NO_DB,
  async () => {
    // A1.1, the blocker. Charging an attempt at the moment of the throw cannot
    // tell "this row is broken" from "the database is broken". A column drift
    // one table over, or a three-minute statement-timeout episode, fails EVERY
    // claimed row every tick — and three ticks later every due reminder,
    // `payment-failed`, `invoice-overdue` and `card-expiring` row was parked,
    // the tick answered 200, the watchdog was green, and fixing the cause
    // brought none of them back. Executed by both lanes before this fix.
    await clearScheduled();
    const ids = [
      await seedDueScheduledRow({
        scheduledFor: new Date('2026-01-01T00:00:00Z'),
        dedupeKey: 'test:systemic-1',
        title: POISON_TITLE,
      }),
      await seedDueScheduledRow({
        scheduledFor: new Date('2026-01-02T00:00:00Z'),
        dedupeKey: 'test:systemic-2',
        title: POISON_TITLE,
      }),
      await seedDueScheduledRow({
        scheduledFor: new Date('2026-01-03T00:00:00Z'),
        dedupeKey: 'test:systemic-3',
        title: POISON_TITLE,
      }),
    ];
    const errors: ErrorLine[] = [];
    const restore = poisonDelivery();
    try {
      // Three ticks — MAX_DELIVERY_ATTEMPTS of them, so under the old
      // per-row accounting every one of these rows would be parked by now.
      for (let tick = 1; tick <= MAX_DELIVERY_ATTEMPTS; tick++) {
        const result = await runSchedulerTickOnce({
          expoPush: makeExpoPushStub(),
          log: makeErrorLog(errors),
          now: new Date('2026-05-26T12:00:00Z'),
        });
        assert.equal(result.scheduledNotifications.scanned, 3, `tick ${tick} must claim all three`);
        assert.equal(result.scheduledNotifications.sent, 0);
        assert.equal(result.scheduledNotifications.failed, 3, 'all three failed');
        assert.equal(result.scheduledNotifications.parked, 0, 'a systemic failure parks nothing');
        // A2.1, and the half of this ruling the systemic branch created: the
        // queue is NOT delivering. Nothing parks, `parkedTotal` reads 0, and
        // before this leaf existed the only notice was a pager line — so a
        // whole-queue outage was pager-only for as long as it lasted, on the
        // one instrument whose purpose is to survive Sentry dying.
        assert.equal(
          result.scheduledNotifications.queueOk,
          false,
          `tick ${tick}: a systemic all-fail batch is NOT a delivering queue`,
        );
        for (const id of ids) {
          const parking = await readParking(id);
          assert.equal(parking.status, 'pending', `row ${id} stays pending`);
          assert.equal(parking.attempts, 0, `row ${id} must not spend an attempt on an outage`);
          assert.equal(parking.lastError, null, `row ${id} must be untouched`);
          assert.equal(parking.failedAt, null, `row ${id} must not park`);
        }
      }

      // ONE phase-level alarm per tick, naming no row: the sentence is constant
      // apart from digits (which the pager normalises) and the first error's
      // text, so a continuing outage is ONE condition rather than 3 × N pages.
      const alarms = phase1Alarms(errors);
      assert.equal(
        alarms.length,
        MAX_DELIVERY_ATTEMPTS,
        `expected one systemic alarm per tick; got ${JSON.stringify(alarms.map((a) => a.msg))}`,
      );
      for (const alarm of alarms) {
        assert.match(alarm.msg ?? '', /every claimed row failed \(3 of 3\)/);
        assert.match(alarm.msg ?? '', /treating as systemic, no attempts spent/);
        assert.match(alarm.msg ?? '', new RegExp(POISON_ERROR), 'the cause rides the sentence');
        // A2.2. `batchSize` used to be here, and `identifyingExtra`
        // (`observability.ts`) renders every scalar in this object
        // UN-NORMALISED — so an outage whose batch grew 2 → 10 as the queue
        // backed up minted a fresh first-ever fingerprint on every tick:
        // executed twice, independently, nine ticks paged NINE times against
        // three as designed. The count rides the SENTENCE below, where digits
        // normalise to `N`.
        //
        // **The KEY SET, not two names** (A3.4). The earlier version of this
        // assertion read `batchSize === undefined` and `scheduledId ===
        // undefined`, which pins the two fields that were removed and nothing
        // about the ones nobody has added yet: a later change putting
        // `firstError` — or a row id, or a duration — into this object keeps
        // the suite green and restores the page-per-tick defect A2.2 was ruled
        // to fix. The invariant is that NOTHING in here varies between ticks of
        // one outage, and the only way to assert that is to enumerate it.
        assert.deepStrictEqual(
          Object.keys(alarm.obj).sort(),
          ['phase', 'workerTick'],
          'a systemic alarm names no row and no count: every scalar in this object is an ' +
            'un-normalised part of the pager fingerprint, so anything that varies pages per tick',
        );
        assert.match(alarm.msg ?? '', /every claimed row failed \(3 of 3\)/);
      }
    } finally {
      restore();
    }

    // The cause is fixed. Nothing was parked, so the next tick delivers all
    // three — this is the self-healing the shipped tree destroyed.
    const recovered = await runSchedulerTickOnce({
      expoPush: makeExpoPushStub(),
      now: new Date('2026-05-26T12:00:00Z'),
    });
    assert.equal(recovered.scheduledNotifications.scanned, 3, 'all three are still claimable');
    assert.equal(recovered.scheduledNotifications.sent, 3, 'and all three deliver');
    // …and the signal clears on its own the moment the cause is gone (A2.1).
    // A red that cannot go green is a red nobody keeps watching.
    assert.equal(recovered.scheduledNotifications.queueOk, true, 'the signal must clear');
    for (const id of ids) {
      assert.equal((await readParking(id)).status, 'sent');
    }

    await clearScheduled();
  },
);

test(
  'runSchedulerTickOnce — a batch of ONE that fails takes the POISON path (the ambiguous case is ruled toward parking)',
  SKIP_WHEN_NO_DB,
  async () => {
    // A1.1's explicit carve-out. One row and one failure look identical whether
    // the row or the database is broken; treating that as systemic would mean a
    // permanently broken row could never park as long as it was alone in its
    // batch — the every-minute-forever alarm the design rejected.
    await clearScheduled();
    const soloId = await seedDueScheduledRow({
      scheduledFor: new Date('2026-01-01T00:00:00Z'),
      dedupeKey: 'test:systemic-solo',
      title: POISON_TITLE,
    });
    const errors: ErrorLine[] = [];
    const restore = poisonDelivery();
    try {
      const result = await runSchedulerTickOnce({
        expoPush: makeExpoPushStub(),
        log: makeErrorLog(errors),
        now: new Date('2026-05-26T12:00:00Z'),
      });
      assert.equal(result.scheduledNotifications.scanned, 1);
      assert.equal(result.scheduledNotifications.failed, 1);
      // A2.1: the poison path is not the systemic branch, so the queue reads
      // OK. The row's own parked signal (A1.6) is what makes this visible —
      // this leaf answers a different question.
      assert.equal(result.scheduledNotifications.queueOk, true, 'the poison path is delivering');
      const parking = await readParking(soloId);
      assert.equal(parking.attempts, 1, 'a lone failing row DOES spend an attempt');
      assert.match(String(parking.lastError), new RegExp(POISON_ERROR));
      const alarms = phase1Alarms(errors, soloId);
      assert.equal(alarms.length, 1, 'and it gets the per-ROW alarm, not the systemic one');
      assert.match(alarms[0]?.msg ?? '', /attempt 1 of 3/);
    } finally {
      restore();
      await clearScheduled();
    }
  },
);

test(
  'recordAttemptFailure — a row that vanished under the claim reports `gone`, not a first attempt',
  SKIP_WHEN_NO_DB,
  async () => {
    // A1.5 / O12. `{ attempts: 0, parked: false }` is a first attempt's shape,
    // and logging "attempt 0 of 3 — row left pending for the next tick" about a
    // row that no longer exists tells a human to wait for a retry that nothing
    // will run.
    const outcome = await db.transaction(async (tx) =>
      scheduledNotificationsRepository.recordAttemptFailure(tx, {
        id: randomUUID(),
        error: 'this row does not exist',
        maxAttempts: MAX_DELIVERY_ATTEMPTS,
      }),
    );
    assert.deepStrictEqual(outcome, { outcome: 'gone' });
  },
);

test(
  'recordAttemptFailure — a throw from the RECORDING escapes to the phase boundary, loudly; it is never swallowed',
  SKIP_WHEN_NO_DB,
  async () => {
    // A1.5 as re-ruled by the refutation pass. "try/catch, log, continue" here
    // is actively harmful: if the recording failed because the transaction is
    // already ABORTED, every later statement is 25P02 and the COMMIT degrades
    // to a silent ROLLBACK — the tick would report sent 2 / failed 1 and commit
    // nothing at all, with no boundary alarm. So the throw is allowed out.
    await clearScheduled();
    const goodId = await seedDueScheduledRow({
      scheduledFor: new Date('2026-01-01T00:00:00Z'),
      dedupeKey: 'test:record-throws-good',
    });
    const poisonId = await seedDueScheduledRow({
      scheduledFor: new Date('2026-01-02T00:00:00Z'),
      dedupeKey: 'test:record-throws-poison',
      title: POISON_TITLE,
    });
    const errors: ErrorLine[] = [];
    const restore = poisonDelivery();
    const originalRecord = scheduledNotificationsRepository.recordAttemptFailure;
    scheduledNotificationsRepository.recordAttemptFailure = async () => {
      throw new Error('fetchd_record_attempt_exploded');
    };
    try {
      const result = await runSchedulerTickOnce({
        expoPush: makeExpoPushStub(),
        log: makeErrorLog(errors),
        now: new Date('2026-05-26T12:00:00Z'),
      });
      // The phase reports its empty default — the batch rolled back — and the
      // tick still ran its other phases.
      assert.equal(result.scheduledNotifications.scanned, 0);
      assert.equal(result.scheduledNotifications.sent, 0);
      assert.equal(result.scheduledNotifications.parkedTotal, null);
      // …and the queue reads NOT-delivering (A2.1): the batch rolled back, so
      // nothing was delivered, and the boundary default says so.
      assert.equal(result.scheduledNotifications.queueOk, false);
      assert.equal(typeof result.idempotencyKeysSwept, 'number');

      const boundary = phase1Alarms(errors).filter((e) => /worker boundary/.test(e.msg ?? ''));
      assert.equal(
        boundary.length,
        1,
        `the throw must reach the phase boundary; alarms were ${JSON.stringify(
          phase1Alarms(errors).map((e) => e.msg),
        )}`,
      );
      assert.match(String(boundary[0]?.obj.err), /fetchd_record_attempt_exploded/);

      // And the batch really did roll back: the healthy row is NOT sent. That
      // is the honest outcome — the alternative is committing a lie.
      assert.equal((await readParking(goodId)).status, 'pending');
      assert.equal((await readParking(poisonId)).attempts, 0);
    } finally {
      scheduledNotificationsRepository.recordAttemptFailure = originalRecord;
      restore();
      await clearScheduled();
    }
  },
);

test(
  'revivePendingByDedupeKey — a revive UN-PARKS: the re-armed reminder is claimed and delivered',
  SKIP_WHEN_NO_DB,
  async () => {
    // A1.2, executed by both lanes: revive set only status + scheduled_for, so
    // a revived parked row was pending, due, and permanently invisible to the
    // claim. `syncSpayNeuterReminder` reported cancelled 1 / revived 1 on every
    // save of the dog, the reminder looked scheduled everywhere, and it never
    // fired and never alarmed again.
    await clearScheduled();
    const dedupeKey = 'spay-neuter:revive-parked:2026-10-01';
    const scheduledFor = new Date('2026-01-01T00:00:00Z');
    const rowId = await seedDueScheduledRow({
      scheduledFor,
      dedupeKey,
      type: 'spay-neuter-reminder',
      trigger: 'spay-neuter-reminder',
      title: POISON_TITLE,
    });

    // Park it the way production does — three failed delivery attempts.
    const errors: ErrorLine[] = [];
    const restore = poisonDelivery();
    try {
      for (let attempt = 1; attempt <= MAX_DELIVERY_ATTEMPTS; attempt++) {
        await runSchedulerTickOnce({
          expoPush: makeExpoPushStub(),
          log: makeErrorLog(errors),
          now: new Date('2026-05-26T12:00:00Z'),
        });
      }
      assert.ok((await readParking(rowId)).failedAt, 'precondition: the row is parked');
    } finally {
      restore(); // the human fixed the cause; delivery works from here
    }

    // The three steps `syncSpayNeuterReminder` runs on every save of the dog,
    // verbatim: cancel the prefix, re-enqueue (ON CONFLICT DO NOTHING → the row
    // already exists, so `undefined`), revive.
    await db.transaction(async (tx) => {
      const cancelled = await scheduledNotificationsRepository.cancelPendingByDedupePrefix(
        tx,
        'spay-neuter:revive-parked:',
      );
      assert.equal(cancelled, 1, 'cancel still reaches a parked row');
      const enqueued = await scheduledNotificationsRepository.enqueueIdempotent(tx, {
        ownerId: OWNER_ID,
        type: 'spay-neuter-reminder',
        trigger: 'spay-neuter-reminder',
        dedupeKey,
        scheduledFor,
        title: 'Is Rex spayed/neutered yet?',
        body: 'update their profile',
      });
      assert.equal(enqueued, undefined, 'the UNIQUE dedupe_key makes the re-enqueue a no-op');
      const revived = await scheduledNotificationsRepository.revivePendingByDedupeKey(tx, {
        dedupeKey,
        scheduledFor,
      });
      assert.equal(revived, 1);
    });

    const revivedRow = await readParking(rowId);
    assert.equal(revivedRow.status, 'pending');
    assert.equal(revivedRow.failedAt, null, 'a revive is a fresh intent — it un-parks');
    assert.equal(revivedRow.attempts, 0, 'and restores the retry budget');

    const result = await runSchedulerTickOnce({
      expoPush: makeExpoPushStub(),
      now: new Date('2026-05-26T12:00:00Z'),
    });
    assert.equal(result.scheduledNotifications.scanned, 1, 'a revived row is claimed again');
    assert.equal(result.scheduledNotifications.sent, 1, 'and it is delivered');
    assert.equal((await readParking(rowId)).status, 'sent');

    await clearScheduled();
  },
);

test(
  'recordAttemptFailure — a row already PAST the ceiling parks on its next failure (`>=`, not `==`)',
  SKIP_WHEN_NO_DB,
  async () => {
    // A1.9b / O14. Exactly the state every currently-parked row is in the
    // moment MAX_DELIVERY_ATTEMPTS drops from 5 to 3, and the state a
    // hand-edited row can be in at any time. `==` would retry it forever.
    await clearScheduled();
    const rowId = await seedDueScheduledRow({
      scheduledFor: new Date('2026-01-01T00:00:00Z'),
      dedupeKey: 'test:past-the-ceiling',
      title: POISON_TITLE,
    });
    await db
      .update(scheduledNotifications)
      .set({ attempts: MAX_DELIVERY_ATTEMPTS + 2 })
      .where(eq(scheduledNotifications.id, rowId));

    const errors: ErrorLine[] = [];
    const restore = poisonDelivery();
    try {
      const result = await runSchedulerTickOnce({
        expoPush: makeExpoPushStub(),
        log: makeErrorLog(errors),
        now: new Date('2026-05-26T12:00:00Z'),
      });
      assert.equal(result.scheduledNotifications.scanned, 1, 'it is still claimable — not parked');
      assert.equal(result.scheduledNotifications.failed, 1);
      assert.equal(result.scheduledNotifications.parked, 1, 'one failure past the ceiling parks it');
      const parking = await readParking(rowId);
      assert.equal(parking.attempts, MAX_DELIVERY_ATTEMPTS + 3);
      assert.ok(parking.failedAt, 'failed_at must be stamped');
    } finally {
      restore();
      await clearScheduled();
    }
  },
);

test(
  "the per-row alarm is TWO pager conditions across a row's whole life, not one per attempt",
  SKIP_WHEN_NO_DB,
  async (t) => {
    // A1.4, corrected by the refutation pass: two fingerprints, not one — the
    // retry line and the deliberately-distinct PARKED line. `attempts` in the
    // merge object made it MAX, because `identifyingExtra` puts every scalar in
    // the fingerprint un-normalised while digits in the MESSAGE normalise to
    // `N`. At MAX = 3 the page count happens to be the same either way
    // (IDENTICAL_ALLOWANCE = 3 admits all three), so this measures the
    // FINGERPRINTS: each distinct condition is raised past the allowance and
    // the pages it is granted are counted.
    await clearScheduled();
    const rowId = await seedDueScheduledRow({
      scheduledFor: new Date('2026-01-01T00:00:00Z'),
      dedupeKey: 'test:fingerprint-poison',
      title: POISON_TITLE,
    });
    const errors: ErrorLine[] = [];
    const restore = poisonDelivery();
    try {
      for (let attempt = 1; attempt <= MAX_DELIVERY_ATTEMPTS; attempt++) {
        await runSchedulerTickOnce({
          expoPush: makeExpoPushStub(),
          log: makeErrorLog(errors),
          now: new Date('2026-05-26T12:00:00Z'),
        });
      }
    } finally {
      restore();
      await clearScheduled();
    }
    const alarms = phase1Alarms(errors, rowId);
    assert.equal(alarms.length, MAX_DELIVERY_ATTEMPTS, 'precondition: one line per attempt');

    // Replay the captured lines through the REAL pager, each condition raised
    // more times than the allowance, so the number of pages delivered is
    // (distinct fingerprints × IDENTICAL_ALLOWANCE) rather than the raw count.
    const events: AlarmEvent[] = [];
    initObservability({
      transport: {
        send(event: AlarmEvent): Promise<void> {
          events.push(event);
          return Promise.resolve();
        },
      },
      installProcessHandlers: false,
    });
    t.after(() => {
      // Drop the recording transport again — global pager state.
      initObservability({ installProcessHandlers: false });
    });
    for (let replay = 0; replay <= IDENTICAL_ALLOWANCE; replay += 1) {
      for (const alarm of alarms) {
        captureAlarm({
          message: alarm.msg ?? '',
          level: 'error',
          logger: 'pino',
          extra: alarm.obj,
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    await flushObservability(500);

    assert.equal(
      events.length,
      2 * IDENTICAL_ALLOWANCE,
      `a poison row must be TWO pager conditions (the retry line and the PARKED line), ` +
        `each capped at IDENTICAL_ALLOWANCE; ${events.length} pages means ` +
        `${events.length / IDENTICAL_ALLOWANCE} fingerprints`,
    );
  },
);

test(
  'the two ops-verb one-liners: unparkByDedupeKey only touches a PARKED row, countDuePending ignores one',
  SKIP_WHEN_NO_DB,
  async () => {
    // A1.9c and A1.9d. Both are answers a human reads back: `unparkByDedupeKey`
    // returning 1 for a row that was never parked reads as "unparked" while
    // having quietly reset a healthy row's counters, and `countDuePending`
    // counting parked rows says "due pending" about rows the worker will never
    // claim — the opposite of what it will do with them.
    await clearScheduled();
    const parkedKey = 'test:oneliners-parked';
    const healthyKey = 'test:oneliners-healthy';
    const parkedId = await seedDueScheduledRow({
      scheduledFor: new Date('2026-01-01T00:00:00Z'),
      dedupeKey: parkedKey,
    });
    await seedDueScheduledRow({
      scheduledFor: new Date('2026-01-02T00:00:00Z'),
      dedupeKey: healthyKey,
    });
    await db.transaction(async (tx) => {
      for (let i = 0; i < MAX_DELIVERY_ATTEMPTS; i += 1) {
        await scheduledNotificationsRepository.recordAttemptFailure(tx, {
          id: parkedId,
          error: 'parked on purpose',
          maxAttempts: MAX_DELIVERY_ATTEMPTS,
        });
      }
    });
    assert.ok((await readParking(parkedId)).failedAt, 'precondition: one row is parked');

    // Two due rows exist; only ONE of them is claimable, and this counter has
    // to agree with the claim.
    assert.equal(
      await scheduledNotificationsRepository.countDuePending(db, new Date('2026-05-26T12:00:00Z')),
      1,
      'a parked row is not "due pending" — the worker will never claim it',
    );

    // Un-parking a row that is not parked is a no-op that SAYS it is a no-op.
    const touchedHealthy = await db.transaction(async (tx) =>
      scheduledNotificationsRepository.unparkByDedupeKey(tx, healthyKey),
    );
    assert.equal(touchedHealthy, 0, '0 means "nothing was parked under that key"');
    const touchedParked = await db.transaction(async (tx) =>
      scheduledNotificationsRepository.unparkByDedupeKey(tx, parkedKey),
    );
    assert.equal(touchedParked, 1);
    assert.equal((await readParking(parkedId)).failedAt, null);

    await clearScheduled();
  },
);
