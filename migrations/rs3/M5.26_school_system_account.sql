-- M5.26 (plan unit P45 with its one-off O-MSG-LIVE; wire 9.2.0; design §4 M8.03, MSG-U03, as
-- designs/messaging-live-v1.md A1.4 renumbers it) — the school's own staff row, *NWA School for
-- Dogs*: the participant of every school-addressed thread, and never a principal. It has no
-- login (`supabase_uid` NULL, held by the CHECK), is never on a roster, pick list or responder
-- choice, and confers nothing (role `trainer`, no lesson price, no Board & Train). One live
-- system row, by the partial unique index. Inserted with a FIXED id, the same row `schema.sql`
-- inserts (brief CR8; `test/contracts/rs3-steps.test.ts` holds the two equal on every column
-- but `created_at`), so a database born from either agrees. No `active` value: M1.20 dropped
-- the column. Rev.: drop the index and the CHECK, delete the row (nothing may name it), restore
-- `supabase_uid NOT NULL`, drop the column.
--
-- The runner sets the actor (`system:migrate-M5.26`); this step names none (brief LR12).
SET LOCAL lock_timeout = '5s';

ALTER TABLE staff ADD COLUMN is_system_account boolean NOT NULL DEFAULT false;
ALTER TABLE staff ALTER COLUMN supabase_uid DROP NOT NULL;
ALTER TABLE staff ADD CONSTRAINT staff_system_account_uid_check
  CHECK (is_system_account = (supabase_uid IS NULL));
CREATE UNIQUE INDEX staff_one_system_account_uidx ON staff ((true))
  WHERE is_system_account AND expired_at IS NULL;

INSERT INTO staff (id, supabase_uid, name, role, image_path, home_locations, is_system_account)
VALUES ('5c400001-0000-4000-8000-000000000001', NULL, 'NWA School for Dogs', 'trainer', NULL,
        '{bentonville,fayetteville}', true);
