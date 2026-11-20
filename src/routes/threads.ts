import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import type { IdempotencyOutcome } from '../db/idempotency.js';
import { hashRequestBody, requireIdempotencyKey, withMutation } from '../db/mutation.js';
import { ApiError } from '../lib/errors.js';
import { formatZodIssues } from '../lib/zodIssues.js';
import { MAX_MESSAGE_SEQ } from '../contracts/wire.js';
import type {
  GetThreadsMessagesQuery,
  PostThreadsMessagesRequest,
  PostThreadsReadRequest,
  PostThreadsRequest,
  PostThreadsResponse,
  ThreadCategory,
} from '../contracts/wire.js';
import type { Equal, Expect } from '../contracts/typeAsserts.js';
import { type MessageWire, type ThreadWire } from '../lib/threadWire.js';
import { wireManyMessages, wireManyThreads } from '../lib/wireManyThreads.js';
import { messagesRepository, type MessageRow } from '../db/repositories/messagesRepository.js';
import {
  mediaAssetsRepository,
  type MediaAssetRow,
} from '../db/repositories/mediaAssetsRepository.js';
import { dogsRepository } from '../db/repositories/dogsRepository.js';
import { staffRepository } from '../db/repositories/staffRepository.js';
import { threadsRepository } from '../db/repositories/threadsRepository.js';
import { threadCategory } from '../db/schema/schema.js';
import { hasRepeats, isClientMessageIdViolation } from '../lib/clientMessageId.js';
import { pgTimestampToIso } from '../lib/pgTimestamp.js';
import { threadPublisherFor } from '../realtime/publish.js';
import { committedThreadRow } from '../realtime/threadRow.js';
import { afterSeqQuerySchema, parseAfterSeqQuery } from '../lib/messageSeq.js';
import { NO_NUL, TOPIC_LABEL, threadPreview } from '../lib/messageText.js';
import { requireOwner } from '../lib/principalNarrows.js';
import { defaultR2Client, type R2Client } from '../lib/r2.js';
import { uuidId } from '../lib/uuidId.js';
import type { Tx } from '../db/tx.js';

/**
 * `GET /threads` `[auth]` · `GET /threads/:id` `[auth]` ·
 * `GET /threads/:id/messages` `[auth]` — the messaging read surface
 * (DATA-CONTRACT §C messaging + §B Thread/Message). Owner-scoped; staff
 * principals get an empty list / 404 (Day-19 staff portal uses
 * `/staff/threads/*` — out of scope here). And the family's two sends:
 * `POST /threads/:id/messages` and, from 9.2.0, `POST /threads`, her start of a
 * conversation with the school (S45, MSG-U05).
 *
 * Three flattenings happen across the layer stack:
 *   - `threads.participant_staff_id` → `participant:{id,name,role,image_path?,is_school?}`
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
 *
 * 9.2.0 (W1, W2): every message carries its `seq` (rs3 M5.29's trigger), both
 * lists are in `seq` order, and a send may carry its `client_message_id`
 * (`lib/clientMessageId.ts`), echoed on her side only.
 */

const uuidParamSchema = z.object({
  id: uuidId(),
});

const MAX_MESSAGE_LEN = 4000;
const MAX_ATTACHMENTS_PER_MESSAGE = 10;
const MAX_DOGS_PER_START = 10;
const MAX_SUBTOPIC_LEN = 120;

/** A message needs a body OR at least one attachment — an empty send is rejected. */
function hasTextOrAttachment(body: { text?: string; attachment_media_ids?: string[] }): boolean {
  return (
    (body.text !== undefined && body.text.length > 0) ||
    (body.attachment_media_ids !== undefined && body.attachment_media_ids.length > 0)
  );
}

// `text` is optional so an attachment-only message is valid (stored as text='').
const messageBodySchema = z
  .object({
    text: z.string().trim().max(MAX_MESSAGE_LEN).refine(NO_NUL.check, NO_NUL.message).optional(),
    attachment_media_ids: z.array(uuidId()).max(MAX_ATTACHMENTS_PER_MESSAGE).optional(),
    // 9.2.0 (W2): the sender's own id for this logical message.
    client_message_id: uuidId().optional(),
  })
  .strict()
  .refine(hasTextOrAttachment, {
    message: 'a message must have text or at least one attachment',
  })
  // 9.2.0 (contract-notes mechanic 14): an id named twice is a 400, never the 500 the
  // `message_attachments_message_media_uidx` insert used to raise (P45 `plan_added`).
  .refine((body) => !hasRepeats(body.attachment_media_ids), {
    message: 'an attachment id is named twice',
  });

