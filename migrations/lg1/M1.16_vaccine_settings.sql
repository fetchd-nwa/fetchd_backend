-- M1.16 (S01, SET-U01 ← VAX-U08) — the `vax` settings domain.
-- design §4 LG1 (design.md:6144), seeds §3.3. The catalog keys (which vaccines,
-- their labels, gate and exemption flags) are required_vaccines columns, not here.
CREATE TABLE vaccine_settings (
  id                                   boolean PRIMARY KEY DEFAULT true CHECK (id),
  proof_file_types                     text[] NOT NULL,
  typical_full_vaccination_age_months  integer NOT NULL CHECK (typical_full_vaccination_age_months > 0),
  updated_at                           timestamptz NOT NULL DEFAULT now(),
  updated_by_staff_id                  uuid REFERENCES staff(id) ON DELETE SET NULL
);
REVOKE ALL ON vaccine_settings FROM anon, authenticated;

INSERT INTO vaccine_settings (proof_file_types, typical_full_vaccination_age_months)
VALUES ('{application/pdf,image/jpeg,image/png,image/heic,image/heif}', 4);

COMMENT ON TABLE vaccine_settings IS 'The vax settings domain (singleton, id = true): accepted proof file types and the typical full-vaccination age. Audited (STAFF-74).';
