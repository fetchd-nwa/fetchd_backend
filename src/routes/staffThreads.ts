import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import { deepLinkToPath } from '../contracts/wire.js';
import type { IdempotencyOutcome } from '../db/idempotency.js';
import { hashRequestBody, requireIdempotencyKey, withMutation } from '../db/mutation.js';
import { messagesRepository } from '../db/repositories/messagesRepository.js';
import { notificationsRepository } from '../db/repositories/notificationsRepository.js';
import { threadsRepository } from '../db/repositories/threadsRepository.js';
import { hasRepeats, isClientMessageIdViolation } from '../lib/clientMessageId.js';
import { ApiError } from '../lib/errors.js';
import { requireStaff } from '../lib/principalNarrows.js';
import type { PostStaffThreadsMessagesRequest } from '../contracts/wire.js';
import type { Equal, Expect } from '../contracts/typeAsserts.js';
import { type MessageWire, type ThreadWire } from '../lib/threadWire.js';
import { wireManyMessages, wireManyThreads } from '../lib/wireManyThreads.js';
import { defaultR2Client, type R2Client } from '../lib/r2.js';
import { uuidId } from '../lib/uuidId.js';

/**
 * Day-19 staff portal verb 3 — messaging reply.
 *
 *   GET  /staff/threads                  — the cross-owner thread queue
 *   GET  /staff/threads/:id/messages     — cross-owner conversation read (19b)
 *   POST /staff/threads/:id/messages     — staff reply (sender_kind='staff')
 *
 * Cross-owner reads/writes gated by `requireStaff`; the owner-scoped read
 * surface lives in `routes/threads.ts`. The reply is the first message-
 * WRITE path in the codebase — it INSERTs a staff message, bumps the
 * thread's last_message preview + last_message_at, and enqueues a
 * `message-received` notification to the thread's owner (deep link
 * `/chat/:threadId` + structured ref kind='thread'/id=threadId).
 *
 * 9.2.0 (W1, W2; backend pass 1): every message carries its `seq`, both lists
 * are in `seq` order, and the reply may carry its `client_message_id`
 * (`lib/clientMessageId.ts`), echoed to staff only.
 */

const MAX_MESSAGE_LEN = 4000;

const MAX_ATTACHMENTS_PER_MESSAGE = 10;

const uuidParamSchema = z.object({ id: uuidId() });
/**
 * The staff reply's keys (9.2.0 `PostStaffThreadsMessagesRequest`, widened to the owner's
 * grammar; brief CR18: the three schema keys land in backend pass 1 so the body pin closes).
 * W6's text-or-attachments rule and stored staff attachments are pass 2's: until then
 * `parseMessageBody` keeps today's refusals — a reply without text is 422, and so is one
 * naming any attachment (9.1.0 refused the key itself). Any failure of THIS schema, an id
 * named twice included, is 422 `invalid_payload` (the asymmetry W6 keeps).
 */
const messageBodySchema = z
  .object({
    text: z.string().trim().min(1).max(MAX_MESSAGE_LEN).optional(),
    attachment_media_ids: z.array(uuidId()).max(MAX_ATTACHMENTS_PER_MESSAGE).optional(),
    client_message_id: uuidId().optional(),
  })
  .strict()
  .refine((body) => !hasRepeats(body.attachment_media_ids), {
    message: 'an attachment id is named twice',
  });

/** Zod ↔ wire pin (designs/wire-contract-completion.md §5.1.3) — the STAFF
 *  reply grammar (ledger NOTE-29; widened at 9.2.0, its 422 kept).
 *  `z.input` so the pin describes what a staffer may SEND, pre-trim. */
export type PostStaffThreadsMessagesBodyConformance = Expect<
  Equal<z.input<typeof messageBodySchema>, PostStaffThreadsMessagesRequest>
>;

export interface StaffThreadsRouteOpts extends AuthRouteOptions {
  /** Override the R2 client (contract tests inject the stub for URL signing). */
  r2?: R2Client;
}

