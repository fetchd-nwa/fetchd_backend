-- M1.02 (S01, SET-U01 ← ALUM-U06) — the `alum` settings domain.
-- design §4 LG1 (design.md:6132), seeds §3.11.
CREATE TABLE alumni_settings (
  id                                      boolean PRIMARY KEY DEFAULT true CHECK (id),
  recheck_after_months_unseen             integer NOT NULL CHECK (recheck_after_months_unseen > 0),
  recheck_due_mirrors_reeval_due_enabled  boolean NOT NULL,
  updated_at                              timestamptz NOT NULL DEFAULT now(),
  updated_by_staff_id                     uuid REFERENCES staff(id) ON DELETE SET NULL
);
REVOKE ALL ON alumni_settings FROM anon, authenticated;

INSERT INTO alumni_settings (recheck_after_months_unseen, recheck_due_mirrors_reeval_due_enabled)
VALUES (6, true);

COMMENT ON TABLE alumni_settings IS 'The alum settings domain (singleton, id = true): the alumni re-check clock. Audited (STAFF-74); edited through PATCH /staff/settings/alum.';
