import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import { hashRequestBody, requireIdempotencyKey, withMutation } from '../db/mutation.js';
import { ApiError } from '../lib/errors.js';
import { formatZodIssues } from '../lib/zodIssues.js';
import type { PostThreadsMessagesRequest } from '../contracts/wire.js';
import type { Equal, Expect } from '../contracts/typeAsserts.js';
import { type MessageWire, type ThreadWire } from '../lib/threadWire.js';
import { wireManyMessages, wireManyThreads } from '../lib/wireManyThreads.js';
import { messagesRepository, type MessageRow } from '../db/repositories/messagesRepository.js';
import {
  mediaAssetsRepository,
  type MediaAssetRow,
} from '../db/repositories/mediaAssetsRepository.js';
import { threadsRepository } from '../db/repositories/threadsRepository.js';
import { defaultR2Client, type R2Client } from '../lib/r2.js';
import type { Tx } from '../db/tx.js';

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
 *     `findNamesByIds`; owner messages omit `sender_name` — and the FE keys
 *     "is this me?" off that name-absence (robust across mock + real ids).
 *
 * `unread_count` is derived server-side per §B Thread + schema comment:
 * count live messages where `sender_kind != 'owner'` AND `read_at IS NULL`.
 * Batched across all threads in the list endpoint via a single GROUP BY.
 */

const uuidParamSchema = z.object({
  id: z.string().uuid(),
});

const MAX_MESSAGE_LEN = 4000;
const MAX_ATTACHMENTS_PER_MESSAGE = 10;
// A message needs a body OR at least one attachment — an empty send is rejected.
// `text` is optional so an attachment-only message is valid (stored as text='').
const messageBodySchema = z
  .object({
    text: z.string().trim().max(MAX_MESSAGE_LEN).optional(),
    attachment_media_ids: z.array(z.string().uuid()).max(MAX_ATTACHMENTS_PER_MESSAGE).optional(),
  })
  .strict()
  .refine(
    (body) =>
      (body.text !== undefined && body.text.length > 0) ||
      (body.attachment_media_ids !== undefined && body.attachment_media_ids.length > 0),
    { message: 'a message must have text or at least one attachment' },
  );

/** Zod ↔ wire pin (designs/wire-contract-completion.md §5.1.3). `z.input`, not
 *  `z.infer`: the wire documents what a client may SEND, pre-trim. Exported so
 *  no unused-locals rule can eat it. If this stops compiling, the WIRE TYPE is
 *  wrong — never the schema (§14.1). The `.refine`'s one-required rule is not
 *  representable here and rides as a doc comment on the wire type (§4 rule 6). */
export type PostThreadsMessagesBodyConformance = Expect<
  Equal<z.input<typeof messageBodySchema>, PostThreadsMessagesRequest>
>;

export interface ThreadsRouteOpts extends AuthRouteOptions {
  /** Override the R2 client (contract tests inject the stub for URL signing). */
  r2?: R2Client;
}

