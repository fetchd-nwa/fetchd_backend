import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import { hashRequestBody, requireIdempotencyKey, withMutation } from '../db/mutation.js';
import { ApiError } from '../lib/errors.js';
import { formatZodIssues } from '../lib/zodIssues.js';
import { pgTimestampToIso } from '../lib/pgTimestamp.js';
import { toNotificationWire, type NotificationWire } from '../lib/notificationWire.js';
import {
  notificationsRepository,
  type NotificationCursor,
  type NotificationRow,
} from '../db/repositories/notificationsRepository.js';

/**
 * `GET /notifications` `[auth]` · `GET /notifications/unread-count`
 * `[auth]` — the owner notifications inbox surface (DATA-CONTRACT §C
 * notifications + §B Notification).
 *
 * Owner-scoped through `notifications.owner_id`; staff principals get an
 * empty page / zero count (Day-19 staff portal has no equivalent — staff
 * watch real-time alerts via a different mechanism).
 *
 * Cursor pagination uses a base64url-encoded JSON envelope
 * `{r:<received_at ISO>, i:<id UUID>}`. Encoding the keyset values (vs
 * an opaque server-stored cursor id) keeps the API stateless — the
 * cursor is the page boundary by value, never a server cache key. See
 * DATA-CONTRACT §A Clarification 2026-05-21 for the wire-shape pin.
 *
 * `limit` defaults to 50 (a reasonable inbox page), caps at 200 (one
 * round-trip should cover a power user's full feed without overloading
 * the FE list).
 */

const LIMIT_DEFAULT = 50;
const LIMIT_MAX = 200;

const listQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(LIMIT_MAX).optional().default(LIMIT_DEFAULT),
});

export interface NotificationListResponse {
  items: NotificationWire[];
  next_cursor?: string;
}

export interface UnreadCountResponse {
  unread_count: number;
}

export function registerNotificationsRoute(
  app: FastifyInstance,
  opts: AuthRouteOptions = {},
): void {
  const authHook = resolveAuthHook(opts);

  // --- GET /notifications/unread-count ------------------------------------
  // Registered before `/notifications` (specific before general); not
  // strictly required since paths don't shadow, but mirrors the Day-7a
  // `/events/rsvps` precedent and keeps the file readable top-down by
  // narrowness.
  app.get(
    '/notifications/unread-count',
    { preHandler: [authHook] },
    async (request): Promise<UnreadCountResponse> => {
      const principal = requirePrincipal(request);
      if (principal.kind !== 'owner') return { unread_count: 0 };
      const unreadCount = await notificationsRepository.findUnreadCountByOwner(principal.ownerId);
      return { unread_count: unreadCount };
    },
  );

  // --- GET /notifications -------------------------------------------------
  app.get(
    '/notifications',
    { preHandler: [authHook] },
    async (request): Promise<NotificationListResponse> => {
      const principal = requirePrincipal(request);
      if (principal.kind !== 'owner') return { items: [] };

      const { cursor: cursorRaw, limit } = parseListQuery(request.query);
      const cursor = cursorRaw === undefined ? null : decodeCursorOrThrow(cursorRaw);

      // Fetch limit+1 to peek at whether a next page exists without a
      // separate COUNT query. The "extra" row, if present, becomes the
      // cursor anchor for the next request.
      const rows = await notificationsRepository.findLiveByOwnerCursor(
        principal.ownerId,
        cursor,
        limit + 1,
      );
      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const items = await wireNotifications(pageRows);

      const response: NotificationListResponse = { items };
      const lastRow = pageRows[pageRows.length - 1];
      if (hasMore && lastRow !== undefined) {
        response.next_cursor = encodeCursor({
          receivedAt: pgTimestampToIso(lastRow.receivedAt),
          id: lastRow.id,
        });
      }
      return response;
    },
  );

  // --- POST /notifications/:id/read ---------------------------------------
  // Mark one notification read. Owner-only, idempotent, 204 No Content. The
  // owner app fires this on tap. 0 affected rows (missing or another owner's)
  // → 404 (owner_id is in the UPDATE WHERE — anti-enumeration, no separate
  // ownership SELECT). Mirrors POST /threads/:id/read.
  app.post('/notifications/:id/read', { preHandler: [authHook] }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const { id } = parseUuidParam(request.params);
    if (principal.kind !== 'owner') {
      throw new ApiError('not_found', `notification ${id} not found`);
    }
    const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
    const outcome = await withMutation<null>(
      {
        principal,
        idempotencyKey,
        endpoint: 'POST /notifications/:id/read',
        requestHash: hashRequestBody({ notificationId: id }),
      },
      async (tx) => {
        const affected = await notificationsRepository.markReadForOwner(tx, id, principal.ownerId);
        if (affected === 0) {
          throw new ApiError('not_found', `notification ${id} not found`);
        }
        return { status: 204, body: null };
      },
    );
    reply.code(outcome.status);
    return outcome.body;
  });

  // --- POST /notifications/read-all ---------------------------------------
  // Mark every unread notification read for the owner. Owner-only, idempotent,
  // 204. Staff have no feed → 204 no-op (soft-empty convention, like the GETs).
  app.post('/notifications/read-all', { preHandler: [authHook] }, async (request, reply) => {
    const principal = requirePrincipal(request);
    if (principal.kind !== 'owner') {
      reply.code(204);
      return null;
    }
    const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
    const outcome = await withMutation<null>(
      {
        principal,
        idempotencyKey,
        endpoint: 'POST /notifications/read-all',
        requestHash: hashRequestBody({}),
      },
      async (tx) => {
        await notificationsRepository.markAllReadForOwner(tx, principal.ownerId);
        return { status: 204, body: null };
      },
    );
    reply.code(outcome.status);
    return outcome.body;
  });

  // --- DELETE /notifications/:id ------------------------------------------
  // Dismiss (soft-delete) one notification — sets dismissed_at so it drops out
  // of the feed + unread count, row retained for audit. Owner-only, idempotent,
  // 204. 0 affected rows → 404.
  app.delete('/notifications/:id', { preHandler: [authHook] }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const { id } = parseUuidParam(request.params);
    if (principal.kind !== 'owner') {
      throw new ApiError('not_found', `notification ${id} not found`);
    }
    const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
    const outcome = await withMutation<null>(
      {
        principal,
        idempotencyKey,
        endpoint: 'DELETE /notifications/:id',
        requestHash: hashRequestBody({ notificationId: id }),
      },
      async (tx) => {
        const affected = await notificationsRepository.dismissForOwner(tx, id, principal.ownerId);
        if (affected === 0) {
          throw new ApiError('not_found', `notification ${id} not found`);
        }
        return { status: 204, body: null };
      },
    );
    reply.code(outcome.status);
    return outcome.body;
  });
}

