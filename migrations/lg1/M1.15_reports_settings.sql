-- M1.15 (S01, SET-U01 ← RPT-U02) — the `rpt` settings domain.
-- design §4 LG1 (design.md:6143), seeds §3.17. media_max_upload_megabytes is
-- bounded 1..25, 25 being MAX_UPLOAD_BYTES: it can only be lowered in v1 (q101).
-- curriculum_levels is M9.03's table, not a column here.
CREATE TABLE reports_settings (
  id                             boolean PRIMARY KEY DEFAULT true CHECK (id),
  events_enabled                 boolean NOT NULL,
  event_max_dogs_per_rsvp        integer NOT NULL CHECK (event_max_dogs_per_rsvp > 0),
  gallery_enabled                boolean NOT NULL,
  gallery_max_dogs               integer NOT NULL CHECK (gallery_max_dogs > 0),
  gallery_rate_limit_per_minute  integer NOT NULL CHECK (gallery_rate_limit_per_minute > 0),
  media_max_upload_megabytes     integer NOT NULL CHECK (media_max_upload_megabytes BETWEEN 1 AND 25),
  updated_at                     timestamptz NOT NULL DEFAULT now(),
  updated_by_staff_id            uuid REFERENCES staff(id) ON DELETE SET NULL
);
REVOKE ALL ON reports_settings FROM anon, authenticated;

INSERT INTO reports_settings (
  events_enabled, event_max_dogs_per_rsvp, gallery_enabled, gallery_max_dogs,
  gallery_rate_limit_per_minute, media_max_upload_megabytes
) VALUES (false, 5, false, 60, 60, 25);

COMMENT ON TABLE reports_settings IS 'The rpt settings domain (singleton, id = true): events and gallery switches and limits, the media upload cap. Audited (STAFF-74).';
