-- =============================================================================
-- Supabase's API roles, for every database that is NOT Supabase (design §4
-- preamble, "Roles in dev, test and rehearsal"; S01).
-- =============================================================================
-- Production is a Supabase project, where `anon`, `authenticated` and
-- `service_role` exist and receive default grants on new objects in `public`.
-- `schema.sql` and every migration step revoke from `anon` and `authenticated`
-- (M1.00 and the REVOKE after each CREATE TABLE), and a REVOKE naming a role
-- that does not exist fails — so a plain Postgres (the docker dev and test
-- volumes, the rehearsal's throwaway container) needs the roles first.
--
-- Loaded BEFORE schema.sql: mounted as /docker-entrypoint-initdb.d/
-- 00-supabase-roles.sql in both docker-compose services (it sorts ahead of
-- 01-schema.sql), and loaded first by scripts/migrate-rehearse.sh. Applied once
-- by hand to a dev volume created before this file existed. NEVER run on
-- production: the roles there are Supabase's, with attributes this file does
-- not reproduce. Idempotent — a role that exists is left exactly as it is.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END $$;
