import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { creditExpirySettingsRepository } from '../../src/db/repositories/creditExpirySettingsRepository.js';
import { DEFAULT_WARNING_LEAD_DAYS } from '../../src/lib/creditExpiry.js';
import { enqueueCreditExpiryWarnings } from '../../src/lib/enqueueCreditExpiryWarnings.js';
import { withActor } from '../../src/db/tx.js';
import {
  creditExpirySettings,
  creditLedger,
  notifications,
  scheduledNotifications,
} from '../../src/db/schema/schema.js';
import { FIXTURE_IDS } from './_fixture.js';
import { SKIP_WHEN_NO_DB, registerFixtureHooks } from './_harness.js';

/**
 * Credit-expiry Phase-3 — the credits-expiring scheduled scan
 * (`enqueueCreditExpiryWarnings`) + `resolveWarningLeadDays`.
 *
 * Invariants under test:
 *   - a live, non-exhausted lot WITHIN its location's warning window enqueues
 *     exactly ONE `credits-expiring` scheduled notification to the lot's owner
 *   - a SECOND scan does NOT re-enqueue (dedup on `credits-expiring:<lotId>`)
 *   - a lot OUTSIDE the window (expiry beyond now + lead days) is not enqueued
 *   - `resolveWarningLeadDays` fallback chain: override → org-default → 60
 *
 * Each test seeds its own lot under a unique id and tears it down so order
 * doesn't matter; `credit_expiry_settings` is reset to its (NULL,12,60) seed.
 */

registerFixtureHooks();

const SCAN_ACTOR = 'system:scheduler';
const SEEDED_WINDOW_MONTHS = 12;
const SEEDED_WARNING_LEAD_DAYS = 60;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

async function resetCreditExpirySettings(): Promise<void> {
  await db.delete(creditExpirySettings);
  await db.insert(creditExpirySettings).values({
    location: null,
    expiryWindowMonths: SEEDED_WINDOW_MONTHS,
    warningLeadDays: SEEDED_WARNING_LEAD_DAYS,
    updatedByStaffId: null,
  });
}

/** Insert a single purchase lot for dog1 with a given expiry + remaining count. */
async function seedLot(args: { lotId: string; expiresAt: Date; credits: number }): Promise<void> {
  await db.insert(creditLedger).values({
    id: args.lotId,
    dogId: FIXTURE_IDS.dog1Id,
    mode: 'school',
    location: 'fayetteville',
    delta: args.credits,
    reason: 'purchase',
    expiresAt: args.expiresAt.toISOString(),
    lotId: null,
  });
}

async function clearScanState(lotIds: string[]): Promise<void> {
  await db
    .update(scheduledNotifications)
    .set({ emittedNotificationId: null })
    .where(eq(scheduledNotifications.ownerId, FIXTURE_IDS.ownerId));
  await db.delete(notifications).where(eq(notifications.ownerId, FIXTURE_IDS.ownerId));
  await db.delete(scheduledNotifications).where(
    inArray(
      scheduledNotifications.dedupeKey,
      lotIds.map((id) => `credits-expiring:${id}`),
    ),
  );
  if (lotIds.length > 0) {
    await db.delete(creditLedger).where(inArray(creditLedger.id, lotIds));
  }
}

async function scheduledForLot(lotId: string): Promise<{
  count: number;
  type: string | null;
  deepLinkPath: string | null;
  deepLinkKind: string | null;
  deepLinkId: string | null;
}> {
  const rows = await db
    .select({
      type: scheduledNotifications.type,
      deepLinkPath: scheduledNotifications.deepLinkPath,
      deepLinkKind: scheduledNotifications.deepLinkKind,
      deepLinkId: scheduledNotifications.deepLinkId,
    })
    .from(scheduledNotifications)
    .where(eq(scheduledNotifications.dedupeKey, `credits-expiring:${lotId}`));
  return {
    count: rows.length,
    type: rows[0]?.type ?? null,
    deepLinkPath: rows[0]?.deepLinkPath ?? null,
    deepLinkKind: rows[0]?.deepLinkKind ?? null,
    deepLinkId: rows[0]?.deepLinkId ?? null,
  };
}

test(
  'credits-expiring scan — in-window lot enqueues exactly once, second tick does NOT re-enqueue',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetCreditExpirySettings();
    const lotId = randomUUID();
    await clearScanState([lotId]);
    // Anchor `now` on the REAL clock, not a hardcoded literal. The production
    // scan's live-lot floor is `expires_at > now()` in Postgres (real time),
    // which we cannot change — so a fixed past `now` lets the lot's now+30d
    // expiry fall behind the real clock and drop out of the scan (the rot).
    // A real-clock anchor keeps the 30d-out lot inside BOTH that floor and the
    // 60d window ceiling (now + lead) on every calendar day, and the single
    // captured instant flows to both the seed and the enqueue call.
    const now = new Date();
    // Expiry 30 days out — inside the 60-day org-default window.
    await seedLot({ lotId, expiresAt: new Date(now.getTime() + 30 * ONE_DAY_MS), credits: 5 });

    const first = await withActor(SCAN_ACTOR, (tx) => enqueueCreditExpiryWarnings(tx, now));
    assert.equal(first.scanned, 1, 'one in-window lot scanned');
    assert.equal(first.enqueued, 1, 'enqueued once');

    const afterFirst = await scheduledForLot(lotId);
    assert.equal(afterFirst.count, 1, 'exactly one scheduled row for the lot');
    assert.equal(afterFirst.type, 'credits-expiring');
    // Decision 4: credits UI lives on the dog profile, keyed on the lot's dog.
    assert.equal(afterFirst.deepLinkPath, `/dog-profile/${FIXTURE_IDS.dog1Id}`);
    assert.equal(afterFirst.deepLinkKind, 'dog-profile');
    assert.equal(afterFirst.deepLinkId, FIXTURE_IDS.dog1Id);

    // Second tick — the lot is still in-window, but the dedupe key blocks re-enqueue.
    const second = await withActor(SCAN_ACTOR, (tx) => enqueueCreditExpiryWarnings(tx, now));
    assert.equal(second.scanned, 1, 'still scanned (the lot still qualifies)');
    assert.equal(second.enqueued, 0, 'DEDUP: no new enqueue on the second tick');
    const afterSecond = await scheduledForLot(lotId);
    assert.equal(afterSecond.count, 1, 'still exactly one scheduled row — never doubled');

    await clearScanState([lotId]);
  },
);

