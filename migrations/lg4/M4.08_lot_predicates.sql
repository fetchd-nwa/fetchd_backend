-- M4.08 (S25, CRED-U03, CRED-U12) — one liveness predicate, and one predicate for a date.
-- design §4 LG4 (design.md:6208), §2.4 step 3 (design.md:2896-2912). Rev.: yes. Empty prod: nothing to backfill.
--
-- `lot_is_live` answers "does this lot count now": the balance, the staff lots read, and a
-- return. `lot_pays_date` answers "can this lot pay that day": the picker and the shortfall
-- count, and nothing else decides it. A lot pays a date while it expires after that date's
-- Chicago midnight, so the expiry day itself still counts. Switching expiry off makes every
-- stamped lot pay every date. Neither is inlined, because each body holds a sub-select.
--
-- A NULL `expires_at` reads as not live while expiry is on, which is what retires the
-- never-expiring class; M4.09 then forbids writing one.
--
-- New functions are EXECUTE-able by PUBLIC unless they say otherwise. The view that calls
-- them runs as its owner, so no API role needs them.
CREATE FUNCTION lot_is_live(expires_at timestamptz) RETURNS boolean
  LANGUAGE sql STABLE
AS $$
  SELECT (SELECT NOT expiry_enforced_enabled FROM credit_settings) OR expires_at > now()
$$;

CREATE FUNCTION lot_pays_date(expires_at timestamptz, d date) RETURNS boolean
  LANGUAGE sql STABLE
AS $$
  SELECT (SELECT NOT expiry_enforced_enabled
                 OR (expires_at > now()
                     AND (booking_outlives_lot_expiry_enabled
                          OR expires_at > (d::timestamp AT TIME ZONE 'America/Chicago')))
            FROM credit_settings)
$$;

REVOKE ALL ON FUNCTION lot_is_live(timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION lot_pays_date(timestamptz, date) FROM PUBLIC, anon, authenticated;

-- M4.10 replaces this with the owner view, on the same predicate.
CREATE OR REPLACE VIEW dog_credit_balance AS
  SELECT cl.dog_id, cl.mode, cl.location, COALESCE(SUM(cl.delta), 0) AS balance
  FROM credit_ledger cl
  LEFT JOIN credit_ledger lot ON lot.id = cl.lot_id
  WHERE CASE
          WHEN cl.lot_id IS NOT NULL THEN lot_is_live(lot.expires_at)
          WHEN cl.delta > 0          THEN lot_is_live(cl.expires_at)
          ELSE true
        END
  GROUP BY cl.dog_id, cl.mode, cl.location;