// ---- query parsing -------------------------------------------------------

function parseListQuery(query: unknown): { cursor?: string; limit: number } {
  const parsed = listQuerySchema.safeParse(query);
  if (!parsed.success) {
    throw new ApiError('bad_request', `invalid query: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}

const uuidParamSchema = z.object({ id: z.string().uuid() });

function parseUuidParam(params: unknown): { id: string } {
  const parsed = uuidParamSchema.safeParse(params);
  if (!parsed.success) {
    throw new ApiError('bad_request', `invalid id: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}

// ---- cursor codec --------------------------------------------------------

const cursorPayloadSchema = z.object({
  r: z.string().datetime(),
  i: z.string().uuid(),
});

function encodeCursor(cursor: NotificationCursor): string {
  const payload = JSON.stringify({ r: cursor.receivedAt, i: cursor.id });
  return Buffer.from(payload, 'utf-8').toString('base64url');
}

/**
 * Decode a client-supplied cursor. Any failure (malformed base64, invalid
 * JSON, wrong shape, bad ISO or UUID) raises 400 bad_request rather than
 * silently treating as "no cursor" — a silent fallback would mask client
 * bugs and create ghost pagination (page-1 reads instead of the requested
 * later page).
 */
function decodeCursorOrThrow(cursor: string): NotificationCursor {
  let json: string;
  try {
    json = Buffer.from(cursor, 'base64url').toString('utf-8');
  } catch {
    throw new ApiError('bad_request', 'invalid cursor: not base64url-encoded');
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(json);
  } catch {
    throw new ApiError('bad_request', 'invalid cursor: payload is not JSON');
  }
  const parsed = cursorPayloadSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new ApiError('bad_request', `invalid cursor payload: ${formatZodIssues(parsed.error)}`);
  }
  return { receivedAt: parsed.data.r, id: parsed.data.i };
}

// ---- batched wiring ------------------------------------------------------

/**
 * Denormalize a batch of notification rows into wire shapes. One batched
 * lookup for `notification_dogs` regardless of row count; cost is constant
 * in page size.
 */
async function wireNotifications(rows: NotificationRow[]): Promise<NotificationWire[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const dogRows = await notificationsRepository.findDogsByNotificationIds(ids);
  const dogsByNotification = groupDogIds(dogRows);
  return rows.map((row) => toNotificationWire(row, dogsByNotification.get(row.id) ?? []));
}

function groupDogIds(rows: { notificationId: string; dogId: string }[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const row of rows) {
    const existing = result.get(row.notificationId) ?? [];
    existing.push(row.dogId);
    result.set(row.notificationId, existing);
  }
  return result;
}
