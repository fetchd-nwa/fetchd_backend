-- M5.08 (S33, CXL-U02, CXL-U20) — the cancel window goes: its table, its seed and its COMMENT.
-- design §4 LG5 (design.md:6227), §2.7:4115-4126, §3.8. Rev.: no. Empty prod: 7 live rows dropped.
--
-- Every cxl.* key is stored only (money cut 3; 12-:67-69 "no true penalty"): no cancel has a
-- window and no route stamps `bookings.cancel_deadline_at` from this step on (contract notes
-- D3), so nothing reads this table. Its readers go in the same commit: the four booking paths'
-- `resolveHoursFor`, `lib/cancelWindow.ts` (the 48-hour class constant and its fallback
-- table), the repository, and `GET /staff/cancel-window` / `PATCH /staff/cancel-window/:category`,
-- replaced by `GET/PATCH /staff/settings/cxl` (6.0.0-lg5.2).
--
-- Locked first, as M4.07 is, so no row lands between the delete and the drop. The rows are
-- DELETEd before the DROP so the table's AFTER DELETE audit trigger writes each row's
-- pre-image to `audit_log`, with this step's own actor (`audit_capture` reads
-- `current_setting('app.actor', true)`; the runner sets the same actor, and this line keeps
-- it true wherever the step runs inside a transaction). The DROP takes the trigger, the
-- primary key, the staff FK (ON DELETE SET NULL: a staff row's delete never reached here)
-- and the COMMENT with it.
LOCK TABLE cancel_window_settings IN ACCESS EXCLUSIVE MODE;
SET LOCAL app.actor = 'system:migrate-M5.08';
DELETE FROM cancel_window_settings;
DROP TABLE cancel_window_settings;