/** Zod ↔ wire pin (designs/wire-contract-completion.md §5.1.3). `z.input`, not
 *  `z.infer`: the wire documents what a client may SEND, pre-trim. Exported so
 *  no unused-locals rule can eat it. If this stops compiling, the WIRE TYPE is
 *  wrong — never the schema (§14.1). The `.refine`'s one-required rule is not
 *  representable here and rides as a doc comment on the wire type (§4 rule 6). */
export type PostThreadsMessagesBodyConformance = Expect<
  Equal<z.input<typeof messageBodySchema>, PostThreadsMessagesRequest>
>;

/** `POST /threads` (9.2.0, `PostThreadsRequest`; contract-notes mechanics 19, 20): the
 *  message grammar above plus the topic, its sub-topic (trimmed, 1–120, stored as the
 *  thread's `sub_text`) and her dogs (uuids, at most 10, no repeats). */
const startBodySchema = z
  .object({
    category: z.enum(threadCategory.enumValues),
    subtopic: z
      .string()
      .trim()
      .min(1)
      .max(MAX_SUBTOPIC_LEN)
      .refine(NO_NUL.check, NO_NUL.message)
      .optional(),
    dog_ids: z.array(uuidId()).max(MAX_DOGS_PER_START).optional(),
    text: z.string().trim().max(MAX_MESSAGE_LEN).refine(NO_NUL.check, NO_NUL.message).optional(),
    attachment_media_ids: z.array(uuidId()).max(MAX_ATTACHMENTS_PER_MESSAGE).optional(),
    client_message_id: uuidId().optional(),
  })
  .strict()
  .refine(hasTextOrAttachment, {
    message: 'a message must have text or at least one attachment',
  })
  .refine((body) => !hasRepeats(body.attachment_media_ids), {
    message: 'an attachment id is named twice',
  })
  .refine((body) => !hasRepeats(body.dog_ids), { message: 'a dog id is named twice' });

/** Zod ↔ wire pin for `POST /threads`, as above. */
export type PostThreadsBodyConformance = Expect<
  Equal<z.input<typeof startBodySchema>, PostThreadsRequest>
>;

/** Zod ↔ wire pin for the list query (§5.1.3; the schema is `lib/messageSeq.ts`'s). */
export type GetThreadsMessagesQueryConformance = Expect<
  Equal<z.input<typeof afterSeqQuerySchema>, GetThreadsMessagesQuery>
>;

/**
 * `POST /threads/:id/read`'s optional body (9.2.0 `PostThreadsReadRequest`, W5; mechanic 17):
 * absent, or `{}`, as before; `up_to_seq` an integer from 0 to `MAX_MESSAGE_SEQ`; `.strict()`.
 */
const readBodySchema = z
  .object({ up_to_seq: z.number().int().min(0).max(MAX_MESSAGE_SEQ).optional() })
  .strict();

/** Zod ↔ wire pin for the read body (§5.1.3). */
export type PostThreadsReadBodyConformance = Expect<
  Equal<z.input<typeof readBodySchema>, PostThreadsReadRequest>
>;

export interface ThreadsRouteOpts extends AuthRouteOptions {
  /** Override the R2 client (contract tests inject the stub for URL signing). */
  r2?: R2Client;
}

