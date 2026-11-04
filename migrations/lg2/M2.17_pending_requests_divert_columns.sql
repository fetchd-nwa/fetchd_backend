-- M2.17 (S17, DOG-U08, PAY-U19) — pending_requests loses the day-program lane's columns.
-- design §4 LG2 (design.md:6178), §2.2 (design.md:2132-2137); DECISIONS 118(f).
-- Rev.: no (a dropped column takes its rows). Empty prod: 0 rows.
--
-- `POST /bookings` has one outcome from wire 3.0.0, so no request carries a
-- campus, a payment plan, a card or a divert reason any more. A `location` or
-- `payment` value goes with its column, along with their own FK and CHECK. No
-- data guard: production is rebuilt clean and the dev seed holds no such row
-- (DECISIONS 118(f)). A surviving `day-school` or `day-care` row stays readable,
-- answers 409 on approve, and can still be denied.
--
-- The table's COMMENT already names only private lesson, boarding and
-- board-and-train, so it stands as it is.
--
-- No table is created, so the step needs no per-table REVOKE, and the group's
-- closing REVOKE (DECISIONS 86, 118(g)) has nothing of this step's to repeat.
ALTER TABLE pending_requests DROP CONSTRAINT pending_requests_payment_method_id_fkey;
ALTER TABLE pending_requests
  DROP COLUMN divert_reasons,
  DROP COLUMN location,
  DROP COLUMN payment,
  DROP COLUMN payment_method_id;
