-- M1.08 (S01, SET-U01 ← DOG-U02, E01) — the `dog` settings domain.
-- design §4 LG1 (design.md:6136), seeds §3.1. DOG-U02's table plus the four E01
-- gate switches and card_required_for_evaluation_booking_enabled (true, 05- #8),
-- which supersedes DOG-U02's nullable card_required_for_evaluation_booking (D4).
-- No descriptor_list column (dog_descriptors is the one store), no
-- intake_field_override_mode. The gate keys are inert until P06/P09 (re-cut 11-02).
CREATE TABLE dog_gate_settings (
  id                                            boolean PRIMARY KEY DEFAULT true CHECK (id),
  spay_neuter_required_by_age_months            integer NOT NULL CHECK (spay_neuter_required_by_age_months > 0),
  spay_neuter_gated_categories                  service_category[] NOT NULL,
  spay_neuter_reminder_time                     time NOT NULL,  -- America/Chicago
  card_required_at_board_train_confirm          boolean NOT NULL,
  card_required_for_evaluation_booking_enabled  boolean NOT NULL DEFAULT true,
  gate_card_on_file_enabled                     boolean NOT NULL,
  gate_evaluation_enabled                       boolean NOT NULL,
  gate_vaccines_enabled                         boolean NOT NULL,
  gate_agreements_enabled                       boolean NOT NULL,
  gate_override_allowed_gate_keys               text[] NOT NULL,
  staff_dog_exempt_gate_keys                    text[] NOT NULL,
  updated_at                                    timestamptz NOT NULL DEFAULT now(),
  updated_by_staff_id                           uuid REFERENCES staff(id) ON DELETE SET NULL
);
REVOKE ALL ON dog_gate_settings FROM anon, authenticated;

INSERT INTO dog_gate_settings (
  spay_neuter_required_by_age_months, spay_neuter_gated_categories, spay_neuter_reminder_time,
  card_required_at_board_train_confirm, card_required_for_evaluation_booking_enabled,
  gate_card_on_file_enabled, gate_evaluation_enabled, gate_vaccines_enabled, gate_agreements_enabled,
  gate_override_allowed_gate_keys, staff_dog_exempt_gate_keys
) VALUES (
  6, '{day-school,day-care}', '09:00',
  true, true,
  true, true, true, true,
  '{custom}', '{card-on-file}'
);

COMMENT ON TABLE dog_gate_settings IS 'The dog settings domain (singleton, id = true): the booking gate switches, the card-for-evaluation rule and the spay/neuter policy. Audited (STAFF-74).';