export function registerThreadsRoute(app: FastifyInstance, opts: ThreadsRouteOpts = {}): void {
  const authHook = resolveAuthHook(opts);
  const r2 = opts.r2 ?? defaultR2Client;
  // 9.2.0 (pass 3 item 2): the live channel, read at registration (throws without one).
  const bus = threadPublisherFor(app);

  /** Her stored message as her side reads it (`client_message_id` included). */
  async function ownerWire(row: MessageRow): Promise<MessageWire> {
    const [wire] = await wireManyMessages([row], r2, 'owner');
    if (wire === undefined) throw new Error(`message ${row.id}: failed to build message wire`);
    return wire;
  }

  /** A thread and a message as `PostThreadsResponse` carries them. */
  async function wirePair(
    threadId: string,
    ownerId: string,
    row: MessageRow,
  ): Promise<PostThreadsResponse> {
    const threadRow = await threadsRepository.findAnyByIdForOwner(threadId, ownerId);
    if (threadRow === undefined) {
      throw new Error(`thread ${threadId}: not found for its own message's sender`);
    }
    const [[thread], message] = await Promise.all([wireManyThreads([threadRow]), ownerWire(row)]);
    if (thread === undefined) throw new Error(`thread ${threadId}: failed to build wire shape`);
    return { thread, message };
  }

  /**
   * W2, the `/messages` verb: her stored message for this `client_message_id`, if the
   * server holds one. In this thread: that message (the caller answers 200). In another of
   * her threads: 409 `conflict` (LR18; never that thread's row).
   */
  async function repeatedSend(
    ownerId: string,
    clientMessageId: string,
    threadId: string,
  ): Promise<MessageWire | undefined> {
    const stored = await messagesRepository.findByOwnerClientMessageId(ownerId, clientMessageId);
    if (stored === undefined) return undefined;
    if (stored.threadId !== threadId) {
      throw new ApiError(
        'conflict',
        'this client_message_id names a message you sent in another thread',
      );
    }
    return ownerWire(stored);
  }

  /** W2, the create verb: her stored message and its thread, always (mechanic 13). */
  async function repeatedStart(
    ownerId: string,
    clientMessageId: string,
  ): Promise<PostThreadsResponse | undefined> {
    const stored = await messagesRepository.findByOwnerClientMessageId(ownerId, clientMessageId);
    if (stored === undefined) return undefined;
    return wirePair(stored.threadId, ownerId, stored);
  }

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
      const afterSeq = parseAfterSeqQuery(request.query);
      const owns = await threadsRepository.ownsThread(id, principal.ownerId);
      if (!owns) {
        throw new ApiError('not_found', `thread ${id} not found`);
      }
      const rows = await messagesRepository.findLiveByThread(
        id,
        afterSeq !== undefined ? { afterSeq } : {},
      );
      return wireManyMessages(rows, r2, 'owner');
    },
  );

  // --- POST /threads/:id/read ---------------------------------------------
  // Mark the thread's owner-facing messages read (clears `unread_count`).
  // Idempotent, owner-only, 204 No Content. The owner app fires this on open;
  // a missing endpoint here is what caused the chat-screen mark-read retry loop.
  // 9.2.0 (W5, B10): an optional `{up_to_seq}` reads only the school's messages at or below
  // it, the newest she rendered; the key's hash covers it (CR34); the thread row is locked
  // first (L4); a read stamps *Delivered* too.
  app.post('/threads/:id/read', { preHandler: [authHook] }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const { id } = parseUuidParam(request.params);
    if (principal.kind !== 'owner') {
      throw new ApiError('not_found', `thread ${id} not found`);
    }
    const upToSeq = parseReadBody(request.body);
    const owns = await threadsRepository.ownsThread(id, principal.ownerId);
    if (!owns) {
      throw new ApiError('not_found', `thread ${id} not found`);
    }
    const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
    const read: {
      step: { upToSeq: number; at: string } | null;
      row?: { id: string; owner_id: string };
    } = { step: null };
    // cache-noop: threads/messages aren't in the §3 cache map (reads aren't cached).
    const outcome = await withMutation<null>(
      {
        principal,
        idempotencyKey,
        endpoint: 'POST /threads/:id/read',
        // An absent `up_to_seq` hashes exactly as the 9.1.0 body did.
        requestHash: hashRequestBody(
          upToSeq === undefined ? { threadId: id } : { threadId: id, upToSeq },
        ),
      },
      async (tx) => {
        await threadsRepository.lockLive(tx, id);
        read.step = await messagesRepository.markThreadReadForOwner(tx, id, upToSeq);
        read.row = await committedThreadRow(tx, id);
        return { status: 204, body: null };
      },
    );
    // 9.2.0 (M4, MB27 Q2/Q3): after commit, only when this call read something: her other
    // devices clear, and staff see the school's messages *Read*.
    if (!outcome.replayed && read.step !== null && read.row !== undefined) {
      const row = read.row;
      bus.publishForThread(row, { kind: 'thread.changed' }, ['owner']);
      bus.publishForThread(row, {
        kind: 'receipt',
        side: 'staff',
        state: 'read',
        up_to_seq: read.step.upToSeq,
        at: pgTimestampToIso(read.step.at),
      });
    }
    reply.code(outcome.status);
    return outcome.body;
  });

  // --- POST /threads/:id/messages -----------------------------------------
  // Owner sends a message (sender_kind='owner'). INSERTs the message + bumps the
  // thread preview. Idempotent, owner-only, 201 + the created MessageWire. No
  // notification: staff read owner messages via the portal (no staff bell feed).
  // 9.2.0 (W2): a `client_message_id` repeat is her stored message, 200, looked up
  // before the key's hash; the same id in another of her threads is 409 `conflict`.
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
    const { text, attachmentMediaIds, clientMessageId } = parseMessageBody(request.body);
    const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);

    if (clientMessageId !== null) {
      const stored = await repeatedSend(principal.ownerId, clientMessageId, id);
      if (stored !== undefined) {
        reply.code(200);
        return stored;
      }
    }

    // cache-noop: threads/messages aren't in the §3 cache map (reads aren't cached).
    // The mutation returns the message ROW; the wire (which reads the just-
    // committed attachment links) is assembled AFTER commit — the attachment
    // loader reads via the pool, so it must run post-commit to see the inserts.
    let outcome: IdempotencyOutcome<MessageRow>;
    try {
      outcome = await withMutation<MessageRow>(
        {
          principal,
          idempotencyKey,
          endpoint: 'POST /threads/:id/messages',
          requestHash: hashRequestBody(
            clientMessageId === null
              ? { id, text, attachmentMediaIds }
              : { id, text, attachmentMediaIds, clientMessageId },
          ),
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
            clientMessageId,
          });
          await threadsRepository.bumpLastMessage(tx, id, threadPreview(text, attachmentRows));
          return { status: 201, body: row };
        },
      );
    } catch (err) {
      // LR11: a racing first send with this id won; its 23505 aborted our transaction, so
      // the winner is read on the pool, outside it (FL1).
      if (clientMessageId !== null && isClientMessageIdViolation(err, 'owner')) {
        const stored = await repeatedSend(principal.ownerId, clientMessageId, id);
        if (stored !== undefined) {
          reply.code(200);
          return stored;
        }
      }
      throw err;
    }

    // 9.2.0 (pass 3 item 2, MB27 Q3): after commit, a fresh send only (a replay publishes nothing).
    if (!outcome.replayed && outcome.body.senderOwnerId !== null) {
      bus.publishForThread(
        { id: outcome.body.threadId, owner_id: outcome.body.senderOwnerId },
        { kind: 'message.created', message_id: outcome.body.id, seq: outcome.body.threadSeq },
      );
    }

    // A8: a replay answers the message as it is now, so a key stored by code from before 9.2.0
    // (a row with no `seq`) still answers with one.
    const answered = outcome.replayed
      ? ((await messagesRepository.findById(outcome.body.id)) ?? outcome.body)
      : outcome.body;
    const wire = await ownerWire(answered);
    reply.code(outcome.status);
    return wire;
  });

  // --- POST /threads -------------------------------------------------------
  // 9.2.0 (S45, MSG-U05; design §2.9:4554): the family starts, or continues, her
  // conversation with the school on one topic. One live school thread per family and
  // topic (rs3 M5.27), whose participant is the school's system row; no trainer pick in
  // v1 (MSG-U07, later), so the responder settings are read by nothing here (MSG-U09).
  // Racing starts answer with one thread id. 201 `PostThreadsResponse`; a
  // `client_message_id` repeat is the stored pair, 200, always (mechanic 13).
  app.post(
    '/threads',
    { preHandler: [authHook] },
    async (request, reply): Promise<PostThreadsResponse> => {
      const principal = requirePrincipal(request);
      requireOwner(principal, 'start a conversation with the school');
      const body = parseStartBody(request.body);
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
      const ownerId = principal.ownerId;

      if (body.clientMessageId !== null) {
        const stored = await repeatedStart(ownerId, body.clientMessageId);
        if (stored !== undefined) {
          reply.code(200);
          return stored;
        }
      }

      let outcome: IdempotencyOutcome<{ threadId: string; message: MessageRow }>;
      try {
        // cache-noop: threads/messages aren't in the §3 cache map (reads aren't cached).
        outcome = await withMutation<{ threadId: string; message: MessageRow }>(
          {
            principal,
            idempotencyKey,
            endpoint: 'POST /threads',
            requestHash: hashRequestBody({
              category: body.category,
              subtopic: body.subtopic,
              dogIds: body.dogIds,
              text: body.text,
              attachmentMediaIds: body.attachmentMediaIds,
              clientMessageId: body.clientMessageId,
            }),
          },
          async (tx) => {
            // Her live dogs only: another family's, or none at all, is 404 (existence
            // never leaks).
            for (const dogId of body.dogIds) {
              if (!(await dogsRepository.findOwnedExists(dogId, ownerId, tx))) {
                throw new ApiError('not_found', `dog ${dogId} not found`);
              }
            }
            const attachmentRows = await validateOwnerAttachments(
              tx,
              ownerId,
              body.attachmentMediaIds,
            );
            const school = await staffRepository.findSchoolAccount(tx);
            if (school === undefined) {
              throw new Error(
                'no live school system row (rs3 M5.26): this database is behind the code',
              );
            }
            const threadId = await threadsRepository.findOrCreateSchoolThread(tx, {
              ownerId,
              category: body.category,
              title: TOPIC_LABEL[body.category],
              subText: body.subtopic ?? '',
              schoolStaffId: school.id,
            });
            await threadsRepository.addDogs(tx, threadId, body.dogIds);
            const message = await messagesRepository.createOwnerMessage(tx, {
              threadId,
              ownerId,
              text: body.text,
              attachmentMediaIds: body.attachmentMediaIds,
              clientMessageId: body.clientMessageId,
            });
            // The latest sub-topic rides the preview bump, so a start writes exactly two
            // `threads` audit rows, as every send does (A2 FL8).
            await threadsRepository.bumpLastMessage(
              tx,
              threadId,
              threadPreview(body.text, attachmentRows),
              body.subtopic !== null ? { subText: body.subtopic } : {},
            );
            return { status: 201, body: { threadId, message } };
          },
        );
      } catch (err) {
        if (body.clientMessageId !== null && isClientMessageIdViolation(err, 'owner')) {
          const stored = await repeatedStart(ownerId, body.clientMessageId);
          if (stored !== undefined) {
            reply.code(200);
            return stored;
          }
        }
        throw err;
      }

      if (!outcome.replayed && outcome.body.message.senderOwnerId !== null) {
        bus.publishForThread(
          { id: outcome.body.message.threadId, owner_id: outcome.body.message.senderOwnerId },
          {
            kind: 'message.created',
            message_id: outcome.body.message.id,
            seq: outcome.body.message.threadSeq,
          },
        );
      }
      const pair = await wirePair(outcome.body.threadId, ownerId, outcome.body.message);
      reply.code(outcome.status);
      return pair;
    },
  );
}

