-- M5.04 (S31, DAY-U43) — the after-school opt-in is one flag per share; its old table goes.
-- design §4 LG5 (design.md:6224), §2.3:2558-2564 (question 43). Rev.: no (the table). Empty prod: 0 rows (unverified).
--
-- `booking_dogs.after_school`: this dog stays for that date's after-school session at the
-- campus, ticked at booking (`POST /bookings` `after_school`, 6.0.0-lg5.2) and counted in
-- dogs, as the seats are, against `day.after_school_capacity_count` under the date's
-- capacity lock. Never charged in v1 (DAY-U45 later).
--
-- `after_school_optins` held the opt-in per booking with a day count, and nothing in the
-- app ever wrote it. It goes with its four indexes, its audit trigger, its COMMENT and its
-- three foreign keys, each of which pointed out of it (ON DELETE CASCADE), so dropping it
-- takes only its own rows. `bookings_id_category_uidx` existed only for that table's
-- subtype foreign key (bookings (id, category)), which was its one dependent. Nothing is
-- backfilled: production is rebuilt clean from schema.sql at M1.
ALTER TABLE booking_dogs ADD COLUMN after_school boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN booking_dogs.after_school IS 'Her opt-in to that date''s after-school session at the campus (M5.04, DAY-U43): counted in dogs against day.after_school_capacity_count; never charged in v1.';

DROP TABLE after_school_optins;
DROP INDEX bookings_id_category_uidx;
