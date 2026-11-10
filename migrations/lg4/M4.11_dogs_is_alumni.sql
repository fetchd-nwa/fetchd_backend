-- M4.11 (S25, ALUM-U02) — alumni status is stored, and a level un-recorded does not take it back.
-- design §4 LG4 (design.md:6211), §2.4 step 4 (design.md:2935-2936). Rev.: yes. Empty prod: 0 rows.
--
-- Set under the dog's row lock when the fifth level is recorded (`lockForAlumniUpdate`),
-- and never cleared. The one-time backfill counts the live completions, which the partial
-- unique index keeps to one per program.
ALTER TABLE dogs ADD COLUMN is_alumni boolean NOT NULL DEFAULT false;

UPDATE dogs d
   SET is_alumni = true
 WHERE (SELECT count(*)
          FROM dog_completed_programs p
         WHERE p.dog_id = d.id AND p.expired_at IS NULL) = 5;
