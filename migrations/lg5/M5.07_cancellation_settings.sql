-- M5.07 (CXL-U02's tables, landed with CXL-U09) — the cancellation policy, seeded and stored only.
-- design §4 LG5 (design.md:6226), §3.8 (design.md:5848-5871), design.md:4115-4120. Rev.: yes.
-- Empty prod: creates, seeds.
--
-- Every cxl.* key is stored only in v1 (money cut 3): no reader, no settings route, until
-- CXL-U02 (P21) adds the `cxl` domain, its shapes and a registry row for every column of
-- both tables together (P20 notes D1). The one exception is `per_dog_cancel_enabled`,
-- seeded on and read by the owner's one-dog cancel (s11). One row per service category;
-- the boarding row is `unset`, its fractions, fee and declare mode NOT SEEDED (NULL).
-- Both tables are audited (§3.8), so each joins `audit_capture()` by name here, as
-- `schema.sql`'s audit list holds it: the trigger fires on UPDATE and DELETE only, so the
-- seed itself writes no audit row and each seeded row carries the `updated_at` /
-- `updated_by_staff_id` pair. Each is revoked as it is created (DECISIONS 71).
CREATE TABLE cancellation_policy_settings (
  category                          text PRIMARY KEY,
  window_state                      text NOT NULL CHECK (window_state IN ('unset', 'none', 'hours')),
  window_hours                      integer CHECK (window_hours > 0),
  forfeit_fraction                  numeric CHECK (forfeit_fraction BETWEEN 0 AND 1),
  no_show_forfeit_fraction          numeric CHECK (no_show_forfeit_fraction BETWEEN 0 AND 1),
  flat_fee_cents                    integer CHECK (flat_fee_cents >= 0),
  unpaid_no_show_close_after_hours  integer NOT NULL CHECK (unpaid_no_show_close_after_hours > 0),
  no_show_declare_mode              text CHECK (no_show_declare_mode IN ('staff_only', 'auto_after_hours')),
  updated_at                        timestamptz NOT NULL DEFAULT now(),
  updated_by_staff_id               uuid REFERENCES staff(id) ON DELETE SET NULL
);
REVOKE ALL ON cancellation_policy_settings FROM anon, authenticated;

INSERT INTO cancellation_policy_settings (
  category, window_state, window_hours, forfeit_fraction, no_show_forfeit_fraction,
  flat_fee_cents, unpaid_no_show_close_after_hours, no_show_declare_mode
) VALUES
  ('day-school',      'none',  NULL, 0,    0,    0,    24, 'staff_only'),
  ('day-care',        'none',  NULL, 0,    0,    0,    24, 'staff_only'),
  ('group-class',     'none',  NULL, 0,    0,    0,    24, 'staff_only'),
  ('private-lesson',  'none',  NULL, 0,    0,    0,    24, 'staff_only'),
  ('board-and-train', 'none',  NULL, 0,    0,    0,    24, 'staff_only'),
  ('boarding',        'unset', NULL, NULL, NULL, NULL, 24, NULL),
  ('evaluation',      'none',  NULL, 0,    0,    0,    24, 'staff_only');

CREATE TABLE cancellation_global_settings (
  id                                                       boolean PRIMARY KEY DEFAULT true CHECK (id),
  per_dog_cancel_enabled                                   boolean NOT NULL,
  staff_entered_client_cancel_follows_owner_rules_enabled  boolean NOT NULL,
  staff_initiated_cancel_full_return_enabled               boolean NOT NULL,
  class_missed_meeting_money_return_mode                   text,
  started_run_cancel_return_mode                           text,
  updated_at                                               timestamptz NOT NULL DEFAULT now(),
  updated_by_staff_id                                      uuid REFERENCES staff(id) ON DELETE SET NULL
);
REVOKE ALL ON cancellation_global_settings FROM anon, authenticated;

INSERT INTO cancellation_global_settings (
  per_dog_cancel_enabled, staff_entered_client_cancel_follows_owner_rules_enabled,
  staff_initiated_cancel_full_return_enabled
) VALUES (true, true, true);

CREATE TRIGGER cancellation_policy_settings_audit AFTER UPDATE OR DELETE ON cancellation_policy_settings
  FOR EACH ROW EXECUTE FUNCTION audit_capture();
CREATE TRIGGER cancellation_global_settings_audit AFTER UPDATE OR DELETE ON cancellation_global_settings
  FOR EACH ROW EXECUTE FUNCTION audit_capture();

COMMENT ON TABLE cancellation_policy_settings IS 'The cxl per-service cancellation policy (M5.07): one row per service category, every key seeded and stored only, read by nothing in v1 (money cut 3). Audited.';
COMMENT ON TABLE cancellation_global_settings IS 'The cxl global switches (M5.07; singleton, id = true): stored only, except per_dog_cancel_enabled, which the owner''s one-dog cancel reads (s11). Audited.';
