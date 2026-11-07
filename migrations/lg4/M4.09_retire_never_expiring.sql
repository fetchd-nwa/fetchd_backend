-- M4.09 (S24, CRED-U17) — the never-expiring class is retired, and a charge grants once.
-- design §4 LG4 (design.md:6211), §2.4 step 3 (design.md:2919-2925). Rev.: yes. Empty prod: 0 rows.
--
-- Every writer these constrain exists by now, so this is the last step of the group.
--
-- `NOT VALID` then validated, in this one transaction. A row that fails stops the step at its
-- VALIDATE with 23514 naming the CHECK, and the runner rolls all of it back, so a database
-- whose ledger still holds a never-expiring lot or a lot-less debit cannot take this step
-- until that row is cleaned. That is the design's "validated after the dev cleanup": the
-- cleanup comes first. Left unvalidated the CHECKs would not be the schema of record, which
-- declares them valid.
--
-- A +1 return to its lot carries `lot_id` and no date; a fresh lot carries a date and no
-- `lot_id`; a debit names its lot.
ALTER TABLE credit_ledger
  ADD CONSTRAINT grant_has_expiry CHECK (delta <= 0 OR lot_id IS NOT NULL OR expires_at IS NOT NULL) NOT VALID,
  ADD CONSTRAINT debit_names_lot CHECK (delta >= 0 OR lot_id IS NOT NULL) NOT VALID,
  ADD CONSTRAINT one_expiry_copy CHECK (lot_id IS NULL OR expires_at IS NULL) NOT VALID;

ALTER TABLE credit_ledger VALIDATE CONSTRAINT grant_has_expiry;
ALTER TABLE credit_ledger VALIDATE CONSTRAINT debit_names_lot;
ALTER TABLE credit_ledger VALIDATE CONSTRAINT one_expiry_copy;

-- A partial index is used for conflict inference only when `ON CONFLICT` repeats its
-- predicate, so every writer writes `ON CONFLICT (charge_id) WHERE reason = 'purchase'`.
CREATE UNIQUE INDEX credit_ledger_purchase_charge_uidx
  ON credit_ledger (charge_id) WHERE reason = 'purchase';

-- The group's closing REVOKE (DECISIONS 86): this is the step applied last.
REVOKE ALL ON credit_lot_expiry_edits FROM anon, authenticated;
