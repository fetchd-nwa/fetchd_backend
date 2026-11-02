-- M1.10 (S01, SET-U01 ← MIG-U02) — the `mig` settings domain.
-- design §4 LG1 (design.md:6138), seeds §3.16. No invite_link_lifetime_days,
-- no expiry-anchor column and no migration_expiry_anchor type: every imported
-- lot dates from its family's import (Allison s04, s06).
CREATE TABLE migration_settings (
  id                                boolean PRIMARY KEY DEFAULT true CHECK (id),
  pilot_family_count                integer NOT NULL CHECK (pilot_family_count > 0),
  full_transfer_after_pilot_months  integer NOT NULL CHECK (full_transfer_after_pilot_months > 0),
  import_credit_balances_enabled    boolean NOT NULL,
  imported_credit_expiry_months     integer NOT NULL CHECK (imported_credit_expiry_months > 0),
  import_unpaid_balances_enabled    boolean NOT NULL,
  invite_recent_within_months       integer NOT NULL CHECK (invite_recent_within_months > 0),
  gingr_retention_billing_cycles    integer NOT NULL CHECK (gingr_retention_billing_cycles > 0),
  updated_at                        timestamptz NOT NULL DEFAULT now(),
  updated_by_staff_id               uuid REFERENCES staff(id) ON DELETE SET NULL
);
REVOKE ALL ON migration_settings FROM anon, authenticated;

INSERT INTO migration_settings (
  pilot_family_count, full_transfer_after_pilot_months, import_credit_balances_enabled,
  imported_credit_expiry_months, import_unpaid_balances_enabled, invite_recent_within_months,
  gingr_retention_billing_cycles
) VALUES (5, 1, true, 1, true, 12, 1);

COMMENT ON TABLE migration_settings IS 'The mig settings domain (singleton, id = true): the Gingr pilot import''s limits and switches. Audited (STAFF-74).';
