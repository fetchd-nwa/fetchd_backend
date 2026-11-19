import { and, count, eq, isNull, ne, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { Tx } from '../db/tx.js';
import { messageAttachments, messagePushes, messages, threads } from '../db/schema/schema.js';
import { deviceTokensRepository } from '../db/repositories/deviceTokensRepository.js';
import { notificationsRepository } from '../db/repositories/notificationsRepository.js';
import { ownersRepository } from '../db/repositories/ownersRepository.js';
import { staffRepository } from '../db/repositories/staffRepository.js';
import {
  deepLinkToPath,
  type NoticeReachWire,
  type NotificationPushData,
} from '../contracts/wire.js';
import type { ExpoPushClient, ExpoPushMessage, ExpoPushTicket } from './expoPush.js';
import { shouldSkipPush } from './pushPreferences.js';
import { staffSenderNames } from './wireManyThreads.js';

/**
 * A staff message's notice to the family, sent directly (plan unit P45 with O-MSG-LIVE; design
 * messaging-live-v1 A1.2, A1 D4/D5/D8, A2 FL2-FL4, FM1, FM2; brief LR5). **The one seam P31
 * rewrites**: its email lane and queue replace these two bodies and nothing else (A1.2), so a
 * message is never both pushed here and queued there.
 *
 *   · `prepareStaffMessageNotice(tx, …)`, INSIDE the send's transaction, in a savepoint (FL2):
 *     the family's feed row (the `message-received` row the reply wrote before 9.2.0) and the
 *     message's `reach` (`NoticeReachWire`), from the two reads a push makes: her master switch
 *     and her live device tokens. If any of it fails, only the notice rolls back: the message
 *     commits, `reach` is `none`/`not-queued`, one warn line, no push.
 *   · `sendStaffMessagePush(messageId, notificationId, deps)`, AFTER commit, never awaited (the
 *     route hands it to `trackInFlight`, so shutdown drains it, LR9). At most once per message:
 *     it claims `message_pushes` first (`INSERT … ON CONFLICT DO NOTHING RETURNING`), so a key
 *     replay, a second instance or a second call sends nothing more. No retry: an Expo failure is
 *     one warn line and the ticket counts on the claim; the message and its feed row are the
 *     record.
 *   · `reportLostStaffMessagePushes(log)`: the boot count (FM2). Pass 3 calls it after `listen`.
 */

type Runner = Tx | typeof db;

/** The logger a notice needs: pino's `warn` (below the pager's level-50 tap). */
export interface NoticeLog {
  warn(obj: Record<string, unknown>, msg: string): void;
}

/** What the boot count logs with. */
export interface BootCountLog extends NoticeLog {
  info(obj: Record<string, unknown>, msg: string): void;
}

/** What the post-commit push is given (the route's injected Expo client; `request.log`). */
export interface StaffMessagePushDeps {
  expoPush: ExpoPushClient;
  log: NoticeLog;
}

/** `prepareStaffMessageNotice`'s answer: what `MessageWire.reach` says, and the feed row. */
export interface StaffMessageNotice {
  reach: NoticeReachWire;
  /** The feed row the push announces (`data.notification_id`, FL3); `null` when not queued. */
  notificationId: string | null;
}

/** A body is her words, cut where the reply's feed row always cut them. */
const MAX_BODY = 140;

/** Today's feed title, kept: only the push's title follows the signature (A1.2). */
const FEED_TITLE = 'New message';

const NOTICE_NOT_QUEUED =
  'staff message notice failed and rolled back alone: the message stands, the family was not told (reach none/not-queued)';
const PUSH_TRANSPORT_FAILED =
  'staff message push: Expo failed; not retried (the message and its feed row stand)';
const PUSH_TICKET_ERRORS = 'staff message push: Expo refused some tickets; not retried';
const BOOT_COUNT = 'boot: staff message pushes claimed over a minute ago and never sent';
const BOOT_TABLE_MISSING =
  'boot: message_pushes is missing (the database is behind rs3), so no lost push is counted';

/** What a notice reads of its message. */
interface NoticeMessage {
  id: string;
  threadId: string;
  ownerId: string;
  senderKind: 'owner' | 'staff';
  senderStaffId: string | null;
  text: string;
  attachmentCount: number;
}

async function readNoticeMessage(
  runner: Runner,
  messageId: string,
): Promise<NoticeMessage | undefined> {
  const [row] = await runner
    .select({
      id: messages.id,
      threadId: messages.threadId,
      ownerId: threads.ownerId,
      senderKind: messages.senderKind,
      senderStaffId: messages.senderStaffId,
      text: messages.text,
    })
    .from(messages)
    .innerJoin(threads, eq(threads.id, messages.threadId))
    .where(and(eq(messages.id, messageId), isNull(messages.expiredAt)))
    .limit(1);
  if (row === undefined) return undefined;
  const [attachments] = await runner
    .select({ n: count(messageAttachments.id) })
    .from(messageAttachments)
    .where(eq(messageAttachments.messageId, messageId));
  return { ...row, attachmentCount: Number(attachments?.n ?? 0) };
}

/**
 * Who the family is told the message is from: the name her own thread shows on it
 * (`MessageWire.sender_name`, "the push title follows it"): in a school thread the staffer's
 * first name, or the school's name under `school_name` (MSG-U04, answer 22); elsewhere the
 * staffer's name. When no name reads (her row expired in between), the school's own name.
 */
async function senderNameOf(message: NoticeMessage): Promise<string> {
  const names = await staffSenderNames([message], 'owner');
  const name = names.get(message.id) ?? null;
  if (name !== null && name !== '') return name;
  const school = await staffRepository.findSchoolAccount();
  return school?.name ?? FEED_TITLE;
}

/** Her words cut at 140, or, for a reply that is only attachments, *Amber sent a photo*. */
export function noticeBody(text: string, attachmentCount: number, senderName: string): string {
  if (text === '' && attachmentCount > 0) return `${senderName} sent a photo`;
  return text.length > MAX_BODY ? `${text.slice(0, MAX_BODY - 3)}…` : text;
}

/**
 * Inside the send's transaction, in a savepoint (A2 FL2): write the family's feed row and decide
 * `reach` from her master switch and her live tokens, the reads `deliverOne` makes
 * (`message-received` has no push category, so only the master switch applies). A failure
 * anywhere in here rolls back the savepoint alone.
 */
export async function prepareStaffMessageNotice(
  tx: Tx,
  args: { messageId: string; threadId: string; ownerId: string; senderStaffId: string },
  log: NoticeLog,
): Promise<StaffMessageNotice> {
  try {
    return await tx.transaction(async (savepoint) => {
      const sp = savepoint as Tx;
      const message = await readNoticeMessage(sp, args.messageId);
      if (message === undefined) {
        throw new Error(`message ${args.messageId} does not read inside its own transaction`);
      }
      const body =
        message.text === '' && message.attachmentCount > 0
          ? noticeBody('', message.attachmentCount, await senderNameOf(message))
          : noticeBody(message.text, message.attachmentCount, '');
      const feed = await notificationsRepository.enqueue(sp, {
        ownerId: args.ownerId,
        type: 'message-received',
        title: FEED_TITLE,
        body,
        deepLinkPath: deepLinkToPath({ kind: 'thread', id: args.threadId }),
        deepLinkKind: 'thread',
        deepLinkId: args.threadId,
        senderStaffId: args.senderStaffId,
      });
      const prefs = await ownersRepository.findPushPrefs(sp, args.ownerId);
      if (prefs !== undefined && shouldSkipPush('message-received', prefs)) {
        return { reach: { channel: 'feed-only', why: 'push-off' }, notificationId: feed.id };
      }
      const tokens = await deviceTokensRepository.findLiveByOwner(sp, args.ownerId);
      if (tokens.length === 0) {
        return { reach: { channel: 'feed-only', why: 'no-device' }, notificationId: feed.id };
      }
      return { reach: { channel: 'push', why: 'device' }, notificationId: feed.id };
    });
  } catch (err) {
    log.warn(
      {
        messageId: args.messageId,
        threadId: args.threadId,
        ownerId: args.ownerId,
        err: err instanceof Error ? err.message : String(err),
      },
      NOTICE_NOT_QUEUED,
    );
    return { reach: { channel: 'none', why: 'not-queued' }, notificationId: null };
  }
}

/** Her unread school messages: what her Messages tab counts, so her icon badge says the same. */
async function unreadSchoolMessages(ownerId: string): Promise<number> {
  const [row] = await db
    .select({ n: count(messages.id) })
    .from(messages)
    .innerJoin(threads, eq(threads.id, messages.threadId))
    .where(
      and(
        eq(threads.ownerId, ownerId),
        isNull(threads.expiredAt),
        isNull(messages.expiredAt),
        ne(messages.senderKind, 'owner'),
        isNull(messages.readAt),
      ),
    );
  return Number(row?.n ?? 0);
}

async function stampClaim(
  messageId: string,
  ticketsOk: number,
  ticketsError: number,
): Promise<void> {
  await db
    .update(messagePushes)
    .set({ ticketsOk, ticketsError })
    .where(eq(messagePushes.messageId, messageId));
}

/**
 * After commit, never awaited (A1.2): the message's one push, to every live device of the
 * family. Claimed first, so at most once (FM2). Push off or no device: the claim is stamped
 * `0`/`0`, so the boot count counts only pushes a crash lost (LR5).
 */
export async function sendStaffMessagePush(
  messageId: string,
  notificationId: string,
  deps: StaffMessagePushDeps,
): Promise<void> {
  const claimed = await db
    .insert(messagePushes)
    .values({ messageId, notificationId })
    .onConflictDoNothing({ target: messagePushes.messageId })
    .returning({ messageId: messagePushes.messageId });
  if (claimed.length === 0) return;

  const message = await readNoticeMessage(db, messageId);
  if (message === undefined || message.senderKind !== 'staff') {
    await stampClaim(messageId, 0, 0);
    return;
  }
  const prefs = await ownersRepository.findPushPrefs(db, message.ownerId);
  if (prefs !== undefined && shouldSkipPush('message-received', prefs)) {
    await stampClaim(messageId, 0, 0);
    return;
  }
  const tokens = await deviceTokensRepository.findLiveByOwner(db, message.ownerId);
  if (tokens.length === 0) {
    await stampClaim(messageId, 0, 0);
    return;
  }

  const [title, badge] = await Promise.all([
    senderNameOf(message),
    unreadSchoolMessages(message.ownerId),
  ]);
  const body = noticeBody(message.text, message.attachmentCount, title);
  const data = {
    type: 'message-received',
    notification_id: notificationId,
    deep_link_path: deepLinkToPath({ kind: 'thread', id: message.threadId }),
    thread_id: message.threadId,
  } satisfies NotificationPushData;
  const pushes: ExpoPushMessage[] = tokens.map((token) => ({
    to: token.expoPushToken,
    title,
    body,
    sound: 'default',
    badge,
    data,
  }));

  let tickets: ExpoPushTicket[];
  try {
    tickets = await deps.expoPush.sendBatch(pushes);
  } catch (err) {
    await stampClaim(messageId, 0, pushes.length);
    deps.log.warn(
      {
        messageId,
        notificationId,
        devices: pushes.length,
        ticketsOk: 0,
        ticketsError: pushes.length,
        err: err instanceof Error ? err.message : String(err),
      },
      PUSH_TRANSPORT_FAILED,
    );
    return;
  }
  const ticketsOk = tickets.filter((t) => t.status === 'ok').length;
  const ticketsError = pushes.length - ticketsOk;
  await stampClaim(messageId, ticketsOk, ticketsError);
  if (ticketsError > 0) {
    deps.log.warn(
      { messageId, notificationId, devices: pushes.length, ticketsOk, ticketsError },
      PUSH_TICKET_ERRORS,
    );
  }
}

/**
 * The claims a crash lost (A2 FM2): claimed over a minute ago, with no ticket counts. `null` when
 * `message_pushes` is missing (a database behind rs3), which the caller counts as 0 (LR5).
 */
export async function countLostStaffMessagePushes(runner: Runner = db): Promise<number | null> {
  const present = await runner.execute(
    sql`SELECT to_regclass('public.message_pushes') IS NOT NULL AS present`,
  );
  if ((present.rows[0] as { present: boolean } | undefined)?.present !== true) return null;
  const lost = await runner.execute(sql`
    SELECT count(*)::int AS lost FROM message_pushes
     WHERE claimed_at < now() - interval '1 minute'
       AND tickets_ok IS NULL AND tickets_error IS NULL`);
  return (lost.rows[0] as { lost: number }).lost;
}

/** The boot count's one line (pass 3 calls this after `listen`, through `fireAndForget`). */
export async function reportLostStaffMessagePushes(
  log: BootCountLog,
  runner: Runner = db,
): Promise<number> {
  const lost = await countLostStaffMessagePushes(runner);
  if (lost === null) {
    log.warn({ table: 'message_pushes', lostPushes: 0 }, BOOT_TABLE_MISSING);
    return 0;
  }
  if (lost > 0) log.warn({ lostPushes: lost }, BOOT_COUNT);
  else log.info({ lostPushes: 0 }, BOOT_COUNT);
  return lost;
}
