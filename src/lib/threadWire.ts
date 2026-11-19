import { assertNever } from './assertNever.js';
import { pgTimestampToIso } from './pgTimestamp.js';
import { senderKind } from '../db/schema/schema.js';
import type {
  MessageReceiptWire,
  StaffRole,
  StaffThreadWire,
  ThreadCategory,
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
/** Schema-internal. `sender_kind` is normalized in the DB and FLATTENED away by
 *  `toMessageWire` — it is never emitted, so it deliberately stays OUT of
 *  wire.ts (designs/wire-contract-completion.md §6, threadWire row). */
export type SenderKind = (typeof senderKind.enumValues)[number];

/** Re-alias of the wire union, kept under this file's historical name so no
 *  consumer moves this pass (§6). `StaffRoleValue` === `StaffRole`. */
export type StaffRoleValue = StaffRole;

// These wire shapes are owned by the single-source contract (contracts/wire.ts).
// `ThreadCategory` joins them in 1.13.0: the local `(typeof
// threadCategory.enumValues)[number]` copy was type-identical to the wire union
// by construction — conformance.ts:71 pins `Equal<ThreadCategory,
// DrizzleEnum<typeof threadCategory>>` and `DrizzleEnum<E>` is defined
// (conformance.ts:57) as `E['enumValues'][number]`, the very expression these
// lines used. Zero behavior change; the pin now guards one declaration, not two.
export type {
  ThreadCategory,
  ThreadParticipantWire,
  ThreadWire,
  StaffThreadWire,
  MessageAttachmentWire,
  MessageWire,
};

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
  /** rs3 M5.29 (`threads.last_seq`): the highest `seq` the thread has given out. */
  lastSeq: number;
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
  /** rs3 M5.29 (`messages.thread_seq`): the message's number in its thread. */
  threadSeq: number;
  /** rs3 M5.30: the sender's own id for the send, or null when it carried none. */
  clientMessageId: string | null;
  /** rs3 M5.30 (W3): the first delivery to the other side (an ack or a read), or null. */
  deliveredAt: string | null;
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
  /** S45 (MSG-U03): the school's system row, the participant of a school thread. */
  isSchool: boolean;
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
  // 9.2.0 (design 7.1.0, MSG-U03): present only on the school's own participant.
  if (participant.isSchool) participantWire.is_school = true;
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
    last_seq: row.lastSeq,
  };
}

/**
 * Who reads a message wire: the family (owner routes, her socket) or staff (the
 * `/staff/threads` routes). 9.2.0: some fields ride one side only — the send's
 * `client_message_id` is echoed to the SENDER's side alone (contract-notes
 * mechanic 11), so an echo is matched, never doubled, and the other side never
 * sees the sender's id.
 */
export type MessageAudience = 'owner' | 'staff';

/**
 * Emit the Message wire shape with polymorphic sender flattened. The route
 * pre-resolves staff names via `staffRepository.resolveTrainerNames` (Day-6b
 * extraction) and the owner name via a single lookup; `senderName` here is
 * the pre-resolved string for the message's sender (or null when the
 * message's sender row was hard-deleted, which shouldn't happen but is
 * tolerated). `is_read` derives from `read_at IS NOT NULL`. `seq` is the
 * trigger's number (W1); `client_message_id` rides only to `audience` when it
 * is the sender's side (W2, mechanic 11).
 */
export function toMessageWire(
  row: MessageRowForWire,
  senderName: string | null,
  attachments: MessageAttachmentWire[],
  audience: MessageAudience,
  firstStaffReadAt: string | null = null,
): MessageWire {
  const senderId = flattenMessageSenderId(row);
  const wire: MessageWire = {
    id: row.id,
    thread_id: row.threadId,
    sender_id: senderId,
    text: row.text,
    sent_at: pgTimestampToIso(row.sentAt),
    is_read: row.readAt !== null,
    seq: row.threadSeq,
  };
  if (senderName !== null && senderName !== '') {
    wire.sender_name = senderName;
  }
  if (attachments.length > 0) {
    wire.attachments = attachments;
  }
  if (row.clientMessageId !== null && row.senderKind === audience) {
    wire.client_message_id = row.clientMessageId;
  }
  const receipt = receiptOf(row, audience, firstStaffReadAt);
  if (receipt !== undefined) wire.receipt = receipt;
  return wire;
}

/**
 * `MessageWire.receipt` (9.2.0, W3; contract-notes mechanics 9, 10): only on a message from the
 * reader's OWN side (hers on her routes; the school's, every staffer's, on the staff routes). The
 * step and its instant: `read` at the first read (on a family's message the EARLIEST staffer's
 * read, `message_staff_reads`, passed in as `firstStaffReadAt`; on the school's, her own
 * `read_at`), else `delivered` at the first delivery, else `sent` at `sent_at`. Her side never
 * learns who read it.
 */
export function receiptOf(
  row: MessageRowForWire,
  audience: MessageAudience,
  firstStaffReadAt: string | null,
): MessageReceiptWire | undefined {
  if (row.senderKind !== audience) return undefined;
  const readAt = audience === 'owner' ? firstStaffReadAt : row.readAt;
  if (readAt !== null) return { state: 'read', at: pgTimestampToIso(readAt) };
  if (row.deliveredAt !== null)
    return { state: 'delivered', at: pgTimestampToIso(row.deliveredAt) };
  return { state: 'sent', at: pgTimestampToIso(row.sentAt) };
}

/**
 * `GET /staff/threads`' row (9.2.0 `StaffThreadWire`, S46): the thread as `toThreadWire` emits
 * it, plus the family and the CALLER's read state (both pre-resolved by `wireManyStaffThreads`).
 */
export function toStaffThreadWire(
  thread: ThreadWire,
  extra: {
    ownerId: string;
    ownerName: string;
    addressedToMe: boolean;
    staffUnreadCount: number;
  },
): StaffThreadWire {
  return {
    ...thread,
    owner_id: extra.ownerId,
    owner_name: extra.ownerName,
    addressed_to_me: extra.addressedToMe,
    staff_unread_count: extra.staffUnreadCount,
  };
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
