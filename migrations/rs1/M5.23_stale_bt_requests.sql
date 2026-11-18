-- M5.23 (P49, plan unit; wire 9.0.0 A1, A2) — an old-flow Board & Train approval goes
-- back to staff. design request-services-v1 §5.1. Rows only: no `schema.sql` counterpart
-- (a database born from `schema.sql` holds no old-flow row). Rev.: no (the approver and
-- the approval instant are cleared; the audit trail keeps them).
--
-- Before 9.0.0 the staff approve parked a Board & Train at 'approved-awaiting-payment'
-- with no dates, and the removed `POST /requests/:id/confirm-payment` took them from the
-- family. From 9.0.0 staff approve dates, a trainer and the price, and the family's yes
-- books exactly those, so a row approved the old way has nothing to say yes to. It goes
-- back to 'submitted' with no approver, and staff approve it again. Production is born
-- clean and has none; the dev database may.
UPDATE pending_requests
   SET status = 'submitted',
       approved_by_staff_id = NULL,
       approved_at = NULL
 WHERE status = 'approved-awaiting-payment'
   AND approved_dropoff_at IS NULL;
