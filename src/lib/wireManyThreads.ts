import type { db } from '../db/client.js';
import type { Tx } from '../db/tx.js';
import { ownersRepository } from '../db/repositories/ownersRepository.js';
import { settingsRepository } from '../db/repositories/settingsRepository.js';
import { staffRepository } from '../db/repositories/staffRepository.js';
import {
  threadsRepository,
  type StaffThreadRow,
  type ThreadRow,
} from '../db/repositories/threadsRepository.js';
import {
  messagesRepository,
  type MessageAttachmentRow,
} from '../db/repositories/messagesRepository.js';
import type { R2Client } from './r2.js';
import {
  toMessageWire,
  toStaffThreadWire,
  toThreadWire,
  type MessageAttachmentWire,
  type MessageAudience,
  type MessageRowForWire,
  type MessageWire,
  type ResolvedParticipant,
  type StaffRoleValue,
  type StaffThreadWire,
  type ThreadWire,
} from './threadWire.js';

type Runner = Tx | typeof db;

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
 * Denormalize a batch of message rows into wire shapes for one `audience` (the
 * family's routes or staff's: `client_message_id` and `receipt` ride the sender's side only,
 * `threadWire.toMessageWire`). One batched staff-name lookup feeds the
 * polymorphic-sender flattening (owner-sent messages omit `sender_name` per
 * `lib/threadWire.toMessageWire`); one batched attachment lookup + parallel URL
 * signing feeds the per-message media list; for the family, one batched read of the school's
 * first reads feeds her receipts. `r2` is injected so contract tests substitute the in-memory
 * stub.
 */
export async function wireManyMessages(
  rows: MessageRowForWire[],
  r2: R2Client,
  audience: MessageAudience,
): Promise<MessageWire[]> {
  if (rows.length === 0) return [];
  const herMessageIds =
    audience === 'owner' ? rows.filter((m) => m.senderKind === 'owner').map((m) => m.id) : [];
  const [senderNames, attachmentRows, firstStaffReads] = await Promise.all([
    staffSenderNames(rows, audience),
    messagesRepository.findAttachmentsByMessageIds(rows.map((r) => r.id)),
    messagesRepository.findFirstStaffReads(herMessageIds),
  ]);
  const attachmentsByMessage = await signAttachmentsByMessage(attachmentRows, r2);

  return rows.map((row) =>
    toMessageWire(
      row,
      senderNames.get(row.id) ?? null,
      attachmentsByMessage.get(row.id) ?? [],
      audience,
      firstStaffReads.get(row.id) ?? null,
    ),
  );
}

/**
 * `MessageWire.sender_name` of each STAFF message in a batch, as `audience` reads it (owner
 * messages carry none). The signature (S45, MSG-U04; design §2.9:4554, answer 22): a staff
 * message in a SCHOOL-addressed thread is signed with the staffer's first name, or, for the
 * FAMILY only, with the school's name (the system row's) while `msg.reply_signature_mode` is
 * `school_name`: staff always read each other's first name (A6; her answer 2, DECISIONS 589:
 * "no staff names on her side, staff see each other's"). Elsewhere a staff message keeps the
 * staffer's name. The push's title is the family's reading of it ("the push title follows it").
 *
 * `runner`: every read runs on it (the pool when absent). A caller inside a transaction passes
 * its own: the staff message notice reads the name inside the send's savepoint, and a pooled read
 * there would wait for a second connection while holding one (pass 2 fix 1, M1).
 */
