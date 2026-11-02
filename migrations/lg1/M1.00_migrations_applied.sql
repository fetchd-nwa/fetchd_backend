-- M1.00 (S01) — the migration log, and no default grants to the API-less roles.
-- design §4 preamble + LG1 table (design.md:6077-6092, :6130). Apply with
-- `npm run migrate:apply -- <this file> --url … --project …`, never the SQL editor.
--
-- DECISIONS 51: written before production's pg_default_acl reading. The three
-- IN SCHEMA public revokes are here; if that reading shows a global grant, the
-- global form (no IN SCHEMA) is added to this step before its first production
-- application. Rows whose grantor is supabase_admin are recorded, not altered.
CREATE TABLE migrations_applied (
  step_id     text PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  applied_by  text NOT NULL,
  sql_sha256  text NOT NULL
);
REVOKE ALL ON migrations_applied FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;

COMMENT ON TABLE migrations_applied IS 'One row per migration step applied through npm run migrate:apply: the step id, who ran it, and the sha256 of the exact bytes sent. Written as the step''s last statement, in its transaction.';