/**
 * Validate a message's attachment ids in one round-trip: each must be a live
 * media asset, owned by the sender, uploaded by the family (9.2.0, B12: a staff
 * upload stamped with her id is treated as missing), with
 * `purpose='message-attachment'`. A missing, cross-owner or staff-uploaded id is a
 * 404 (existence never leaks); a wrong-purpose id is a 422. Returns the rows in
 * the order supplied (for the thread preview).
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
    if (row === undefined || row.ownerId !== ownerId || row.createdBy !== 'owner') {
      throw new ApiError('not_found', `attachment media ${mediaId} not found`);
    }
    if (row.purpose !== 'message-attachment') {
      throw new ApiError('invalid_payload', `media ${mediaId} is not a message attachment`);
    }
    ordered.push(row);
  }
  return ordered;
}

// ---- body parsing --------------------------------------------------------

function parseMessageBody(body: unknown): {
  text: string;
  attachmentMediaIds: string[];
  clientMessageId: string | null;
} {
  const parsed = messageBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError('bad_request', `invalid body: ${formatZodIssues(parsed.error)}`);
  }
  // Normalize: an attachment-only message stores text='' (the schema's refine
  // guarantees text-nonempty OR ≥1 attachment, so this is never a no-op send).
  return {
    text: parsed.data.text ?? '',
    attachmentMediaIds: parsed.data.attachment_media_ids ?? [],
    clientMessageId: parsed.data.client_message_id ?? null,
  };
}

function parseReadBody(body: unknown): number | undefined {
  const parsed = readBodySchema.safeParse(body ?? {});
  if (!parsed.success) {
    throw new ApiError('bad_request', `invalid body: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data.up_to_seq;
}

function parseStartBody(body: unknown): {
  category: ThreadCategory;
  subtopic: string | null;
  dogIds: string[];
  text: string;
  attachmentMediaIds: string[];
  clientMessageId: string | null;
} {
  const parsed = startBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError('bad_request', `invalid body: ${formatZodIssues(parsed.error)}`);
  }
  return {
    category: parsed.data.category,
    subtopic: parsed.data.subtopic ?? null,
    dogIds: parsed.data.dog_ids ?? [],
    text: parsed.data.text ?? '',
    attachmentMediaIds: parsed.data.attachment_media_ids ?? [],
    clientMessageId: parsed.data.client_message_id ?? null,
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
