-- migrate: no-transaction
-- M3.03 (S20, PAY-U07) — `booking_status` gains 'payment-pending'.
-- design §4 LG3 (design.md:6190). Rev.: no (Postgres has no DROP VALUE). Empty prod: nothing to move.
--
-- The value's own committed statement: Postgres refuses a new enum value's use in
-- the transaction that added it (55P04), so this step is not bracketed with any
-- step that uses one. The wire's `BookingStatus` mirrors it; `conformance.ts` pins
-- the two, and no wire tuple exists to mirror (P15 notes A7).
--
-- LG3's last step, so it carries the group's closing REVOKE (DECISIONS 86): every
-- table the group created, once more. `orders` is the only one. A REVOKE beside an
-- ALTER TYPE runs as one implicit transaction, which Postgres 12 and up allows.
ALTER TYPE booking_status ADD VALUE 'payment-pending' AFTER 'cancelled';
REVOKE ALL ON orders FROM anon, authenticated;
