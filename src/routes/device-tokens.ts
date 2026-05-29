import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import {
  deviceTokensRepository,
  type DevicePlatform,
  type RegisteredDeviceTokenRow,
} from '../db/repositories/deviceTokensRepository.js';
import { ApiError } from '../lib/errors.js';
import { hashRequestBody, requireIdempotencyKey, withMutation } from '../db/mutation.js';
import { pgTimestampToIso } from '../lib/pgTimestamp.js';
import { requireOwner } from '../lib/principalNarrows.js';
import { formatZodIssues } from '../lib/zodIssues.js';

/**
 * `POST /device-tokens` `[auth]` · `DELETE /device-tokens/:token` `[auth]` —
 * Expo push-token registration (DATA-CONTRACT §B "Push & staff bookings";
 * schema.sql `device_tokens`, Day-16). The FE registers the device's Expo
 * token on app foreground once push permission is granted, and revokes it on
 * opt-out / sign-out.
 *
 * Both verbs are owner-scoped — staff principals get 403. Staff device
 * tokens are out of scope today: there's no staff portal app yet, so no
 * staff device has a token to register. When the portal app ships, a
 * `staff_device_tokens` surface (or a `principal_kind` column here) is the
 * extension point — not a widening of this owner-only route.
 *
 * Wire shape is client-friendly, mapped from the schema columns in
 * `toDeviceTokenWire`: request `token` ↔ column `expo_push_token`, response
 * `registered_at` ↔ column `created_at`. DATA-CONTRACT §B pins only the two
 * paths + the `:token` param, not the response field names, so these names
 * are this route's to choose; they mirror how every other route renames
 * (e.g. `payment_methods.exp_month`). One call site → wire helper stays
 * inline (promote to `lib/deviceTokenWire.ts` at a third caller).
 */

// Expo push tokens are ~40-50 chars (`ExponentPushToken[…]`); cap generously
// so a hostile client can't push arbitrarily large strings into `text`.
const DEVICE_TOKEN_MAX_LEN = 512;

interface DeviceTokenWire {
  id: string;
  owner_id: string;
  token: string;
  platform: DevicePlatform;
  registered_at: string;
}

const postBodySchema = z
  .object({
    token: z.string().min(1, 'token must not be empty').max(DEVICE_TOKEN_MAX_LEN),
    platform: z.enum(['ios', 'android']),
  })
  .strict();

const tokenParamSchema = z.object({
  token: z.string().min(1).max(DEVICE_TOKEN_MAX_LEN),
});

export function registerDeviceTokensRoute(app: FastifyInstance, opts: AuthRouteOptions = {}): void {
  const authHook = resolveAuthHook(opts);

  // --- POST /device-tokens ---------------------------------------------
  //
  // UPSERT by (owner_id, expo_push_token): registering a token the owner
  // already has live re-touches the existing row (idempotent at the DB
  // layer) rather than inserting a duplicate. `withMutation` adds the
  // request-level idempotency replay on top, so a retried POST with the
  // same Idempotency-Key returns the stored 201 without re-running the
  // upsert.
  app.post('/device-tokens', { preHandler: [authHook] }, async (request, reply) => {
    const principal = requirePrincipal(request);
    requireOwner(principal, 'register a device token');
    const { token, platform } = parsePostBody(request.body);
    const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);

    // cache-noop: device_tokens isn't in the §3 cache map (only the
    // scheduler reads them, never a cached owner-facing read).
    const outcome = await withMutation<DeviceTokenWire>(
      {
        principal,
        idempotencyKey,
        endpoint: 'POST /device-tokens',
        requestHash: hashRequestBody({ ownerId: principal.ownerId, token, platform }),
      },
      async (tx) => {
        const row = await deviceTokensRepository.upsert(tx, {
          ownerId: principal.ownerId,
          token,
          platform,
        });
        return { status: 201, body: toDeviceTokenWire(row) };
      },
    );

    reply.code(outcome.status);
    return outcome.body;
  });

  // --- DELETE /device-tokens/:token ------------------------------------
  //
  // Soft-expire the token (set `expired_at`); 204 on success, 404 when the
  // token isn't a live row for this owner. Missing + not-yours collapse to
  // 404 — same enumeration-defense shape as DELETE /payment-methods/:id.
  app.delete('/device-tokens/:token', { preHandler: [authHook] }, async (request, reply) => {
    const principal = requirePrincipal(request);
    requireOwner(principal, 'unregister a device token');
    const { token } = parseTokenParam(request.params);
    const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);

    // cache-noop: device_tokens isn't in the §3 cache map.
    const outcome = await withMutation<null>(
      {
        principal,
        idempotencyKey,
        endpoint: 'DELETE /device-tokens/:token',
        requestHash: hashRequestBody({ ownerId: principal.ownerId, token }),
      },
      async (tx) => {
        const expired = await deviceTokensRepository.softExpireByToken(tx, {
          ownerId: principal.ownerId,
          token,
        });
        if (expired === undefined) {
          // No token value in the message — enumeration defense + it's PII.
          throw new ApiError('not_found', 'device token not found');
        }
        return { status: 204, body: null };
      },
    );

    reply.code(outcome.status);
    return outcome.status === 204 ? undefined : outcome.body;
  });
}

function toDeviceTokenWire(row: RegisteredDeviceTokenRow): DeviceTokenWire {
  return {
    id: row.id,
    owner_id: row.ownerId,
    token: row.expoPushToken,
    platform: row.platform,
    registered_at: pgTimestampToIso(row.createdAt),
  };
}

function parsePostBody(body: unknown): z.infer<typeof postBodySchema> {
  const parsed = postBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError('bad_request', `invalid body: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}

function parseTokenParam(params: unknown): { token: string } {
  const parsed = tokenParamSchema.safeParse(params);
  if (!parsed.success) {
    throw new ApiError('bad_request', `invalid path: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}
