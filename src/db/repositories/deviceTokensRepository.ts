import { and, eq, isNull, ne, sql } from 'drizzle-orm';
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
 *
 * From wire 9.2.0 (O-MSG-LIVE; A2 OH1; `PostDeviceTokensRequest`'s doc), a token
 * has ONE live row whoever's it is: rs3 M5.30's partial unique index
 * {@link DEVICE_TOKENS_LIVE_TOKEN_INDEX} on `(expo_push_token) WHERE expired_at
 * IS NULL`. A phone that changes family stops being the last family's device:
 * registering expires every OTHER owner's live row for the token
 * (`expireOtherOwnersLiveToken`, before `upsert`), and the DELETE expires every
 * live row holding it (`softExpireByToken`).
 */

/**
 * rs3 M5.30's one-live-row-per-token index. `POST /device-tokens` re-runs its
 * mutation once on a 23505 naming THIS constraint and no other (LR11): a
 * concurrent registration of the same token by another family.
 */
export const DEVICE_TOKENS_LIVE_TOKEN_INDEX = 'device_tokens_live_token_uidx';

/**
 * A unique violation on {@link DEVICE_TOKENS_LIVE_TOKEN_INDEX}, matched by constraint
 * name (LR11, the Opus seat's note): any other 23505 is a different story and keeps
 * failing the request. drizzle 0.36 rethrows the driver's error unwrapped.
 */
export function isLiveTokenConflict(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const record = err as { code?: unknown; constraint?: unknown };
  return record.code === '23505' && record.constraint === DEVICE_TOKENS_LIVE_TOKEN_INDEX;
}

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
   * Expire every OTHER owner's live row holding `token` (A2 OH1). Runs inside the
   * registration's transaction, before `upsert`, so the phone's new family is the
   * only one it pushes to. The registering owner's own live row is left for
   * `upsert` to touch (its `registered_at` stays the first registration's).
   * Returns how many rows it expired.
   */
  async expireOtherOwnersLiveToken(
    tx: Tx,
    args: { ownerId: string; token: string },
  ): Promise<number> {
    const rows = await tx
      .update(deviceTokens)
      .set({ expiredAt: sql`now()` })
      .where(
        and(
          eq(deviceTokens.expoPushToken, args.token),
          ne(deviceTokens.ownerId, args.ownerId),
          isNull(deviceTokens.expiredAt),
        ),
      )
      .returning({ id: deviceTokens.id });
    return rows.length;
  },

  /**
   * Revoke a token: set `expired_at = now()` on EVERY live row holding it,
   * whoever's (wire 9.2.0, `PostDeviceTokensRequest`'s doc; the Fable seat's last
   * read M1: holding the token string is holding the device). The app sends this
   * on a sign-in with push off, so the phone's previous family stops receiving
   * pushes too. Returns how many rows it expired; the route answers 204 when that
   * is at least one and 404 when it is none (never held, or already expired).
   */
  async softExpireByToken(tx: Tx, args: { token: string }): Promise<number> {
    const rows = await tx
      .update(deviceTokens)
      .set({ expiredAt: sql`now()` })
      .where(and(eq(deviceTokens.expoPushToken, args.token), isNull(deviceTokens.expiredAt)))
      .returning({ id: deviceTokens.id });
    return rows.length;
  },
};
