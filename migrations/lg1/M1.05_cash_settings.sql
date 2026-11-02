-- M1.05 (S01, SET-U01 ← CASH-U07) — the `cash` settings domain.
-- design §4 LG1 (design.md:6133), seeds §3.9. Every column is stored only (R2:
-- no in-person invoice exists in v1). cash.due_event is one jsonb column, service
-- → due event (boarding NOT SEEDED: null); there is no cash_due_event_settings table.
-- No package entry and no 'purchase' event: §1.1 never builds that rule
-- (design.md:672, :729-730), which outranks §3.9's and M1.05's "package
-- purchase" (DECISIONS 53, D1).
CREATE TABLE cash_settings (
  id                                boolean PRIMARY KEY DEFAULT true CHECK (id),
  unpaid_checkout_block_enabled     boolean NOT NULL,
  pack_grant_on_promise_enabled     boolean NOT NULL,
  did_not_pay_undo_window_hours     integer NOT NULL CHECK (did_not_pay_undo_window_hours >= 0),
  pack_partial_payment_destination  text NOT NULL CHECK (pack_partial_payment_destination IN ('account-credit', 'cash-refund')),
  bounced_check_fee_cents           integer NOT NULL CHECK (bounced_check_fee_cents >= 0),
  due_event_by_service              jsonb NOT NULL,
  updated_at                        timestamptz NOT NULL DEFAULT now(),
  updated_by_staff_id               uuid REFERENCES staff(id) ON DELETE SET NULL
);
REVOKE ALL ON cash_settings FROM anon, authenticated;

INSERT INTO cash_settings (
  unpaid_checkout_block_enabled, pack_grant_on_promise_enabled, did_not_pay_undo_window_hours,
  pack_partial_payment_destination, bounced_check_fee_cents, due_event_by_service
) VALUES (
  true, false, 24, 'account-credit', 0,
  '{"day-school": "drop-off", "day-care": "drop-off", "group-class": "first-meeting-start", "walk-in": "front-desk-or-pickup", "event": "event-start", "private-lesson": "close-out", "board-and-train": "close-out", "boarding": null}'
);

COMMENT ON TABLE cash_settings IS 'The cash settings domain (singleton, id = true): cash and check policy, every key stored only in v1 (R2). Audited (STAFF-74).';
