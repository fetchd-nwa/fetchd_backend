-- M4.06 (S23, CRED-U07, DAY-U22, DAY-U23) — the ten rows of the catalog, as reference data.
-- design §4 LG4 (design.md:6206), §2.4 step 2 (design.md:2865-2874). Rev.: yes. Empty prod: seeds; every row buyable.
--
-- Every row has its campus, program and tier and `expiry_months` 1, and the $60 day school
-- day is a catalog row now, one per campus: the day-school rate is gone (DAY-U23). The
-- explicit `effective_from` is not CURRENT_DATE because the session is UTC: a seed run
-- after 18:00 Chicago would stamp tomorrow and leave the shop empty until midnight, and
-- fixed-clock tests dated 2026-05-19 would see no row.
--
-- The same statement is in schema.sql, so a fresh load and this step agree, and the
-- rehearsal's row check holds them to it because the fingerprint reads no rows.
INSERT INTO credit_packages (key, location, mode, tier, credits, price_cents, label, is_popular, single_day, expiry_months, effective_from) VALUES
  ('school-2x-weekly-fayetteville', 'fayetteville', 'school', 'regular', 8, 45600, 'Fayetteville 2x Weekly', false, false, 1, '2026-01-01'),
  ('school-3x-weekly-fayetteville', 'fayetteville', 'school', 'regular', 12, 64800, 'Fayetteville 3x Weekly', true, false, 1, '2026-01-01'),
  ('school-alumni-10-fayetteville', 'fayetteville', 'school', 'alumni', 10, 32000, 'Alumni Fayetteville 10 Visits', false, false, 1, '2026-01-01'),
  ('single-day-school-fayetteville', 'fayetteville', 'school', 'regular', 1, 6000, 'Single Day School Day · Fayetteville', false, true, 1, '2026-01-01'),
  ('school-2x-weekly-bentonville', 'bentonville', 'school', 'regular', 8, 45600, 'Bentonville 2x Weekly', false, false, 1, '2026-01-01'),
  ('school-3x-weekly-bentonville', 'bentonville', 'school', 'regular', 12, 64800, 'Bentonville 3x Weekly', true, false, 1, '2026-01-01'),
  ('school-5x-weekly-bentonville', 'bentonville', 'school', 'regular', 20, 102000, 'Bentonville 5x Weekly', false, false, 1, '2026-01-01'),
  ('single-day-school-bentonville', 'bentonville', 'school', 'regular', 1, 6000, 'Single Day School Day · Bentonville', false, true, 1, '2026-01-01'),
  ('daycare-10-bentonville', 'bentonville', 'daycare', 'regular', 10, 35000, 'Bentonville Day Care Package', false, false, 1, '2026-01-01'),
  ('single-day-daycare-bentonville', 'bentonville', 'daycare', 'regular', 1, 3500, 'Single Day Care Day · Bentonville', false, true, 1, '2026-01-01')
ON CONFLICT (key, effective_from) DO NOTHING;
