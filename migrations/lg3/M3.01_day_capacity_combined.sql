-- M3.01 (S18, DAY-U05) — day_capacity carries one seat count, not two.
-- design §4 LG3 (design.md:6187), §2.3 DAY-U05 (design.md:2305); DECISIONS 128(j).
-- Rev.: no (a dropped column takes its rows). Empty prod: no override rows.
--
-- Day school and daycare share one cap per campus per date, so an override row
-- holds that one number. There is no honest way to fold two caps into one, and no
-- route has ever written this table, so the step does not try: it counts the rows,
-- a soft-expired one included, and refuses by name if it meets any. Production
-- starts clean; a dev volume holding overrides is drift to clear by hand
-- (design §4 M3.01, which wins over §2.3's "carrying today's overrides").
--
-- The same step gives the row the audit pair every settings row has (STAFF-74).
-- A date's first PUT is an INSERT and the audit trigger fires only on UPDATE or
-- DELETE, so nothing but the row itself can name who opened or closed that date.
-- The writers stamp both columns, as every settings writer does: day_program_settings
-- gets its updated_at from its writer too, not from the touch_updated_at trigger.
--
-- The table is locked first so no row can land between the count and the reshape.
--
-- No table is created, so the step needs no per-table REVOKE, and the group's
-- closing REVOKE (DECISIONS 86) has nothing of this step's to repeat.
LOCK TABLE day_capacity IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
  override_rows bigint;
BEGIN
  SELECT count(*) INTO override_rows FROM day_capacity;
  IF override_rows > 0 THEN
    RAISE EXCEPTION 'M3.01 refuses: day_capacity holds % row(s). It folds two caps into one, so clear them by hand and run it again.', override_rows;
  END IF;
END
$$;

ALTER TABLE day_capacity
  ADD COLUMN capacity_dogs integer NOT NULL CHECK (capacity_dogs >= 0),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN updated_by_staff_id uuid REFERENCES staff(id) ON DELETE SET NULL,
  DROP COLUMN school_openings,
  DROP COLUMN daycare_openings;

COMMENT ON TABLE day_capacity IS 'Sparse per-(location, calendar-day) seat overrides for Day School and Day Care combined; a live row wins over the campus''s day.daily_capacity_dogs and day.open_weekdays_list, which the API applies when no row exists.';
