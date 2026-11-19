import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import type { IdempotencyOutcome } from '../db/idempotency.js';
import { hashRequestBody, requireIdempotencyKey, withMutation } from '../db/mutation.js';
import { dogsRepository } from '../db/repositories/dogsRepository.js';
import {
  mediaAssetsRepository,
  type MediaAssetRow,
} from '../db/repositories/mediaAssetsRepository.js';
import { messagesRepository, type MessageRow } from '../db/repositories/messagesRepository.js';
import { ownersRepository } from '../db/repositories/ownersRepository.js';
import { threadsRepository } from '../db/repositories/threadsRepository.js';
import { threadCategory } from '../db/schema/schema.js';
import type { Tx } from '../db/tx.js';
import { hasRepeats, isClientMessageIdViolation } from '../lib/clientMessageId.js';
import { ApiError } from '../lib/errors.js';
import { defaultExpoPushClient, type ExpoPushClient } from '../lib/expoPush.js';
import { prepareStaffMessageNotice, sendStaffMessagePush } from '../lib/messageNotice.js';
import { afterSeqQuerySchema, parseAfterSeqQuery } from '../lib/messageSeq.js';
import { NO_NUL, TOPIC_LABEL, threadPreview } from '../lib/messageText.js';
import { requireStaff } from '../lib/principalNarrows.js';
import { staffBell } from '../lib/staffBell.js';
import { formatZodIssues } from '../lib/zodIssues.js';
import type {
  GetStaffThreadsMessagesQuery,
  NoticeReachWire,
  PostStaffThreadsMessagesRequest,
  PostStaffThreadsReadRequest,
  PostStaffThreadsRequest,
  PostStaffThreadsResponse,
  StaffBellWire,
  ThreadCategory,
} from '../contracts/wire.js';
import type { Equal, Expect } from '../contracts/typeAsserts.js';
import { type MessageWire, type StaffThreadWire } from '../lib/threadWire.js';
import {
  wireManyMessages,
  wireManyStaffThreads,
  type StaffReader,
} from '../lib/wireManyThreads.js';
import { defaultR2Client, type R2Client } from '../lib/r2.js';
import { uuidId } from '../lib/uuidId.js';
import { trackInFlight } from '../realtime/settle.js';

/**
 * The staff portal's messaging (Day-19 verb 3; S46 from 9.2.0):
 *
 *   GET  /staff/threads                    — every live thread, as `StaffThreadWire` (S46)
 *   GET  /staff/threads/:id/messages       — a conversation (`?after_seq=`, W4)
 *   POST /staff/threads/:id/messages       — the staff reply (text and/or photos, W6)
 *   POST /staff/threads                    — a staffer starts, or continues, a conversation (S46)
 *   POST /staff/threads/:id/read           — the family messages the portal rendered (S46)
 *   GET  /staff/notifications/summary      — the bell (`StaffBellWire`, NOTIF-U33)
 *
 * Gated by `requireStaff`; the owner-scoped surface lives in `routes/threads.ts`. Each staff
 * message writes the family's feed row inside its transaction and, after commit, sends her
 * phone one push, never awaited (`lib/messageNotice.ts`, A1.2); the 201 carries `reach`. A
 * staff message is not its sender's read (MB27 Q4): a bell clears only through `/read`.
 *
 * 9.2.0 (W1, W2; backend pass 1): every message carries its `seq`, both lists are in `seq`
 * order, and a staff send may carry its `client_message_id` (`lib/clientMessageId.ts`), echoed
 * to staff only.
 */

const MAX_MESSAGE_LEN = 4000;

const MAX_ATTACHMENTS_PER_MESSAGE = 10;

const MAX_DOGS_PER_START = 10;

/** `PostStaffThreadsReadRequest.message_ids`: 1–500 (a client chunks a longer list, CR13). */
const MAX_READ_IDS = 500;

const uuidParamSchema = z.object({ id: uuidId() });

/** A reply needs a body OR at least one attachment — an empty reply is refused (W6). */
function hasTextOrAttachment(body: { text?: string; attachment_media_ids?: string[] }): boolean {
  return (
    (body.text !== undefined && body.text.length > 0) ||
    (body.attachment_media_ids !== undefined && body.attachment_media_ids.length > 0)
  );
}

