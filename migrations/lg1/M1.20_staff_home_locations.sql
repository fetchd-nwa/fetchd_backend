-- M1.20 (S02, STAFF-U03, STAFF-U02) — a staffer's home campuses become a set;
-- staff.location and staff.active go.
-- design §4 LG1 (design.md:6152), §2.1 STAFF-U03 (design.md:1939-1950), E67.
-- Rev.: data (the dropped columns take their values).
--
-- `home_locations text[]`, backfilled from `location`: a staffer with one
-- campus gets it, a staffer with NULL gets '{}' and the CHECK below then aborts
-- the step — loud and correct (a staff row must name a campus). The backfill
-- yields ONE campus each: a staffer of both campuses (Shanthi) is written by
-- `npm run staff:provision` / `seed-dev.ts`, not here. No trigger: the column is
-- descriptive (STAFF-71) and has one person writer, the provisioning script,
-- which refuses an empty set, an unknown slug and a repeat.
--
-- `active` is dropped (question 34): sign-in reads `expired_at` alone
-- (`auth/mirror.ts`), so the column gated nothing. Dropping `location` drops
-- `staff_location_fkey` with it. No production staff rows are seeded here.
ALTER TABLE staff ADD COLUMN home_locations text[] NOT NULL DEFAULT '{}';

UPDATE staff SET home_locations = array_remove(ARRAY[location], NULL);

ALTER TABLE staff DROP COLUMN location;
ALTER TABLE staff DROP COLUMN active;

-- The default only carried the backfill: from here a staff row that omits the
-- column fails loudly instead of reaching GET /me as [] (r4-opus #13).
ALTER TABLE staff ALTER COLUMN home_locations DROP DEFAULT;
ALTER TABLE staff ADD CHECK (cardinality(home_locations) > 0);
