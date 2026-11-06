-- M4.03 (S28, ALUM-U17) — the alumni attendance flag goes with its scan.
-- design §4 LG4 (design.md:6203), §2.4 (design.md:2846). Rev.: no. Empty prod: 0 rows set.
--
-- Alumni status is never lost (ALUM-U01): this was a staff nudge, not a state, and its
-- only writer, the monthly scan, left with the same unit.
ALTER TABLE dogs DROP COLUMN alumni_attendance_flagged_at;
