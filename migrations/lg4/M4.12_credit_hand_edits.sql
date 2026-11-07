-- M4.12 (S27, CRED-U14, CRED-U15) — who wrote a hand edit, why, and every date a lot moved through.
-- design §4 LG4 (design.md:6214), §2.4 step 6 (design.md:3073-3099). Rev.: yes. Empty prod: 0 rows.
--
-- A hand add or remove is an `adjustment` row, and it carries the staffer and the reason.
-- A lot's date lives on the grant row, so moving it edits that row, and this history is what
-- makes the move visible. No cap column: the role list is the limit (answer 11).
-- `credit_ledger` does not join the audit list: the generic trigger keeps OLD and the actor
-- only and fires on every column, which would reverse the ledger's documented exclusion.
ALTER TABLE credit_ledger
  ADD COLUMN created_by_staff_id uuid REFERENCES staff(id) ON DELETE SET NULL,
  ADD CONSTRAINT credit_ledger_adjustment_note_check CHECK (reason <> 'adjustment' OR note IS NOT NULL);

CREATE TABLE credit_lot_expiry_edits (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id          uuid NOT NULL REFERENCES credit_ledger(id),
  from_expires_at timestamptz NOT NULL,
  to_expires_at   timestamptz NOT NULL,
  staff_id        uuid REFERENCES staff(id) ON DELETE SET NULL,
  note            text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX credit_lot_expiry_edits_lot_idx ON credit_lot_expiry_edits (lot_id, created_at DESC);
REVOKE ALL ON credit_lot_expiry_edits FROM anon, authenticated;

COMMENT ON TABLE credit_lot_expiry_edits IS 'Every hand move of a lot''s expiry (CRED-U15), from the locked read, so a lot''s dates chain. Append-only.';
