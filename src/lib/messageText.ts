import type { ThreadCategory } from '../contracts/wire.js';

/**
 * What every messaging verb shares about the text it stores (plan unit P45 with O-MSG-LIVE).
 *
 * A1 (the Fable pass-1 audit's H1): Postgres refuses U+0000 in a `text` column (22021), which
 * reached the pager as a 500 from any signed-in family. Every user-supplied string a messaging verb
 * writes to `text` (a message's `text`, `POST /threads`' `subtopic`) carries this refinement, so a
 * NUL is refused at the schema, before any database call, with the verb's own bad-body status (400
 * on the owner verbs and `POST /staff/threads`; the staff reply's 422). `staffSettings.ts` refuses
 * control characters in settings the same way.
 */
export const NO_NUL = {
  check: (value: string | undefined): boolean => value === undefined || !value.includes('\u0000'),
  message: 'must not hold a NUL character (U+0000)',
} as const;

/** A media row as the preview reads it. */
export interface PreviewMedia {
  kind: 'image' | 'video';
}

/**
 * Thread-list preview line. Uses the message body when present; for an
 * attachment-only message, a media summary ("Photo" / "Video" / "N attachments")
 * so the threads list isn't blank. Shared by the family's send and, from 9.2.0 (W6), the staff
 * reply.
 */
export function threadPreview(text: string, attachments: readonly PreviewMedia[]): string {
  if (text !== '') return text;
  if (attachments.length === 1) {
    return attachments[0]?.kind === 'video' ? 'Video' : 'Photo';
  }
  return `${attachments.length} attachments`;
}

/**
 * A thread's `title` when a start creates it: the topic's label, as the compose wizard names it
 * (a family's school thread, `POST /threads`, and a staffer's, `POST /staff/threads`).
 */
export const TOPIC_LABEL: Record<ThreadCategory, string> = {
  sessions: 'Sessions',
  billing: 'Billing',
  enrollment: 'Enrollment',
  other: 'Other',
};
