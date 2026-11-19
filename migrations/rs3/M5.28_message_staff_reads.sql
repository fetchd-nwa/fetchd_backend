-- M5.28 (plan unit P45; wire 9.2.0; design §4 M8.05, MSG-U17, as A1.4 renumbers it) — read
-- state per staffer per family message: `POST /staff/threads/:id/read` inserts one row per
-- message the portal rendered, for the caller only (`ON CONFLICT DO NOTHING`), and
-- `staff_unread_count` and the bell count family messages with no row for the caller. A
-- message's delete cascades its rows away. Insert-only by nature and keyed by its pair, so it
-- stays out of `audit_capture` (whose `row_pk` arms could not name a row of it). Revoked as it
-- is created (DECISIONS 71); M5.30 re-revokes it as the group's last step (DECISIONS 86).
-- Rev.: drop the table.
SET LOCAL lock_timeout = '5s';

CREATE TABLE message_staff_reads (
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  staff_id   uuid NOT NULL REFERENCES staff(id),
  read_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, staff_id)
);
CREATE INDEX message_staff_reads_staff_idx ON message_staff_reads (staff_id);
REVOKE ALL ON message_staff_reads FROM anon, authenticated;
