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
--   1. The guard. Before this step no road wrote a Fayetteville day care lot (no row sold
--      day care there, so the desk's add answered `pool_not_bookable`). An alumni lot of that
--      pool, if a database holds one, would start paying an alumni dog's Fayetteville day the
--      moment day care opens, against 553 (b). So the step refuses while any such lot has
--      credits left, live OR expired (an expired lot's credits come back when expiry is
--      switched off or its date is moved, M4.12; M5.25 fix 1, Fable L6). It names owner and
--      lot ids and balances, never a name or an email. Regular lots of the pool are not
--      refused: they are Fayetteville day care credits, and now pay Fayetteville day care.
--   2. The offerings: only `day-care`'s two flags move at Fayetteville; its `name` and
--      `description` stay as staff left them, and Bentonville's document is not touched.
--      (`jsonb_set` with a NULL value returns NULL, so a document missing its `day-care`
--      entry gets a whole one, NOT SEEDED name and description, instead of losing itself.)
--   3. The two rows, in M4.06's form (Bentonville's `daycare-10-bentonville` and
--      `single-day-daycare-bentonville` with the campus changed).
--   4. Each new key's latest row is open: run again after the reversal, the insert above finds
--      the rows the reversal closed and does nothing, so this reopens them rather than leave
--      day care offered with nothing on sale (M5.25 fix 1, Fable L5). On a first run it
--      changes nothing.
SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
  balances text;
BEGIN
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

  IF balances IS NOT NULL THEN
    RAISE EXCEPTION 'M5.34 refused: a Fayetteville day care alumni pool holds credits, which opening day care there would let an alumni dog spend (alumni credits are Bentonville-only, 553 (b)). Credits left on its lots, live or expired: %. Move them by hand (CRED-26), then run the step again.',
      balances;
  END IF;
END $$;

UPDATE day_program_settings
   SET offerings = jsonb_set(
         offerings,
         '{day-care}',
         COALESCE(offerings -> 'day-care', '{"name": null, "description": null}'::jsonb)
           || '{"offered": true, "client_visible": true}'::jsonb
       )
 WHERE location = 'fayetteville';

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
