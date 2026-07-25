import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import { hashRequestBody, requireIdempotencyKey, withMutation } from '../db/mutation.js';
import { messagesRepository } from '../db/repositories/messagesRepository.js';
import { notificationsRepository } from '../db/repositories/notificationsRepository.js';
import { threadsRepository } from '../db/repositories/threadsRepository.js';
import { ApiError } from '../lib/errors.js';
import { requireStaff } from '../lib/principalNarrows.js';
import { type MessageWire, type ThreadWire } from '../lib/threadWire.js';
import { wireManyMessages, wireManyThreads } from '../lib/wireManyThreads.js';
import { defaultR2Client, type R2Client } from '../lib/r2.js';

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
 */

const MAX_MESSAGE_LEN = 4000;

const uuidParamSchema = z.object({ id: z.string().uuid() });
const messageBodySchema = z
  .object({ text: z.string().trim().min(1).max(MAX_MESSAGE_LEN) })
  .strict();

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
      return wireManyMessages(rows, r2);
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
      const { text } = parseMessageBody(request.body);

      // cache-noop: threads/messages aren't in the §3 cache map (reads are
      // uncached); the bell badge recomputes on the owner's next read.
      const outcome = await withMutation<MessageWire>(
        {
          principal,
          idempotencyKey,
          endpoint: 'POST /staff/threads/:id/messages',
          requestHash: hashRequestBody({ id, text }),
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
          });
          await threadsRepository.bumpLastMessage(tx, id, text);

          // Notify the owner a staff member replied (deep link to the thread).
          await notificationsRepository.enqueue(tx, {
            ownerId,
            type: 'message-received',
            title: 'New message',
            body: text.length > 140 ? `${text.slice(0, 137)}…` : text,
            deepLinkPath: `/chat/${id}`,
            deepLinkKind: 'thread',
            deepLinkId: id,
            senderStaffId: principal.staffId,
          });

          const [wire] = await wireManyMessages([row], r2);
          if (wire === undefined) {
            throw new Error(`staff reply ${id}: wire assembly returned no row`);
          }
          return { status: 201, body: wire };
        },
      );

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

function parseMessageBody(body: unknown): z.infer<typeof messageBodySchema> {
  const parsed = messageBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError('invalid_payload', `invalid body: ${parsed.error.message}`);
  }
  return parsed.data;
}
