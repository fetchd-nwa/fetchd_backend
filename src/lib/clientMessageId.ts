/**
 * W2 (wire 9.2.0 `client_message_id?` on the four send bodies; design messaging-live-v1 §4 W2
 * as A2 OL2 and the Opus seat's last read N6 amend it; contract-notes mechanics 11–13): the
 * sender's own id for one logical message, minted once and sent on every retry.
 *
 * Unique PER SENDER (rs3 M5.30: `messages_owner_client_message_uidx` on
 * `(sender_owner_id, client_message_id)`, `messages_staff_client_message_uidx` on
 * `(sender_staff_id, client_message_id)`). Every send route:
 *   1. looks the id up BEFORE `withMutation` and its Idempotency-Key body hash, so a repeat of
 *      a message the server holds is that message, 200, whatever the body or key (M2, B8);
 *   2. on the two `/messages` verbs, answers 409 `conflict` when the stored message is in
 *      another thread (LR18); a create verb always answers with the stored pair, 200;
 *   3. inserts with the id, and when two first sends race, the loser's INSERT is a 23505 on
 *      the sender's index, which ABORTS its transaction (LR11): the route catches it OUTSIDE
 *      `withMutation`, then repeats step 1 on the pool and answers with the winner's row
 *      (FL1). Only that constraint is caught; any other 23505 still fails the request.
 */

export type ClientMessageSender = 'owner' | 'staff';

const SENDER_INDEX: Record<ClientMessageSender, string> = {
  owner: 'messages_owner_client_message_uidx',
  staff: 'messages_staff_client_message_uidx',
};

/** A Postgres 23505 on the sender's own `client_message_id` index, and nothing else. */
export function isClientMessageIdViolation(err: unknown, sender: ClientMessageSender): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const record = err as { code?: unknown; constraint?: unknown };
  return record.code === '23505' && record.constraint === SENDER_INDEX[sender];
}

/** Whether a list names one id more than once (an attachment or a dog named twice). */
export function hasRepeats(ids: readonly string[] | undefined): boolean {
  if (ids === undefined) return false;
  return new Set(ids).size !== ids.length;
}
