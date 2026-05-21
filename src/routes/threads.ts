import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import { ApiError } from '../lib/errors.js';
import { formatZodIssues } from '../lib/zodIssues.js';
import {
  toMessageWire,
  toThreadWire,
  type MessageRowForWire,
  type MessageWire,
  type ResolvedParticipant,
  type ThreadWire,
} from '../lib/threadWire.js';
import { messagesRepository } from '../db/repositories/messagesRepository.js';
import { staffRepository } from '../db/repositories/staffRepository.js';
import { threadsRepository, type ThreadRow } from '../db/repositories/threadsRepository.js';

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
    return wireThreads(rows);
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
    const [wire] = await wireThreads([row]);
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
      return wireMessages(rows);
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

// ---- batched wiring ------------------------------------------------------

/**
 * Denormalize a batch of thread rows into wire shapes. Three batched
 * lookups regardless of row count (participants, thread_dogs, unread-
 * counts) — cost is constant in the input size.
 *
 * Participant resolution: every fixture thread has a live participant
 * staff row (schema column is nullable but the comment + business reality
 * say "always set" — see Day-7a handoff for the future NOT NULL
 * tightening). A thread referencing a missing/expired staff id throws so
 * a structural fault surfaces loud, not silent.
 */
async function wireThreads(rows: ThreadRow[]): Promise<ThreadWire[]> {
  if (rows.length === 0) return [];
  const threadIds = rows.map((r) => r.id);
  const participantStaffIds = [
    ...new Set(rows.map((r) => r.participantStaffId).filter((v): v is string => v !== null)),
  ];
  const [participantRows, dogRows, unreadRows] = await Promise.all([
    staffRepository.findParticipantsByIds(participantStaffIds),
    threadsRepository.findDogsByThreadIds(threadIds),
    threadsRepository.findUnreadCountsByThreadIds(threadIds),
  ]);
  const participantsById = new Map<string, ResolvedParticipant>(
    participantRows.map((p) => [p.id, p] as const),
  );
  const dogsByThread = groupDogIds(dogRows);
  const unreadByThread = new Map(unreadRows.map((r) => [r.threadId, r.unreadCount] as const));

  return rows.map((row) => {
    const participant = resolveParticipantOrThrow(row, participantsById);
    const relatedDogIds = dogsByThread.get(row.id) ?? [];
    const unreadCount = unreadByThread.get(row.id) ?? 0;
    return toThreadWire(row, participant, relatedDogIds, unreadCount);
  });
}

/**
 * Denormalize a batch of message rows into wire shapes. One batched
 * staff-name lookup feeds the polymorphic-sender flattening; owner-sent
 * messages omit `sender_name` per the convention noted on
 * `lib/threadWire.toMessageWire`.
 */
async function wireMessages(rows: MessageRowForWire[]): Promise<MessageWire[]> {
  if (rows.length === 0) return [];
  const staffSenderIds = [
    ...new Set(
      rows
        .filter((m) => m.senderKind === 'staff')
        .map((m) => m.senderStaffId)
        .filter((v): v is string => v !== null),
    ),
  ];
  const staffNameRows = await staffRepository.findNamesByIds(staffSenderIds);
  const staffNamesById = new Map(staffNameRows.map((s) => [s.id, s.name] as const));

  return rows.map((row) => {
    let senderName: string | null = null;
    if (row.senderKind === 'staff' && row.senderStaffId !== null) {
      senderName = staffNamesById.get(row.senderStaffId) ?? null;
    }
    return toMessageWire(row, senderName);
  });
}

/**
 * Group `thread_dogs` rows into a per-thread sorted id list. Repo orders
 * by `dog_id` ASC; this preserves that order so the snapshot diff is
 * stable across reseeds.
 */
function groupDogIds(rows: { threadId: string; dogId: string }[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const row of rows) {
    const existing = result.get(row.threadId) ?? [];
    existing.push(row.dogId);
    result.set(row.threadId, existing);
  }
  return result;
}

/**
 * Look up the resolved participant for a thread row. Throws if the
 * participant_staff_id is null (a temporary structural invariant — the
 * schema allows NULL but business reality always sets it; see Day-7a
 * handoff) or the staff row is missing/expired (would silently emit a
 * broken wire shape otherwise).
 */
function resolveParticipantOrThrow(
  row: ThreadRow,
  participantsById: Map<string, ResolvedParticipant>,
): ResolvedParticipant {
  if (row.participantStaffId === null) {
    throw new Error(
      `thread ${row.id}: participant_staff_id is null (no NULL-participant wire shape exists yet)`,
    );
  }
  const participant = participantsById.get(row.participantStaffId);
  if (participant === undefined) {
    throw new Error(
      `thread ${row.id}: participant_staff_id ${row.participantStaffId} not found in live staff`,
    );
  }
  return participant;
}
