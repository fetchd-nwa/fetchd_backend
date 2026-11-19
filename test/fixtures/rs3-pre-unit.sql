-- The pre-unit shape the rs3 step harness applies M5.26–M5.30 to (O-MSG-LIVE, plan unit P45;
-- brief "The step-file harness (LR15)"). Never a step file: `test/contracts/rs3-steps.test.ts`
-- loads it into a scratch database of its own, one per describe, and drops that database after.
--
-- What it is: the objects rs3 touches, copied from the base commit's schema.sql (549c14e,
-- O-CREDITS (B)), every column, constraint, index and function body as written there (a few
-- comment lines shortened): `staff`, `threads`, `thread_dogs`, `messages`, `device_tokens`,
-- `audit_log`, `audit_capture()` and the five audit triggers, with `migrations_applied` so the
-- runner can log. Two referenced tables are reduced to their key, because no rs3 step reads
-- them: `owners` (threads, messages and device tokens point at it) and `notifications`
-- (M5.30's `message_pushes.notification_id` points at it); `thread_dogs.dog_id` keeps its
-- column and loses its foreign key (there is no `dogs` here). The full-schema proof that the
-- steps produce exactly `schema.sql` is the rehearsal's (`npm run migrate:rehearse`), not
-- this file's.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE migrations_applied (
  step_id     text PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  applied_by  text NOT NULL,
  sql_sha256  text NOT NULL
);

CREATE TYPE thread_category    AS ENUM ('sessions', 'billing', 'enrollment', 'other');
CREATE TYPE staff_role         AS ENUM ('owner', 'manager', 'trainer');
CREATE TYPE record_source      AS ENUM ('app', 'gingr', 'seed');
CREATE TYPE sender_kind        AS ENUM ('owner', 'staff');

-- Reduced: the key every rs3 table points at.
CREATE TABLE owners (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL DEFAULT 'Family',
  expired_at timestamptz
);

CREATE TABLE staff (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supabase_uid  uuid UNIQUE NOT NULL,                 -- staff log in via the SAME
                                                      -- Supabase project, role:'staff'
  name          text NOT NULL,                        -- seed = lib/staff.ts roster
  role          staff_role NOT NULL,
  image_path    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expired_at    timestamptz,                          -- NULL = live (never hard-deleted);
                                                      -- sign-in reads this alone
  home_locations text[] NOT NULL CHECK (cardinality(home_locations) > 0),
  lesson_price_cents   integer CONSTRAINT staff_lesson_price_cents_check
                         CHECK (lesson_price_cents > 0),
  board_train_eligible boolean NOT NULL DEFAULT false
);

CREATE TABLE threads (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id        uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  participant_staff_id uuid REFERENCES staff(id),       -- the "WITH" staffer
  category        thread_category NOT NULL,
  title           text NOT NULL,
  sub_text        text NOT NULL,
  last_message    text NOT NULL DEFAULT '',
  last_message_at timestamptz NOT NULL DEFAULT now(),
  external_ref    text,
  source          record_source NOT NULL DEFAULT 'app',
  created_at      timestamptz NOT NULL DEFAULT now(),
  expired_at      timestamptz                           -- NULL = live (soft delete)
);
CREATE UNIQUE INDEX threads_source_ref_uidx
  ON threads (source, external_ref) WHERE expired_at IS NULL;
CREATE INDEX threads_owner_idx ON threads (owner_id, last_message_at DESC);

CREATE TABLE thread_dogs (
  thread_id uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  dog_id    uuid NOT NULL,
  expired_at timestamptz,                               -- NULL = live
  PRIMARY KEY (thread_id, dog_id)
);

