-- M1.01 (S01, SET-U01 ← ACCT-U02) — the `acct` settings domain.
-- design §4 LG1 (design.md:6131), seeds §3.15. Every key is stored only in v1
-- except acct.signup_field_requirement_map (signup_fields), which PATCH /me and
-- the booking pre-check read. locked_account_view_mode is NOT SEEDED: NULL, and
-- no reader may default it.
CREATE TABLE account_settings (
  id                                          boolean PRIMARY KEY DEFAULT true CHECK (id),
  email_verification_grace_days               integer NOT NULL CHECK (email_verification_grace_days >= 0),
  close_blocked_by_pending_refund_enabled     boolean NOT NULL,
  close_auto_refund_fraction                  numeric NOT NULL CHECK (close_auto_refund_fraction BETWEEN 0 AND 1),
  reactivation_restores_expired_value_enabled boolean NOT NULL,
  locked_account_view_mode                    text CHECK (locked_account_view_mode IN ('lock_screen', 'actions_refused')),
  -- service → 'refund' | 'none', for group-class and boarding
  pause_reserved_service_return_mode          jsonb NOT NULL,
  -- the signup field → 'off' | 'asked' | 'mandatory' map (acct.signup_field_requirement_map)
  signup_fields                               jsonb NOT NULL,
  updated_at                                  timestamptz NOT NULL DEFAULT now(),
  updated_by_staff_id                         uuid REFERENCES staff(id) ON DELETE SET NULL
);
REVOKE ALL ON account_settings FROM anon, authenticated;

INSERT INTO account_settings (
  email_verification_grace_days, close_blocked_by_pending_refund_enabled, close_auto_refund_fraction,
  reactivation_restores_expired_value_enabled, locked_account_view_mode,
  pause_reserved_service_return_mode, signup_fields
) VALUES (
  7, true, 0, false, NULL,
  '{"group-class": "refund", "boarding": "refund"}',
  '{"name": "mandatory", "phone": "mandatory", "email": "mandatory", "location": "mandatory", "emergency_contact": "mandatory", "address": "asked"}'
);

COMMENT ON TABLE account_settings IS 'The acct settings domain (singleton, id = true): account lifecycle switches and the signup field requirement map. Audited (STAFF-74); edited through PATCH /staff/settings/acct.';