export function registerThreadsRoute(app: FastifyInstance, opts: ThreadsRouteOpts = {}): void {
  const authHook = resolveAuthHook(opts);
  const r2 = opts.r2 ?? defaultR2Client;

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
      return wireManyMessages(rows, r2);
    },
  );

  // --- POST /threads/:id/read ---------------------------------------------
  // Mark the thread's owner-facing messages read (clears `unread_count`).
  // Idempotent, owner-only, 204 No Content. The owner app fires this on open;
  // a missing endpoint here is what caused the chat-screen mark-read retry loop.
  app.post('/threads/:id/read', { preHandler: [authHook] }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const { id } = parseUuidParam(request.params);
    if (principal.kind !== 'owner') {
      throw new ApiError('not_found', `thread ${id} not found`);
    }
    const owns = await threadsRepository.ownsThread(id, principal.ownerId);
    if (!owns) {
      throw new ApiError('not_found', `thread ${id} not found`);
    }
    const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
    // cache-noop: threads/messages aren't in the §3 cache map (reads aren't cached).
    const outcome = await withMutation<null>(
      {
        principal,
        idempotencyKey,
        endpoint: 'POST /threads/:id/read',
        requestHash: hashRequestBody({ threadId: id }),
      },
      async (tx) => {
        await messagesRepository.markThreadReadForOwner(tx, id);
        return { status: 204, body: null };
      },
    );
    reply.code(outcome.status);
    return outcome.body;
  });

  // --- POST /threads/:id/messages -----------------------------------------
  // Owner sends a message (sender_kind='owner'). INSERTs the message + bumps the
  // thread preview. Idempotent, owner-only, 201 + the created MessageWire. No
  // notification: staff read owner messages via the portal (no staff bell feed).
  app.post('/threads/:id/messages', { preHandler: [authHook] }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const { id } = parseUuidParam(request.params);
    if (principal.kind !== 'owner') {
      throw new ApiError('not_found', `thread ${id} not found`);
    }
    const owns = await threadsRepository.ownsThread(id, principal.ownerId);
    if (!owns) {
      throw new ApiError('not_found', `thread ${id} not found`);
    }
    const { text, attachmentMediaIds } = parseMessageBody(request.body);
    const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);

    // cache-noop: threads/messages aren't in the §3 cache map (reads aren't cached).
    // The mutation returns the message ROW; the wire (which reads the just-
    // committed attachment links) is assembled AFTER commit — the attachment
    // loader reads via the pool, so it must run post-commit to see the inserts.
    const outcome = await withMutation<MessageRow>(
      {
        principal,
        idempotencyKey,
        endpoint: 'POST /threads/:id/messages',
        requestHash: hashRequestBody({ id, text, attachmentMediaIds }),
      },
      async (tx) => {
        // Validate the attachments belong to this owner + are message media
        // BEFORE the insert, inside the tx so a soft-expire can't race us.
        const attachmentRows = await validateOwnerAttachments(
          tx,
          principal.ownerId,
          attachmentMediaIds,
        );
        const row = await messagesRepository.createOwnerMessage(tx, {
          threadId: id,
          ownerId: principal.ownerId,
          text,
          attachmentMediaIds,
        });
        await threadsRepository.bumpLastMessage(tx, id, threadPreview(text, attachmentRows));
        return { status: 201, body: row };
      },
    );

    const [wire] = await wireManyMessages([outcome.body], r2);
    if (wire === undefined) {
      throw new Error(`thread ${id}: failed to build message wire`);
    }
    reply.code(outcome.status);
    return wire;
  });
}

/**
 * Validate a message's attachment ids in one round-trip: each must be a live
 * media asset, owned by the sender, with `purpose='message-attachment'`. A
 * missing or cross-owner id is a 404 (existence never leaks); a wrong-purpose
 * id is a 422. Returns the rows in the order supplied (for the thread preview).
 */
async function validateOwnerAttachments(
  tx: Tx,
  ownerId: string,
  ids: string[],
): Promise<MediaAssetRow[]> {
  if (ids.length === 0) return [];
  const rows = await mediaAssetsRepository.findManyByIds(ids, tx);
  const rowById = new Map(rows.map((r) => [r.id, r] as const));
  const ordered: MediaAssetRow[] = [];
  for (const mediaId of ids) {
    const row = rowById.get(mediaId);
    if (row === undefined || row.ownerId !== ownerId) {
      throw new ApiError('not_found', `attachment media ${mediaId} not found`);
    }
    if (row.purpose !== 'message-attachment') {
      throw new ApiError('invalid_payload', `media ${mediaId} is not a message attachment`);
    }
    ordered.push(row);
  }
  return ordered;
}

/**
 * Thread-list preview line. Uses the message body when present; for an
 * attachment-only message, a media summary ("Photo" / "Video" / "N attachments")
 * so the threads list isn't blank.
 */
function threadPreview(text: string, attachments: MediaAssetRow[]): string {
  if (text !== '') return text;
  if (attachments.length === 1) {
    return attachments[0]?.kind === 'video' ? 'Video' : 'Photo';
  }
  return `${attachments.length} attachments`;
}

// ---- body parsing --------------------------------------------------------

function parseMessageBody(body: unknown): { text: string; attachmentMediaIds: string[] } {
  const parsed = messageBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError('bad_request', `invalid body: ${formatZodIssues(parsed.error)}`);
  }
  // Normalize: an attachment-only message stores text='' (the schema's refine
  // guarantees text-nonempty OR ≥1 attachment, so this is never a no-op send).
  return {
    text: parsed.data.text ?? '',
    attachmentMediaIds: parsed.data.attachment_media_ids ?? [],
  };
}

// ---- param parsing -------------------------------------------------------

function parseUuidParam(params: unknown): { id: string } {
  const parsed = uuidParamSchema.safeParse(params);
  if (!parsed.success) {
    throw new ApiError('bad_request', `invalid path: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}