/**
 * The staff reply (9.2.0 `PostStaffThreadsMessagesRequest`, W6): the owner's grammar — non-empty
 * `text` OR at least one attachment, `text` at most 4000 after trim, at most 10 ids, no id twice,
 * no NUL (A1). Any failure of THIS schema is 422 `invalid_payload` (the asymmetry W6 keeps,
 * `parseMessageBody`).
 */
const messageBodySchema = z
  .object({
    text: z.string().trim().max(MAX_MESSAGE_LEN).refine(NO_NUL.check, NO_NUL.message).optional(),
    attachment_media_ids: z.array(uuidId()).max(MAX_ATTACHMENTS_PER_MESSAGE).optional(),
    client_message_id: uuidId().optional(),
  })
  .strict()
  .refine(hasTextOrAttachment, {
    message: 'a reply must have text or at least one attachment',
  })
  .refine((body) => !hasRepeats(body.attachment_media_ids), {
    message: 'an attachment id is named twice',
  });

/** Zod ↔ wire pin (designs/wire-contract-completion.md §5.1.3) — the STAFF
 *  reply grammar (ledger NOTE-29; widened at 9.2.0, its 422 kept).
 *  `z.input` so the pin describes what a staffer may SEND, pre-trim. */
export type PostStaffThreadsMessagesBodyConformance = Expect<
  Equal<z.input<typeof messageBodySchema>, PostStaffThreadsMessagesRequest>
>;

/**
 * `POST /staff/threads` (9.2.0 `PostStaffThreadsRequest`; contract-notes mechanics 20–22):
 * `.strict()`, text only (a staff photo goes in a reply), `text` 1–4000 after trim, no NUL,
 * `owner_id` and `dog_ids` uuids, at most 10 dogs, no repeats. A body failing it is 400 (R6).
 */
const startBodySchema = z
  .object({
    owner_id: uuidId(),
    category: z.enum(threadCategory.enumValues),
    dog_ids: z.array(uuidId()).max(MAX_DOGS_PER_START).optional(),
    text: z.string().trim().min(1).max(MAX_MESSAGE_LEN).refine(NO_NUL.check, NO_NUL.message),
    client_message_id: uuidId().optional(),
  })
  .strict()
  .refine((body) => !hasRepeats(body.dog_ids), { message: 'a dog id is named twice' });

/** Zod ↔ wire pin for `POST /staff/threads`. */
export type PostStaffThreadsBodyConformance = Expect<
  Equal<z.input<typeof startBodySchema>, PostStaffThreadsRequest>
>;

/** `POST /staff/threads/:id/read` (9.2.0 `PostStaffThreadsReadRequest`; mechanic 18). */
const readBodySchema = z
  .object({ message_ids: z.array(uuidId()).min(1).max(MAX_READ_IDS) })
  .strict();

/** Zod ↔ wire pin for the staff read. */
export type PostStaffThreadsReadBodyConformance = Expect<
  Equal<z.input<typeof readBodySchema>, PostStaffThreadsReadRequest>
>;

/** Zod ↔ wire pin for the staff list's query (W4). */
export type GetStaffThreadsMessagesQueryConformance = Expect<
  Equal<z.input<typeof afterSeqQuerySchema>, GetStaffThreadsMessagesQuery>
>;

/**
 * What a staff send's Idempotency-Key stores: the message ROW (its wire, attachments' signed URLs
 * included, is assembled after commit, as the family's send does), the `reach` decided at commit,
 * and the feed row its push announces. A key replay rebuilds the same answer, `reach` included,
 * and hands the push to its claim (which sends nothing more).
 */
interface StaffSendRecord {
  row: MessageRow;
  reach: NoticeReachWire;
  notificationId: string | null;
}

interface StaffStartRecord extends StaffSendRecord {
  threadId: string;
}

export interface StaffThreadsRouteOpts extends AuthRouteOptions {
  /** Override the R2 client (contract tests inject the stub for URL signing). */
  r2?: R2Client;
  /** Override the Expo client the direct push sends through (contract tests inject the stub). */
  expoPush?: ExpoPushClient;
}

