-- M5.27 (plan unit P45; wire 9.2.0; design §4 M8.04, MSG-U05, as A1.4 renumbers it) — school
-- threads. `threads.addressed_to_school` marks a family's conversation with the school (its
-- participant is M5.26's system row), and the partial unique index keeps one LIVE school
-- thread per family and topic, so `POST /threads` continues it instead of opening a second:
-- `INSERT … ON CONFLICT (owner_id, category) WHERE addressed_to_school AND expired_at IS NULL
-- DO NOTHING` infers it (never named; a partial unique index is not a constraint). Keyed on the
-- school marker, not on `participant_staff_id`. Every existing thread is staff-addressed, so
-- none becomes a school thread. Rev.: drop the index, then the column.
SET LOCAL lock_timeout = '5s';

ALTER TABLE threads ADD COLUMN addressed_to_school boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX threads_owner_school_topic_uidx ON threads (owner_id, category)
  WHERE addressed_to_school AND expired_at IS NULL;
