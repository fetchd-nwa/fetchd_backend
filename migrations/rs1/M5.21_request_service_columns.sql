-- M5.21 (P49, plan unit; wire 9.0.0 A6, A8, A9) — the columns private lessons and Board &
-- Train are booked by. design request-services-v1 §5.1. Additive: no column dropped, no
-- row moved. Rev.: drop the seven columns and three constraints.
--
-- staff: a trainer's flat lesson price (NULL = she teaches none) and her Board & Train
--   eligibility, written by `npm run staff:provision`'s roster alone.
-- pending_requests: what staff approved for a Board & Train, which is exactly what the
--   family says yes to: trainer, drop-off, pick-up (the cue transfer session) and the
--   flat price. Both stay ends set together, the pick-up after the drop-off.
-- bookings: the price fixed at booking for a lesson or a Board & Train. Nothing is
--   charged at booking; the bill after the service is plan unit P51's.
-- Every constraint is named, so a database born from `schema.sql` and one that took this
-- step hold the same names (`scripts/db/fingerprint.sql`).
ALTER TABLE staff
  ADD COLUMN lesson_price_cents integer CONSTRAINT staff_lesson_price_cents_check
    CHECK (lesson_price_cents > 0),
  ADD COLUMN board_train_eligible boolean NOT NULL DEFAULT false;

ALTER TABLE pending_requests
  ADD COLUMN approved_trainer_staff_id uuid REFERENCES staff(id),
  ADD COLUMN approved_dropoff_at timestamptz,
  ADD COLUMN approved_pickup_at timestamptz,
  ADD COLUMN approved_price_cents integer CONSTRAINT pending_requests_approved_price_cents_check
    CHECK (approved_price_cents > 0),
  ADD CONSTRAINT pending_requests_approved_window_check
    CHECK (approved_pickup_at > approved_dropoff_at),
  ADD CONSTRAINT pending_requests_approved_window_pair_check
    CHECK ((approved_dropoff_at IS NULL) = (approved_pickup_at IS NULL));

ALTER TABLE bookings
  ADD COLUMN quoted_price_cents integer CONSTRAINT bookings_quoted_price_cents_check
    CHECK (quoted_price_cents > 0);
