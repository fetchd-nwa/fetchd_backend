# What this repo needs from the monorepo

> **Extraction COMPLETE (2026-07-18).** The monorepo `api/` folder + backend
> infra (root `docker-compose.yml`, `api-ci.yml`, the `*-api` lefthook hooks)
> were removed; `fetchd_backend` builds, tests, and deploys on its own. The only
> real work left is the **prod deploy** (Railway + prod Redis) and the **staff-
> portal contract drift-guard**. Everything else below is either done or kept as
> historical record.

Companion to [RESUME-MIGRATION.md](./RESUME-MIGRATION.md). This catalogs the
dependencies `fetchd_backend` had on the monorepo
(`~/Desktop/fetchd_client_mobile_app`) — code, env/secrets, infra, tooling,
deploy wiring, and ongoing cross-repo coordination — kept as a record of the
extraction and the remaining prod-side work.

Compiled 2026-07-18 from a cross-repo audit + direct verification.

## TL;DR

**The code is fully extracted and healthy.** The `src/`, `test/`, config, and
`certs/` trees are the canonical home for the backend (the monorepo `api/`
folder was removed 2026-07-18); the booking-divert round is applied. Verified
locally on this repo:

| Check                   | Result                        |
| ----------------------- | ----------------------------- |
| `npm run typecheck`     | ✅ pass                       |
| `npm run lint`          | ✅ pass                       |
| `npm run build`         | ✅ pass                       |
| `npm test` (full suite) | ✅ **851 / 851 pass, 0 fail** |
| `npm run format:check`  | ✅ pass (prettier sweep done) |

