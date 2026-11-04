# Fetch'd API

The backend for Fetch'd (NWA School for Dogs): a Fastify + Drizzle + Postgres
API that both frontends depend on — the client mobile app
(`fetchd_client_mobile_app`) and the staff portal (`fetchd-staff-portal`).

Extracted from the `api/` folder of the client-app monorepo on 2026-07-16 with
full git history. The backend spec lives in [.claude/backend/](.claude/backend/)
— `schema.sql` is the canonical DDL, `DATA-CONTRACT.md` the wire contract,
`BACKEND-ARCHITECTURE.md` the locked decisions.

## Quickstart

```sh
docker compose up -d          # dev Postgres (5432) + Redis (6379)
cp .env.local.example .env.local   # per-machine overrides → local docker pg
npm ci
npm run dev                   # Fastify on :3000, tsx watch
```

`.env` holds canonical dev config; `.env.local` layers per-machine overrides
on top (loaded first, wins per-key). Both are gitignored — copy from the
`.example` files.

## Tests

```sh
npm test    # auto-spins db-test (5433) via pretest, runs node:test suite
```

Tests run against an isolated `db-test` container (port 5433, own volume) so
fixture teardown never touches dev data. `npm run db:test:nuke` resets it.

## Database

- `schema.sql` is canonical — Drizzle is query-only. The typed surface at
  `src/db/schema/` is hand-edited to match. Do not run `npm run db:introspect`:
  it fails on this tree after overwriting `src/db/schema/`, and it reads `.env`,
  not `.env.local`.
- Schema loads once per empty volume via docker-entrypoint-initdb.d. After
  editing `schema.sql`, re-init the test volume:
  `npm run db:test:nuke && npm run db:test:up`. Never `docker compose down -v`:
  it also deletes the dev database volume.
- `npm run db:dev:seed` seeds dev data (preserves real Stripe rows).

## Deploy

Railway, via the multi-stage `Dockerfile` (`railway.json` pins the builder
and `/health` healthcheck). See the monorepo's `BUILDING.md` for the mobile
ship checklist — this repo only ships the API.
