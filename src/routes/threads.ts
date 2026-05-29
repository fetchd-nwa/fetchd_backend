import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import { ApiError } from '../lib/errors.js';
import { formatZodIssues } from '../lib/zodIssues.js';
import { type MessageWire, type ThreadWire } from '../lib/threadWire.js';
import { wireManyMessages, wireManyThreads } from '../lib/wireManyThreads.js';
import { messagesRepository } from '../db/repositories/messagesRepository.js';
import { threadsRepository } from '../db/repositories/threadsRepository.js';

/**
 * `GET /threads` `[auth]` · `GET /threads/:id` `[auth]` ·
 * `GET /threads/:id/messages` `[auth]` — the messaging read surface
 * (DATA-CONTRACT §C messaging + §B Thread/Message). Owner-scoped; staff
 * principals get an empty list / 404 (Day-19 staff portal uses
 * `/staff/threads/*` — out of scope here).
 *
 * Three flattenings happen across the layer stack:
 *   - `threads.participant_staff_id` → `participant:{id,name,role,image_path?}`
 *     via `staffRepository.findParticipantsByIds`.
 *   - `thread_dogs` join → `related_dog_ids: string[]` (always emitted,
 *     possibly empty per §B Thread).
 *   - `messages.sender_kind` + `sender_owner_id|sender_staff_id` (XOR) →
 *     `sender_id` + optional `sender_name`. Staff names resolved via
 *     `findNamesByIds`; owner messages omit `sender_name` (the FE
 *     identifies "is this me?" by id comparison, not by name).
 *
 * `unread_count` is derived server-side per §B Thread + schema comment:
 * count live messages where `sender_kind != 'owner'` AND `read_at IS NULL`.
 * Batched across all threads in the list endpoint via a single GROUP BY.
 */

const uuidParamSchema = z.object({
  id: z.string().uuid(),
});

export function registerThreadsRoute(app: FastifyInstance, opts: AuthRouteOptions = {}): void {
  const authHook = resolveAuthHook(opts);

  // --- GET /threads -------------------------------------------------------
  app.get('/threads', { preHandler: [authHook] }, async (request): Promise<ThreadWire[]> => {
    const principal = requirePrincipal(request);
    if (principal.kind !== 'owner') return [];
    const rows = await threadsRepository.findLiveByOwner(principal.ownerId);
    return wireManyThreads(rows);
  });

  // --- GET /threads/:id ---------------------------------------------------
  app.get('/threads/:id', { preHandler: [authHook] }, async (request): Promise<ThreadWire> => {
    const principal = requirePrincipal(request);
    const { id } = parseUuidParam(request.params);
    if (principal.kind !== 'owner') {
      throw new ApiError('not_found', `thread ${id} not found`);
    }
    const row = await threadsRepository.findByIdForOwner(id, principal.ownerId);
    if (row === undefined) {
      throw new ApiError('not_found', `thread ${id} not found`);
    }
    const [wire] = await wireManyThreads([row]);
    if (wire === undefined) {
      // Unreachable: wireThreads returns one wire per input row.
      throw new Error(`thread ${id}: failed to build wire shape`);
    }
    return wire;
  });

  // --- GET /threads/:id/messages ------------------------------------------
  app.get(
    '/threads/:id/messages',
    { preHandler: [authHook] },
    async (request): Promise<MessageWire[]> => {
      const principal = requirePrincipal(request);
      const { id } = parseUuidParam(request.params);
      // Same 404-on-staff response as the by-id route: ownership must hold
      // before any message data leaks.
      if (principal.kind !== 'owner') {
        throw new ApiError('not_found', `thread ${id} not found`);
      }
      const owns = await threadsRepository.ownsThread(id, principal.ownerId);
      if (!owns) {
        throw new ApiError('not_found', `thread ${id} not found`);
      }
      const rows = await messagesRepository.findLiveByThread(id);
      return wireManyMessages(rows);
    },
  );
}

// ---- param parsing -------------------------------------------------------

function parseUuidParam(params: unknown): { id: string } {
  const parsed = uuidParamSchema.safeParse(params);
  if (!parsed.success) {
    throw new ApiError('bad_request', `invalid path: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}
