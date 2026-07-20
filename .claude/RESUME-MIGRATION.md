# Backend extraction — COMPLETE 2026-07-18

## Done

- `api/` history extracted (git subtree split, 81 commits) → this repo's `main`,
  plus 2 scaffolding commits (`6577dcf` rewiring, `4f0c27e` docs/README/CLAUDE.md).
- Gitignored `.env` + `.env.local` copied over; `.claude/backend/` docs copied at HEAD.
- Monorepo WIP diff applied here as UNCOMMITTED working-tree changes (5 files:
  src/db/locks.ts, src/routes/bookings.ts, test/contracts/booking-approval-divert.test.ts,
  .claude/backend/schema.sql, .claude/backend/DATA-CONTRACT.md) — parity with monorepo.
- `npm ci` clean; **typecheck PASS, lint PASS, build PASS**.
- Staff portal: sync-contracts default path fixed → this repo (commit `05f40df` there).

## Resume order — COMPLETE (finished 2026-07-18)

1. DONE — `npm run format:check` passing; CI green.
2. DONE — the earlier "845 tests, 825 pass, 20 FAIL" baseline was **redis-timing env
   noise**, not real failures caused by the extraction. A clean run is **851/851**.
   That old 845/825/20 number is superseded — the standing test count is 851/851 and
   meets the "all tests pass" bar.
3. DONE — docker is now owned by the `fetchd_backend` compose project (named volumes
   fetchd-pg-data / fetchd-pg-test-data carried over all data).
4. DONE — `npm test` here is **851/851** (db-test auto-spins via pretest).
5. DONE — `npm run dev` boots and serves :3000; GET /health smoke passed.
6. DONE — `main` pushed to https://github.com/fetchd-nwa/fetchd_backend (green CI).
7. OPEN — portal contract drift-guard: `cd ../fetchd-staff-portal && node scripts/sync-contracts.mjs --check`
   (fix committed but not yet verified against this repo).
8. DONE — temp branch `backend-extract` deleted; monorepo `api/` (plus root
   docker-compose.yml, api-ci.yml, and the `*-api` lefthook hooks) **REMOVED 2026-07-18**
   — the monorepo now owns only `mobile/` + `.claude/`, and the extraction is complete.
   Note: the monorepo still carries a stale DUPLICATE `.claude/backend/` copy —
   canonical is this repo's `.claude/backend/`.

## Remaining real work

Not part of the extraction (which is done) — the only genuinely-open items are:

- **PROD deploy** — Railway + a prod Redis (the one piece still genuinely missing;
  deploy target is Railway, not Vercel/EAS).
- **Portal contract drift-guard** verification (item 7 above).
