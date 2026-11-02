-- M1.21 (S02, SET-U01 ← STAFF-U14; STAFF-U07, PAY-U25, CASH-U20) — the `staff`
-- settings domain: who may use each money verb, and the portal's idle sign-out.
-- design §4 LG1 (design.md:6153), §1.1:687-701, seeds §3.14. Right after M1.19:
-- its columns are the rebuilt staff_role[]. Rev.: yes.
--
-- Every key is `roles` class: only the owner role edits it (§3.14), and the
-- owner role passes every list whatever it holds (STAFF-09), so the owner can
-- never be edited out of a verb. Each list is non-empty by its own CHECK and is
-- read as a set. Seeds: refunds, hand credit edits and the custom invoice owner
-- and manager; the desk sale and the end-of-day totals every role (s15). The
-- idle minutes are 1..60: they decide how long a money session outlives its
-- staffer at the shared desk. Audited (STAFF-74) and revoked in this step.
CREATE TABLE staff_settings (
  id                           boolean PRIMARY KEY DEFAULT true CHECK (id),
  refund_roles                 staff_role[] NOT NULL CHECK (cardinality(refund_roles) > 0),
  credit_hand_edit_roles       staff_role[] NOT NULL CHECK (cardinality(credit_hand_edit_roles) > 0),
  desk_sale_roles              staff_role[] NOT NULL CHECK (cardinality(desk_sale_roles) > 0),
  custom_invoice_roles         staff_role[] NOT NULL CHECK (cardinality(custom_invoice_roles) > 0),
  cash_day_totals_roles        staff_role[] NOT NULL CHECK (cardinality(cash_day_totals_roles) > 0),
  portal_idle_signout_minutes  integer NOT NULL DEFAULT 30
                                 CHECK (portal_idle_signout_minutes BETWEEN 1 AND 60),
  updated_at                   timestamptz NOT NULL DEFAULT now(),
  updated_by_staff_id          uuid REFERENCES staff(id) ON DELETE SET NULL
);
REVOKE ALL ON staff_settings FROM anon, authenticated;

INSERT INTO staff_settings (
  refund_roles, credit_hand_edit_roles, desk_sale_roles, custom_invoice_roles,
  cash_day_totals_roles, portal_idle_signout_minutes
) VALUES (
  '{owner,manager}', '{owner,manager}', '{owner,manager,trainer}', '{owner,manager}',
  '{owner,manager,trainer}', 30
);

CREATE TRIGGER staff_settings_audit AFTER UPDATE OR DELETE ON staff_settings
  FOR EACH ROW EXECUTE FUNCTION audit_capture();

COMMENT ON TABLE staff_settings IS 'The staff settings domain (singleton, id = true): the five role lists that gate the money verbs (refund, hand credit edits, desk sale, custom invoice, end-of-day totals) and the portal idle sign-out minutes. Every key is roles class (owner only); the owner role passes every list. Audited (STAFF-74).';
