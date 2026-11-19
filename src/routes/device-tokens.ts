import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import {
  deviceTokensRepository,
  isLiveTokenConflict,
  type RegisteredDeviceTokenRow,
} from '../db/repositories/deviceTokensRepository.js';
import { ApiError } from '../lib/errors.js';
import { hashRequestBody, requireIdempotencyKey, withMutation } from '../db/mutation.js';
import { NO_NUL } from '../lib/messageText.js';
import { pgTimestampToIso } from '../lib/pgTimestamp.js';
import { requireOwner } from '../lib/principalNarrows.js';
import { formatZodIssues } from '../lib/zodIssues.js';
import type { DeviceTokenWire, PostDeviceTokensRequest } from '../contracts/wire.js';
import type { Equal, Expect } from '../contracts/typeAsserts.js';

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
 * From wire 9.2.0 (O-MSG-LIVE; A2 OH1; `PostDeviceTokensRequest`'s doc), a
 * token has one live row whoever's it is. The POST expires every OTHER
 * family's live row for the token before its upsert, so a phone that changes
 * family never shows the last family's messages; the DELETE expires every live
 * row holding the token, whoever's (holding the token string is holding the
 * device). The app sends one or the other on every change of signed-in user.
 *
 * Wire shape is client-friendly, mapped from the schema columns in
 * `toDeviceTokenWire`: request `token` ↔ column `expo_push_token`, response
 * `registered_at` ↔ column `created_at`. DATA-CONTRACT §B pins only the two
 * paths + the `:token` param, not the response field names, so these names
 * are this route's to choose; they mirror how every other route renames
 * (e.g. `payment_methods.exp_month`). As of contract 1.13.0 the SHAPES live in
 * `src/contracts/wire.ts` (`DeviceTokenWire`, `PostDeviceTokensRequest` and
 * `DevicePlatform`) and the body is pinned to `postBodySchema` below; the
 * one-call-site `toDeviceTokenWire` mapper stays here.
 */

// Expo push tokens are ~40-50 chars (`ExponentPushToken[…]`); cap generously
// so a hostile client can't push arbitrarily large strings into `text`.
const DEVICE_TOKEN_MAX_LEN = 512;

// A NUL in a token is refused here, a 400 like any other schema failure: Postgres refuses U+0000
// in `text` (22021), which was a 500 at the pager's level from any signed-in family (O-MSG-LIVE
// pass 2 fix 1, M2; A1's `NO_NUL`, on both verbs).
const postBodySchema = z
  .object({
    token: z
      .string()
      .min(1, 'token must not be empty')
      .max(DEVICE_TOKEN_MAX_LEN)
      .refine(NO_NUL.check, NO_NUL.message),
    platform: z.enum(['ios', 'android']),
  })
  .strict();

/**
 * §5.1.3 pin — `PostDeviceTokensRequest` IS this schema's input, or the build fails.
 * `z.input`, not `z.infer`: the wire documents what a client may SEND.
 */
export type PostDeviceTokensBodyConformance = Expect<
  Equal<z.input<typeof postBodySchema>, PostDeviceTokensRequest>
>;

const tokenParamSchema = z.object({
  token: z.string().min(1).max(DEVICE_TOKEN_MAX_LEN).refine(NO_NUL.check, NO_NUL.message),
});

export function registerDeviceTokensRoute(app: FastifyInstance, opts: AuthRouteOptions = {}): void {
  const authHook = resolveAuthHook(opts);

  // --- POST /device-tokens ---------------------------------------------
  //
  // Expire every OTHER family's live row for this token, then UPSERT by
  // (owner_id, expo_push_token): registering a token the owner already has
  // live re-touches the existing row (idempotent at the DB layer) rather than
  // inserting a duplicate. `withMutation` adds the request-level idempotency
  // replay on top, so a retried POST with the same Idempotency-Key returns the
  // stored 201 without re-running either statement.
  //
  // A concurrent registration of the same token by another family can commit
  // between our expire and our insert: our insert is then a 23505 on the
  // live-token index, and the transaction is dead (LR11). So the whole
  // mutation is re-run ONCE, on a fresh transaction, outside the failed one:
  // its expire now sees the other family's committed row. The retry keys on
  // that constraint name alone; any other error, or a second 23505, propagates.
  app.post('/device-tokens', { preHandler: [authHook] }, async (request, reply) => {
    const principal = requirePrincipal(request);
    requireOwner(principal, 'register a device token');
    const { token, platform } = parsePostBody(request.body);
    const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);

    // cache-noop: device_tokens isn't in the §3 cache map (only the
    // scheduler reads them, never a cached owner-facing read).
    const register = (): Promise<{ status: number; body: DeviceTokenWire }> =>
      withMutation<DeviceTokenWire>(
        {
          principal,
          idempotencyKey,
          endpoint: 'POST /device-tokens',
          requestHash: hashRequestBody({ ownerId: principal.ownerId, token, platform }),
        },
        async (tx) => {
          await deviceTokensRepository.expireOtherOwnersLiveToken(tx, {
            ownerId: principal.ownerId,
            token,
          });
          const row = await deviceTokensRepository.upsert(tx, {
            ownerId: principal.ownerId,
            token,
            platform,
          });
          return { status: 201, body: toDeviceTokenWire(row) };
        },
      );

    let outcome: { status: number; body: DeviceTokenWire };
    try {
      outcome = await register();
    } catch (err) {
      if (!isLiveTokenConflict(err)) throw err;
      outcome = await register();
    }

    reply.code(outcome.status);
    return outcome.body;
  });

  // --- DELETE /device-tokens/:token ------------------------------------
  //
  // Soft-expire EVERY live row holding the token, whoever's (wire 9.2.0): 204
  // if any was expired, 404 if none was (never registered, or already
  // expired). The answer says only whether this device was live somewhere —
  // which the caller, holding the token, already knows; it names no family.
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
        const expired = await deviceTokensRepository.softExpireByToken(tx, { token });
        if (expired === 0) {
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
