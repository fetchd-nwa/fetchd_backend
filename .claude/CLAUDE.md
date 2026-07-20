# CLAUDE.md — Fetch'd API repo

This is the standalone backend repo for Fetch'd (NWA School for Dogs),
extracted from the client-app monorepo's `api/` folder on 2026-07-16 with full
history. Both frontends depend on it: the client mobile app
(`~/Desktop/fetchd_client_mobile_app`, RN/Expo) and the staff portal
(`~/Desktop/fetchd-staff-portal`, React/Vite).

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
- `src/contracts/wire.ts` is dependency-free by construction: the staff
  portal copies it verbatim via its `sync-contracts.mjs` (env override
  `FETCHD_API_WIRE`). Changing a wire shape means editing it HERE and
  re-running the portal's sync — never editing the portal's generated copy.
- Tests are `node:test`, sequential (`--test-concurrency=1`), against the
  isolated `db-test` container on 5433. Contract tests hard-DELETE their
  fixtures on teardown — that is why they never point at the dev DB.
- Dev/test config comes from `.env` + `.env.local` (dotenv, dev/test only —
  staging/prod use host-injected env exclusively). Never commit either.

## Cross-repo coordination

- Wire-contract changes ripple to the portal (`sync-contracts.mjs`) and to
  the mobile app's repository layer. Flag both in the handoff when you
  change `src/contracts/wire.ts`.
- The monorepo's `api/` folder was **removed 2026-07-18** — the extraction is
  complete and this repo is the only backend. (The monorepo still carries a
  stale duplicate of `.claude/backend/*`; canonical is this repo's copy.)
