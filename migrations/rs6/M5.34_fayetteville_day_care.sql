-- M5.34 (plan one-off O-BUGS3, her bug #40; build DECISIONS 677 (1), 702 (3), 704) — day care
-- is offered and shown at Fayetteville, and sold there as at Bentonville: a 10-pack at $350.00
-- and a single day at $35.00. Rows only, in the runner's one transaction; `schema.sql`'s seed
-- says the same (`rs6-steps.test.ts` holds the two equal: the rehearsal compares
-- `credit_packages` rows but no `day_program_settings` row).
-- Rev.: set Fayetteville's `day-care` back to `offered: false, client_visible: false` and close
-- both rows with `effective_to = effective_from` (never a DELETE: a purchase names its row).
--
-- Her words: "fayetteville does offer day care" (11-19 13:50); her answer to the three
-- questions, "default" (704): prices as Bentonville's; the campus's 15 daily places shared
-- with day school (one count per campus, `daily_capacity_dogs`: nothing to change here); and
-- alumni credits stay Bentonville-only (553 (b)): no alumni row is added at Fayetteville.
--   0. `lock_timeout` first, so a step queued behind a long transaction fails in 5 s and runs
--      again, instead of stalling the settings and the shop behind its row locks.
--   1. The catalog and the ledger locked against writers before the guard reads them (M5.25's
--      form, fix 1 Fable L2): a lot or a row another connection commits while the step runs
--      waits for its commit, and one already in flight is waited for and then read. Readers
--      (the shop, a purchase's row read) do not wait. A non-zero runner exit (a lock timeout,
--      or a 40P01 that chose the step) means nothing was applied: run it again.
--   2. The guard, which refuses while day care cannot open cleanly at Fayetteville. Before this
--      step no road wrote a Fayetteville day care lot (no row sold day care there, so the desk's
--      add answered `pool_not_bookable`), and no route makes a catalog row; every clause below
--      needs a hand-altered database, which hers is. It names owner, lot and booking ids,
--      balances and catalog keys, never a name or an email.
--      a. Fayetteville's settings row exists (fix 1, Fable N2): without it the UPDATE below
--         matches nothing and the rows would go on sale with day care not offered.
--      b. No alumni lot of the pool has credits left, live OR expired (an expired lot's credits
--         come back when expiry is switched off or its date is moved, M4.12; M5.25 fix 1,
--         Fable L6). Such a lot would start paying an alumni dog's Fayetteville day the moment
--         day care opens, against 553 (b). Regular lots of the pool are not refused: they are
--         Fayetteville day care credits, and now pay Fayetteville day care.
--      c. No alumni debit of the pool is live on an uncancelled booking dated today or later in
--         Chicago, whose cancel would return the credit there (M5.25's third clause; fix 1,
--         Fable L3).
--      d. The catalog at Fayetteville day care holds no row but this step's two, live or to come
--         (another key, an alumni row, another date, or the step's key and date on other terms),
--         and no closed row of the step's keys is on other terms (the reopen in 5 could open
--         it): so the step never leaves two live rows of one key, a price not Bentonville's, or
--         an alumni row there (fix 1, Fable L4). A row whose window is over, and a row the
--         reversal closed (`effective_to = effective_from`), do not block.
--   3. The offerings: only `day-care`'s two flags move at Fayetteville; its `name` and
--      `description` stay as staff left them, and Bentonville's document is not touched.
--      (`jsonb_set` with a NULL value returns NULL, so a document missing its `day-care`
--      entry gets a whole one, NOT SEEDED name and description, instead of losing itself.)
--      A document already on is not written, so a run that changes nothing writes no audit
--      row (fix 1, Fable N1).
--   4. The two rows, in M4.06's form (Bentonville's `daycare-10-bentonville` and
--      `single-day-daycare-bentonville` with the campus changed).
--   5. Each new key's latest row is open: run again after the reversal, the insert above finds
--      the rows the reversal closed and does nothing, so this reopens them rather than leave
--      day care offered with nothing on sale (M5.25 fix 1, Fable L5). On a first run it
--      changes nothing.
SET LOCAL lock_timeout = '5s';

LOCK TABLE credit_packages IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE credit_ledger IN SHARE MODE;

DO $$
DECLARE
  balances text;
  debits text;
  other_rows text;
