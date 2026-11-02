-- M1.12 (S01, SET-U01 ← NOTIF-U02) — the `notif` settings domain.
-- design §4 LG1 (design.md:6140), seeds §3.12. Times are America/Chicago.
-- email_sender_address is NULL until Allison supplies it (the preflight refuses
-- a pilot without it). No push_receipt_check_delay_minutes.
CREATE TABLE notification_settings (
  id                                    boolean PRIMARY KEY DEFAULT true CHECK (id),
  quiet_hours_start_time                time NOT NULL,
  quiet_hours_end_time                  time NOT NULL,
  quiet_hours_bypass_types              text[] NOT NULL,
  scan_send_time                        time NOT NULL,
  booking_reminder_lead_hours           integer NOT NULL CHECK (booking_reminder_lead_hours >= 0),
  card_expiry_warning_days_before       integer NOT NULL CHECK (card_expiry_warning_days_before >= 0),
  email_sender_address                  text,
  broadcast_audience_list               text[] NOT NULL
    CHECK (broadcast_audience_list <@ ARRAY['everyone', 'campus', 'class', 'day-school-families']),
  cash_payment_due_reminder_lead_hours  integer NOT NULL CHECK (cash_payment_due_reminder_lead_hours >= 0),
  email_sender_display_name             text NOT NULL DEFAULT 'NWA School for Dogs',
  -- program → 'push_only' | 'push_then_email'
  reminder_channel_by_program           jsonb NOT NULL,
  expiry_notice_channel                 text NOT NULL DEFAULT 'push_then_email'
    CHECK (expiry_notice_channel IN ('push_only', 'push_then_email')),
  email_inflight_alarm_minutes          integer NOT NULL DEFAULT 5 CHECK (email_inflight_alarm_minutes > 0),
  updated_at                            timestamptz NOT NULL DEFAULT now(),
  updated_by_staff_id                   uuid REFERENCES staff(id) ON DELETE SET NULL
);
REVOKE ALL ON notification_settings FROM anon, authenticated;

INSERT INTO notification_settings (
  quiet_hours_start_time, quiet_hours_end_time, quiet_hours_bypass_types, scan_send_time,
  booking_reminder_lead_hours, card_expiry_warning_days_before, email_sender_address,
  broadcast_audience_list, cash_payment_due_reminder_lead_hours, email_sender_display_name,
  reminder_channel_by_program, expiry_notice_channel, email_inflight_alarm_minutes
) VALUES (
  '21:00', '08:00', '{payment-failed,closure,staff-reply}', '08:00',
  24, 7, NULL,
  '{everyone,campus,class,day-school-families}', 24, 'NWA School for Dogs',
  '{"day-school": "push_only", "day-care": "push_then_email", "group-class": "push_then_email", "evaluation": "push_then_email"}',
  'push_then_email', 5
);

COMMENT ON TABLE notification_settings IS 'The notif settings domain (singleton, id = true): send times, reminder and expiry-notice leads and channels, the email sender. Audited (STAFF-74).';
