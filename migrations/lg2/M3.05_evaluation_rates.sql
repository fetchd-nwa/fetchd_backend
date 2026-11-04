-- M3.05 (S17, DAY-U23, EVAL-U10) — the evaluation's price: 0 at each campus.
-- design §4 LG2 (design.md:6180, "Runs in LG2", before S15's steps); DECISIONS 118(c).
-- Rev.: yes. Empty prod: without it `POST /evaluations` 404s.
--
-- These two rows are the evaluation's one price store: `eval.price_cents` is the
-- registry's name for them, `evaluation_settings` carries no price (M1.09), and
-- `GET /rates` serves them. `service_rates` has no unique key but `id`, so the
-- ids are fixed, the same here and in schema.sql, and the step is safe to run
-- again. The date is the seed's placeholder. No day-school row: the $60 is the two
-- single-day catalog rows (M4.06; R1).
--
-- The fingerprint reads no seed rows, so `test/contracts/lg2-p12-steps.test.ts` is
-- the proof of these two.
--
-- No table is created, so the step needs no per-table REVOKE, and the group's
-- closing REVOKE (DECISIONS 86, 118(g)) has nothing of this step's to repeat.
INSERT INTO service_rates (id, category, location, amount_cents, unit, effective_from, effective_to, note) VALUES
  ('e7a10000-0000-4000-8000-000000000001', 'evaluation', 'fayetteville', 0, 'per-session', '2025-01-01', NULL, 'Evaluation rate, Fayetteville: free (M3.05 seed)'),
  ('e7a10000-0000-4000-8000-000000000002', 'evaluation', 'bentonville', 0, 'per-session', '2025-01-01', NULL, 'Evaluation rate, Bentonville: free (M3.05 seed)')
ON CONFLICT (id) DO NOTHING;