export function registerStaffThreadsRoute(
  app: FastifyInstance,
  opts: StaffThreadsRouteOpts = {},
): void {
  const authHook = resolveAuthHook(opts);
  const r2 = opts.r2 ?? defaultR2Client;
  const expoPush = opts.expoPush ?? defaultExpoPushClient;

  /** A staff message as staff read it (its `client_message_id` and `receipt` included). */
  async function staffWire(row: MessageRow): Promise<MessageWire> {
    const [wire] = await wireManyMessages([row], r2, 'staff');
    if (wire === undefined) throw new Error(`message ${row.id}: failed to build message wire`);
    return wire;
  }

  /** A thread and a message as `PostStaffThreadsResponse` carries them, for this reader. */
  async function staffPair(
    threadId: string,
    row: MessageRow,
    reader: StaffReader,
  ): Promise<PostStaffThreadsResponse> {
    const threadRow = await threadsRepository.findOneForStaff(threadId);
    if (threadRow === undefined)
      throw new Error(`thread ${threadId}: not found for its own message`);
    const [[thread], message] = await Promise.all([
      wireManyStaffThreads([threadRow], reader),
      staffWire(row),
    ]);
    if (thread === undefined) throw new Error(`thread ${threadId}: failed to build wire shape`);
    return { thread, message };
  }

  /**
   * After commit, never awaited (A1.2): the message's one push. Through `trackInFlight`, so a
   * rejection is one warn line and shutdown drains it (FH1, LR5, LR9). Called on a key replay
   * too: the claim in `message_pushes` is what keeps it to one.
   */
  function pushAfterCommit(record: StaffSendRecord, log: FastifyBaseLogger): void {
    const { notificationId } = record;
    if (notificationId === null) return; // none/not-queued: nothing was written to announce
    const messageId = record.row.id;
    void trackInFlight(() => sendStaffMessagePush(messageId, notificationId, { expoPush, log }), {
      log,
      what: 'staff message push',
      fields: { messageId, notificationId },
    });
  }

  // --- GET /staff/threads -------------------------------------------------
  //
  // Every live thread, newest last_message_at first, each with its family and the caller's
  // own read state (9.2.0 `StaffThreadWire`, S46). Every staffer, trainers included, sees
  // every thread (MSG-12).
  app.get(
    '/staff/threads',
    { preHandler: [authHook] },
    async (request): Promise<StaffThreadWire[]> => {
      const principal = requirePrincipal(request);
      requireStaff(principal, 'read the staff thread queue');
      const rows = await threadsRepository.findLiveForStaff();
      return wireManyStaffThreads(rows, readerOf(principal));
    },
  );

  // --- GET /staff/threads/:id/messages ------------------------------------
  //
  // Cross-owner conversation read (Day-19b). The reply verb is useless
  // without the staffer seeing the thread first; the owner-side read
  // (`routes/threads.ts`) is owner-scoped, so staff need their own
  // cross-owner read. 404 when the thread doesn't exist (checked via
  // `existsLive` — an empty live thread must read as `[]`, not 404).
  // 9.2.0 (W4): `?after_seq=`.
  app.get(
    '/staff/threads/:id/messages',
    { preHandler: [authHook] },
    async (request): Promise<MessageWire[]> => {
      const principal = requirePrincipal(request);
      requireStaff(principal, 'read a thread');
      const { id } = parseUuidParam(request.params);
      const afterSeq = parseAfterSeqQuery(request.query);
      const exists = await threadsRepository.existsLive(id);
      if (!exists) {
        throw new ApiError('not_found', `thread ${id} not found`);
      }
      const rows = await messagesRepository.findLiveByThread(
        id,
        afterSeq !== undefined ? { afterSeq } : {},
      );
      return wireManyMessages(rows, r2, 'staff');
    },
  );

  // --- POST /staff/threads/:id/messages -----------------------------------
  //
  // Staff reply. 404 when the thread doesn't exist (cross-owner: any live
  // thread is replyable by staff). INSERTs the message (and, from 9.2.0, its photos), bumps
  // the thread preview, writes the family's feed row and decides `reach`; after commit, the
  // push. Returns 201 + the created MessageWire with `reach`.
  app.post(
    '/staff/threads/:id/messages',
    { preHandler: [authHook] },
    async (request, reply): Promise<MessageWire> => {
      const principal = requirePrincipal(request);
      requireStaff(principal, 'reply to a thread');
      const { id } = parseUuidParam(request.params);
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
      const { text, attachmentMediaIds, clientMessageId } = parseMessageBody(request.body);

      // A5: the thread first, as the family's send checks hers, so a used id never answers
      // for a thread that does not exist or has expired.
      if (!(await threadsRepository.existsLive(id))) {
        throw new ApiError('not_found', `thread ${id} not found`);
      }

      /**
       * W2: her stored message for this `client_message_id`, looked up BEFORE the key's
       * hash. In this thread: that message, 200, without `reach` (the notice was decided
       * once). In another thread: 409 `conflict` (LR18).
       */
      const repeated = async (): Promise<MessageWire | undefined> => {
        if (clientMessageId === null) return undefined;
        const stored = await messagesRepository.findByStaffClientMessageId(
          principal.staffId,
          clientMessageId,
        );
        if (stored === undefined) return undefined;
        if (stored.threadId !== id) {
          throw new ApiError(
            'conflict',
            'this client_message_id names a message you sent in another thread',
          );
        }
        return staffWire(stored);
      };
      const stored = await repeated();
      if (stored !== undefined) {
        reply.code(200);
        return stored;
      }

      // cache-noop: threads/messages aren't in the §3 cache map (reads are
      // uncached); the bell badge recomputes on the owner's next read.
      let outcome: IdempotencyOutcome<StaffSendRecord>;
      try {
        outcome = await withMutation<StaffSendRecord>(
          {
            principal,
            idempotencyKey,
            endpoint: 'POST /staff/threads/:id/messages',
            // A text-only reply without an id hashes as the 9.1.0 reply did.
            requestHash: hashRequestBody({
              id,
              text,
              ...(attachmentMediaIds.length > 0 ? { attachmentMediaIds } : {}),
              ...(clientMessageId !== null ? { clientMessageId } : {}),
            }),
          },
          async (tx) => {
            const ownerId = await threadsRepository.findOwnerById(tx, id);
            if (ownerId === undefined) {
              throw new ApiError('not_found', `thread ${id} not found`);
            }
            const media = await validateStaffAttachments(tx, ownerId, attachmentMediaIds);
            const row = await messagesRepository.createStaffMessage(tx, {
              threadId: id,
              staffId: principal.staffId,
              text,
              attachmentMediaIds,
              clientMessageId,
            });
            await threadsRepository.bumpLastMessage(tx, id, threadPreview(text, media));
            const notice = await prepareStaffMessageNotice(
              tx,
              { messageId: row.id, threadId: id, ownerId, senderStaffId: principal.staffId },
              request.log,
            );
            return {
              status: 201,
              body: { row, reach: notice.reach, notificationId: notice.notificationId },
            };
          },
        );
      } catch (err) {
        // LR11: a racing first reply with this id won; its 23505 aborted our transaction,
        // so the winner is read on the pool, outside it (FL1).
        if (clientMessageId !== null && isClientMessageIdViolation(err, 'staff')) {
          const winner = await repeated();
          if (winner !== undefined) {
            reply.code(200);
            return winner;
          }
        }
        throw err;
      }

      const record = await answeredRecord(outcome);
      if (record === undefined) {
        // A8: a key stored by code from before 9.2.0 holds a 9.1.0 MessageWire (no `seq`, no
        // `reach`): answer the stored message as it is now.
        const legacy = outcome.body as unknown as { id?: unknown };
        const row =
          typeof legacy.id === 'string' ? await messagesRepository.findById(legacy.id) : undefined;
        reply.code(outcome.status);
        return row === undefined ? (outcome.body as unknown as MessageWire) : staffWire(row);
      }
      pushAfterCommit(record, request.log);
      const wire = await staffWire(record.row);
      wire.reach = record.reach;
      reply.code(outcome.status);
      return wire;
    },
  );

  // --- POST /staff/threads ------------------------------------------------
  //
  // 9.2.0 (S46, MSG-U13; signed design §2.9:4555 as A1 re-cuts it): a staffer starts a
  // conversation with a family, or continues her own live one on that topic (by lookup, no
  // unique index). Text only; no `closure` until P31 (A1 D5). The family is told as by a
  // reply. 201 `PostStaffThreadsResponse`; a `client_message_id` repeat is the stored pair,
  // 200, always, never 409 (mechanic 13; CR9).
  app.post(
    '/staff/threads',
    { preHandler: [authHook] },
    async (request, reply): Promise<PostStaffThreadsResponse> => {
      const principal = requirePrincipal(request);
      requireStaff(principal, 'start a conversation with a family');
      const reader = readerOf(principal);
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
      const body = parseStartBody(request.body);

      const repeated = async (): Promise<PostStaffThreadsResponse | undefined> => {
        if (body.clientMessageId === null) return undefined;
        const stored = await messagesRepository.findByStaffClientMessageId(
          principal.staffId,
          body.clientMessageId,
        );
        if (stored === undefined) return undefined;
        return staffPair(stored.threadId, stored, reader);
      };
      const stored = await repeated();
      if (stored !== undefined) {
        reply.code(200);
        return stored;
      }

      let outcome: IdempotencyOutcome<StaffStartRecord>;
      try {
        // cache-noop: threads/messages aren't in the §3 cache map (reads aren't cached).
        outcome = await withMutation<StaffStartRecord>(
          {
            principal,
            idempotencyKey,
            endpoint: 'POST /staff/threads',
            requestHash: hashRequestBody({
              ownerId: body.ownerId,
              category: body.category,
              dogIds: body.dogIds,
              text: body.text,
              clientMessageId: body.clientMessageId,
            }),
          },
          async (tx) => {
            // A live family, and her live dogs only (404 otherwise; existence never leaks).
            if (!(await ownersRepository.existsLive(tx, body.ownerId))) {
              throw new ApiError('not_found', `family ${body.ownerId} not found`);
            }
            for (const dogId of body.dogIds) {
              if (!(await dogsRepository.findOwnedExists(dogId, body.ownerId, tx))) {
                throw new ApiError('not_found', `dog ${dogId} not found`);
              }
            }
            const threadId = await threadsRepository.findOrCreateStaffThread(tx, {
              ownerId: body.ownerId,
              category: body.category,
              staffId: principal.staffId,
              title: TOPIC_LABEL[body.category],
            });
            await threadsRepository.addDogs(tx, threadId, body.dogIds);
            const row = await messagesRepository.createStaffMessage(tx, {
              threadId,
              staffId: principal.staffId,
              text: body.text,
              clientMessageId: body.clientMessageId,
            });
            await threadsRepository.bumpLastMessage(tx, threadId, body.text);
            const notice = await prepareStaffMessageNotice(
              tx,
              {
                messageId: row.id,
                threadId,
                ownerId: body.ownerId,
                senderStaffId: principal.staffId,
              },
              request.log,
            );
            return {
              status: 201,
              body: { threadId, row, reach: notice.reach, notificationId: notice.notificationId },
            };
          },
        );
      } catch (err) {
        if (body.clientMessageId !== null && isClientMessageIdViolation(err, 'staff')) {
          const winner = await repeated();
          if (winner !== undefined) {
            reply.code(200);
            return winner;
          }
        }
        throw err;
      }

      pushAfterCommit(outcome.body, request.log);
      const pair = await staffPair(outcome.body.threadId, outcome.body.row, reader);
      pair.message.reach = outcome.body.reach;
      reply.code(outcome.status);
      return pair;
    },
  );

  // --- POST /staff/threads/:id/read ---------------------------------------
  //
  // 9.2.0 (S46, MSG-U17; signed design §2.9:4555): marks read, for the caller only, the
  // listed family messages of this thread (the ones the portal rendered); anything else
  // listed is ignored; a repeat is a no-op. The thread row is locked first (L4). 204.
  app.post('/staff/threads/:id/read', { preHandler: [authHook] }, async (request, reply) => {
    const principal = requirePrincipal(request);
    requireStaff(principal, 'mark messages read');
    const { id } = parseUuidParam(request.params);
    const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
    const messageIds = parseReadBody(request.body);
    // cache-noop: threads/messages aren't in the §3 cache map (reads aren't cached).
    const outcome = await withMutation<null>(
      {
        principal,
        idempotencyKey,
        endpoint: 'POST /staff/threads/:id/read',
        requestHash: hashRequestBody({ threadId: id, messageIds }),
      },
      async (tx) => {
        if ((await threadsRepository.lockLive(tx, id)) === undefined) {
          throw new ApiError('not_found', `thread ${id} not found`);
        }
        await messagesRepository.markReadForStaff(tx, {
          threadId: id,
          staffId: principal.staffId,
          messageIds,
        });
        return { status: 204, body: null };
      },
    );
    reply.code(outcome.status);
    return outcome.body;
  });

  // --- GET /staff/notifications/summary -----------------------------------
  //
  // 9.2.0 (NOTIF-U33; `StaffBellWire`): the bell, per campus, for the caller. A family is 403.
  app.get(
    '/staff/notifications/summary',
    { preHandler: [authHook] },
    async (request): Promise<StaffBellWire> => {
      const principal = requirePrincipal(request);
      requireStaff(principal, 'read the staff bell');
      return staffBell(readerOf(principal));
    },
  );
}

