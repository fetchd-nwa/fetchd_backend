-- M5.25 (plan one-off O-CREDITS; wire 9.1.0; build DECISIONS 553 (b), 569) — the alumni pack
-- moves to Bentonville day care: "Alumni Bentonville 10 Visits", $320.00 for 10, and the
-- Fayetteville day-school pack is retired. Rows only, in the runner's one transaction;
-- `schema.sql`'s seed says the same (`rs2-steps.test.ts` holds the two equal).
-- Rev.: `test/fixtures/m525-reversal.sql`, never a step file. Reopening the Fayetteville
-- pack is a design decision that changes R7 at the same time: an alumni dog would again
-- hold Fayetteville day-school credits that R7 bars him from booking.
--
-- Her ruling (553): "yeah go with default", pending Shanthi's read-back before Stage B.
-- The design's §3.3 and the brief's catalog step, in order:
--   0. `lock_timeout` first, so a step queued behind a long transaction fails in 5 s and
--      runs again, instead of stalling every purchase behind its lock.
--   1. The catalog, then the charges and the ledger, as a settle takes them. A purchase or a
--      settle already under way finishes before the count below; one that starts later waits
--      for the step and then finds its row closed. A non-zero runner exit (a lock timeout, or
--      a 40P01 that chose the step) means nothing was applied: run it again.
--   2. The guard, which refuses while the retired pool can still hold or take a credit:
--      a Fayetteville day-school alumni lot with credits left, live OR expired (an expired
--      lot's credits come back when expiry is switched off or its date is moved, M4.12, so
--      the live `owner_credit_balance` is not enough; fix 1, Fable L6); a purchase of the
--      old pack still pending (`requires_payment`, or `failed` with `next_sweep_at` set); a
--      live debit from a Fayetteville alumni lot on an uncancelled booking dated today or
--      later in Chicago, whose cancel would return the credit there. It names owner, lot
--      and booking ids and balances, never a name or an email.
--   3. Every row of the old key closes with `effective_to = effective_from`: no live day.
--   4. The new row, in M4.06's form.
--   5. The new key's latest row is open: the reversal's last statement, mirrored. Run again
--      after the reversal, the insert above finds the row the reversal closed and does
--      nothing, so this reopens it rather than leave no alumni pack on sale (fix 1, Fable
--      L5). On a first run it changes nothing.
SET LOCAL lock_timeout = '5s';

LOCK TABLE credit_packages IN ACCESS EXCLUSIVE MODE;
LOCK TABLE charges, credit_ledger IN SHARE MODE;

DO $$
DECLARE
  balances text;
  pending text;
  debits text;
BEGIN
  -- Every lot of the pool, live or not, with what is left on it: the grant plus every
  -- row that names it (the unspent `lotUnspentInTx` reads).
  SELECT string_agg(owner_id::text || ' holds ' || held::text || ' (' || lots || ')', ', '
                    ORDER BY owner_id)
    INTO balances
    FROM (
      SELECT lot.owner_id,
             SUM(lot.unspent) AS held,
             string_agg('lot ' || lot.id::text || ' holds ' || lot.unspent::text
                          || CASE WHEN lot.expires_at <= now() THEN ', expired' ELSE '' END,
                        '; ' ORDER BY lot.expires_at, lot.id) AS lots
        FROM (
          SELECT g.owner_id, g.id, g.expires_at,
                 g.delta + COALESCE((SELECT SUM(a.delta) FROM credit_ledger a WHERE a.lot_id = g.id), 0)
                   AS unspent
            FROM credit_ledger g
           WHERE g.location = 'fayetteville' AND g.mode = 'school' AND g.tier = 'alumni'
             AND g.delta > 0 AND g.lot_id IS NULL
        ) lot
       WHERE lot.unspent > 0
       GROUP BY lot.owner_id
    ) held_by_owner;

  SELECT string_agg(c.owner_id::text || ' charge ' || c.id::text || ' ' || c.status::text, ', '
                    ORDER BY c.owner_id, c.id)
    INTO pending
    FROM charges c
   WHERE c.package_id IN (SELECT id FROM credit_packages WHERE key = 'school-alumni-10-fayetteville')
     AND (c.status = 'requires_payment' OR (c.status = 'failed' AND c.next_sweep_at IS NOT NULL));

  SELECT string_agg(DISTINCT d.owner_id::text || ' booking ' || d.booking_id::text, ', ')
    INTO debits
    FROM credit_ledger d
    JOIN bookings b ON b.id = d.booking_id
   WHERE d.location = 'fayetteville' AND d.mode = 'school' AND d.tier = 'alumni'
     AND d.reason = 'booking-debit'
     AND NOT EXISTS (
       SELECT 1 FROM credit_ledger r
        WHERE r.reverses_entry_id = d.id AND r.reason = 'settlement-return')
     AND b.status <> 'cancelled'
     AND (b.scheduled_at AT TIME ZONE 'America/Chicago')::date
           >= (now() AT TIME ZONE 'America/Chicago')::date;

  IF balances IS NOT NULL OR pending IS NOT NULL OR debits IS NOT NULL THEN
    RAISE EXCEPTION 'M5.25 refused: the Fayetteville day-school alumni pool still holds or can take credits. Credits left on its lots, live or expired: %. Pending purchases of school-alumni-10-fayetteville: %. Live debits on bookings today or later: %. Move them by hand (CRED-26), then run the step again.',
      coalesce(balances, 'none'), coalesce(pending, 'none'), coalesce(debits, 'none');
  END IF;
END $$;

UPDATE credit_packages
   SET effective_to = effective_from
 WHERE key = 'school-alumni-10-fayetteville';

INSERT INTO credit_packages (key, location, mode, tier, credits, price_cents, label, is_popular, single_day, expiry_months, effective_from) VALUES
  ('daycare-alumni-10-bentonville', 'bentonville', 'daycare', 'alumni', 10, 32000, 'Alumni Bentonville 10 Visits', false, false, 1, '2026-01-01')
ON CONFLICT (key, effective_from) DO NOTHING;

UPDATE credit_packages
   SET effective_to = NULL
 WHERE id = (SELECT id FROM credit_packages
              WHERE key = 'daycare-alumni-10-bentonville'
              ORDER BY effective_from DESC
              LIMIT 1)
   AND effective_to IS NOT NULL;
