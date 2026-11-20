-- M5.28 (plan unit P45; wire 9.2.0; design §4 M8.05, MSG-U17, as A1.4 renumbers it) — read
-- state per staffer per family message: `POST /staff/threads/:id/read` inserts one row per
-- message the portal rendered, for the caller only (`ON CONFLICT DO NOTHING`), and
-- `staff_unread_count` and the bell count family messages with no row for the caller. A
-- message's delete cascades its rows away. Insert-only by nature and keyed by its pair, so it
-- stays out of `audit_capture` (whose `row_pk` arms could not name a row of it). Revoked as it
-- is created (DECISIONS 71); M5.30 re-revokes it as the group's last step (DECISIONS 86). Its
-- one data step (item 20, below) marks the family messages from before it read.
-- Rev.: drop the table (its rows go with it).
SET LOCAL lock_timeout = '5s';

CREATE TABLE message_staff_reads (
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  staff_id   uuid NOT NULL REFERENCES staff(id),
  read_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, staff_id)
);
CREATE INDEX message_staff_reads_staff_idx ON message_staff_reads (staff_id);
REVOKE ALL ON message_staff_reads FROM anon, authenticated;

-- Item 20 (the messaging take-back; build DECISIONS 770 (a), her default, its reason corrected
-- at 816; HANDBACK §4 item 20): the portal never showed these messages (its messages screen was
-- hidden until 9.2.0), so no staffer saw one there. Each family message that exists now is
-- marked read for every live staffer (live AND NOT the school's system row: `livePrincipal`) so
-- that a database migrated forward does not open with a one-time wall of unread. A removed
-- staffer gets no row; a message sent after this step is unread until a staffer opens it.
-- `read_at` is this step's time (no earlier staff read of a family message was ever
-- recorded). Production is born clean, so there this inserts nothing; it is for a
-- database migrated forward.
INSERT INTO message_staff_reads (message_id, staff_id)
SELECT m.id, s.id
  FROM messages m
  CROSS JOIN staff s
 WHERE m.sender_kind = 'owner'
   AND s.expired_at IS NULL
   AND NOT s.is_system_account;