/** The staff reader the wire and the bell are built for: her row's id and role. */
function readerOf(principal: { staffId: string; role: StaffReader['role'] }): StaffReader {
  return { staffId: principal.staffId, role: principal.role };
}

/**
 * The stored record of a staff send, or `undefined` when the key was stored by code from before
 * 9.2.0 (its body is a 9.1.0 MessageWire, A8). A replay answers the message as it is now, with
 * the `reach` decided at its commit.
 */
async function answeredRecord(
  outcome: IdempotencyOutcome<StaffSendRecord>,
): Promise<StaffSendRecord | undefined> {
  const body = outcome.body as unknown;
  if (typeof body !== 'object' || body === null || !('row' in body)) return undefined;
  if (!outcome.replayed) return outcome.body;
  const fresh = await messagesRepository.findById(outcome.body.row.id);
  return fresh === undefined ? outcome.body : { ...outcome.body, row: fresh };
}

/**
 * W6 (9.2.0; contract-notes mechanic 24; B12's staff half): each id must be a live
 * `message-attachment` row a staffer uploaded for THIS family (`created_by = 'staff'`, the
 * thread owner's stamp, `POST /media/upload`'s message-attachment arm). Missing, another
 * family's, or a family's own upload is 404 (existence never leaks); a staff upload of this
 * family that is not a message attachment is 422, as on the family's send. Rows in the order
 * supplied (the preview reads them).
 */
