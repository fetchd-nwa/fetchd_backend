import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../client.js';
import { deviceTokens } from '../schema/schema.js';
import type { Tx } from '../tx.js';

/** Polymorphic runner — pool for pre/post-tx reads, Tx for in-mutation work. */
type Runner = Tx | typeof db;

/**
 * Data-access seam for `device_tokens` (schema.sql ~line 1148). Registered
 * Expo push tokens per owner/device. The scheduler reads via
 * `findLiveByOwner` to fan a push out to every live device the owner has
 * registered (an owner may have multiple devices — phone + tablet — and
 * each gets the push).
 *
 * Day-16 shipped the read side. Day-18c adds the write verbs the FE drives:
 * `upsert` (POST /device-tokens — register on app foreground) and
 * `softExpireByToken` (DELETE /device-tokens/:token — revoke on opt-out /
 * sign-out).
 *
 * `expired_at IS NULL` is the live-token filter (the partial unique index
 * `device_tokens_uidx` enforces "one live row per (owner, expo_push_token)";
 * a revoked token can be re-registered without UNIQUE collision).
 */

export type DevicePlatform = 'ios' | 'android';

export interface DeviceTokenRow {
  id: string;
  ownerId: string;
  expoPushToken: string;
  platform: DevicePlatform;
}

/**
 * `DeviceTokenRow` plus `createdAt` — the wire response for POST needs the
 * registration timestamp (`created_at` → `registered_at` on the wire). The
 * scheduler's `findLiveByOwner` deliberately omits it (it only needs the
 * token + platform to dispatch), so it stays off the base row.
 */
export interface RegisteredDeviceTokenRow extends DeviceTokenRow {
  /** PG timestamptz string (drizzle `mode: 'string'`); route maps to ISO. */
  createdAt: string;
}

const DEVICE_TOKEN_PROJECTION = {
  id: deviceTokens.id,
  ownerId: deviceTokens.ownerId,
  expoPushToken: deviceTokens.expoPushToken,
  platform: deviceTokens.platform,
} as const;

const REGISTERED_DEVICE_TOKEN_PROJECTION = {
  ...DEVICE_TOKEN_PROJECTION,
  createdAt: deviceTokens.createdAt,
} as const;

export const deviceTokensRepository = {
  /**
   * Every live device token for one owner. Used by the scheduler to fan
   * a single notification out to all of the owner's registered devices.
   * An owner with zero registered devices returns an empty array — the
   * scheduler logs and proceeds (the in-app feed entry is still landed;
   * push is best-effort).
   */
  async findLiveByOwner(runner: Runner, ownerId: string): Promise<DeviceTokenRow[]> {
    // The schema CHECK constrains `platform` to ('ios','android'); the
    // cast here narrows the column's text return to the union. Drizzle's
    // pg-core typing surfaces it as `string`.
    const rows = await runner
      .select(DEVICE_TOKEN_PROJECTION)
      .from(deviceTokens)
      .where(and(eq(deviceTokens.ownerId, ownerId), isNull(deviceTokens.expiredAt)));
    return rows.map((row) => ({
      ...row,
      platform: row.platform as DevicePlatform,
    }));
  },

  /**
   * Register (or re-touch) a live token for an owner. Idempotent at the DB
   * level via the partial unique `device_tokens_uidx`: a second register of
   * the same `(owner, token)` while a live row exists updates `platform` in
   * place rather than inserting a duplicate, and `created_at` is preserved
   * (only set on INSERT) so `registered_at` stays the first-registration
   * time. A previously-revoked token (expired_at set) is outside the partial
   * index, so re-registering inserts a fresh live row — exactly the
   * "device re-grants push" case the index predicate is designed for.
   *
   * `ON CONFLICT … DO UPDATE` (vs DO NOTHING) is deliberate: DO NOTHING
   * returns no row on conflict, forcing a second SELECT. The redundant
   * platform write fires one audit_log row per re-register; the FE dedups
   * within a session (it skips re-POSTing an unchanged token), so this is
   * roughly one row per cold start — negligible.
   */
  async upsert(
    tx: Tx,
    args: { ownerId: string; token: string; platform: DevicePlatform },
  ): Promise<RegisteredDeviceTokenRow> {
    const [row] = await tx
      .insert(deviceTokens)
      .values({
        ownerId: args.ownerId,
        expoPushToken: args.token,
        platform: args.platform,
      })
      .onConflictDoUpdate({
        target: [deviceTokens.ownerId, deviceTokens.expoPushToken],
        targetWhere: isNull(deviceTokens.expiredAt),
        set: { platform: args.platform },
      })
      .returning(REGISTERED_DEVICE_TOKEN_PROJECTION);
    if (!row) {
      throw new Error('deviceTokensRepository.upsert: INSERT returned no row');
    }
    return { ...row, platform: row.platform as DevicePlatform };
  },

  /**
   * Revoke a live token: set `expired_at = now()`. Scoped by owner so a
   * token can only be revoked by its registrant. Returns the row if it was
   * live + owned by this principal; undefined for the not-found / not-yours
   * / already-revoked cases (the route maps all three to 404 — device
   * tokens don't enumerate across owners).
   */
  async softExpireByToken(
    tx: Tx,
    args: { ownerId: string; token: string },
  ): Promise<DeviceTokenRow | undefined> {
    const [row] = await tx
      .update(deviceTokens)
      .set({ expiredAt: sql`now()` })
      .where(
        and(
          eq(deviceTokens.ownerId, args.ownerId),
          eq(deviceTokens.expoPushToken, args.token),
          isNull(deviceTokens.expiredAt),
        ),
      )
      .returning(DEVICE_TOKEN_PROJECTION);
    if (!row) return undefined;
    return { ...row, platform: row.platform as DevicePlatform };
  },
};
