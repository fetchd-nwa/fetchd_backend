-- The reversal of M5.25 (plan one-off O-CREDITS; design credits-joint-booking §3.3, brief
-- "The reversal"). A fixture, NEVER a step file: the rehearsal applies every `M*.sql` under
-- `migrations/`. Run it the way the runner runs a step (one transaction, the actor set), on
-- Shanthi's "no" to 553 (b) and only then.
-- Rev.: reopening the Fayetteville pack is a design decision that changes R7 at the same
-- time. An alumni dog would again hold Fayetteville day-school credits that R7 bars him from
-- spending (`alumni_no_day_school`), so this file is not to be run on its own: the design
-- is revised first. That revision must also lift the desk's alumni day-school hand-add refusal
-- (`src/routes/staffCredits.ts` `assertPoolBookable`, `pool_not_bookable`; fix 1), which now
-- refuses the hand move its guard asks for (CRED-26) back into Fayetteville day-school alumni.
--
-- It mirrors the step: the same `lock_timeout`, the same locks in the same order, and a guard
-- of two clauses, a live Bentonville day care alumni balance and a pending purchase of
-- `daycare-alumni-10-bentonville`. It does not mirror the step's live-debit clause:
-- Bentonville day care stays bookable for an alumni dog, so a credit a later cancel returns to
-- a Bentonville alumni lot stays spendable there. Then every row of the new key closes with
-- `effective_to = effective_from`, and the old key's latest row opens again. (The step closed
-- every row of the old key, so an older superseded row's window is not restored: it held no
-- live day before the step either.)
SET LOCAL lock_timeout = '5s';

LOCK TABLE credit_packages IN ACCESS EXCLUSIVE MODE;
LOCK TABLE charges, credit_ledger IN SHARE MODE;

DO $$
DECLARE
  balances text;
  pending text;
BEGIN
  SELECT string_agg(owner_id::text || ' holds ' || balance::text, ', ' ORDER BY owner_id)
    INTO balances
    FROM owner_credit_balance
   WHERE location = 'bentonville' AND mode = 'daycare' AND tier = 'alumni' AND balance > 0;

  SELECT string_agg(c.owner_id::text || ' charge ' || c.id::text || ' ' || c.status::text, ', '
                    ORDER BY c.owner_id, c.id)
    INTO pending
    FROM charges c
   WHERE c.package_id IN (SELECT id FROM credit_packages WHERE key = 'daycare-alumni-10-bentonville')
     AND (c.status = 'requires_payment' OR (c.status = 'failed' AND c.next_sweep_at IS NOT NULL));

  IF balances IS NOT NULL OR pending IS NOT NULL THEN
    RAISE EXCEPTION 'M5.25 reversal refused: the Bentonville day care alumni pool still holds or can take credits. Live balances: %. Pending purchases of daycare-alumni-10-bentonville: %. Move them by hand (CRED-26), then run it again.',
      coalesce(balances, 'none'), coalesce(pending, 'none');
  END IF;
END $$;

UPDATE credit_packages
   SET effective_to = effective_from
 WHERE key = 'daycare-alumni-10-bentonville';

UPDATE credit_packages
   SET effective_to = NULL
 WHERE id = (SELECT id FROM credit_packages
              WHERE key = 'school-alumni-10-fayetteville'
              ORDER BY effective_from DESC
              LIMIT 1);
