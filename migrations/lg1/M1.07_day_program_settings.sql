-- M1.07 (S01, SET-U01 ← DAY-U02, STAFF-U42) — the `day` settings domain.
-- design §4 LG1 (design.md:6141), seeds §3.4, offerings E03 (design §2.6).
-- Two tiers in one table, credit_expiry_settings' pattern: ONE global row
-- (location NULL) and one row per campus, each tier's columns NOT NULL on its
-- own rows and NULL on the other's (the tier CHECK). No day-school price column
-- (the $60 single day is a credit_packages row, R1) and no lookback column.
-- open_weekdays_list is ISO weekdays, 1 = Monday … 7 = Sunday. Times are
-- America/Chicago wall-clock. `offerings` is the campus's service document,
-- service → {offered, client_visible, name, description} (E03), every service at
-- every campus. Whether a service runs at a campus has ONE store, its
-- `offered` here: the §3.4 keys day.day_school_offered_flag and
-- day.daycare_offered_flag are names for offerings['day-school'|'day-care']
-- .offered, not columns (DECISIONS 53, D2). name and description are NOT SEEDED
-- (no design line gives their text, D6): null, and no reader defaults them.
-- No capacity_override_dogs column: its store is the per-date day_capacity row (D3).
CREATE TABLE day_program_settings (
  location                                   text REFERENCES locations(slug),  -- NULL = the global row
  -- the global row
  booking_horizon_months                     integer CHECK (booking_horizon_months > 0),
  max_dogs_per_booking_count                 integer CHECK (max_dogs_per_booking_count > 0),
  day_school_one_on_one_minutes              integer CHECK (day_school_one_on_one_minutes > 0),
  occupied_block_end_time                    time,
  midstay_day_charge_fraction                numeric CHECK (midstay_day_charge_fraction BETWEEN 0 AND 1),
  sent_home_before_training_return_fraction  numeric CHECK (sent_home_before_training_return_fraction BETWEEN 0 AND 1),
  sent_home_after_training_return_fraction   numeric CHECK (sent_home_after_training_return_fraction IN (0, 1)),
  closure_return_fraction                    numeric CHECK (closure_return_fraction BETWEEN 0 AND 1),
  after_school_price_cents                   integer CHECK (after_school_price_cents >= 0),
  -- each campus row
  offerings                                  jsonb,
  open_weekdays_list                         integer[] CHECK (open_weekdays_list <@ ARRAY[1, 2, 3, 4, 5, 6, 7]),
  daily_capacity_dogs                        integer CHECK (daily_capacity_dogs >= 0),
  dropoff_open_time                          time,
  dropoff_close_time                         time,
  pickup_open_time                           time,
  pickup_close_time                          time,
  same_day_cutoff_time                       time,
  late_pickup_call_time                      time,
  late_pickup_grace_minutes                  integer CHECK (late_pickup_grace_minutes >= 0),
  late_pickup_fee_cents                      integer CHECK (late_pickup_fee_cents >= 0),
  after_school_start_time                    time,
  after_school_end_time                      time,
  after_school_capacity_count                integer CHECK (after_school_capacity_count >= 0),
  updated_at                                 timestamptz NOT NULL DEFAULT now(),
  updated_by_staff_id                        uuid REFERENCES staff(id) ON DELETE SET NULL,
  CONSTRAINT day_program_settings_tier_check CHECK (
    CASE WHEN location IS NULL THEN
      num_nulls(booking_horizon_months, max_dogs_per_booking_count, day_school_one_on_one_minutes,
                occupied_block_end_time, midstay_day_charge_fraction,
                sent_home_before_training_return_fraction, sent_home_after_training_return_fraction,
                closure_return_fraction, after_school_price_cents) = 0
      AND num_nonnulls(offerings, open_weekdays_list, daily_capacity_dogs, dropoff_open_time,
                       dropoff_close_time, pickup_open_time, pickup_close_time, same_day_cutoff_time,
                       late_pickup_call_time, late_pickup_grace_minutes, late_pickup_fee_cents,
                       after_school_start_time, after_school_end_time, after_school_capacity_count) = 0
    ELSE
      num_nulls(offerings, open_weekdays_list, daily_capacity_dogs, dropoff_open_time,
                dropoff_close_time, pickup_open_time, pickup_close_time, same_day_cutoff_time,
                late_pickup_call_time, late_pickup_grace_minutes, late_pickup_fee_cents,
                after_school_start_time, after_school_end_time, after_school_capacity_count) = 0
      AND num_nonnulls(booking_horizon_months, max_dogs_per_booking_count, day_school_one_on_one_minutes,
                       occupied_block_end_time, midstay_day_charge_fraction,
                       sent_home_before_training_return_fraction, sent_home_after_training_return_fraction,
                       closure_return_fraction, after_school_price_cents) = 0
    END
  )
);
REVOKE ALL ON day_program_settings FROM anon, authenticated;