test(
  'credits-expiring scan — lot BEYOND the warning window is not enqueued',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetCreditExpirySettings();
    const lotId = randomUUID();
    await clearScanState([lotId]);
    const now = new Date('2026-06-20T12:00:00Z');
    // Expiry 200 days out — well beyond the 60-day window.
    await seedLot({ lotId, expiresAt: new Date(now.getTime() + 200 * ONE_DAY_MS), credits: 5 });

    const result = await withActor(SCAN_ACTOR, (tx) => enqueueCreditExpiryWarnings(tx, now));
    assert.equal(result.scanned, 0, 'out-of-window lot is not scanned');
    assert.equal(result.enqueued, 0);
    assert.equal((await scheduledForLot(lotId)).count, 0);

    await clearScanState([lotId]);
  },
);

test(
  'resolveWarningLeadDays — override beats org-default beats code default (60)',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetCreditExpirySettings();
    // Only the org-default (60) exists → both locations resolve to it.
    assert.equal(await creditExpirySettingsRepository.resolveWarningLeadDays('fayetteville'), 60);

    // A fayetteville override wins for fayetteville; bentonville still org-default.
    await db.transaction((tx) =>
      creditExpirySettingsRepository.upsert(tx, {
        location: 'fayetteville',
        expiryWindowMonths: 12,
        warningLeadDays: 14,
        staffId: FIXTURE_IDS.staffDonavanId,
      }),
    );
    assert.equal(
      await creditExpirySettingsRepository.resolveWarningLeadDays('fayetteville'),
      14,
      'override wins for its location',
    );
    assert.equal(
      await creditExpirySettingsRepository.resolveWarningLeadDays('bentonville'),
      60,
      'no override → org-default',
    );

    // Move the org-default to a value distinct from the code default, so the
    // bentonville read can't be the code default by coincidence.
    const DISTINCT_ORG_LEAD = 21;
    await db.transaction((tx) =>
      creditExpirySettingsRepository.upsert(tx, {
        location: null,
        expiryWindowMonths: SEEDED_WINDOW_MONTHS,
        warningLeadDays: DISTINCT_ORG_LEAD,
        staffId: FIXTURE_IDS.staffDonavanId,
      }),
    );
    assert.equal(
      await creditExpirySettingsRepository.resolveWarningLeadDays('bentonville'),
      DISTINCT_ORG_LEAD,
      'reads the org-default ROW, not a baked constant',
    );

    // Delete every row → only the code default (60) can answer.
    await db.delete(creditExpirySettings);
    assert.equal(
      await creditExpirySettingsRepository.resolveWarningLeadDays('bentonville'),
      DEFAULT_WARNING_LEAD_DAYS,
      'code default when neither override nor org-default exists',
    );
    await resetCreditExpirySettings();
  },
);

test(
  'credits-expiring scan — a per-location override widens/narrows the window',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetCreditExpirySettings();
    const lotId = randomUUID();
    await clearScanState([lotId]);
    const now = new Date('2026-06-20T12:00:00Z');
    // Expiry 100 days out — OUTSIDE the 60-day default but INSIDE a 120-day override.
    await seedLot({ lotId, expiresAt: new Date(now.getTime() + 100 * ONE_DAY_MS), credits: 3 });

    // Default 60d window → not in window.
    const beforeOverride = await withActor(SCAN_ACTOR, (tx) =>
      enqueueCreditExpiryWarnings(tx, now),
    );
    assert.equal(beforeOverride.enqueued, 0, '100d out is beyond the 60d default');

    // fayetteville override to 120d → now in window.
    await db.transaction((tx) =>
      creditExpirySettingsRepository.upsert(tx, {
        location: 'fayetteville',
        expiryWindowMonths: SEEDED_WINDOW_MONTHS,
        warningLeadDays: 120,
        staffId: FIXTURE_IDS.staffDonavanId,
      }),
    );
    const afterOverride = await withActor(SCAN_ACTOR, (tx) => enqueueCreditExpiryWarnings(tx, now));
    assert.equal(afterOverride.enqueued, 1, '120d window now covers the 100d-out lot');
    assert.equal((await scheduledForLot(lotId)).count, 1);

    await clearScanState([lotId]);
    await resetCreditExpirySettings();
  },
);
