-- M1.06 (S01, SET-U01 ← CRED-U02) — the `cred` settings domain.
-- design §4 LG1 (design.md:6134), seeds §3.5. Credits expire from day one
-- (expiry_enforced_enabled true, answer 3) with one 7-day notice — and at least
-- one notice, always: the lead list is never empty (DECISIONS 61); no clawback
-- columns, no hand-grant cap (A3, R6, RULING §5). This is the one store of
-- cred.expiry_warning_lead_days (question 35 → (b)): the legacy
-- credit_expiry_settings is a store of no setting from here on.
CREATE TABLE credit_settings (
  id                                        boolean PRIMARY KEY DEFAULT true CHECK (id),
  expiry_enforced_enabled                   boolean NOT NULL,
  expiry_warning_lead_days                  integer[] NOT NULL
    CHECK (cardinality(expiry_warning_lead_days) > 0
           AND 0 <= ALL (expiry_warning_lead_days)
           AND array_position(expiry_warning_lead_days, NULL) IS NULL),
  manual_grant_expiry_months                integer NOT NULL CHECK (manual_grant_expiry_months > 0),
  returned_credit_expiry_months             integer NOT NULL CHECK (returned_credit_expiry_months >= 0),
  booking_outlives_lot_expiry_enabled       boolean NOT NULL,
  single_day_purchase_max_count             integer NOT NULL CHECK (single_day_purchase_max_count > 0),
  account_deletion_expires_credits_enabled  boolean NOT NULL,
  dispute_auto_reversal_enabled             boolean NOT NULL,
  pause_daily_expiry_extension_days         integer NOT NULL CHECK (pause_daily_expiry_extension_days >= 0),
  unpaid_payment_auto_reversal_enabled      boolean NOT NULL,
  updated_at                                timestamptz NOT NULL DEFAULT now(),
  updated_by_staff_id                       uuid REFERENCES staff(id) ON DELETE SET NULL
);
REVOKE ALL ON credit_settings FROM anon, authenticated;

INSERT INTO credit_settings (
  expiry_enforced_enabled, expiry_warning_lead_days, manual_grant_expiry_months,
  returned_credit_expiry_months, booking_outlives_lot_expiry_enabled, single_day_purchase_max_count,
  account_deletion_expires_credits_enabled, dispute_auto_reversal_enabled,
  pause_daily_expiry_extension_days, unpaid_payment_auto_reversal_enabled
) VALUES (
  true, '{7}', 1,
  1, false, 30,
  true, false,
  1, false
);

COMMENT ON TABLE credit_settings IS 'The cred settings domain (singleton, id = true): whether credits expire, the expiry notice leads, hand-grant and return expiry months. The one store of cred.expiry_warning_lead_days. Audited (STAFF-74).';