BEGIN
  PERFORM 1 FROM day_program_settings WHERE location = 'fayetteville';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'M5.34 refused: the database holds no day_program_settings row for fayetteville, so day care cannot be switched on there and its two rows would go on sale with day care not offered. Restore the row (schema.sql seeds it), then run the step again.';
  END IF;

  -- Every alumni lot of the pool, live or not, with what is left on it: the grant plus every
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
           WHERE g.location = 'fayetteville' AND g.mode = 'daycare' AND g.tier = 'alumni'
             AND g.delta > 0 AND g.lot_id IS NULL
        ) lot
       WHERE lot.unspent > 0
       GROUP BY lot.owner_id
    ) held_by_owner;

  SELECT string_agg(DISTINCT d.owner_id::text || ' booking ' || d.booking_id::text, ', ')
    INTO debits
    FROM credit_ledger d
    JOIN bookings b ON b.id = d.booking_id
   WHERE d.location = 'fayetteville' AND d.mode = 'daycare' AND d.tier = 'alumni'
     AND d.reason = 'booking-debit'
     AND NOT EXISTS (
       SELECT 1 FROM credit_ledger r
        WHERE r.reverses_entry_id = d.id AND r.reason = 'settlement-return')
     AND b.status <> 'cancelled'
     AND (b.scheduled_at AT TIME ZONE 'America/Chicago')::date
           >= (now() AT TIME ZONE 'America/Chicago')::date;

  SELECT string_agg(r.key || ' from ' || r.effective_from::text
                      || COALESCE(' to ' || r.effective_to::text, '')
                      || CASE WHEN r.on_step_terms THEN '' ELSE ' (not this step''s terms)' END,
                    ', ' ORDER BY r.key, r.effective_from)
    INTO other_rows
    FROM (
      SELECT cp.key, cp.effective_from, cp.effective_to,
             (cp.location = 'fayetteville' AND cp.mode = 'daycare' AND cp.tier = 'regular'
              AND ((cp.key = 'daycare-10-fayetteville' AND cp.credits = 10
                    AND cp.price_cents = 35000 AND NOT cp.single_day)
                OR (cp.key = 'single-day-daycare-fayetteville' AND cp.credits = 1
                    AND cp.price_cents = 3500 AND cp.single_day))) AS on_step_terms,
             (cp.effective_to IS NULL
              OR cp.effective_to > GREATEST(cp.effective_from,
                                            (now() AT TIME ZONE 'America/Chicago')::date))
               AS live_or_to_come
        FROM credit_packages cp
       WHERE (cp.location = 'fayetteville' AND cp.mode = 'daycare')
          OR cp.key IN ('daycare-10-fayetteville', 'single-day-daycare-fayetteville')
    ) r
   WHERE (r.live_or_to_come AND NOT (r.on_step_terms AND r.effective_from = '2026-01-01'))
      OR (r.key IN ('daycare-10-fayetteville', 'single-day-daycare-fayetteville')
          AND NOT r.on_step_terms);

  IF balances IS NOT NULL OR debits IS NOT NULL OR other_rows IS NOT NULL THEN
    RAISE EXCEPTION 'M5.34 refused: Fayetteville day care cannot open cleanly (alumni credits are Bentonville-only, 553 (b); its catalog must be this step''s two rows). Alumni credits left on its lots, live or expired: %. Live alumni debits on bookings today or later, whose cancel would return the credit there: %. Catalog rows at Fayetteville day care, or of this step''s keys, other than this step''s two: %. Move the credits by hand (CRED-26) and close or correct those rows, then run the step again.',
      coalesce(balances, 'none'), coalesce(debits, 'none'), coalesce(other_rows, 'none');
  END IF;
END $$;

UPDATE day_program_settings
   SET offerings = jsonb_set(
         offerings,
         '{day-care}',
         COALESCE(offerings -> 'day-care', '{"name": null, "description": null}'::jsonb)
           || '{"offered": true, "client_visible": true}'::jsonb
       )
 WHERE location = 'fayetteville'
   AND NOT COALESCE(offerings -> 'day-care' @> '{"offered": true, "client_visible": true}'::jsonb, false);

INSERT INTO credit_packages (key, location, mode, tier, credits, price_cents, label, is_popular, single_day, expiry_months, effective_from) VALUES
  ('daycare-10-fayetteville', 'fayetteville', 'daycare', 'regular', 10, 35000, 'Fayetteville Day Care Package', false, false, 1, '2026-01-01'),
  ('single-day-daycare-fayetteville', 'fayetteville', 'daycare', 'regular', 1, 3500, 'Single Day Care Day · Fayetteville', false, true, 1, '2026-01-01')
ON CONFLICT (key, effective_from) DO NOTHING;

UPDATE credit_packages
   SET effective_to = NULL
 WHERE id IN (SELECT DISTINCT ON (key) id
                FROM credit_packages
               WHERE key IN ('daycare-10-fayetteville', 'single-day-daycare-fayetteville')
               ORDER BY key, effective_from DESC)
   AND effective_to IS NOT NULL;
