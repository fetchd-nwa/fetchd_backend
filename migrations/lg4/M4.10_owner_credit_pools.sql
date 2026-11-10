-- M4.10 (S25, CRED-U10, CRED-U04) — credits belong to the owner, one pool per campus, program and tier.
-- design §4 LG4 (design.md:6210), §2.4 step 4 (design.md:2931-2940). Rev.: data. Empty prod: 0 rows.
--
-- `owner_id` is backfilled from the dog, so a ledger row on a staff-owned dog fails the
-- SET NOT NULL here, loudly: it has no owner to give it, and none exist. `dog_id` stays on
-- a debit as the dog served, and goes nullable because a grant names no dog.
--
-- The composite FK is what makes a debit unable to spend another pool: a row names its lot
-- together with that lot's owner, campus, program and tier. MATCH SIMPLE leaves a grant,
-- with no `lot_id`, untouched.
--
-- The purchase's frozen terms land with it. `charges.package_id` and `credits_count` are
-- what every settler reads to grant exactly what was paid for, never the metadata.
-- `invoices.package_id` and `location` are stamped by the settle from the first pack sold,
-- so M6.03's CHECK validates against real rows.
LOCK TABLE credit_ledger IN ACCESS EXCLUSIVE MODE;

ALTER TABLE credit_ledger ADD COLUMN owner_id uuid REFERENCES owners(id) ON DELETE RESTRICT;

UPDATE credit_ledger cl SET owner_id = d.owner_id FROM dogs d WHERE d.id = cl.dog_id;

ALTER TABLE credit_ledger
  ALTER COLUMN owner_id SET NOT NULL,
  ALTER COLUMN dog_id DROP NOT NULL,
  ADD COLUMN tier text NOT NULL DEFAULT 'regular' CHECK (tier IN ('regular', 'alumni')),
  ADD CONSTRAINT credit_ledger_lot_pool_key UNIQUE (id, owner_id, location, mode, tier),
  ADD CONSTRAINT credit_ledger_lot_pool_fkey FOREIGN KEY (lot_id, owner_id, location, mode, tier)
    REFERENCES credit_ledger (id, owner_id, location, mode, tier);

DROP INDEX credit_ledger_dog_mode_idx;
DROP INDEX credit_ledger_lot_fifo_idx;
CREATE INDEX credit_ledger_pool_idx ON credit_ledger (owner_id, location, mode, tier);
CREATE INDEX credit_ledger_lot_fifo_idx
  ON credit_ledger (owner_id, location, mode, tier, expires_at)
  WHERE delta > 0 AND lot_id IS NULL;

DROP VIEW dog_credit_balance;
CREATE VIEW owner_credit_balance AS
  SELECT cl.owner_id, cl.location, cl.mode, cl.tier, COALESCE(SUM(cl.delta), 0) AS balance
  FROM credit_ledger cl
  LEFT JOIN credit_ledger lot ON lot.id = cl.lot_id
  WHERE CASE
          WHEN cl.lot_id IS NOT NULL THEN lot_is_live(lot.expires_at)
          WHEN cl.delta > 0          THEN lot_is_live(cl.expires_at)
          ELSE true
        END
  GROUP BY cl.owner_id, cl.location, cl.mode, cl.tier;
REVOKE ALL ON owner_credit_balance FROM anon, authenticated;

ALTER TABLE invoices
  ADD COLUMN package_id uuid REFERENCES credit_packages(id),
  ADD COLUMN location text REFERENCES locations(slug);

ALTER TABLE charges
  ADD COLUMN package_id uuid REFERENCES credit_packages(id),
  ADD COLUMN credits_count integer;

COMMENT ON TABLE credit_ledger IS 'Append-only credit transactions, the owner''s: one pool per (owner, location, mode, tier), modeled as expiring LOTS. A source row (delta>0, lot_id NULL) carries expires_at; debits and returns name their lot, and dog_id on a debit is the dog served. Balance counts only live lots. Corrections are reversing entries.';
COMMENT ON VIEW owner_credit_balance IS 'Derived per-(owner,location,mode,tier) credit balance over the append-only ledger; counts only LIVE lots (lot_is_live, M4.08).';
