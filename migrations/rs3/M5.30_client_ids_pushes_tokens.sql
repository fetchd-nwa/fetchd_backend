-- M5.30 (plan unit P45; wire 9.2.0; design messaging-live-v1 §4 M8.08, A1.2, A2 OL2, FL3, OH1,
-- as the brief's LR3 and LR4 amend them) — rs3's LAST step. In this order:
--   0. `lock_timeout` first (A2 ON2).
--   1. `messages.client_message_id`, unique PER SENDER (A2 OL2): a family's repeat of her own
--      id returns her stored message; a staffer's and a family's identical ids are two
--      messages. `delivered_at` (the *Delivered* receipt, stamped by the other side's ack or
--      read).
--   2. `message_pushes`: the claim on a staff message's one direct push (A1.2: `INSERT … ON
--      CONFLICT DO NOTHING RETURNING`, so a replay, a `client_message_id` repeat, a second
--      instance or a second post-commit call sends nothing more), with the feed row it
--      announces (FL3) and its ticket counts (FM2's boot count reads claims with none).
--      Append-only and not a soft-expire entity, so out of `audit_capture`. Revoked as it is
--      created (DECISIONS 71).
--   3. One live device-token row per token (A2 OH1), with NO winner (brief LR3): every live
--      row of a token that is live for two or more families is expired, because the row a
--      phone's current family holds cannot be told from the rows (a re-registration keeps the
--      first `created_at`). That phone registers again at its next sign-in or cold start. The
--      table is locked first so no registration lands between the dedupe and the index. Its
--      audit rows carry the runner's actor, `system:migrate-M5.30` (LR12).
--   4. `device_tokens_live_token_uidx`, this step's last object; `/health` reads it (LR1).
--      Code from before the unit still upserts on `(owner_id, expo_push_token)`, so between
--      this step and the unit's deploy a second family registering a live token is a 23505
--      and a 500: on dev, rs3 and the new API go in one sitting, and rolling the unit's
--      backend back drops this index first (LR4).
--   5. The group's closing re-revoke of both tables rs3 creates (DECISIONS 86).
-- Rev.: drop the index (the expired token rows stay expired), the table, the two indexes and
-- the two columns.
SET LOCAL lock_timeout = '5s';

ALTER TABLE messages
  ADD COLUMN client_message_id uuid,
  ADD COLUMN delivered_at timestamptz;
CREATE UNIQUE INDEX messages_owner_client_message_uidx
  ON messages (sender_owner_id, client_message_id) WHERE client_message_id IS NOT NULL;
CREATE UNIQUE INDEX messages_staff_client_message_uidx
  ON messages (sender_staff_id, client_message_id) WHERE client_message_id IS NOT NULL;

CREATE TABLE message_pushes (
  message_id      uuid PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  notification_id uuid REFERENCES notifications(id) ON DELETE SET NULL,
  claimed_at      timestamptz NOT NULL DEFAULT now(),
  tickets_ok      integer,
  tickets_error   integer
);
REVOKE ALL ON message_pushes FROM anon, authenticated;

LOCK TABLE device_tokens IN SHARE ROW EXCLUSIVE MODE;
UPDATE device_tokens
   SET expired_at = now()
 WHERE expired_at IS NULL
   AND expo_push_token IN (
     SELECT expo_push_token
       FROM device_tokens
      WHERE expired_at IS NULL
      GROUP BY expo_push_token
     HAVING count(DISTINCT owner_id) >= 2
   );
CREATE UNIQUE INDEX device_tokens_live_token_uidx ON device_tokens (expo_push_token)
  WHERE expired_at IS NULL;

REVOKE ALL ON message_staff_reads, message_pushes FROM anon, authenticated;
