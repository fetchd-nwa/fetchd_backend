-- M4.04 (S28, PAY-U15) — the auto-charge lane's storage goes.
-- design §4 LG4 (design.md:6204), §2.4 (design.md:2847-2850). Rev.: no. Empty prod: 0 rows.
--
-- `invoice_charge_attempts` is off the audit list, so a row there goes to `audit_log`
-- first (`design.md:6196-6197`). Both tables are locked before the snapshot so no row can
-- land between it and the drop. The table's indexes, its touch trigger and its COMMENT go
-- with it, and `invoice_attempt_outcome` has no other reader.
--
-- `invoices.payment_method_id` goes nullable: no worker bills a card on its own, so an
-- invoice no longer needs a card bound for one to bill. No code writes a NULL yet (P25 is
-- the first writer), so every row keeps its card and `POST /invoices/:id/pay` stays as it
-- is. The column stays: it is the card a person charges, whoever that person is.
--
-- `invoices` carries a COMMENT describing the lane, so it moves with it.
LOCK TABLE invoices, invoice_charge_attempts IN ACCESS EXCLUSIVE MODE;

INSERT INTO audit_log (table_name, row_pk, op, before, actor)
SELECT 'invoice_charge_attempts', t.id::text, 'MIGRATION-DROP', to_jsonb(t), 'system:migration:M4.04'
  FROM invoice_charge_attempts t;

DROP TABLE invoice_charge_attempts;
DROP TYPE invoice_attempt_outcome;

ALTER TABLE invoices
  DROP COLUMN next_attempt_at,
  DROP COLUMN auto_charge_attempts,
  ALTER COLUMN payment_method_id DROP NOT NULL;

COMMENT ON TABLE invoices IS 'Money owed and unpaid: the pay-later twin of a charge, with a due_at. No worker bills an invoice on its own: it stays open until a person settles it, and it flips to paid when settled.';