CREATE TABLE messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id       uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  sender_kind     sender_kind NOT NULL,
  sender_owner_id uuid REFERENCES owners(id),
  sender_staff_id uuid REFERENCES staff(id),
  text            text NOT NULL,
  sent_at         timestamptz NOT NULL DEFAULT now(),
  read_at         timestamptz,                          -- NULL = unread (R5: no bool)
  expired_at      timestamptz,                          -- NULL = live; "unsend"/delete = expire (text retained in audit_log)
  CHECK (
    (sender_kind = 'owner' AND sender_owner_id IS NOT NULL AND sender_staff_id IS NULL)
    OR
    (sender_kind = 'staff' AND sender_staff_id IS NOT NULL AND sender_owner_id IS NULL)
  )
);
CREATE INDEX messages_thread_idx ON messages (thread_id, sent_at);

-- Reduced: the key M5.30's message_pushes.notification_id points at.
CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid()
);

CREATE TABLE device_tokens (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id        uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  expo_push_token text NOT NULL,
  platform        text NOT NULL CHECK (platform IN ('ios','android')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  expired_at      timestamptz                           -- NULL = live (token revoked = expire)
);
CREATE UNIQUE INDEX device_tokens_uidx
  ON device_tokens (owner_id, expo_push_token) WHERE expired_at IS NULL;

CREATE TABLE audit_log (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  table_name text NOT NULL,
  row_pk     text NOT NULL,            -- stringified PK of the affected row
  op         text NOT NULL,            -- 'UPDATE' | 'DELETE' | 'MIGRATION-DROP' (a step's snapshot of a row it drops)
  before     jsonb NOT NULL,           -- the OLD row
  actor      text,                     -- current_setting('app.actor', true)
  txid       bigint NOT NULL DEFAULT txid_current(),
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_table_row_idx ON audit_log (table_name, row_pk, at DESC);

CREATE OR REPLACE FUNCTION audit_capture() RETURNS trigger AS $$
BEGIN
  INSERT INTO audit_log (table_name, row_pk, op, before, actor)
  VALUES (
    TG_TABLE_NAME,
    COALESCE((to_jsonb(OLD) ->> 'id'),
             CASE WHEN to_jsonb(OLD) ? 'scope'
                  THEN (to_jsonb(OLD) ->> 'key') || '/' || (to_jsonb(OLD) ->> 'scope') END,
             (to_jsonb(OLD) ->> 'key'),
             (to_jsonb(OLD) ->> 'dog_id'),
             (to_jsonb(OLD) ->> 'booking_id'),
             (to_jsonb(OLD) ->> 'request_id'),
             (to_jsonb(OLD) ->> 'thread_id'),
             (to_jsonb(OLD) ->> 'rsvp_id'),
             (to_jsonb(OLD) ->> 'notification_id'),
             (to_jsonb(OLD) ->> 'date'),
             (to_jsonb(OLD) ->> 'category'),
             (to_jsonb(OLD) ->> 'field_key'),
             CASE WHEN to_jsonb(OLD) ? 'location'
                  THEN COALESCE(to_jsonb(OLD) ->> 'location', '<global>') END),
    TG_OP,
    to_jsonb(OLD),
    current_setting('app.actor', true)
  );
  RETURN NULL;  -- AFTER trigger; return value ignored
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER staff_audit AFTER UPDATE OR DELETE ON staff
  FOR EACH ROW EXECUTE FUNCTION audit_capture();
CREATE TRIGGER threads_audit AFTER UPDATE OR DELETE ON threads
  FOR EACH ROW EXECUTE FUNCTION audit_capture();
CREATE TRIGGER thread_dogs_audit AFTER UPDATE OR DELETE ON thread_dogs
  FOR EACH ROW EXECUTE FUNCTION audit_capture();
CREATE TRIGGER messages_audit AFTER UPDATE OR DELETE ON messages
  FOR EACH ROW EXECUTE FUNCTION audit_capture();
CREATE TRIGGER device_tokens_audit AFTER UPDATE OR DELETE ON device_tokens
  FOR EACH ROW EXECUTE FUNCTION audit_capture();
