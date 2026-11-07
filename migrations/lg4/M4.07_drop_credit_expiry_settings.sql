-- M4.07 (S24, CRED-U05, CRED-U03) — the staff-tunable expiry window goes.
-- design §4 LG4 (design.md:6209), §2.4 step 3 (design.md:2891-2893). Rev.: no (a dropped table takes its rows). Empty prod: 1 live row.
--
-- Every lot's expiry comes from its row's `expiry_months` now, and the warning lead has one
-- home, `credit_settings.expiry_warning_lead_days`, so nothing reads this table.
--
-- Locked first so no row can land between the snapshot and the drop. `DROP TABLE` fires no
-- row trigger, so being on the audit list saves nothing: the rows go to `audit_log` by hand
-- (`design.md:6196-6197`). The table has no id, so `row_pk` is what the audit trigger writes.
-- Its indexes, audit trigger and COMMENT go with it.
LOCK TABLE credit_expiry_settings IN ACCESS EXCLUSIVE MODE;

INSERT INTO audit_log (table_name, row_pk, op, before, actor)
SELECT 'credit_expiry_settings', COALESCE(t.location, '<global>'), 'MIGRATION-DROP', to_jsonb(t),
       'system:migration:M4.07'
  FROM credit_expiry_settings t;

DROP TABLE credit_expiry_settings;
