-- M1.22 (S01/S02; DECISIONS 86) — LG1's second check: every table the group
-- created, revoked from the API roles once more, as the group's last step.
-- design §4 preamble (design.md:6106-6110): "every landing group's migration
-- file ends with a REVOKE ALL ON <each table the file created> FROM anon,
-- authenticated as a second check". The runner applies one file per step, so
-- that file is the group's last step file (DECISIONS 86).
--
-- Each step already revokes its own table right after its CREATE TABLE. This
-- repeats those revokes in one place, so a table whose step lost its line is
-- still closed when the group lands. It is idempotent (revoking a privilege
-- that is not held does nothing) and changes no end state: schema.sql does
-- not change, and the rehearsal shows 0 differences. A static test
-- (test/migrateRunner.test.ts) holds the rule for every group: the last step
-- of each migrations/lg<n>/ revokes every table any step of the group creates.
-- Rev.: yes (nothing to undo).
REVOKE ALL ON migrations_applied FROM anon, authenticated;
REVOKE ALL ON account_settings FROM anon, authenticated;
REVOKE ALL ON alumni_settings FROM anon, authenticated;
REVOKE ALL ON cash_settings FROM anon, authenticated;
REVOKE ALL ON credit_settings FROM anon, authenticated;
REVOKE ALL ON day_program_settings FROM anon, authenticated;
REVOKE ALL ON dog_gate_settings FROM anon, authenticated;
REVOKE ALL ON evaluation_settings FROM anon, authenticated;
REVOKE ALL ON migration_settings FROM anon, authenticated;
REVOKE ALL ON messaging_settings FROM anon, authenticated;
REVOKE ALL ON notification_settings FROM anon, authenticated;
REVOKE ALL ON payment_settings FROM anon, authenticated;
REVOKE ALL ON reports_settings FROM anon, authenticated;
REVOKE ALL ON vaccine_settings FROM anon, authenticated;
REVOKE ALL ON staff_settings FROM anon, authenticated;
