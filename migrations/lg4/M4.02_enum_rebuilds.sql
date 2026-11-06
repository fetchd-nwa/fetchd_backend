-- M4.02 (S28, CRED-U29, ALUM-U17, DECISIONS 151(h), 162) — the three enums are rebuilt.
-- design §4 LG4 (design.md:6202), §2.4 (design.md:2836-2845). Rev.: no. Empty prod: 0 rows
-- of those labels; the rebuild is the one way the wire removal typechecks.
--
-- Postgres cannot drop an enum value, so each type is rebuilt as M1.19 rebuilt
-- `staff_role`: new type, recast, drop, rename, in the runner's one transaction.
--   charge_purpose     loses 'membership' and 'payg'
--   ledger_reason      loses 'membership-grant'
--   notification_type  loses 'membership-ended' and 'alumni-attendance'
-- `invoice-overdue` keeps its label and loses its writer (C5). `evaluation-result` is
-- not added here: M2.15 appends it (P10).
--
-- Every row carrying one of those labels, or `deep_link_kind = 'membership'` (a `text`
-- column with no CHECK), goes first, and goes to `audit_log` before it goes (DECISIONS
-- 162(c)): 22P02 would be loud, but this delete comes first and would be silent, so the
-- snapshot is what stands between a real row and nothing. Production holds none.
--
-- Deletes run children first and nothing here says CASCADE or disables a trigger: a row
-- another money row still references stops the step, under RESTRICT or a NO ACTION FK, and
-- the runner rolls all of it back. That is the ruling, not an accident, and it covers a
-- debit against a `membership-grant` lot, a refund against a membership charge, and an
-- `invoice_charge_attempts` row against a doomed invoice (that table lives until M4.04).
--
-- The one schema-side cascade is `notification_dogs` on `notifications`. It would take
-- those rows with no snapshot, so they are snapshotted and deleted by name here, first.
--
-- `charges` carries a COMMENT naming the labels, so it moves with them.
LOCK TABLE charges, invoices, credit_ledger, notifications, notification_dogs,
  scheduled_notifications IN ACCESS EXCLUSIVE MODE;

INSERT INTO audit_log (table_name, row_pk, op, before, actor)
SELECT 'scheduled_notifications', t.id::text, 'MIGRATION-DROP', to_jsonb(t), 'system:migration:M4.02'
  FROM scheduled_notifications t
 WHERE t.type IN ('membership-ended', 'alumni-attendance') OR t.deep_link_kind = 'membership';

INSERT INTO audit_log (table_name, row_pk, op, before, actor)
SELECT 'notification_dogs', t.notification_id::text || '/' || t.dog_id::text, 'MIGRATION-DROP',
       to_jsonb(t), 'system:migration:M4.02'
  FROM notification_dogs t
  JOIN notifications n ON n.id = t.notification_id
 WHERE n.type IN ('membership-ended', 'alumni-attendance') OR n.deep_link_kind = 'membership';

INSERT INTO audit_log (table_name, row_pk, op, before, actor)
SELECT 'notifications', t.id::text, 'MIGRATION-DROP', to_jsonb(t), 'system:migration:M4.02'
  FROM notifications t
 WHERE t.type IN ('membership-ended', 'alumni-attendance') OR t.deep_link_kind = 'membership';

INSERT INTO audit_log (table_name, row_pk, op, before, actor)
SELECT 'invoices', t.id::text, 'MIGRATION-DROP', to_jsonb(t), 'system:migration:M4.02'
  FROM invoices t
 WHERE t.purpose IN ('membership', 'payg');

INSERT INTO audit_log (table_name, row_pk, op, before, actor)
SELECT 'credit_ledger', t.id::text, 'MIGRATION-DROP', to_jsonb(t), 'system:migration:M4.02'
  FROM credit_ledger t
 WHERE t.reason = 'membership-grant';

INSERT INTO audit_log (table_name, row_pk, op, before, actor)
SELECT 'charges', t.id::text, 'MIGRATION-DROP', to_jsonb(t), 'system:migration:M4.02'
  FROM charges t
 WHERE t.purpose IN ('membership', 'payg');

DELETE FROM scheduled_notifications
 WHERE type IN ('membership-ended', 'alumni-attendance') OR deep_link_kind = 'membership';
DELETE FROM notification_dogs t
 USING notifications n
 WHERE n.id = t.notification_id
   AND (n.type IN ('membership-ended', 'alumni-attendance') OR n.deep_link_kind = 'membership');
DELETE FROM notifications
 WHERE type IN ('membership-ended', 'alumni-attendance') OR deep_link_kind = 'membership';
-- Invoices and the ledger before charges: both reference a charge.
DELETE FROM invoices WHERE purpose IN ('membership', 'payg');
DELETE FROM credit_ledger WHERE reason = 'membership-grant';
DELETE FROM charges WHERE purpose IN ('membership', 'payg');

CREATE TYPE charge_purpose_v2 AS ENUM ('package', 'board-train', 'group-class');
ALTER TABLE charges  ALTER COLUMN purpose TYPE charge_purpose_v2 USING purpose::text::charge_purpose_v2;
ALTER TABLE invoices ALTER COLUMN purpose TYPE charge_purpose_v2 USING purpose::text::charge_purpose_v2;
DROP TYPE charge_purpose;
ALTER TYPE charge_purpose_v2 RENAME TO charge_purpose;

CREATE TYPE ledger_reason_v2 AS ENUM ('purchase', 'booking-debit', 'cancel-refund', 'adjustment');
ALTER TABLE credit_ledger ALTER COLUMN reason TYPE ledger_reason_v2 USING reason::text::ledger_reason_v2;
DROP TYPE ledger_reason;
ALTER TYPE ledger_reason_v2 RENAME TO ledger_reason;

CREATE TYPE notification_type_v2 AS ENUM (
  'booking-confirmed', 'report-published', 'booking-cancelled',
  'announcement', 'message-received',
  'booking-reminder', 'boarding-profile-check',
  'credits-expiring', 'payment-failed', 'payment-succeeded',
  'spay-neuter-reminder',
  'payment-due',
  'invoice-overdue',
  'card-expiring',
  'waitlist-spot-open'
);
ALTER TABLE notifications           ALTER COLUMN type TYPE notification_type_v2 USING type::text::notification_type_v2;
ALTER TABLE scheduled_notifications ALTER COLUMN type TYPE notification_type_v2 USING type::text::notification_type_v2;
DROP TYPE notification_type;
ALTER TYPE notification_type_v2 RENAME TO notification_type;

COMMENT ON TABLE charges IS 'Stripe PaymentIntent records (package purchase, board-and-train, group-class). Retained financial record.';
