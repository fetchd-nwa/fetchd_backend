-- M1.13 (S01, SET-U01 ← PAY-U02; PAY-U05, PAY-U07, PAY-U14) — the `pay` domain.
-- design §4 LG1 (design.md:6141), seeds §3.7. PAY-U02's key/value shape, scope
-- 'global' for an org-wide row and a service (or 'package', 'retail', 'event')
-- for charge_timing_mode, the one per-service key. Seeded whole here (M3.04's
-- inserts move in). No payment_setting_changes table: audit_log is the history.
-- max_sessions_per_booking_count, automatic_return_instrument_mode,
-- charge_timing_mode and price_change_notice_days are stored only in v1.
-- The value CHECK holds each seeded key's shape and bounds; a key with no
-- clause is accepted as any jsonb (the store is generic by design).
CREATE TABLE payment_settings (
  key                  text NOT NULL,
  scope                text NOT NULL DEFAULT 'global',
  value                jsonb NOT NULL,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by_staff_id  uuid REFERENCES staff(id) ON DELETE SET NULL,
  PRIMARY KEY (key, scope),
  CONSTRAINT payment_settings_scope_check CHECK ((key = 'charge_timing_mode') = (scope <> 'global')),
  CONSTRAINT payment_settings_value_check CHECK (
    CASE
      WHEN key IN ('card_attempts_max_count', 'seat_hold_max_minutes', 'processing_hold_max_minutes',
                   'refund_any_role_limit_cents', 'price_change_notice_days',
                   'max_sessions_per_booking_count')
        THEN CASE
          WHEN jsonb_typeof(value) <> 'number' THEN false
          WHEN (value::text)::numeric <> trunc((value::text)::numeric) THEN false
          WHEN key = 'card_attempts_max_count' THEN (value::text)::numeric BETWEEN 1 AND 5
          WHEN key = 'seat_hold_max_minutes' THEN (value::text)::numeric BETWEEN 1 AND 5
          WHEN key = 'processing_hold_max_minutes' THEN (value::text)::numeric BETWEEN 1 AND 60
          WHEN key = 'max_sessions_per_booking_count' THEN (value::text)::numeric >= 1
          ELSE (value::text)::numeric >= 0
        END
      WHEN key IN ('custom_invoice_kind_list', 'custom_invoice_card_kind_list')
        THEN jsonb_typeof(value) = 'array'
      WHEN key = 'charge_timing_mode'
        THEN value IN ('"at_confirm"'::jsonb, '"at_close_out"'::jsonb)
      WHEN key = 'automatic_return_instrument_mode'
        THEN value = '"original_card"'::jsonb
      ELSE true
    END
  )
);
REVOKE ALL ON payment_settings FROM anon, authenticated;

INSERT INTO payment_settings (key, scope, value) VALUES
  ('card_attempts_max_count',          'global',          '3'),
  ('seat_hold_max_minutes',            'global',          '2'),
  ('processing_hold_max_minutes',      'global',          '10'),
  ('custom_invoice_kind_list',         'global',          '["vet-bill", "damage", "other"]'),
  ('custom_invoice_card_kind_list',    'global',          '["vet-bill", "damage"]'),
  ('refund_any_role_limit_cents',      'global',          '0'),
  ('price_change_notice_days',         'global',          '30'),
  ('max_sessions_per_booking_count',   'global',          '30'),
  ('automatic_return_instrument_mode', 'global',          '"original_card"'),
  ('charge_timing_mode',               'private-lesson',  '"at_close_out"'),
  ('charge_timing_mode',               'board-and-train', '"at_close_out"'),
  ('charge_timing_mode',               'day-school',      '"at_confirm"'),
  ('charge_timing_mode',               'group-class',     '"at_confirm"'),
  ('charge_timing_mode',               'package',         '"at_confirm"'),
  ('charge_timing_mode',               'retail',          '"at_confirm"'),
  ('charge_timing_mode',               'event',           '"at_confirm"');

COMMENT ON TABLE payment_settings IS 'The pay settings domain: one row per (key, scope), value jsonb; scope ''global'' except charge_timing_mode, which is per service. Seeded whole at M1.13. Audited (STAFF-74); audit_log is the change history.';
