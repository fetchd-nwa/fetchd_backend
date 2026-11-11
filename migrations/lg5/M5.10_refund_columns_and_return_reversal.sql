-- M5.10 (S35's columns, landed with DAY-U34; PAY-U24, PAY-U27) — the refund's columns, and every return names its debit.
-- design §4 LG5 (design.md:6228), §2.4:2957-2960, :2976-2977. Rev.: yes. Empty prod: 0 rows.
--
-- The whole step lands at LG5 (P20, the earliest unit that builds one of its ledger units:
-- DAY-U34). The eight `refunds` columns and `credit_ledger.refund_id` get no reader and no
-- writer until the refund unit (P22); `enrollment_id`'s FK lands at M7.08, when
-- `enrollments` exists. `reverses_entry_id` names the one `booking-debit` a
-- `settlement-return` reverses, and the CHECK makes every return name one, so Luna's
-- return on a two-dog day points at Luna's debit and never Bao's (s11). No
-- `account_credit`, no `issued_over_limit`. Runs after M5.03, whose value the CHECK names,
-- and after M5.01, whose table the event link names.
--
-- Amended by P20 fix round 1 (designs/p20-event-ledger-link.md §3, §9; build DECISIONS 249(a),
-- 253): `checkin_event_id` names the check-in event whose transaction wrote the row (a
-- re-check-in's debit, a ticked check-out's or a settling verb's return), so no reader
-- infers the link from equal `created_at` stamps. The composite FK keeps the row on the
-- event's own booking and dog (`checkin_events_share_key` is its target), the CHECK keeps
-- a linked row a debit or a return on a share (its `IS NOT NULL` is load-bearing: a MATCH
-- SIMPLE FK skips its check when any column is NULL), and the partial unique index allows
-- one row per event. NO ACTION: a CASCADE would pass M5.01's append-only trigger and
-- delete a credit with its event; SET NULL would unlink a credit unseen. A cancel's
-- return and every booking-time debit name no event.
ALTER TABLE refunds
  ADD COLUMN instrument text NOT NULL DEFAULT 'original_card' CHECK (instrument IN ('original_card', 'cash', 'check')),
  ADD COLUMN returned_instrument text CHECK (returned_instrument IN ('cash', 'check')),
  ADD COLUMN issued_by_staff_id uuid REFERENCES staff(id),
  ADD COLUMN retry_of_refund_id uuid REFERENCES refunds(id),
  ADD COLUMN resolved_outcome text CHECK (resolved_outcome IN ('returned', 'withdrawn')),
  ADD COLUMN credits_settled_by_staff_id uuid REFERENCES staff(id),
  ADD COLUMN credits_settled_at timestamptz,
  ADD COLUMN enrollment_id uuid;

ALTER TABLE credit_ledger
  ADD COLUMN refund_id uuid,
  ADD COLUMN reverses_entry_id uuid REFERENCES credit_ledger(id),
  ADD CONSTRAINT credit_ledger_refund_id_fkey FOREIGN KEY (refund_id) REFERENCES refunds(id),
  ADD CONSTRAINT credit_ledger_return_reverses_debit_check
    CHECK (reason <> 'settlement-return' OR reverses_entry_id IS NOT NULL);

ALTER TABLE checkin_events ADD CONSTRAINT checkin_events_share_key UNIQUE (id, booking_id, dog_id);
ALTER TABLE credit_ledger
  ADD COLUMN checkin_event_id uuid,
  ADD CONSTRAINT credit_ledger_checkin_event_fkey FOREIGN KEY (checkin_event_id, booking_id, dog_id)
    REFERENCES checkin_events (id, booking_id, dog_id),
  ADD CONSTRAINT credit_ledger_checkin_event_check CHECK (checkin_event_id IS NULL OR
    (reason IN ('booking-debit', 'settlement-return') AND booking_id IS NOT NULL AND dog_id IS NOT NULL));
CREATE UNIQUE INDEX credit_ledger_checkin_event_uidx ON credit_ledger (checkin_event_id)
  WHERE checkin_event_id IS NOT NULL;

COMMENT ON TABLE refunds IS 'Refunds against a prior Stripe charge (partial allowed). Append-only retained financial record; money-back, distinct from a credit_ledger settlement-return.';