async function validateStaffAttachments(
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
    if (row === undefined || row.ownerId !== ownerId || row.createdBy !== 'staff') {
      throw new ApiError('not_found', `attachment media ${mediaId} not found`);
    }
    if (row.purpose !== 'message-attachment') {
      throw new ApiError('invalid_payload', `media ${mediaId} is not a message attachment`);
    }
    ordered.push(row);
  }
  return ordered;
}

function parseUuidParam(params: unknown): { id: string } {
  const parsed = uuidParamSchema.safeParse(params);
  if (!parsed.success) {
    throw new ApiError('bad_request', `invalid path: ${parsed.error.message}`);
  }
  return parsed.data;
}

function parseMessageBody(body: unknown): {
  text: string;
  attachmentMediaIds: string[];
  clientMessageId: string | null;
} {
  const parsed = messageBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError('invalid_payload', `invalid body: ${parsed.error.message}`);
  }
  // An attachment-only reply is stored as text '' (the schema guarantees text OR a photo).
  return {
    text: parsed.data.text ?? '',
    attachmentMediaIds: parsed.data.attachment_media_ids ?? [],
    clientMessageId: parsed.data.client_message_id ?? null,
  };
}

function parseStartBody(body: unknown): {
  ownerId: string;
  category: ThreadCategory;
  dogIds: string[];
  text: string;
  clientMessageId: string | null;
} {
  const parsed = startBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError('bad_request', `invalid body: ${formatZodIssues(parsed.error)}`);
  }
  return {
    ownerId: parsed.data.owner_id,
    category: parsed.data.category,
    dogIds: parsed.data.dog_ids ?? [],
    text: parsed.data.text,
    clientMessageId: parsed.data.client_message_id ?? null,
  };
}

function parseReadBody(body: unknown): string[] {
  const parsed = readBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError('bad_request', `invalid body: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data.message_ids;
}
