-- M5.12 (S29, DAY-U29) — the overwritable attendance columns go; the check-in log is the one record.
-- design §4 LG5 (design.md:6230), §2.3:2369-2372 (question 9). Rev.: no. Empty prod: 0 rows.
--
-- `booking_dogs.attendance`, `checked_in_at` and `checked_in_by_staff_id`, and the
-- `booking_attendance` type, replaced by M5.01's append-only `checkin_events`
-- (Adjudication 3: "Full event log wins"). The same commit deletes
-- `POST /staff/bookings/:id/attendance`, swaps `conformance.ts`'s `booking_attendance` pin
-- for a `checkin_event_kind` one, and rewrites `scripts/seed-dev.ts` to write
-- `checkin_events` and `dogs.last_seen_on`. Less its "deletes the evaluation verdict's
-- no-show read (EVAL-U04)" clause: S12 is written after this step with no attendance read
-- (P20 `deferred_arms`). Nothing is backfilled: production holds no attendance.
ALTER TABLE booking_dogs
  DROP COLUMN attendance,
  DROP COLUMN checked_in_at,
  DROP COLUMN checked_in_by_staff_id;
DROP TYPE booking_attendance;

COMMENT ON TABLE booking_dogs IS 'Dogs on a booking (lead + additional), one share each; a share cancelled alone carries expired_at. A dog''s presence is the check-in log''s (checkin_events).';

-- LG5's last step by number, so it carries the group's closing REVOKE (DECISIONS 86):
-- every table the group's steps create, once more.
REVOKE ALL ON checkin_events, cancellation_policy_settings, cancellation_global_settings FROM anon, authenticated;