-- Exactly one global row; at most one row per campus.
CREATE UNIQUE INDEX day_program_settings_global_uniq
  ON day_program_settings ((location IS NULL)) WHERE location IS NULL;
CREATE UNIQUE INDEX day_program_settings_location_uniq
  ON day_program_settings (location) WHERE location IS NOT NULL;

INSERT INTO day_program_settings (
  location, booking_horizon_months, max_dogs_per_booking_count, day_school_one_on_one_minutes,
  occupied_block_end_time, midstay_day_charge_fraction, sent_home_before_training_return_fraction,
  sent_home_after_training_return_fraction, closure_return_fraction, after_school_price_cents
) VALUES (
  NULL, 3, 5, 20,
  '17:00', 1, 1,
  0, 1, 0
);

INSERT INTO day_program_settings (
  location, offerings, open_weekdays_list, daily_capacity_dogs,
  dropoff_open_time, dropoff_close_time, pickup_open_time, pickup_close_time,
  same_day_cutoff_time, late_pickup_call_time, late_pickup_grace_minutes, late_pickup_fee_cents,
  after_school_start_time, after_school_end_time, after_school_capacity_count
) VALUES (
  'fayetteville',
  '{"day-school": {"offered": true, "client_visible": true, "name": null, "description": null},
    "day-care": {"offered": false, "client_visible": false, "name": null, "description": null},
    "group-class": {"offered": true, "client_visible": true, "name": null, "description": null},
    "evaluation": {"offered": true, "client_visible": true, "name": null, "description": null},
    "private-lesson": {"offered": false, "client_visible": false, "name": null, "description": null},
    "board-and-train": {"offered": false, "client_visible": false, "name": null, "description": null},
    "boarding": {"offered": false, "client_visible": false, "name": null, "description": null}}',
  '{1,2,3,4,5}', 15,
  '07:30', '08:30', '16:30', '17:30',
  '07:30', '17:30', 0, 0,
  '17:30', '18:30', 10
), (
  'bentonville',
  '{"day-school": {"offered": true, "client_visible": true, "name": null, "description": null},
    "day-care": {"offered": true, "client_visible": true, "name": null, "description": null},
    "group-class": {"offered": true, "client_visible": true, "name": null, "description": null},
    "evaluation": {"offered": true, "client_visible": true, "name": null, "description": null},
    "private-lesson": {"offered": false, "client_visible": false, "name": null, "description": null},
    "board-and-train": {"offered": false, "client_visible": false, "name": null, "description": null},
    "boarding": {"offered": false, "client_visible": false, "name": null, "description": null}}',
  '{1,2,3,4,5}', 15,
  '07:30', '08:30', '16:30', '17:30',
  '07:30', '17:30', 0, 0,
  '17:30', '18:30', 5
);

COMMENT ON TABLE day_program_settings IS 'The day settings domain: one global row (location NULL) and one row per campus, every day.* key a typed column on its tier, plus each campus''s offerings document (E03). Audited (STAFF-74); edited through PATCH /staff/settings/day/:location.';
