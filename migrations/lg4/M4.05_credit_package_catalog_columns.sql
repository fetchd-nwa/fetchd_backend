-- M4.05 (S23, CRED-U04, CRED-U08) — a catalog row carries its own tier, expiry window and single-day flag.
-- design §4 LG4 (design.md:6205), §2.4 step 2 (design.md:2856-2884). Rev.: data. Empty prod: holds no packages.
--
-- `mode` and `location` stay NOT NULL, and no visibility flag lands: every seeded row is
-- complete and buyable. `expiry_months` is `cred.package_expiry_months`, versioned by
-- `effective_from` like the price, and no other table holds it. `created_at` is what the
-- preflight's price clause compares a price-changing row's `effective_from` with (§1.3).
--
-- A key names one row's campus from here, so the UNIQUE loses `location`. Two campus copies
-- of one key would fail it on any populated database, whatever their windows, so every
-- copy but one is re-keyed first. The ledger's FK is on `id`, so no reference moves.
-- Closing a copy by `effective_to` cannot satisfy the new UNIQUE.
--
-- The audit trigger lands last, so the re-key does not fire it: `expiry_months` is a
-- money-class edit, and a same-day correction overwrites the only copy of the old value
-- (DECISIONS 177(d)).
ALTER TABLE credit_packages
  ADD COLUMN tier text NOT NULL DEFAULT 'regular' CHECK (tier IN ('regular', 'alumni')),
  ADD COLUMN expiry_months integer NOT NULL DEFAULT 1 CHECK (expiry_months > 0),
  ADD COLUMN single_day boolean NOT NULL DEFAULT false,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();

UPDATE credit_packages p
   SET key = p.key || '-' || p.location
 WHERE p.location > (SELECT min(o.location) FROM credit_packages o WHERE o.key = p.key);

ALTER TABLE credit_packages DROP CONSTRAINT credit_packages_key_location_effective_from_key;
ALTER TABLE credit_packages ADD CONSTRAINT credit_packages_key_effective_from_key UNIQUE (key, effective_from);

CREATE TRIGGER credit_packages_audit AFTER UPDATE OR DELETE ON credit_packages
  FOR EACH ROW EXECUTE FUNCTION audit_capture();

COMMENT ON TABLE credit_packages IS 'Effective-dated catalog of purchasable credit packages: each row names one campus, program and tier, and a key names one campus. Repricing or retiring closes effective_to; an expiry_months edit opens a new row, or corrects a row opened that same Chicago day in place. Never edit a price.';
