# Backend extraction — paused mid-migration 2026-07-16 (credits ran out)

## Done

- `api/` history extracted (git subtree split, 81 commits) → this repo's `main`,
  plus 2 scaffolding commits (`6577dcf` rewiring, `4f0c27e` docs/README/CLAUDE.md).
- Gitignored `.env` + `.env.local` copied over; `.claude/backend/` docs copied at HEAD.
- Monorepo WIP diff applied here as UNCOMMITTED working-tree changes (5 files:
  src/db/locks.ts, src/routes/bookings.ts, test/contracts/booking-approval-divert.test.ts,
  .claude/backend/schema.sql, .claude/backend/DATA-CONTRACT.md) — parity with monorepo.
- `npm ci` clean; **typecheck PASS, lint PASS, build PASS**.
- Staff portal: sync-contracts default path fixed → this repo (commit `05f40df` there).

## Not done (resume order)

1. `npm run format:check` FAILED — 9 files (incl. the new README.md/CLAUDE.md/ci.yml
   and .vscode/settings.json). Run `npx prettier --write` on the offenders, or extend
   .prettierignore for .vscode/; amend into `6577dcf`/`4f0c27e` as appropriate.
2. **Baseline monorepo run FINISHED: 845 tests, 825 pass, 20 FAIL** — with the
   WIP working tree, BEFORE any migration. These 20 are pre-existing (WIP
   booking-divert round in flight), NOT caused by the extraction. Failure names
   unknown — the run was piped through `tail -30` so only the summary survived
   (and the pipe masked the non-zero exit). On resume: re-run `npm test` in
   monorepo api/ WITHOUT a pipe, capture the `not ok` list, fix or attribute all
   20, and only then compare against this repo's run. "All tests pass" is the
   user's explicit bar — 825/845 does not meet it.
3. Docker swap: `docker compose down` in monorepo, then `docker compose up -d` HERE
   (pinned container names conflict across compose projects; named volumes
   fetchd-pg-data / fetchd-pg-test-data preserve all data automatically).
4. `npm test` here (auto-spins db-test via pretest). Expect ~844 pass.
5. Boot `npm run dev` + smoke GET /health.
6. Push `main` → https://github.com/fetchd-nwa/fetchd_backend (remote already set,
   repo empty). Watch the ci workflow run.
7. Verify portal drift-guard: `cd ../fetchd-staff-portal && node scripts/sync-contracts.mjs --check`
   (fix committed but NOT yet verified against this repo).
8. Monorepo cleanup: delete temp branch `backend-extract`; docs sweep
   (CLAUDE.md file-locations, ARCHITECTURE.md, HANDOFF.md) marking monorepo `api/`
   reference-only; memory entry for the split. Do NOT delete monorepo api/ — WIP
   round in flight there.