export function registerStaffThreadsRoute(
  app: FastifyInstance,
  opts: StaffThreadsRouteOpts = {},
): void {
  const authHook = resolveAuthHook(opts);
  const r2 = opts.r2 ?? defaultR2Client;

  // --- GET /staff/threads -------------------------------------------------
  //
  // Cross-owner thread queue, newest last_message_at first. No filter
  // today — the "dumbest viable" portal filters client-side; a status /
  // owner filter is a 19b/Day-20 item if the list grows.
  app.get('/staff/threads', { preHandler: [authHook] }, async (request): Promise<ThreadWire[]> => {
    const principal = requirePrincipal(request);
    requireStaff(principal, 'read the staff thread queue');
    const rows = await threadsRepository.findLive();
    return wireManyThreads(rows);
  });

  // --- GET /staff/threads/:id/messages ------------------------------------
  //
  // Cross-owner conversation read (Day-19b). The reply verb is useless
  // without the staffer seeing the thread first; the owner-side read
  // (`routes/threads.ts`) is owner-scoped, so staff need their own
  // cross-owner read. 404 when the thread doesn't exist (checked via
  // `existsLive` — an empty live thread must read as `[]`, not 404).
  app.get(
    '/staff/threads/:id/messages',
    { preHandler: [authHook] },
    async (request): Promise<MessageWire[]> => {
      const principal = requirePrincipal(request);
      requireStaff(principal, 'read a thread');
      const { id } = parseUuidParam(request.params);
      const exists = await threadsRepository.existsLive(id);
      if (!exists) {
        throw new ApiError('not_found', `thread ${id} not found`);
      }
      const rows = await messagesRepository.findLiveByThread(id);
      return wireManyMessages(rows, r2, 'staff');
    },
  );

  // --- POST /staff/threads/:id/messages -----------------------------------
  //
  // Staff reply. 404 when the thread doesn't exist (cross-owner: any live
  // thread is replyable by staff). INSERTs the message, bumps the thread
  // preview, notifies the owner. Returns 201 + the created MessageWire.
  app.post(
    '/staff/threads/:id/messages',
    { preHandler: [authHook] },
    async (request, reply): Promise<MessageWire> => {
      const principal = requirePrincipal(request);
      requireStaff(principal, 'reply to a thread');
      const { id } = parseUuidParam(request.params);
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
      const { text, clientMessageId } = parseMessageBody(request.body);

      /**
       * W2: her stored message for this `client_message_id`, looked up BEFORE the key's
       * hash. In this thread: that message, 200. In another thread: 409 `conflict` (LR18).
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
        const [wire] = await wireManyMessages([stored], r2, 'staff');
        if (wire === undefined) throw new Error(`staff reply ${id}: wire assembly returned no row`);
        return wire;
      };
      const stored = await repeated();
      if (stored !== undefined) {
        reply.code(200);
        return stored;
      }

      // cache-noop: threads/messages aren't in the §3 cache map (reads are
      // uncached); the bell badge recomputes on the owner's next read.
      let outcome: IdempotencyOutcome<MessageWire>;
      try {
        outcome = await withMutation<MessageWire>(
          {
            principal,
            idempotencyKey,
            endpoint: 'POST /staff/threads/:id/messages',
            requestHash: hashRequestBody(
              clientMessageId === null ? { id, text } : { id, text, clientMessageId },
            ),
          },
          async (tx) => {
            const ownerId = await threadsRepository.findOwnerById(tx, id);
            if (ownerId === undefined) {
              throw new ApiError('not_found', `thread ${id} not found`);
            }

            const row = await messagesRepository.createStaffMessage(tx, {
              threadId: id,
              staffId: principal.staffId,
              text,
              clientMessageId,
            });
            await threadsRepository.bumpLastMessage(tx, id, text);

            // Notify the owner a staff member replied (deep link to the thread).
            await notificationsRepository.enqueue(tx, {
              ownerId,
              type: 'message-received',
              title: 'New message',
              body: text.length > 140 ? `${text.slice(0, 137)}…` : text,
              deepLinkPath: deepLinkToPath({ kind: 'thread', id }),
              deepLinkKind: 'thread',
              deepLinkId: id,
              senderStaffId: principal.staffId,
            });

            const [wire] = await wireManyMessages([row], r2, 'staff');
            if (wire === undefined) {
              throw new Error(`staff reply ${id}: wire assembly returned no row`);
            }
            return { status: 201, body: wire };
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

      reply.code(outcome.status);
      return outcome.body;
    },
  );
}

function parseUuidParam(params: unknown): { id: string } {
  const parsed = uuidParamSchema.safeParse(params);
  if (!parsed.success) {
    throw new ApiError('bad_request', `invalid path: ${parsed.error.message}`);
  }
  return parsed.data;
}

function parseMessageBody(body: unknown): { text: string; clientMessageId: string | null } {
  const parsed = messageBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError('invalid_payload', `invalid body: ${parsed.error.message}`);
  }
  // Backend pass 1 keeps 9.1.0's refusals until W6 lands (pass 2): text is required, and a
  // staff attachment is not accepted yet.
  if (parsed.data.text === undefined) {
    throw new ApiError('invalid_payload', 'invalid body: text is required');
  }
  if ((parsed.data.attachment_media_ids ?? []).length > 0) {
    throw new ApiError('invalid_payload', 'invalid body: staff attachments are not accepted yet');
  }
  return { text: parsed.data.text, clientMessageId: parsed.data.client_message_id ?? null };
}
