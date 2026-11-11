-- M5.02 (S30, DAY-U33) — one settling event per dog per session.
-- design §4 LG5 (design.md:6222), §2.3:2477-2479. Rev.: yes. Empty prod: 0 rows.
--
-- A share holds at most one of `turn-away`, `sent-home` and `no-show`: the backstop under
-- the verbs' state check, which refuses a second settling event first. No settling event
-- can be undone (design §2.3:2387-2390), so the index never needs to read the undos. No
-- table is created, so this step needs no REVOKE of its own; M5.12, the group's last step,
-- carries LG5's closing one.
CREATE UNIQUE INDEX checkin_events_one_settling_uidx ON checkin_events (booking_id, dog_id)
  WHERE kind IN ('turn-away', 'sent-home', 'no-show');
