import { staffRepository } from '../db/repositories/staffRepository.js';
import { threadsRepository, type ThreadRow } from '../db/repositories/threadsRepository.js';
import {
  messagesRepository,
  type MessageAttachmentRow,
} from '../db/repositories/messagesRepository.js';
import type { R2Client } from './r2.js';
import {
  toMessageWire,
  toThreadWire,
  type MessageAttachmentWire,
  type MessageRowForWire,
  type MessageWire,
  type ResolvedParticipant,
  type ThreadWire,
} from './threadWire.js';

// Message attachment GET URLs are signed short: the open thread polls every 4s
// (see useMessages THREAD_POLL_MS), well inside this TTL, so a refresh always
// lands before the URL dies — and a leaked URL is useless within minutes.
const MESSAGE_ATTACHMENT_URL_TTL_SECONDS = 60 * 5;

/**
 * Batched denormalization of N thread rows into `ThreadWire` shapes.
 * Three join lookups (participants, thread_dogs, unread-counts) regardless
 * of row count. Extracted at the rule-of-two when the Day-19 staff queue
 * (`GET /staff/threads`) became the second consumer of the owner read's
 * denormalizer — same `wireMany*` shape as requests/bookings.
 *
 * Throws if a thread's participant_staff_id is null or points at a
 * missing/expired staff row — both are structural faults that should
 * surface loud rather than emit a broken wire.
 */
export async function wireManyThreads(rows: ThreadRow[]): Promise<ThreadWire[]> {
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
 * staff-name lookup feeds the polymorphic-sender flattening (owner-sent
 * messages omit `sender_name` per `lib/threadWire.toMessageWire`); one batched
 * attachment lookup + parallel URL signing feeds the per-message media list.
 * `r2` is injected so contract tests substitute the in-memory stub.
 */
export async function wireManyMessages(
  rows: MessageRowForWire[],
  r2: R2Client,
): Promise<MessageWire[]> {
  if (rows.length === 0) return [];
  const staffSenderIds = [
    ...new Set(
      rows
        .filter((m) => m.senderKind === 'staff')
        .map((m) => m.senderStaffId)
        .filter((v): v is string => v !== null),
    ),
  ];
  const [staffNameRows, attachmentRows] = await Promise.all([
    staffRepository.findNamesByIds(staffSenderIds),
    messagesRepository.findAttachmentsByMessageIds(rows.map((r) => r.id)),
  ]);
  const staffNamesById = new Map(staffNameRows.map((s) => [s.id, s.name] as const));
  const attachmentsByMessage = await signAttachmentsByMessage(attachmentRows, r2);

  return rows.map((row) => {
    let senderName: string | null = null;
    if (row.senderKind === 'staff' && row.senderStaffId !== null) {
      senderName = staffNamesById.get(row.senderStaffId) ?? null;
    }
    return toMessageWire(row, senderName, attachmentsByMessage.get(row.id) ?? []);
  });
}

/**
 * Sign each attachment's object key into a short-lived GET URL (in parallel)
 * and group the results by message id, preserving the repo's position order.
 */
async function signAttachmentsByMessage(
  rows: MessageAttachmentRow[],
  r2: R2Client,
): Promise<Map<string, MessageAttachmentWire[]>> {
  const signed = await Promise.all(
    rows.map(async (row): Promise<readonly [string, MessageAttachmentWire]> => {
      const url = await r2.signGetUrl({
        key: row.objectKey,
        expiresSeconds: MESSAGE_ATTACHMENT_URL_TTL_SECONDS,
      });
      return [
        row.messageId,
        {
          media_id: row.mediaAssetId,
          kind: row.kind,
          url,
          width: row.width,
          height: row.height,
          blurhash: row.blurhash,
          duration_ms: row.durationMs,
        },
      ] as const;
    }),
  );
  const byMessage = new Map<string, MessageAttachmentWire[]>();
  for (const [messageId, wire] of signed) {
    const existing = byMessage.get(messageId) ?? [];
    existing.push(wire);
    byMessage.set(messageId, existing);
  }
  return byMessage;
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
 * participant_staff_id is null (schema allows NULL but business reality
 * always sets it) or the staff row is missing/expired — either would
 * silently emit a broken wire shape otherwise.
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
