-- M4.01 (S28, CRED-U29) — the membership product's table goes.
-- design §4 LG4 (design.md:6201), §2.4 (design.md:2835); DECISIONS 162.
-- Rev.: no (a dropped table takes its rows). Empty prod: 0 rows unverified, so it snapshots.
--
-- Both tables are locked first so no row can land between a snapshot and the drop.
--
-- A dropped table's rows go to `audit_log` first (`design.md:6196-6197`): `DROP TABLE`
-- fires no row trigger, so being on the audit list saves nothing here. Two snapshots,
-- because the column goes too. `invoices.membership_id` says which subscription month an
-- invoice billed, and M4.02 snapshots a `purpose = 'membership'` invoice after this step
-- has already dropped that column, so its link is kept here or nowhere.
--
-- The FK and the column go together; the table's indexes, its audit trigger and its
-- COMMENT go with the table. Nothing else references `memberships`.
LOCK TABLE invoices, memberships IN ACCESS EXCLUSIVE MODE;

INSERT INTO audit_log (table_name, row_pk, op, before, actor)
SELECT 'memberships', t.id::text, 'MIGRATION-DROP', to_jsonb(t), 'system:migration:M4.01'
  FROM memberships t;

INSERT INTO audit_log (table_name, row_pk, op, before, actor)
SELECT 'invoices', t.id::text, 'MIGRATION-DROP', to_jsonb(t), 'system:migration:M4.01'
  FROM invoices t
 WHERE t.membership_id IS NOT NULL;

ALTER TABLE invoices DROP COLUMN membership_id;
DROP TABLE memberships;
