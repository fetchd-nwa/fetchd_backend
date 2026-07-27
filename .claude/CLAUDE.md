# CLAUDE.md — Fetch'd API repo

This is the standalone backend repo for Fetch'd (NWA School for Dogs),
extracted from the client-app monorepo's `api/` folder on 2026-07-16 with full
history. Both frontends depend on it: the client mobile app (the sibling
`fetchd_client_mobile_app` repo, RN/Expo) and the staff portal (the sibling
`fetchd_staff_portal_desktop` repo, React 19/Vite; branch of record `scaffold/phase-1`). All three repos sit side-by-side
under one umbrella folder; folder names are load-bearing (the clients' sync
scripts resolve `src/contracts/wire.ts` sibling-relative).

The monorepo's `.claude/CLAUDE.md` identity and engineering principles apply
here unchanged — senior engineer, honest names, functions do one thing,
errors are values, YAGNI, surgical edits, "I would hire the person who wrote
this" bar. Read that file when in doubt; this file covers only what is
backend-specific.

## Reading order

1. This file.
2. `.claude/backend/BACKEND-ARCHITECTURE.md` — locked Day-0 decisions
   (Drizzle query-only, JWKS auth, Fastify+Zod, raw-SQL migrations,
   Supabase-hosted Postgres in prod).
3. `.claude/backend/DATA-CONTRACT.md` — the wire contract, kept in lockstep
   with `src/contracts/wire.ts`.
4. `.claude/backend/schema.sql` — the canonical DDL. Drizzle never owns
   migrations; `src/db/schema/` is an introspected mirror (machine-authored,
   lint-ignored, committed).

## Locked invariants

- `schema.sql` is the source of truth for DDL. Edit it, then re-init the
  docker volume (`docker compose down -v`) or apply by hand. `npm run
  db:introspect` refreshes the typed query surface afterward.
- The DEV-RESET `DROP SCHEMA` preamble in `schema.sql` stays **commented** in
  git — CI asserts this before every schema load.
- `src/contracts/wire.ts` is dependency-free by construction (it is copied
  verbatim into client bundles). Today only the mobile app generates from it;
  the canonical portal (`fetchd_staff_portal_desktop`) has no
  `sync-contracts.mjs` yet — when built it copies wire.ts verbatim (env override
  `FETCHD_API_WIRE`). Changing a wire shape means editing it HERE and
  re-running each client's sync — never editing a generated copy.
- Tests are `node:test`, sequential (`--test-concurrency=1`), against the
  isolated `db-test` container on 5433. Contract tests hard-DELETE their
  fixtures on teardown — that is why they never point at the dev DB.
- Dev/test config comes from `.env` + `.env.local` (dotenv, dev/test only —
  staging/prod use host-injected env exclusively). Never commit either.

## Cross-repo coordination (orchestrator model, adopted 2026-07-20)

- `src/contracts/wire.ts` is THE versioned API contract for all three repos.
  Every edit to it bumps `WIRE_CONTRACT_VERSION` (semver: major =
  remove/rename/retype, minor = additive, patch = doc-only), adds an entry to
  `src/contracts/CHANGELOG.md`, and requires resyncing every generated client — today the mobile app via `npm run sync:contracts` (the portal joins once its sync exists — to-build), in their own repos' commits — plus a row in the orchestrator's `STATUS.md`.
- The operating manual is the sibling `fetchd_client_mobile_app` repo's
  `.claude/ORCHESTRATOR.md`; the shared alignment log is `.claude/STATUS.md`
  next to it. Read STATUS.md at session start when doing contract-touching
  work; update it at session end.
- Wire-contract changes ripple to the mobile app's repository layer today, and
  to the portal once its `sync-contracts.mjs` exists (to-build). Flag both in
  the handoff when you change `src/contracts/wire.ts`.
- The monorepo's `api/` folder was **removed 2026-07-18** — the extraction is
  complete and this repo is the only backend. (The monorepo still carries a
  stale duplicate of `.claude/backend/*`; canonical is this repo's copy.)
