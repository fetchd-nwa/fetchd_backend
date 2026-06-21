import { assertNever } from './assertNever.js';
import { pgTimestampToIso } from './pgTimestamp.js';
import { senderKind, threadCategory, staffRole } from '../db/schema/schema.js';
import type {
  ThreadParticipantWire,
  ThreadWire,
  MessageAttachmentWire,
  MessageWire,
} from '../contracts/wire.js';

/**
 * Wire shapes for `Thread` + `Message` per DATA-CONTRACT §B (line 193-200).
 * Two flattenings happen here:
 *
 *   1. **Participant.** The DB carries `threads.participant_staff_id` (the
 *      "WITH" staffer, nullable in schema but always set in practice — see
 *      Day-7a handoff note on the future NOT NULL tightening). The wire emits
 *      a `{id,name,role,image_path?}` object resolved from the `staff` row.
 *   2. **Polymorphic sender.** `messages` stores `sender_kind` +
 *      `sender_owner_id|sender_staff_id` (XOR per the schema CHECK). The wire
 *      flattens to a single `sender_id` (+ optional `sender_name`) so the FE
 *      doesn't need to switch on `sender_kind`.
 *
 * `unread_count` is **derived** (DATA-CONTRACT §B Thread note + schema comment
 * `messages_thread_idx`): count of live messages where `sender_kind != 'owner'`
 * AND `read_at IS NULL`. The repo computes this per-thread; the wire emits
 * the resolved integer.
 */
export type ThreadCategory = (typeof threadCategory.enumValues)[number];
export type SenderKind = (typeof senderKind.enumValues)[number];
export type StaffRoleValue = (typeof staffRole.enumValues)[number];

// These wire shapes are owned by the single-source contract (contracts/wire.ts).
export type { ThreadParticipantWire, ThreadWire, MessageAttachmentWire, MessageWire };

/**
 * Row shape the repo emits for thread rows (subset of the Drizzle projection).
 * Structural type — keeps the helper decoupled from full Drizzle row
 * inference. Matches `THREAD_PROJECTION` in `threadsRepository.ts`.
 */
export interface ThreadRowForWire {
  id: string;
  category: ThreadCategory;
  title: string;
  subText: string;
  participantStaffId: string | null;
  lastMessage: string;
  lastMessageAt: string;
}

/**
 * Row shape the repo emits for message rows. Polymorphic sender stays
 * normalized here (kind + owner_id|staff_id); the wire helper does the
 * flatten upstream of `toMessageWire`.
 */
export interface MessageRowForWire {
  id: string;
  threadId: string;
  senderKind: SenderKind;
  senderOwnerId: string | null;
  senderStaffId: string | null;
  text: string;
  sentAt: string;
  readAt: string | null;
}

/**
 * The staff participant row, resolved from `staff` and passed in by the
 * route. Image path is the storage path string (matches `staff.image_path`
 * column), not a resolved URL — the FE turns it into one via the same
 * `media_assets` seam as dogs.
 */
export interface ResolvedParticipant {
  id: string;
  name: string;
  role: StaffRoleValue;
  imagePath: string | null;
}

/**
 * Emit the Thread wire shape. `participant` comes pre-resolved (the route
 * batches a `staff` lookup across all threads in a list); `relatedDogIds`
 * + `unreadCount` come pre-resolved likewise. The helper is pure JSON
 * shaping — no DB access, no async.
 */
export function toThreadWire(
  row: ThreadRowForWire,
  participant: ResolvedParticipant,
  relatedDogIds: string[],
  unreadCount: number,
): ThreadWire {
  const participantWire: ThreadParticipantWire = {
    id: participant.id,
    name: participant.name,
    role: participant.role,
  };
  if (participant.imagePath !== null && participant.imagePath !== '') {
    participantWire.image_path = participant.imagePath;
  }
  return {
    id: row.id,
    category: row.category,
    title: row.title,
    sub_text: row.subText,
    participant: participantWire,
    related_dog_ids: relatedDogIds,
    last_message: row.lastMessage,
    last_message_at: pgTimestampToIso(row.lastMessageAt),
    unread_count: unreadCount,
  };
}

/**
 * Emit the Message wire shape with polymorphic sender flattened. The route
 * pre-resolves staff names via `staffRepository.resolveTrainerNames` (Day-6b
 * extraction) and the owner name via a single lookup; `senderName` here is
 * the pre-resolved string for the message's sender (or null when the
 * message's sender row was hard-deleted, which shouldn't happen but is
 * tolerated). `is_read` derives from `read_at IS NOT NULL`.
 */
export function toMessageWire(
  row: MessageRowForWire,
  senderName: string | null,
  attachments: MessageAttachmentWire[] = [],
): MessageWire {
  const senderId = flattenMessageSenderId(row);
  const wire: MessageWire = {
    id: row.id,
    thread_id: row.threadId,
    sender_id: senderId,
    text: row.text,
    sent_at: pgTimestampToIso(row.sentAt),
    is_read: row.readAt !== null,
  };
  if (senderName !== null && senderName !== '') {
    wire.sender_name = senderName;
  }
  if (attachments.length > 0) {
    wire.attachments = attachments;
  }
  return wire;
}

/**
 * Flatten the polymorphic sender pair (`sender_owner_id` XOR
 * `sender_staff_id`) into a single id. Throws on the structural invariant
 * violation that the schema CHECK already prevents — defense in depth so a
 * stray row from a future direct-DB write doesn't silently emit `undefined`.
 */
export function flattenMessageSenderId(row: MessageRowForWire): string {
  if (row.senderKind === 'owner') {
    if (row.senderOwnerId === null) {
      throw new Error(`message ${row.id}: sender_kind=owner but sender_owner_id is null`);
    }
    return row.senderOwnerId;
  }
  if (row.senderKind === 'staff') {
    if (row.senderStaffId === null) {
      throw new Error(`message ${row.id}: sender_kind=staff but sender_staff_id is null`);
    }
    return row.senderStaffId;
  }
  // Future-proof: a new `sender_kind` enum variant fails the compile here
  // via the shared `assertNever`. Schema `sender_kind` is locked at the
  // two values today (DATA-CONTRACT §B Message + schema CHECK).
  return assertNever(row.senderKind);
}
