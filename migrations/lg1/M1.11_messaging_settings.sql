-- M1.11 (S01, SET-U01 ← MSG-U02) — the `msg` settings domain.
-- design §4 LG1 (design.md:6139), seeds §3.13. The two responders are set by
-- `npm run staff:provision` after the staff rows exist, never by a migration.
CREATE TABLE messaging_settings (
  id                                 boolean PRIMARY KEY DEFAULT true CHECK (id),
  referral_subtopic_enabled          boolean NOT NULL,
  school_default_responder_staff_id  uuid REFERENCES staff(id) ON DELETE SET NULL,
  school_backup_responder_staff_id   uuid REFERENCES staff(id) ON DELETE SET NULL,
  school_default_responder_out       boolean NOT NULL,
  video_max_duration_seconds         integer NOT NULL CHECK (video_max_duration_seconds > 0),
  video_max_size_mb                  integer NOT NULL CHECK (video_max_size_mb > 0),
  max_attachments_per_message        integer NOT NULL CHECK (max_attachments_per_message > 0),
  max_text_length_chars              integer NOT NULL CHECK (max_text_length_chars > 0),
  request_reply_window_hours         integer NOT NULL CHECK (request_reply_window_hours > 0),
  reply_signature_mode               text NOT NULL DEFAULT 'staffer_first_name'
    CHECK (reply_signature_mode IN ('staffer_first_name', 'school_name')),
  updated_at                         timestamptz NOT NULL DEFAULT now(),
  updated_by_staff_id                uuid REFERENCES staff(id) ON DELETE SET NULL
);
REVOKE ALL ON messaging_settings FROM anon, authenticated;

INSERT INTO messaging_settings (
  referral_subtopic_enabled, school_default_responder_staff_id, school_backup_responder_staff_id,
  school_default_responder_out, video_max_duration_seconds, video_max_size_mb,
  max_attachments_per_message, max_text_length_chars, request_reply_window_hours, reply_signature_mode
) VALUES (false, NULL, NULL, false, 60, 100, 10, 4000, 24, 'staffer_first_name');

COMMENT ON TABLE messaging_settings IS 'The msg settings domain (singleton, id = true): message limits, the reply signature, and the default and backup responders (set by staff:provision). Audited (STAFF-74).';
