import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../client.js';
import { deviceTokens } from '../schema/schema.js';
import type { Tx } from '../tx.js';

/** Polymorphic runner — pool for pre/post-tx reads, Tx for in-mutation work. */
type Runner = Tx | typeof db;

/**
 * Data-access seam for `device_tokens` (schema.sql ~line 1113). Registered
 * Expo push tokens per owner/device. The scheduler reads via
 * `findLiveByOwner` to fan a push out to every live device the owner has
 * registered (an owner may have multiple devices — phone + tablet — and
 * each gets the push).
 *
 * Day-16 ships the read side only. Token registration (POST /device-tokens
 * + the matching revoke verb) lands at Day-18 (FE swap day) when the
 * FE actually has push tokens to send. Tests seed live rows directly.
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

const DEVICE_TOKEN_PROJECTION = {
  id: deviceTokens.id,
  ownerId: deviceTokens.ownerId,
  expoPushToken: deviceTokens.expoPushToken,
  platform: deviceTokens.platform,
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
};