So "does it all work?" — **yes, the backend works and runs on its own.** The
local Docker project swap is done (this repo's compose owns the containers) and
`main` is pushed with green CI. What remains is the **prod deploy wiring** on a
new Railway service and the **staff-portal contract drift-guard**. Those are the
items below.

**Nothing here requires copying more application code from the monorepo.** The
remaining needs are configuration, secrets, deploy setup, and coordination.

### Legend

- **Status** — `present` (already here) · `partial` (dev value here, prod TODO) ·
  `missing` (not here) · `coordination-only` (lives in another repo/service).
- **Severity** — 🔴 blocker · 🟠 important · 🟡 nice-to-have · ⚪ informational.
- A blocker is scoped: **[local]** blocks `npm test`/dev on this machine;
  **[prod]** blocks a live deployment but not local dev.

---

## 0. Migration checklist — ✅ COMPLETE (prod deploy + portal drift-guard remain)

Carried forward from `RESUME-MIGRATION.md`, corrected against what's verified:

1. ✅ **[local] Docker project swap — DONE.** The `fetchd-db` / `fetchd-db-test`
   / `fetchd-redis` containers are now owned by **this repo's** compose project;
   the old monorepo compose was torn down and this repo stood up its own. Named
   volumes (`fetchd-pg-data`, `fetchd-pg-test-data`) are global, so **no data
   was lost.** Full suite runs 851/851 here.
2. ✅ **Prettier sweep — DONE.** The offenders were formatted; CI's `check` job
   (`format:check` over the whole repo) is green.
3. ✅ **Push `main` — DONE.** `main` is on `github.com/fetchd-nwa/fetchd_backend`
   with green CI.
4. 🟡 **Portal drift-guard handoff** (§F.1 — the guard currently _fails_).
5. ✅ **Monorepo cleanup — DONE** (§H — `backend-extract` branch deleted, monorepo
   `api/` folder removed).

Everything below is the detailed catalog behind these.

---

## A. Application code & config — ✅ already carried over

All present and verified byte-identical against the monorepo `api/` folder at
extraction (`diff -rq`; that folder has since been removed).
**No action needed** — listed so the parity is on record.

| Item                                                                                                                                        | Status               | Note                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/` (auth, contracts, db, lib, routes, webhooks, workers, index/server/env/redis)                                                        | present              | byte-identical; no imports escape the old `api/` root                                                                                                                                                     |
| `test/` (unit + contract + `snapshots/*.json`)                                                                                              | present              | passes 851/851 here                                                                                                                                                                       |
| Build/lint config (`Dockerfile`, `railway.json`, `drizzle.config.ts`, `eslint.config.js`, `tsconfig*.json`, `.prettierrc`, `.dockerignore`) | present              | `tsconfig.build.json` self-contained, no monorepo parent                                                                                                                                                  |
| `package.json` / `package-lock.json`                                                                                                        | present              | **correctly rewired**: `db:*` scripts dropped the monorepo's `-f ../docker-compose.yml` because compose now lives in this repo root (commit `6577dcf`). No `workspace:` deps → `npm ci` is self-contained |
| `certs/supabase-ca.crt`                                                                                                                     | present              | not gitignored, so the subtree split preserved it; `DATABASE_SSL_CA` points here                                                                                                                          |
| `docker-compose.yml`                                                                                                                        | present              | **new in this repo** — a faithful extract of the backend services (db/db-test/redis) from the monorepo _root_ compose                                                                                     |
| `.env` / `.env.local` (dev/test)                                                                                                            | present              | gitignored → **manually copied** during extraction (a subtree split does not carry them)                                                                                                                  |
| `src/db/schema/meta/` + `*.sql`                                                                                                             | intentionally absent | gitignored in both repos (Drizzle is query-only; regenerated by `npm run db:introspect`). Committed typed surface (`schema.ts`, `relations.ts`) is present                                                |
| stray `api/api/` folder in monorepo                                                                                                         | n/a                  | was empty untracked cruft — correctly not carried; removed with the monorepo `api/` folder                                                                                                                |

---

## B. Local dev / test environment

| #   | Item                                                        | Sev        | Status                  | What's needed                                                                                                                                                                                                                                    |
| --- | ----------------------------------------------------------- | ---------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| B.1 | **Docker container/volume ownership**                       | ⚪         | resolved                | The `fetchd-db` / `fetchd-db-test` / `fetchd-redis` containers are now owned by **this repo's** compose project (see checklist #1). Full suite runs 851/851 here                                                                                 |
| B.2 | Dev DB seed (`npm run db:dev:seed` → `scripts/seed-dev.ts`) | 🟡         | present                 | Runs, but carries two hidden couplings (see §G.4): a hardcoded Shanthi staff-id that must match the portal's default principal, and `captureRealStripeRows` logic tied to the shared Stripe **test** account. Re-verify after the container swap |
| B.3 | Redis (local)                                               | ⚪         | present                 | `redis:7-alpine` in this repo's compose; required at boot even though the read surface doesn't use it yet                                                                                                                                        |

---

## C. Environment & secrets contract

**The authoritative list is [`.env.example`](../.env.example)** (every key with
provisioning notes) and `.env.local.example`. This section summarizes; it lists
**names only — no secret values live in this document.**

Real **dev/test** values are already present in the gitignored `.env` /
`.env.local` (copied during extraction). What's outstanding is the **prod
contract**: the same ~18 variables must be re-entered as **host-injected
secrets** on the new deploy target (§E) — staging/prod never read `.env`.

| Variable(s)                                                              | Purpose                                                                                            | Dev/test                              | Prod action                                             |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------- |
| `DATABASE_URL`                                                           | Supabase Postgres conn string                                                                      | ✅ staging value in `.env`            | 🟠 inject prod value                                    |
| `DATABASE_SSL_CA`                                                        | path to `certs/supabase-ca.crt` (verified TLS)                                                     | ✅ present                            | ⚪ ships in image                                       |
| `REDIS_URL`                                                              | cache / rate-limit / health probe                                                                  | ✅ local docker                       | 🔴 **no prod Redis exists** (§D)                        |
| `SUPABASE_JWKS_URL`, `SUPABASE_JWT_AUD`, `SUPABASE_JWT_ISS`              | JWT verification (JWKS auth)                                                                       | ✅ present                            | 🟠 inject                                               |
| `SUPABASE_AUTH_WEBHOOK_SECRET`                                           | verifies user-created provisioning webhook                                                         | ⚠️ placeholder                        | 🟠 real secret + Supabase dashboard hook → deployed URL |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`                             | payments + signed webhook                                                                          | ✅ **test-mode** keys in `.env.local` | 🟠 live keys + Stripe dashboard webhook → deployed URL  |
| `SCHEDULER_WEBHOOK_SECRET`                                               | bearer for `/workers/tick` cron                                                                    | ✅ present                            | 🟡 real secret + pg_cron SQL (§D)                       |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | Cloudflare R2 private media                                                                        | ✅ **dev bucket** creds in `.env`     | 🟠 prod bucket + prod creds                             |
| `NODE_ENV`, `PORT`, `LOG_LEVEL`, `BYPASS_HEADER_ENABLED`                 | runtime; `BYPASS_HEADER_ENABLED` gates the dev auth bypass (forced off when `NODE_ENV=production`) | ✅ present                            | ⚪ set per environment                                  |

> ⚠️ **Secret hygiene:** the gitignored `.env`/`.env.local` contain a **real
> staging Supabase password, real R2 credentials, and real Stripe test keys**
> that originated in the monorepo. Treat them as live secrets — do not commit
> them, and rotate anything that has been shared in plaintext.

---

## D. External services (prod provisioning)

Each has a working **dev/test** binding already; the gap is **production**.

| Service                   | Sev       | Status                   | Prod need                                                                                                                                                                                                                   |
| ------------------------- | --------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Supabase Postgres**     | 🟠        | partial                  | Prod DB + `DATABASE_URL`; load `schema.sql` (56 tables) into it                                                                                                                                                             |
| **Supabase Auth (JWKS)**  | 🟠        | partial                  | Prod JWKS URL / aud / iss injected                                                                                                                                                                                          |
| **Supabase Auth webhook** | 🟠        | partial                  | Dashboard webhook → `<api-url>/webhooks/...` + `SUPABASE_AUTH_WEBHOOK_SECRET`. Without it, new users `403 not_provisioned`                                                                                                  |
| **Stripe**                | 🟠        | partial                  | Live keys + dashboard webhook → `<api-url>/webhooks/stripe`. Note the seed's shared-test-account coupling (§G.4)                                                                                                            |
| **Cloudflare R2**         | 🟠        | partial                  | Prod bucket (e.g. `nwa-media`) + prod creds. `npm run smoke:r2` does a live round-trip check                                                                                                                                |
| **Production Redis**      | 🔴 [prod] | **missing**              | No prod Redis config exists yet — this is the one genuinely-missing piece for prod. Railway must provision Redis (or Upstash) and inject `REDIS_URL`, or `/health` fails in prod                                            |
| **Scheduler cron**        | 🟡        | partial                  | Supabase `pg_cron` + `pg_net` running `net.http_post` → `<api-url>/workers/tick` with the bearer secret. SQL is docs-only in `IMPLEMENTATION.md` (Day-16), applied by hand in Supabase — deliberately _not_ in `schema.sql` |
| **Expo Push**             | ⚪        | present                  | None — public endpoint, per-device token auth. Nothing to configure                                                                                                                                                         |

---

## E. Deploy (Railway)

The build recipe travels with the repo (`railway.json` + `Dockerfile` are
identical). The outstanding work is **platform-side wiring**, not files.

| #   | Item                                                                                 | Sev       | Status                 |
| --- | ------------------------------------------------------------------------------------ | --------- | ---------------------- |
| E.1 | Push `main` to `github.com/fetchd-nwa/fetchd_backend`                                | ✅        | done (green CI)        |
| E.2 | Create a Railway **service** linked to the new GitHub repo                           | 🔴 [prod] | coordination-only      |
| E.3 | Configure Railway's **host-injected env store** with the §C prod contract (~18 vars) | 🔴 [prod] | coordination-only      |
| E.4 | Provision prod **Redis** (see §D)                                                    | 🔴 [prod] | missing                |
| E.5 | GitHub **branch protection** requiring CI on the new remote                          | 🟡        | coordination-only      |

**Deploy contract (for reference):** `railway.json` → `DOCKERFILE` builder,
`startCommand: node dist/index.js`, healthcheck `/health` (60s), restart
`ON_FAILURE` ×3. `Dockerfile` is a two-stage `node:22-bookworm-slim` build that
`COPY`s `certs/` for Supabase TLS.

---

## F. CI & git-hook tooling

| #   | Item                                         | Sev | Status      | Detail                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | -------------------------------------------- | --- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F.1 | **CI workflow** (`.github/workflows/ci.yml`) | ⚪  | present     | Faithful port of the (now-removed) monorepo `api-ci.yml`: `schema-load` (loads `schema.sql`, asserts **56 tables** + DROP-SCHEMA-commented) and `check` (typecheck/lint/format). **Neither runs `npm test`** — same as the monorepo, by design (tests run locally against the docker DB). Pins **node 20** while the Docker runtime uses **node 22** (`engines: >=20`) — pre-existing, harmless, worth aligning someday |
| F.2 | **lefthook pre-commit gate**                 | 🟠  | **missing** | The monorepo's `lefthook.yml` ran `typecheck-api` / `lint-api` / `format-api` on staged backend files. **This repo has no `lefthook.yml`** — nothing enforces format/lint pre-commit locally, which is how the 10 unformatted files slipped in. Add a repo-local lefthook (or a pre-commit hook) running the same three checks                                                                              |
| F.3 | Stripe agent **skills** + `skills-lock.json` | 🟡  | missing     | Monorepo-root Claude skills used during backend work; not carried. Nice-to-have for workflow parity                                                                                                                                                                                                                                                                                                         |

---

## G. Cross-repo coordination (dependencies that flow **out** of this repo)

These are the obligations the split created. The backend is authoritative; the
unmet work mostly lives in the **consumers**.

### G.1 — Staff portal contract drift 🟠 **FAILING NOW**

The portal generates `src/api/contracts.ts` verbatim from this repo's
[`src/contracts/wire.ts`](../src/contracts/wire.ts) via its
`scripts/sync-contracts.mjs`. Running the guard today
(`cd ../fetchd-staff-portal && node scripts/sync-contracts.mjs --check`)
**FAILS** — the portal's committed copy is ~51 lines behind, missing every July
wire addition (`lesson_setting`/`LessonSetting`, the day-program divert fields,
`DivertedBookingWire`, `BookingDivertPreviewWire`, …).
**Fix (portal-side):** run `npm run sync:contracts` in the portal and commit.
This is the concrete failure behind RESUME step 7.

### G.2 — Portal sync path repoint ⚪ verified

The portal's default source path was repointed to
`../fetchd_backend/src/contracts/wire.ts` (portal commit `05f40df`). Verified:
the guard resolves the path to this repo and reports _stale_ (not _skipped_), so
the **path is correct** — the staleness in G.1 is the only remaining issue.

### G.3 — Portal has no CI drift enforcement 🟠

The guard only runs via the portal's local `pretest` hook — the portal has **no
`.github/workflows/`**, so nothing catches stale contracts automatically, and
the `FETCHD_REQUIRE_WIRE=1` hardening never runs. Portal-side task: add a
workflow that checks out both repos (or sets `FETCHD_API_WIRE`) and runs the
guard. Also note the **sibling-path coupling**: the default assumes
`fetchd-staff-portal` and `fetchd_backend` are siblings under `~/Desktop`;
elsewhere, set `FETCHD_API_WIRE` to this repo's `wire.ts`.

### G.4 — Mobile app 🟠 (no file share, manual coordination)

The mobile app (`~/Desktop/fetchd_client_mobile_app/mobile`) consumes the
backend purely over **HTTP** — there is no `wire.ts` import. Stable coupling
points to preserve: base URL (`apiBaseUrl`; dev defaults to
`http://localhost:3000`, while staging/prod have no default and **throw at
startup** if `EXPO_PUBLIC_API_BASE_URL` is unset — fail-loud, HTTP-only),
Supabase Bearer JWT + `X-Dev-Principal` dev bypass, the `Idempotency-Key`
requirement on all mutations, and the `{ error: { code, message, details? } }`
envelope. Mobile hand-maintains camelCase mirrors of the wire shapes in
`mobile/src/types/*` with no drift guard — **every `wire.ts` change must be
hand-ported.** Known drift today: mobile has _not_ yet consumed the newest
`POST /bookings/preview` → `BookingDivertPreviewWire`. (This repo's `CLAUDE.md`
already mandates flagging mobile in the handoff on any `wire.ts` change.)

Also, the **seed** (`scripts/seed-dev.ts`) hardcodes the Shanthi staff id
`00000000-…-a1` to match the portal's default principal, and preserves the
shared Stripe **test** customer/card across re-seeds — provisioning a _separate_
Stripe account for this repo would break that preservation. Keep them in
lockstep.

---

## H. Docs & monorepo-side cleanup

| #   | Item                                   | Sev | Status            | Detail                                                                                                                                                                                                                                                                                                                     |
| --- | -------------------------------------- | --- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H.1 | Backend **RUNBOOK**                    | 🟡  | missing           | The only runbook is the monorepo's mobile-centric `RUNBOOK.md`, whose backend entries name the **wrong secret stores** (references EAS / "Supabase, Vercel" — should be **Railway** for this repo). Author a backend runbook here (Railway redeploy, prod schema-load, secret rotation)                                    |
| H.2 | `README.md` "Deploy" section           | ⚪  | present-but-thin  | Points back at the monorepo's `BUILDING.md` (mobile ship steps). Fold the essentials into the new runbook                                                                                                                                                                                                                  |
| H.3 | Backend spec docs (`.claude/backend/`) | ⚪  | present           | Copied at extraction; **canonical** source of truth for schema/wire/architecture. Note: the monorepo still carries a **stale duplicate** `.claude/backend/` copy                                                                                                                                                            |
| H.4 | Monorepo post-extraction hygiene       | ✅  | done              | `backend-extract` temp branch deleted (history lives here); monorepo `api/` folder + backend infra removed. Remaining monorepo-side note: its `.claude/backend/` copy is now a stale duplicate of this repo's canonical set                                                                                                  |

---

## Appendix: minimal path to each goal

- **Run the test suite cleanly on this machine** → done; this repo's compose owns
  the containers and the full suite passes 851/851.
- **Get CI green on push** → done; the prettier sweep landed and `main` is pushed
  green.
- **Deploy to production** → §E (Railway service + env store) + §D (prod Redis is
  the one genuinely-missing piece) + load `schema.sql` into the prod DB.
- **Keep the frontends working** → §G.1 (portal: run `sync:contracts` + commit)
  and remember §G.4 for mobile on every `wire.ts` change.
