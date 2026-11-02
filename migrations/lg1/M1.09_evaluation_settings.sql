-- M1.09 (S01, SET-U01 ← EVAL-U08) — the `eval` settings domain.
-- design §4 LG1 (design.md:6137), seeds §3.2. Two tiers with tier CHECKs: the
-- global row (location NULL) carries reeval_after_months_unseen (NULL = the
-- clock is off, EVAL-53; DECISIONS 62; seeded 3) and failed_rebook_wait_hours
-- (required there); each campus row carries max_per_day_dogs (NULL = no limit,
-- which is its seed). No price column — eval.price_cents is the
-- campus's evaluation service_rates row — and no verdict_correction_window_hours.
CREATE TABLE evaluation_settings (
  location                     text REFERENCES locations(slug),  -- NULL = the global row
  reeval_after_months_unseen   integer CHECK (reeval_after_months_unseen > 0),
  failed_rebook_wait_hours     integer CHECK (failed_rebook_wait_hours >= 0),
  max_per_day_dogs             integer CHECK (max_per_day_dogs > 0),
  updated_at                   timestamptz NOT NULL DEFAULT now(),
  updated_by_staff_id          uuid REFERENCES staff(id) ON DELETE SET NULL,
  CONSTRAINT evaluation_settings_tier_check CHECK (
    CASE WHEN location IS NULL
      THEN failed_rebook_wait_hours IS NOT NULL AND max_per_day_dogs IS NULL
      ELSE reeval_after_months_unseen IS NULL AND failed_rebook_wait_hours IS NULL
    END
  )
);
REVOKE ALL ON evaluation_settings FROM anon, authenticated;

-- Exactly one global row; at most one row per campus.
CREATE UNIQUE INDEX evaluation_settings_global_uniq
  ON evaluation_settings ((location IS NULL)) WHERE location IS NULL;
CREATE UNIQUE INDEX evaluation_settings_location_uniq
  ON evaluation_settings (location) WHERE location IS NOT NULL;

INSERT INTO evaluation_settings (location, reeval_after_months_unseen, failed_rebook_wait_hours, max_per_day_dogs)
VALUES
  (NULL,           3,    0,    NULL),
  ('fayetteville', NULL, NULL, NULL),
  ('bentonville',  NULL, NULL, NULL);

COMMENT ON TABLE evaluation_settings IS 'The eval settings domain: one global row (location NULL: re-evaluation clock, failed-rebook wait) and one row per campus (daily evaluation cap). The evaluation price is its service_rates row, not a column here. Audited (STAFF-74).';
