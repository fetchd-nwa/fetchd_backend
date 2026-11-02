-- migrate: census-empty staff
-- M1.19 (S02, STAFF-U02) — staff roles become owner, manager and trainer.
-- design §4 LG1 (design.md:6151), §2.1 STAFF-U02 (design.md:1939-1945). The
-- enum is REBUILT (a value cannot be removed in place), in the runner's one
-- transaction: this file carries no BEGIN or COMMIT. Rev.: no.
--
-- The census gate (the header line above; design.md:2122-2128) is a gate, not
-- a reading: on production and on the rehearsal's production-shaped copy the
-- runner stops unless `staff` holds 0 rows, so the cast below meets no live
-- staffer there. Staff rows come afterwards from `npm run staff:provision`.
-- Dev takes the cast on its seeded roster (`--skip-census staff`, refused for
-- any project but local): 'owner-shanthi' → 'owner', 'trainer' → 'trainer'.
-- A live 'office' row has no arm, casts to NULL and aborts the step on
-- `role NOT NULL`: map it by hand first. 'manager' is new (Amber).
CREATE TYPE staff_role_v2 AS ENUM ('owner', 'manager', 'trainer');

ALTER TABLE staff ALTER COLUMN role TYPE staff_role_v2
  USING ((CASE role::text WHEN 'owner-shanthi' THEN 'owner' WHEN 'trainer' THEN 'trainer' END)::staff_role_v2);

DROP TYPE staff_role;

-- Renaming the type renames its array type too (_staff_role_v2 → _staff_role),
-- which M1.21's staff_role[] columns use.
ALTER TYPE staff_role_v2 RENAME TO staff_role;