export async function staffSenderNames(
  rows: ReadonlyArray<Pick<MessageRowForWire, 'id' | 'threadId' | 'senderKind' | 'senderStaffId'>>,
  audience: MessageAudience,
  runner?: Runner,
): Promise<Map<string, string | null>> {
  const staffRows = rows.filter((m) => m.senderKind === 'staff');
  if (staffRows.length === 0) return new Map();
  const staffSenderIds = [
    ...new Set(staffRows.map((m) => m.senderStaffId).filter((v): v is string => v !== null)),
  ];
  const [staffNameRows, signature] = await Promise.all([
    staffRepository.findNamesByIds(staffSenderIds, runner),
    schoolSignature([...new Set(staffRows.map((m) => m.threadId))], runner),
  ]);
  const staffNamesById = new Map(staffNameRows.map((s) => [s.id, s.name] as const));
  const names = new Map<string, string | null>();
  for (const row of staffRows) {
    let name = row.senderStaffId === null ? null : (staffNamesById.get(row.senderStaffId) ?? null);
    if (signature.schoolThreadIds.has(row.threadId)) {
      name =
        audience === 'owner' && signature.mode === 'school_name'
          ? signature.schoolName
          : firstName(name);
    }
    names.set(row.id, name);
  }
  return names;
}

/** Who reads the staff routes: the caller's mirror row and its role (never a client's claim). */
export interface StaffReader {
  staffId: string;
  role: StaffRoleValue;
}

/**
 * `StaffThreadWire.addressed_to_me` (S46; signed design §2.9:4554, question 72, MSG-37): a
 * school thread for every owner- and manager-role staffer; her own thread for its participant; a
 * departed participant's thread for the owner and manager roles. The bell reads the same rule.
 */
export function isAddressedTo(row: StaffThreadRow, reader: StaffReader): boolean {
  const desk = reader.role === 'owner' || reader.role === 'manager';
  if (row.addressedToSchool) return desk;
  if (row.participantStaffId === reader.staffId) return true;
  return row.participantExpired && desk;
}

/**
 * Batched denormalization for the staff routes (9.2.0 `StaffThreadWire`, S46): `wireManyThreads`
 * plus the family (`owner_name` is the name a staff read prints: her name, or her email when it
 * is blank) and the reader's own `addressed_to_me` and `staff_unread_count`.
 */
export async function wireManyStaffThreads(
  rows: StaffThreadRow[],
  reader: StaffReader,
): Promise<StaffThreadWire[]> {
  if (rows.length === 0) return [];
  const [wires, unread, families] = await Promise.all([
    wireManyThreads(rows),
    threadsRepository.findStaffUnreadCounts(
      rows.map((r) => r.id),
      reader.staffId,
    ),
    ownersRepository.findNamesByIds(rows.map((r) => r.ownerId)),
  ]);
  return rows.map((row, i) => {
    const wire = wires[i];
    const family = families.get(row.ownerId);
    if (wire === undefined || family === undefined) {
      throw new Error(`thread ${row.id}: failed to build the staff wire shape`);
    }
    return toStaffThreadWire(wire, {
      ownerId: row.ownerId,
      ownerName: family.name,
      addressedToMe: isAddressedTo(row, reader),
      staffUnreadCount: unread.get(row.id) ?? 0,
    });
  });
}

/**
 * The school threads among `threadIds`, the signature mode and the school's own name, each read
 * on `runner` (the pool when absent).
 */
async function schoolSignature(
  threadIds: string[],
  runner?: Runner,
): Promise<{
  schoolThreadIds: Set<string>;
  mode: 'staffer_first_name' | 'school_name';
  schoolName: string | null;
}> {
  const [schoolThreadIds, mode, school] = await Promise.all([
    threadsRepository.findSchoolThreadIds(threadIds, runner),
    settingsRepository.replySignatureMode(runner),
    staffRepository.findSchoolAccount(runner),
  ]);
  return { schoolThreadIds: new Set(schoolThreadIds), mode, schoolName: school?.name ?? null };
}

/** A staffer's first name: her name up to its first space (as the settings read words it). */
function firstName(name: string | null): string | null {
  if (name === null) return null;
  return name.trim().split(/\s+/)[0] ?? null;
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
 * always sets it) or the staff row is missing — either would silently emit a
 * broken wire shape otherwise. An EXPIRED staffer resolves (a departed
 * staffer stays a thread's participant; `staffRepository.findParticipantsByIds`).
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
      `thread ${row.id}: participant_staff_id ${row.participantStaffId} not found in staff`,
    );
  }
  return participant;
}
