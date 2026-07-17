# IMPLEMENTATION.md — Phase 3 Node API, day by day

The execution plan for BACKEND-ARCHITECTURE.md §6 step 4 ("stand up Node API +
Postgres + endpoints"). One reviewable day per thread. The contract
(`schema.sql` + `DATA-CONTRACT.md`) is **FROZEN** — if a day exposes a gap,
STOP and surface it; never silently edit the frozen spec.

## Operating protocol (every day, every thread)

1. **New Claude Code thread.** Paste `HANDOFF.md`. Claude reads, in order:
   `CLAUDE.md` → `HANDOFF.md` → this file → the day's governing contract §.
2. **Do exactly ONE day.** Not "a bit of the next." Small, consumable,
   overseeable. If a day proves too big, split it (`Day 7 → 7a/7b`) and stop
   at the natural seam — don't power through.
3. **Allison reviews.** Backend days (M-owner: Allison) — Claude assists, she
   drives/approves the running code. FE days (M-owner: Claude) — Claude owns.
4. **Commit + push** (scoped, `Co-Authored-By` trailer; backend code in
   `api/`, FE in `mobile/`, never mixed in one commit).
5. **Overwrite `HANDOFF.md`** for the next thread (the existing rolling-handoff
   discipline) + tick this file's status tracker + sweep the 4 MDs if scope
   moved. That IS the day's sign-off.
6. Next thread starts at step 1.

Rule: a day is DONE only when its **Exit** check passes — a real command/test/
observable behavior, not "looks right."

## Uniform day template

```
### Day N — <title>
- **Owner:** Allison (backend) | Claude (FE)
- **Depends on:** Day(s) X
- **Governing contract:** schema.sql <section> / DATA-CONTRACT §X / BACKEND-ARCHITECTURE §X
- **Goal:** one sentence.
- **Work:** the concrete deliverables.
- **Exit:** the verifiable check that says done.
- **Handoff note:** what the next thread must know.
```

## Status tracker (update the row each day)

| Day | Title | Owner | Status |
|----|-------|-------|--------|
| 0 | Decisions & conventions lock | Allison | ☑ |
| 1 | Scaffold + config + connectivity | Allison | ☑ |
| 2 | Auth verify + mirror-row + authz | Allison | ☑ |
| 3a | Data-layer invariants: audited-write primitives (soft-expire / relink / idempotency / withMutation) | Allison | ☑ |
| 3b | Data-layer invariants: concurrency primitives + America/Chicago bucketing | Allison | ☑ |
| 4a | Read: identity + dogs + contract-test harness pattern | Allison | ☑ |
| 4b | Read: vets / required-vaccines / agreements + env-selection lock | Allison | ☑ |
| 5a | Read: bookings (4 endpoints) + bucketing + multi-dog denorm + repo layer + local-dev docker-compose | Allison | ☑ |
| 5b | Read: availability / per-dog credits / credit-packages / rates | Allison | ☑ |
| 6a | Read: requests + group-classes + cohorts + eligibility (R7) + OR-prereq schema amendment | Allison | ☑ |
| 6b | Read: reports (R2 JSONB rehydration) | Allison | ☑ |
| 7a | Read: messaging + events + X-Dev-Principal dev-bypass scaffold | Allison | ☑ |
| 7b | Read: notifications + announcements + payment-methods + full read-surface manual sweep | Allison | ☑ |
| 8 | Redis read-through + invalidation | Allison | ☑ |
| 9a | Foundation refactor: lib/dogWire + dogs/vets repos (no behavior change) | Allison | ☑ |
| 9b | Mutations: vets POST/PATCH/DELETE + GET /vets/:id + idempotency live | Allison | ☑ |
| 9c | Mutations: dogs POST/PATCH/DELETE + GET /dogs/:id | Allison | ☑ |
| 9d | Mutations: dog-nested resources (vaccines / medications / feeding) | Allison | ☑ |
| 10 | Txn: bookSession (Day School/Care) + 3 gates | Allison | ☑ |
| 11 | Txn: enrollInGroupClass + cohort capacity | Allison | ☑ |
| 12 | Txn: pending requests + approve (portal verb 1) | Allison | ☑ |
| 12b1 | Txn: evaluation gate (4th BOOKING GATE — backend) | Allison | ☑ |
| 12b2 | FE: EvaluationGateModal extraction + program-tile gate + picker parity | Claude | ☐ |
| 13 | Txn: cancelBooking + refunds + cancel window + staff-tunable policy | Allison | ☑ |
| 14 | Stripe test-mode core (intents/cards/charges) | Allison | ☑ |
| 15 | Stripe webhooks + invoices + dunning worker | Allison | ☑ |
| 16 | Scheduler worker (scheduled_notifications) | Allison | ☑ |
| 17 | Media / Cloudflare R2 | Allison | ☑ |
| 18a | FE foundations: Supabase Auth + apiClient + TanStack QueryClient | Claude | ☑ |
| 18b | FE repository swap (11 remaining repos + media wire + hook migration) | Claude | ☑ |
| 18c | Device-token verbs (backend additive POST/DELETE + FE registration) | Claude | ☑ |
| 19a | Staff portal — backend verbs (queue + bookings confirm/cancel/attendance + threads reply + report authoring) | Claude | ☑ |
| 19b | Staff portal — web client (React+Vite+TS) + 2 cross-owner reads + dev seed + group-class multi-week link | Claude | ☑ |
| 19c | Staff-author media arm (report-photo/video upload on `/media` + portal UI) | Claude | ☑ |
| 19d | Real-mode completion + full-app smoke (close mock-only holes; verify every owner flow against the live API) + duplicate guards + group-class event cards | Claude | ☑ |
| 19e | Real-mode QA + change pass (walk every owner flow; log + batch-fix all bugs/change-requests before go-live) | Claude (fixes) + Allison (finds) | ☐ |
| 20 | Observability + deploy hardening + go-live gate | Allison | ☐ |

---

### Day 0 — Decisions & conventions lock
- **Owner:** Allison (Claude recommends; Allison rules)
- **Depends on:** —
- **Governing contract:** BACKEND-ARCHITECTURE "Open sub-decisions"
- **Goal:** Lock the 5 stand-up decisions so no later day is blocked.
- **Work:** Rule ORM (rec: **Drizzle** over frozen `schema.sql`, ORM never
  owns migrations), JWT verify (rec: **JWKS** + Redis-cached keys), Postgres
  hosting (rec: **managed for v1**), framework (rec: **Fastify + Zod**),
  migrations (rec: **raw SQL**, `schema.sql` canonical; dev-reset is a commented `DROP SCHEMA` preamble inside schema.sql, not a separate file). Write
  each into BACKEND-ARCHITECTURE (flip "Open sub-decisions" → locked) + memory.
- **Exit:** all 5 recorded as locked in the spec; zero code written.
- **Handoff note:** the locked choices + rationale; Day 1 can scaffold.

### Day 1 — Scaffold + config + connectivity
- **Owner:** Allison
- **Depends on:** Day 0
- **Governing contract:** schema.sql (load), DATA-CONTRACT `GET /health`
- **Goal:** A booting API that connects to Postgres + Redis and loads the schema.
- **Work:** `api/` package (TS strict, lefthook parity); Zod-validated env at
  boot (DB/Redis/Supabase/Stripe/R2 — fail fast); pg pool + Drizzle + Redis;
  `GET /health` `[public]`; CI loads `schema.sql` into a fresh empty ephemeral PG (no reset needed) and asserts the DEV-RESET preamble is still commented.
- **Exit:** `/health` 200; CI loads 45/45 tables green on push.
- **Handoff note:** package layout, env var contract, how to run + test locally.

### Day 2 — Auth verify + mirror-row + authz
- **Owner:** Allison
- **Depends on:** Day 1
- **Governing contract:** BACKEND-ARCHITECTURE §2; DATA-CONTRACT identity/session
- **Goal:** A Supabase JWT resolves to an owners/staff mirror row, role-gated.
- **Work:** JWKS verify middleware (sig/exp/aud/iss, cached); mirror-row
  resolve + first-request upsert + `POST /auth/webhook` `[signed]`; the
  `SET LOCAL app.actor='<kind>:<id>'` per-txn primitive (audit_log depends on
  it); ownership/role/`[public]` authz middleware — no RLS.
- **Exit:** test JWT → mirror row created/resolved; `GET /me` correct; a
  `[staff]` route 403s an owner; an audited write shows the right `actor`.
- **Handoff note:** the auth middleware contract; how `app.actor` is set.

### Day 3a — Data-layer invariants: audited-write primitives
- **Owner:** Allison
- **Depends on:** Day 2
- **Governing contract:** schema.sql "Transaction contract notes" (GLOBAL +
  IDEMPOTENCY) + `idempotency_keys` table + audit-trigger attach loop
- **Goal:** Encode the audited-write half of the locked invariants as reusable
  primitives every Day-9+ mutation route composes around — never reinvents.
- **Work:** soft-expire convention (`live(table)` filter + `RELINK` spread
  constant); `withIdempotency(tx, claim, fn)` wrapper around `idempotency_keys`
  (atomic INSERT-on-conflict claim, completed-row replay, in-flight 409,
  request-hash mismatch 422); composed `withMutation(principal, params, fn) =
  withActor(withIdempotency(fn))` as the single mutation entrypoint;
  `hashRequestBody` canonical-JSON SHA; `requireIdempotencyKey` header guard;
  two new error codes (`idempotency_mismatch` 422 / `idempotency_inflight`
  409); PATCH /me wired through `withMutation` (header now required).
- **Exit:** tests prove (1) a soft-expire `UPDATE` is captured by
  `audit_capture` with the live prior state in `before`, and (2) the same
  Idempotency-Key on the same body/endpoint replays without re-executing `fn`.
- **Handoff note:** `withMutation` is THE mutation entrypoint — Day 9+ routes
  call it, never `withActor` directly. Two new error codes live alongside the
  existing 6; the envelope's still a Day-2 design choice (not in DATA-CONTRACT
  yet). PATCH /me's `Idempotency-Key` header is now required (400 if absent).

### Day 3b — Data-layer invariants: concurrency primitives + Chicago bucketing
- **Owner:** Allison
- **Depends on:** Day 3a
- **Governing contract:** schema.sql txn-notes `bookSession` /
  `enrollInGroupClass`; `BUSINESS TIMEZONE = America/Chicago` (locked
  2026-05-19, schema.sql lines ~55-59)
- **Goal:** Encode the concurrency + calendar half of the invariants so every
  Day-10+ txn day has them on tap.
- **Work:** `withDogModeLock(dogId, mode, tx)` over
  `pg_advisory_xact_lock(hashtext(dog||mode))` (the booking serializability
  primitive — no double-spend under concurrent retries); `lockCohort(id, tx)`
  + `lockDayCapacity(location, date, tx)` `SELECT ... FOR UPDATE` helpers;
  `bucketToChicagoDate(ts)` + day-window utilities (every calendar/day calc
  routes through this — never raw UTC).
- **Exit:** tests prove (3) two concurrent transactions on the same
  `(dog,mode)` serialize (the second blocks on the advisory lock until the
  first commits), and (4) Chicago bucketing across a DST boundary
  (spring-forward / fall-back) returns the right calendar day.
- **Handoff note:** the locks + bucket are the only Day-10/11/12/13
  prerequisites left. Day 4 (the read days) doesn't depend on 3b — it could
  start in parallel, but the operating protocol is one-day-at-a-time, so 3b
  ships first.

### Day 4a — Read: identity + dogs + contract-test harness pattern
- **Owner:** Allison
- **Depends on:** Day 3
- **Governing contract:** DATA-CONTRACT §B (Owner, Dog), §C dogs
- **Goal:** First read surface (GET /me re-verify + GET /dogs) + the
  contract-test pattern Days 4b/5/6/7 inherit verbatim.
- **Work:** `routes/dogs.ts` with denormalized `vet?`, `age_months` computed
  in America/Chicago via `bucketToChicagoDate`, `vaccines/medications/
  feeding/completed_class_keys` from 5 batched queries (`live(table)` on
  each); `lib/ageMonths.ts` pure-date helper; `AuthRouteOptions` +
  `resolveAuthHook(opts)` extracted from the me/dogs duplication (rule-of-
  two); `DogsRouteOptions extends AuthRouteOptions` adds an injectable
  `now?: () => Date` factory so contract tests get a deterministic
  `age_months`. Wire-shape conventions locked (see below). **Contract-test
  harness:** fixed-UUID fixture (`test/contracts/_fixture.ts`), `makeContract
  App(principal)` factory (`_harness.ts`) with a stubbed `authenticate`
  preHandler + Fastify logger so unhandled errors surface, frozen snapshots
  at `test/contracts/snapshots/<endpoint>.json` asserted via
  `deepStrictEqual` (semantic byte-match — key order ignored, value-and-
  presence enforced). `npm test` script pinned to `--test-concurrency=1` so
  the shared-UUID fixture doesn't race across files.
- **Exit:** ☑ 48/48 tests green (Day-3b's 46 + me + dogs contract tests
  byte-match the §B Owner + Dog shapes against a seeded DB).
- **Wire-shape conventions (locked, applied through 4b/5/6/7):**
  - Required §B keys (no `?`): always emit; null DB text → `''`.
  - Optional §B keys (with `?`): omit when null/empty (`evaluation_date`,
    `completed_class_keys`, `vet`, vet-internal `phone/email/address/notes`).
  - Documented exceptions per the FE RawX type: `feeding.notes` is
    `string | null` — always present.
- **Handoff note:** Day 4b reuses this harness verbatim. Three concrete
  contracts to honor: (1) `seedFixture()`/`teardownFixture()` extends from
  `_fixture.ts` — add the rows your reads consume (required_vaccines,
  agreement_documents, agreement_signatures); same hard-DELETE teardown
  order (signatures BEFORE owner — ON DELETE RESTRICT). (2) one test file
  per read group, each registering its route with the test's `authenticate`
  + any route-specific injectables (Days 4b's catalogs don't need a clock).
  (3) snapshots are real JSON in git — when a contract changes deliberately
  the diff is the audit trail. The route-DI seam graduates: `registerXxx
  (app, opts?)` extends `AuthRouteOptions`; route-specific knobs (the
  clock, future similar) extend that interface.

### Day 4b — Read: vets / required-vaccines / agreements + env-selection lock
- **Owner:** Allison
- **Depends on:** Day 4a
- **Governing contract:** DATA-CONTRACT §B/§C vets + catalogs (no frozen
  byte-shape for required_vaccines/agreements — Day 4b designs them).
- **Goal:** Complete the §C identity/dogs/vets/catalogs surface; lock the
  env-selection decision deferred from Day 1.
- **Work:** `GET /vets?q=` (live + name/clinic typeahead per the contract);
  `GET /required-vaccines` (catalog, `{key,label,gates_categories[]}`); `GET
  /agreements` (catalog + per-owner signed-current-version derivation, shape
  Day 4b's choice — propose `{key,label,current_version,required,applies_to,
  signed_version: int|null, signed_at: iso|null}` and pin in the route
  doc). Extend `_fixture.ts` with required_vaccines + agreement_documents +
  one agreement_signatures row at current_version so the signed-vs-unsigned
  branch is in the snapshot. Wire `requirementKey: 'rabies'/'bordetella'`
  back into the Day-4a vaccine fixture rows (the FK target now exists).
  Env-selection decision (Day-1 deferred): pick host-injected for staging/
  prod and `dotenv.config()` called conditionally in dev/test only — small
  guard in `env.ts`, ratify in ARCHITECTURE.md or here at Day 20.
- **Exit:** contract tests pass for vets/required-vaccines/agreements against
  the extended seeded DB; env.ts conditionally loads `.env` only in
  dev/test; tracker row ☑.
- **Handoff note:** read surface is one Day-5 away from complete; document
  any agreements-shape choices that the FE-swap (Day 18) will need to know
  about.

### Day 5a — Read: bookings + bucketing + repo layer + local-dev infra
- **Owner:** Allison
- **Depends on:** Day 4
- **Governing contract:** DATA-CONTRACT §B (Booking, with Δ 2026-05-20)
  + §C bookings + §F lifecycle
- **Goal:** Four GET endpoints (`/bookings?view=` · `/bookings/up-next` ·
  `/bookings/:id` · `/dogs/:id/bookings?view=`) with honest per-category
  runtime bucketing + multi-dog denormalization, on top of a freshly
  extracted repository layer the rest of Day 5–8 builds on.
- **Work:** `lib/bookingBucket.ts` (sessionEndTime per category, isInView
  combining DB status with runtime bucket, day-program windows 07:30-09:00
  drop + 16:30-17:30 pickup); `lib/bookingWire.ts` (multi-dog denorm +
  §B emit, cancelled_at/cancel_forfeited only when status=cancelled);
  `lib/chicagoDate.ts` extended with `chicagoWallTimeToUtc` (DST-correct
  per IANA fold=0); `lib/pgTimestamp.ts` extracted `pgTimestampToDate`;
  `lib/errors.ts` (moved from auth/errors.ts; AuthError → ApiError;
  +`not_found` 9th code at 404 — restores dep rule); `db/repositories/{bookings,staff}Repository.ts`
  (data-access seam; Day-8 Redis injection point); `routes/bookings.ts`
  (parse → repo → bucket+sort → wire → respond); env.ts loads `.env.local`
  before `.env` with empty-DATABASE_SSL_CA → undefined transform; `index.ts`
  boot banner logs active env layer + DB target (creds redacted);
  `docker-compose.yml` at repo root (db 5432 + redis 6379 + test pg 5433,
  test pg profile-gated, auto-spun by `pretest`); `api/.env.local.example`;
  `api/package.json` `db:up`/`db:down`/`db:nuke` scripts; test harness
  extraction (`registerFixtureHooks`/`FIXTURE_*_PRINCIPAL`/`SKIP_WHEN_NO_DB`
  in `_harness.ts`); fixture extended with 10 bookings, 11 booking_dogs,
  2 staff, payment_method, +Lola vaccines, +marketing-consent agreement,
  +boarding signature; 16 contract tests + 8 snapshots; 34 unit tests
  across all 7 service categories incl. spring-forward gap + fall-back
  overlap.
- **Exit:** ☑ 105/105 tests green locally against the docker-compose test
  pg; typecheck/lint/format clean; latent DST bug in `chicagoWallTimeToUtc`
  found + fixed (probe-pair Math.max).
- **Wire-shape additions (locked in DATA-CONTRACT §B Δ 2026-05-20):**
  - **Booking** runtime-bucketing rules + day-program windows; `location`
    / `cancelled_at` / `cancel_forfeited` omit conventions
  - **Credits** zero-sentinel for new dogs (no 404 on `/dogs/:id/credits`)
  - **CreditPackage** new wire shape `{key, mode, credits, price_cents,
    label, is_popular}`
  - **Rate** new wire shape `{category, location, amount_cents, unit,
    effective_from, note?}` with location-specific over null-location
    precedence
  - **DayCapacity** mode does NOT filter; 60-day range cap
- **Handoff note:** Day 5b inherits the repo pattern verbatim — make
  `dayCapacityRepository`, `creditsRepository`, `creditPackagesRepository`,
  `serviceRatesRepository`. Wire helpers in `lib/`. Use `lib/pgEnumTuple`
  helper (extract at first use) for `z.enum` from pgEnum (rule-of-two
  fires on `mode` + `location` query params).

### Day 5b — Read: availability / per-dog credits / credit-packages / rates
- **Owner:** Allison
- **Depends on:** Day 5a
- **Governing contract:** DATA-CONTRACT §B (Credits, DayCapacity,
  CreditPackage, Rate — all with Δ 2026-05-20 wire shapes pinned)
  + §C availability/credits
- **Goal:** Round out the booking-data read surface — per-location
  availability with the default rule applied server-side, per-dog
  credit balance via `dog_credit_balance` view + zero-sentinel,
  catalog reads for credit-packages and effective-dated rates.
- **Work:** `GET /availability?from=&to=&mode=&location=` (DayCapacity
  rows over the date range, weekend=closed + default 3, sparse overrides
  via `day_capacity` table; 60-day range cap; mode does NOT filter
  output, both school + daycare openings always emit); `GET /dogs/:id/credits`
  (LEFT JOIN view for zero-sentinel); `GET /credit-packages` (live
  catalog, active=true filter, ORDER BY mode, credits); `GET /rates?category=&location=`
  (effective-dated lookup: `effective_from <= today_chicago AND
  (effective_to IS NULL OR today_chicago < effective_to)`, location-
  specific over null-location precedence, 404 if none); plus
  `lib/pgEnumTuple` extraction at the rule-of-two; contract tests +
  snapshots following the 5a pattern.
- **Exit:** ☑ 141/141 tests green. Per-location availability exercises
  weekend / weekday / override / **soft-expired override** (live() filter);
  effective-dated rate lookup exercises location-specific / null-location /
  **closed-window fallback** / **empty-note omit** / 404; zero-sentinel
  credits exercises a dog with zero ledger rows; `lib/availability.test.ts`
  (11 unit tests) pins day-of-week branches, leap year (2028 Feb), year
  boundary, **exact 92-cap boundary** (92 ok / 93 over), reversed range,
  100-year pathological short-circuit. **Cap raised 60 → 92 dates** —
  DATA-CONTRACT §B DayCapacity Δ updated per Allison's "book up to 3
  months in advance" requirement.
- **Handoff note:** booking-data read surface is now complete (Days 4 + 5
  = identity, dogs, vets, agreements, bookings, availability, credits,
  packages, rates). Day-5b additions Day 6+ should reuse: `lib/pgEnumTuple`
  (now 6 call sites — extract once more if a 7th shows up), `lib/ratesWire`
  pattern (mirror with `requestWire` / `reportWire` etc.), `bucketChicagoToday`,
  Result-typed validation in `lib/availability.enumerateRangeWithCap`,
  `assertNever` exhaustiveness pattern from creditsRepository. Day 6
  (reports/requests/classes) begins the R2/JSONB-shape work.

### Day 6a — Read: requests + group classes + cohorts + eligibility (R7)
- **Owner:** Allison
- **Depends on:** Day 5b
- **Governing contract:** DATA-CONTRACT §B PendingRequest (R1, R8) +
  GroupClass / Cohort / GroupEligibility (all Δ 2026-05-20) + §C
  requests + group-classes
- **Goal:** Pending-request reads (2 endpoints) + group-class catalog +
  cohorts + server-derived eligibility (R7) with proper **OR-prereq**
  semantics (the schema's singular `prereq_class_key` FK couldn't
  express "manners-1 OR manners-2 → public-manners" — see schema
  amendment).
- **Work:** ☑ 7 endpoints (`GET /requests?status=` · `/requests/:id` ·
  `/group-classes` · `/group-classes/:key` · `/group-classes/:key/cohorts`
  · `/cohorts/:id` · `/dogs/:id/group-eligibility?class=`) over 4 new
  repos (`requestsRepository`, `groupClassesRepository`,
  `cohortsRepository`, `dogCompletedClassesRepository`) + 2 wire
  helpers (`lib/requestWire`, `lib/groupClassWire`). **Schema amendment
  (freeze opened narrowly):** dropped `group_classes.prereq_class_key`
  (singular FK); added `class_prereq_options` join (M:N, soft-expire,
  partial-unique). Multiple rows per class_key = OR alternatives.
  DATA-CONTRACT §A logs the amendment; R7 unchanged. Tables 45 → 46.
  +25 contract tests (11 requests + 14 group-classes) with 13 frozen
  JSON snapshots.
- **Exit:** ☑ 166/166 tests green (141 prior + 25 new); boot smoke
  /health 200 with db+redis ok; 3 new routes return 401 on auth-gated
  paths (registered). OR-prereq eligibility derives correctly: Waffles
  (has manners-1) → eligible for manners-2; Lola (no completions) →
  ineligible with `missing_prereq_options: ['manners-1']`.
- **Handoff note:** Day 6b inherits the repo + wire pattern verbatim
  for reports. R2 JSONB rehydration is the new ground — `reports.results`
  holds curriculum keys (skills + practice + friends + additional_skills);
  `reports.content` holds the variant doc. Wire helper rehydrates both
  to top-level §B keys. Schema-freeze stays closed (no R2-shape gap
  identified Day 6a).

### Day 6b — Read: reports (R2 JSONB rehydration)
- **Owner:** Allison
- **Depends on:** Day 6a
- **Governing contract:** DATA-CONTRACT §B Report (R2) + §C reports +
  §A Clarification 2026-05-20 (results JSONB envelope, doc-only)
- **Goal:** 4 report read endpoints + the R2 rehydration helper that
  maps `reports.program` enum → variant content key, spreads
  `reports.results` JSONB envelope into top-level curriculum keys,
  and emits exactly one of the 4 variant docs keyed by program.
- **Work:** ☑ 4 endpoints (`GET /dogs/:id/reports` · `/reports/:id` ·
  `/dogs/:id/reports/latest` · `/dogs/:id/reports/resolve?reportId=&program=`)
  over `reportsRepository` (3 methods) + `lib/reportWire.ts`
  (`toReportWire`, the heaviest single helper of the phase — envelope
  spread + variant-key switch with `assertNever` over the
  `report_program` enum). Schema clarification (comment-only): the
  `reports.results` JSONB column holds an envelope `{ results,
  practice_at_home?, friends_today?, additional_skills_completed? }`,
  not a bare skills grid; the block + inline comments contradicted
  each other before. DATA-CONTRACT §A logs the clarification. +18
  contract tests + 7 frozen JSON snapshots. **End-of-day Path-A
  refactor** extended `staffRepository` with `resolveTrainerNames`
  (rule-of-two: `wireBookings` + `wireReports` both did the dedupe-
  fetch-Map-lookup dance inline; now collapsed to a single `await`),
  and tightened the JSONB trust boundary in `reportWire.ts` with a
  typed `ReportResultsEnvelope` interface + single-site `asEnvelope`
  cast (replaces 4 inner `as` casts). Wire output unchanged; 184/184
  green throughout the refactor.
- **Exit:** ☑ 184/184 tests green (166 prior + 18 new); boot smoke
  /health 200 with db+redis ok; 4 new routes return 401 on auth-gated
  paths (registered). R2 rehydration verified by snapshot diff for
  all 4 variant programs: foundation (curriculum envelope, all 4
  sibling keys), private-lesson (variant doc + sparse envelope),
  boarding-session (variant doc + null envelope + no trainer +
  visit_count/verdict_headline both omitted), board-train-session
  (variant doc, full scalars), group-class-session (variant doc,
  weeks[] with mixed-shape topic entries).
- **Handoff note:** the read surface for booking data + reports +
  classes is now COMPLETE (Days 4 + 5 + 6). Day 7 = messaging /
  events / notifs / payment methods. Day 7's first-hour task is
  scaffolding the `X-Dev-Principal` dev-bypass header before the
  day's endpoints — unblocks manual curl testing for the rest of
  the backend phase.

### Day 7a — Read: messaging + events + X-Dev-Principal dev-bypass scaffold
- **Owner:** Allison
- **Depends on:** Day 6b
- **Governing contract:** DATA-CONTRACT §B Thread/Message/Event/EventRsvp +
  §C messaging/events
- **Goal:** Threads (`unread_count` derived server-side, polymorphic
  sender flattening) + events catalog + owner's-RSVPs, plus the dev-only
  `X-Dev-Principal` header bypass that unblocks curl/Bruno/Postman
  testing for the rest of the backend phase.
- **Work:** ☑ 6 endpoints (`GET /threads` · `/threads/:id` ·
  `/threads/:id/messages` · `/events` · `/events/:id` · `/events/rsvps`)
  over 3 new repos (`threadsRepository` with unread-count batch derivation
  + `ownsThread` gate, `messagesRepository`, `eventsRepository`), 2 new
  wire helpers (`lib/threadWire` with polymorphic sender flatten +
  `participant` resolve, `lib/eventWire` with `starts_at→date` rename +
  `loc_*→location{}` nesting). `staff_role` validation against the enum.
  Extended `staffRepository.findParticipantsByIds`. **`X-Dev-Principal`
  bypass scaffold** — `auth/plugin.ts` parses `owner:<uuid>` /
  `staff:<uuid>:<role>` before the JWT path when `env.bypassHeader
  Enabled` is true; `env.ts:resolveBypassHeaderEnabled` defaults ON for
  development/test, OFF for staging/prod, with `NODE_ENV=production`
  hard-overriding to OFF. Boot banner warns when active. **`lib/assertNever.ts`
  promoted** at rule-of-three (third inlined use — `sender_kind` switch
  in `flattenMessageSenderId`). +19 contract tests (11 threads + 8
  events) + 9 frozen JSON snapshots + 6 new auth.test.ts bypass cases.
- **Exit:** ☑ 209/209 tests green (184 prior + 6 bypass + 19 contracts).
  Boot smoke against the live dev server confirms the bypass: no-header
  → 401, malformed → 400, valid → 200. New routes registered in
  `server.ts`; `X-Dev-Principal: owner:11111111-1111-4111-8111-111111111111`
  passes the auth gate; logger emits a warning at boot when the bypass is ON.
- **Handoff note:** Day 7b inherits the bypass scaffold (full ~38-endpoint
  manual sweep via curl) + the repo/wire pattern (notifications +
  announcements + payment-methods are direct mirrors). The `readEndpoint
  <Q,W>` factory remains deferred — 26 near-identical handler shapes
  now; Day 8 commits or documents the decision NOT to.

### Day 7b — Read: notifications + announcements + payment-methods + full manual sweep
- **Owner:** Allison
- **Depends on:** Day 7a
- **Governing contract:** DATA-CONTRACT §B Notification/Announcement/
  PaymentMethod + §C notifications/announcements/payments-read +
  §A Clarification 2026-05-21 (cursor pagination shape)
- **Goal:** Round out the final read-day with the 4 remaining surfaces,
  then exercise the full read surface via curl + the dev-bypass header.
- **Work:** ☑ 4 endpoints (`GET /notifications` with cursor pagination
  + `notification_dogs` denorm, `GET /notifications/unread-count`,
  `GET /announcements?location=`, `GET /payment-methods`) over
  `notificationsRepository` (keyset cursor + unread-count + M:N
  resolve), `announcementsRepository` (live + location filter),
  `paymentMethodsRepository` (one read method; pre-positioned for
  Day-9 mutations). `lib/notificationWire.ts` + `lib/announcementWire.ts`
  (3rd + 4th wire helpers respectively). PaymentMethod wire shape
  inlined in `routes/paymentMethods.ts` (7-key flat row, no helper
  needed). DATA-CONTRACT §A Clarification 2026-05-21 pins the cursor-
  pagination wire shape (`{items, next_cursor?}` envelope + base64url-
  encoded `{r,i}` keyset payload). Both `readEndpoint<Q,W>` factory and
  `db/schema/domainTypes.ts` extraction **deferred with justification**
  (see HANDOFF §4.10). +16 contract tests + 7 frozen JSON snapshots.
- **Exit:** ☑ 225/225 tests green (209 prior + 16 new). Manual sweep
  43/43 OK against live dev server via `X-Dev-Principal` bypass
  (38 happy-path 200 + 5 negative-branch 400; zero unexpected).
- **Handoff note:** read surface is **DONE**. Two §C endpoints noted
  but not built: `GET /dogs/:id` and `GET /vets/:id` (single-resource
  reads; deferred to Day-9 mutations where the wire shape mirrors POST/
  PATCH response). Day 8 = Redis read-through + invalidation; the repo
  layer's projection constants are the natural cache-key boundary.

### Day 8 — Redis read-through + invalidation
- **Owner:** Allison
- **Depends on:** Day 7
- **Governing contract:** BACKEND-ARCHITECTURE §3
- **Goal:** Cache the hot reads with explicit, correct invalidation.
- **Work:** ☑ `lib/cache.ts` (`readThrough` + `invalidate` +
  `invalidatePattern`; required Zod validate at the trust boundary;
  `undefined`/`null` skip-cache so optional reads compose; SCAN+UNLINK
  for pattern wipes; §3 invalidation map mirrored as a code comment).
  `withMutation` extended with optional post-commit `keysToInvalidate:
  (body) => string[]` callback — fires only on new (non-replayed)
  outcomes; failures are **logged + swallowed** (committed mutation
  must return its real status; cache self-heals via TTL; Day-20 will
  route the log through the observability seam). Five repo methods
  wired through `readThrough` (one shy of §3's table — `cohorts:*`
  defers to Day 11, `credits:*` to Day 14, `dogprofile:*` to Day 9+):
  `announcementsRepository.findLive` (`ann:{location|all}`, 300s);
  `groupClassesRepository.findAll` / `findByKey` /
  `findPrereqOptionsForClass` (all under the `groupclasses:*` prefix,
  600s — one pattern wipe covers them); `dayCapacityRepository.
  findOverridesInRange` (`avail:{location}:{from}:{to}`, 300s,
  pattern-wiped via `avail:{location}:*` on day_capacity write).
  Test infra: `REDIS_URL=redis://localhost:6379/1` (DB-1 isolation
  from dev DB 0); `_harness.ts` `FLUSHDB`s the test DB on every
  fixture seed; `closeRedis()` hooks in cache.test.ts /
  idempotency.test.ts / `_harness.ts` so Node 25's
  `--test-isolation=process` subprocesses can exit cleanly. +12
  cache unit tests + 6 integration tests + 1 stale-shape regression.
- **Exit:** ☑ 243/243 tests green (225 prior + 12 cache unit + 6
  cache integration). Dev curl shakeout confirmed: `ann:all`,
  `groupclasses:catalog`, `avail:fayetteville:2026-05-21:2026-05-28`
  all cached server-side with the configured TTLs; manual
  `DEL ann:all` + re-curl repopulates with TTL reset; `SCAN+UNLINK`
  pattern wipe drops every `avail:fayetteville:*` range cache.
- **Handoff note:** Day-9+ mutations call
  `withMutation({ ..., keysToInvalidate: (body) => [...] }, fn)` —
  the callback runs post-commit on new outcomes only, after the
  transaction has committed; throwing keys from the callback or
  redis errors from the invalidate are logged-and-swallowed so the
  client gets the truthful success response. **Soft-expire
  mutations must wipe BOTH the `:all` key AND every per-filter key**
  (a single row can be in multiple caches) — convention is
  `invalidatePattern('{entity}:*')` unless invalidation is truly
  one-key-precise. The §3 invalidation map in `lib/cache.ts` is the
  at-a-glance reference. Two deferred-to-mutation-day caches:
  `cohorts:{classKey}` (Day 11 enroll txn) and `credits:{dogId}`
  (Day 14 Stripe purchase). Day-9 also lands `GET /dogs/:id` +
  `GET /vets/:id` (single-resource reads deferred from Day 7b).

### Day 9a — Foundation refactor: lib/dogWire + dogs/vets repos
- **Owner:** Allison
- **Depends on:** Day 8
- **Governing contract:** none (pure no-behavior-change refactor pinned by
  existing snapshots).
- **Goal:** Extract dog-wire mechanics + dogs/vets data-access into the
  established `lib/` + `db/repositories/` seams so Day-9b mutations land
  on top of a clean surface.
- **Work:** ☑ `lib/dogWire.ts` (`AssembledDog` domain shape + `DogWire` +
  `toDogWire`); `db/repositories/dogsRepository.ts` (`findManyByOwner`
  only — assembled-row builder with batched joins for vaccines /
  medications / feeding / completed-classes / vet); `db/repositories/
  vetsRepository.ts` (`search` only — the typeahead `ilike` + `live()`
  filter); `routes/dogs.ts` 196 → 41 lines, `routes/vets.ts` thin
  orchestrator. No new tests (refactor pinned by existing snapshots).
- **Exit:** ☑ 243/243 tests still green byte-equal; routes parse, repos
  encapsulate the data access.
- **Handoff note:** Day-9b extends `vetsRepository` with the first
  mutation primitives (findById / hasLiveDogReferences / create / update
  / softExpire); Day-9c extends `dogsRepository` with the same shape
  (findById / findOwnedExists / softExpire) + the mutation methods.

### Day 9b — Mutations: vets POST/PATCH/DELETE + GET /vets/:id + idempotency live
- **Owner:** Allison
- **Depends on:** Day 8 + Day 9a
- **Governing contract:** schema.sql vets lifecycle clauses (soft-expire
  + audit-log triggers); DATA-CONTRACT §A vets amendment + §C `/vets`
  endpoints.
- **Goal:** First mutation surface composing `withMutation` end-to-end;
  validates the shape on the smaller vet surface before Day-9c's dog
  fan-out adds scale.
- **Work:** ☑ 4 endpoints (`POST /vets` `[auth]` create-if-missing
  `source='app'` · `PATCH /vets/:id` `[staff]` edit · `DELETE /vets/:id`
  `[staff]` soft-expire · `GET /vets/:id` `[auth]` — deferred §C read
  from Day 7b). `vetsRepository` extended with `findById` (polymorphic
  `Tx | typeof db` runner so the same lookup serves both the GET route
  and the mutation-internal pre-checks), **`findByIdForUpdate`** (the
  half-fix for the DELETE-vs-Day-9c-PATCH-/dogs race — `SELECT ...
  FOR UPDATE` on the vet row at the top of the DELETE txn so a
  concurrent PATCH/POST /dogs `FOR SHARE` on the same vet serializes;
  proven by a synthetic-race test that asserts a concurrent
  `FOR SHARE NOWAIT` from a separate pool connection fails with
  Postgres `55P03` lock_not_available), `hasLiveDogReferences` (the §A
  API-block guard — `dogs.primary_vet_id` references under `live()`),
  `create` (always `source='app'`), `update` (partial `set`),
  `softExpire`. New `conflict: 409` error code (`errors.ts`) for "the
  request conflicts with current state" — first use is the
  live-dog-references block on DELETE; will likely recur in Day-9c
  (DELETE /dogs blocked by live bookings) and Day-10+ (booking guards).
  Every mutation declares `keysToInvalidate: () => []` as the convention
  seam per Day-8 §3 (vets aren't in the cache map today — silent seam,
  not a missing one). Empty-string optional fields normalize to `null`
  server-side so `toVetWire`'s omit-on-null convention round-trips
  cleanly. `requireStaff(principal, action: 'edit' | 'delete')` is the
  staff-gate helper; literal-union narrows the action so a typo can't
  silently land. +18 contract tests + 1 frozen JSON snapshot
  (`vet-by-id`).
- **Exit:** ☑ 261/261 tests green (243 prior + 18 Day-9b). Manual smoke
  through live dev API confirmed: POST 201 + replay returns same id;
  PATCH 200 + replay byte-identical; PATCH owner→403, staff→200; DELETE
  204 + subsequent GET 404 + audit_log captures the soft-expire under
  staff actor; DELETE on fixture vet (Waffles' primary) 409 conflict.
  `audit_log` query confirmed both PATCH + DELETE UPDATEs recorded under
  `staff:donavan`; `vets.expired_at IS NOT NULL` for the deleted row.
  The synthetic-race test proved `FOR UPDATE` blocks concurrent
  `FOR SHARE NOWAIT` end-to-end against real Postgres.
- **Handoff note:** Day-9c (dogs mutations) inherits the route shape +
  repo pattern verbatim; the `conflict: 409` code is the seam for
  state-conflict rejections (delete-dog-with-live-bookings will reuse).
  **DELETE-vs-PATCH race is half-closed — Day-9c finishes it.** Day-9b's
  `findByIdForUpdate` takes `FOR UPDATE` on the vet row up-front;
  Day-9c's matching `SELECT ... FOR SHARE` on PATCH/POST /dogs
  `primary_vet_id` reassign completes the pair (the dogs-side lock
  blocks against the vets-side exclusive lock and they serialize).
  Rule-of-three mutation-route extraction candidate (parse params →
  parse body → requireIdempotencyKey → hashRequestBody → withMutation
  → repo call → reply) — defer until Day-9c forces the shape decision.

**Confidence-score self-review (Day-9b sign-off, all ≥ 95):**
- Correctness: 95 — full happy + idempotency + audit + soft-expire +
  conflict + 404 paths all covered by the 18 contract tests; the
  prophylactic FOR UPDATE half-fix proven by a synthetic-race test
  against real Postgres; Day-9c finishes the matching FOR SHARE half.
- Architecture: 95 — `withMutation` is the entrypoint; every Day-9b
  mutation declares `keysToInvalidate` as the convention seam; the
  `FOR UPDATE` lock lives at the repo layer (`findByIdForUpdate`),
  not inline in the route; `requireStaff(action: 'edit' | 'delete')`
  is literal-union-narrow.
- Clean Code: 95 — honest names, paragraph-style handlers, no dead
  code; redundant `.trim()` after Zod's `.trim().min(1)` removed at
  both POST + PATCH call sites; the `requireStaff` action narrows
  prevent stringly-typed typos.

### Day 9c — Mutations: dogs POST/PATCH/DELETE + GET /dogs/:id
- **Owner:** Allison
- **Depends on:** Day 9b
- **Governing contract:** schema.sql dogs lifecycle clauses;
  DATA-CONTRACT §B Dog + §C `/dogs` endpoints.
- **Goal:** Dogs CRUD surface composing `withMutation` over the
  vet-mutation shape from Day-9b. Validates that the shape scales over
  the larger entity and the `primary_vet_id` linkage.
- **Work:** ☑ 4 endpoints (`POST /dogs` · `PATCH /dogs/:id` · `DELETE
  /dogs/:id` · `GET /dogs/:id`) wired into the existing
  `registerDogsRoute` (one registration call per resource, Day-9b
  convention). `dogsRepository` extended with `findById(id, ownerId,
  runner: Tx | typeof db = db)` — polymorphic runner so the same
  assembled-shape lookup serves both the standalone GET (default pool)
  and the post-mutation re-fetch inside `withMutation`'s tx (snapshot
  consistency); `findOwnedExists(dogId, ownerId, tx)` — boolean
  ownership guard, the rule-of-three extraction Day-9d's nested
  mutations reuse verbatim; `create(tx, values)` — owner-stamped
  insert; `update(tx, id, set)` — partial-set update with `live()`
  filter; `softExpire(tx, id)` — `expired_at = now()` with `live()`
  filter (idempotent re-call). `vetsRepository.findByIdForShare(id,
  tx)` lands as the matching half of Day-9b's `findByIdForUpdate` —
  PATCH /dogs and POST /dogs call it on the `primary_vet_id` reassign
  branch so the lock pair serializes a concurrent DELETE /vets.
  `lib/normalize.ts` (`normalizeOptional`) promoted from
  `routes/vets.ts` at the rule-of-two trigger. `requireOwner(principal,
  action: 'create' | 'edit' | 'delete')` is the owner-narrow helper
  with an `asserts` predicate (mirrors Day-9b's `requireStaff`; same
  literal-union pattern). **Mutation-route choreography deliberately
  NOT extracted** — decision documented inline with rationale (verb-
  shape variance dominates the boilerplate; the 2-line saving doesn't
  pay for the abstraction cost; Day-9d's six nested mutations are the
  right re-evaluation point). Every mutation declares
  `keysToInvalidate: () => []` per the Day-8 convention seam (dogs
  aren't in §3 cache map today — `dogprofile:{dogId}` deferred). +24
  contract tests + 1 frozen JSON snapshot (`dog-by-id` mirrors fixture
  Waffles).
- **Exit:** ☑ 285/285 tests green (261 prior + 24 Day-9c). The
  cross-route race is exercised by a `Promise.allSettled` test that
  runs DELETE /vets + PATCH /dogs { primary_vet_id } in parallel
  through real Fastify against real Postgres (separate pool
  connections); asserts exactly one rejects with the correct error
  code (409 conflict on the DELETE side OR 422 invalid_payload on the
  PATCH side). Manual smoke through live dev API confirmed:
  POST 201 + Dog assembled wire shape with `vet` resolved →
  GET /dogs/:id byte-identical → PATCH clear primary_vet_id → PATCH
  reassign + set evaluation_status='passed' → DELETE 204 → subsequent
  GET 404 → DB row carries `expired_at IS NOT NULL` → audit_log records
  3 UPDATE rows under `owner:<id>` actor (2 PATCH UPDATEs + 1 soft-
  expire UPDATE; POST INSERTs aren't captured by the AFTER UPDATE OR
  DELETE trigger). The DELETE-vs-PATCH-/dogs race is **now fully
  closed** (Day-9b's `FOR UPDATE` × Day-9c's `FOR SHARE` lock pair).
- **Handoff note:** Day-9d composes nested-resource mutations on top —
  `POST/PATCH/DELETE /dogs/:id/vaccines` (POST/PATCH may set
  `requirement_key`), same triple on medications, `PUT
  /dogs/:id/feeding`. All under `findOwnedExists(dogId, ownerId)` as
  the parent-dog ownership gate. After Day-9d, `Day 9 ☑` (all four
  sub-rows tick). Deferred from Day-9c (deliberate): PATCH on
  `birthdate` / `age_months_override` (the DB CHECK requires at least
  one non-null; safe edit needs a paired-clear guard OR
  check_violation→invalid_payload mapping); the "different owner →
  404" coverage gap (no second owner in fixture today — could backfill
  alongside nested-resource ownership tests in Day-9d if the fixture
  grows).

**Confidence-score self-review (Day-9c sign-off, all ≥ 95):**
- Correctness: 95 — full happy + idempotency + audit + soft-expire +
  ownership + bad-vet + race paths covered by the 24 contract tests;
  manual smoke through the live dev API confirms POST/GET/PATCH×2/
  DELETE + soft-expire + audit_log under owner actor; the cross-route
  race test exercises the full DELETE/PATCH pair against real
  Postgres with separate pool connections and asserts exactly one
  rejects (409 or 422). What'd push it higher: cross-owner "not yours
  → 404" branch isn't exercised (no second-owner fixture today; low
  risk since the filter is in-SQL).
- Architecture: 95 — `withMutation` remains the entrypoint;
  `findByIdForShare`/`findByIdForUpdate` lock pair lives at the repo
  layer; polymorphic-runner `findById` (Tx | typeof db) serves both
  GET and re-fetch; `findOwnedExists` is the Day-9d-shared ownership
  primitive; `requireOwner` mirrors `requireStaff` with the same
  `asserts` + literal-union narrows; mutation-route choreography
  extraction deferred to Day-9d with documented rationale. What'd
  push it higher: the two `throw new Error('row vanished before re-
  fetch')` defense-in-depth branches are dead-letter paths under
  current triggers — acceptable as belt-and-suspenders.
- Clean Code: 95 — honest names, JSDoc on every public method,
  paragraph-style handlers, no dead code, `normalizeOptional`
  extracted; the mutation-route non-extraction decision documented
  inline. What'd push it higher: `postBodySchema` / `patchBodySchema`
  repeat per-column type definitions (DRY trade declined because the
  shapes diverge on birthdate/age_months_override + .refine).

### Day 9d — Mutations: dog-nested resources (vaccines / medications / feeding)
- **Owner:** Allison
- **Depends on:** Day 9c
- **Governing contract:** schema.sql dog_vaccines / dog_medications /
  dog_feeding lifecycle clauses; DATA-CONTRACT §B Dog sub-shapes
  (VaccineWire / MedicationWire / FeedingWire) + §C nested-dog
  endpoints + §A 2026-05-22 amendment (VaccineWire grew `id` +
  `requirement_key?`).
- **Goal:** Round out the dog-write surface so the FE can fully manage
  a dog's care fields end-to-end.
- **Work:** ☑ 7 endpoints (`POST /dogs/:id/vaccines` · `PATCH
  /dogs/:id/vaccines/:vid` · `DELETE /dogs/:id/vaccines/:vid`; same
  triple on medications; `PUT /dogs/:id/feeding`) wired into the
  existing `registerDogsRoute` (file size grew to ~700 lines; the
  monolithic-vs-split decision stayed monolithic per "group by feature,
  not by file kind"). Three new repos:
  `dogVaccinesRepository` (findByIdForDog parent-child guard + create
  / update / softExpire); `dogMedicationsRepository` (symmetric);
  `dogFeedingRepository` (single `upsert` via `onConflictDoUpdate(
  { target: dogFeeding.dogId, set: { ...RELINK, ...values }})` — the
  canonical second RELINK use case after Day-2's owner/staff
  provisioning, documented inline in `softExpire.ts`'s `RELINK`
  doc-comment). `requiredVaccinesRepository` extracted at the
  rule-of-two trigger (Day-4b's route read Drizzle directly — existing
  violation cleaned up alongside the Day-9d FK guard); `keyIsLive(key,
  tx)` is the gate POST/PATCH on vaccines call before writing
  `requirement_key`. **DATA-CONTRACT §A amendment** (2026-05-22):
  VaccineWire grew `id` (required, always emitted) + `requirement_key?`
  (optional, omit-on-null) — forced by PATCH/DELETE needing the id in
  the URL; additive so the FE ignores until Day-18 swap. `lib/dogWire.ts`
  exports `toVaccineWire` / `toMedicationWire` / `toFeedingWire` so the
  mutation routes have a single helper per child resource. `parseOrThrow
  (schema, value, label)` promoted to `lib/zodIssues.ts` at the
  rule-of-N safeParse pattern (~20 call sites across `routes/*` after
  Day-9d); used everywhere in `routes/dogs.ts` (Boy-Scout cleanup of
  the existing Day-9c handlers while in the file). `requireOwner`
  action union stays `'create' | 'edit' | 'delete'` — PUT /feeding
  uses `'edit'` (closest semantic); message generalized to "their
  dogs" so the nested-resource case reads correctly. **Mutation-route
  choreography helper STILL not extracted** at the rule-of-10 mark —
  decision re-confirmed in the route doc after writing all 10
  mutations: the prelude lines name three orthogonal concerns and the
  request-hash input varies per verb, so a unified `mutationContext`
  helper can't own the hash without losing precision. +31 contract
  tests in `dogs-nested-mutations.test.ts` (no new snapshot — wire
  shapes covered by inline assertions; the existing `dog-by-id` +
  `dogs` snapshots updated for the §A VaccineWire amendment).
- **Exit:** ☑ 316/316 tests green (285 prior + 31 Day-9d). The RELINK
  round-trip is exercised by a contract test that creates a feeding
  row via PUT, soft-expires it directly via DB UPDATE, PUTs again,
  and asserts the row's `expired_at` clears + new values are visible
  + audit_log captures the UPDATE under owner actor. Manual smoke
  through live dev API confirmed POST/PATCH/DELETE vaccine with
  `test-rabies` requirement_key (2 audit UPDATE rows under owner
  actor) + bad requirement_key → 422 + POST/DELETE medication +
  PUT feeding (create + RELINK round-trip + audit_log capture).
  **`Day 9 ☑`** — all four sub-rows ticked.
- **Handoff note:** the dog-write surface is now complete (top-level
  CRUD + GET-by-id from Day-9c + 7 nested endpoints from Day-9d).
  Day-10 (`bookSession` txn) is the next surface — composes
  `withMutation` with `withDogModeLock` + `lockDayCapacity` +
  `credit_ledger` debit + the 3 booking gates (vaccine / agreement /
  payment). The Day-9d patterns Day-10 inherits: `parseOrThrow`
  (every parse in the new booking routes), `findOwnedExists` (the
  dog ownership gate before any per-dog write), the `requireOwner`
  /  `requireStaff` literal-union pattern.

**Confidence-score self-review (Day-9d sign-off, all ≥ 95):**
- Correctness: 95 — full happy + parent-child + idempotency + audit
  + soft-expire + RELINK paths covered by 31 contract tests; manual
  smoke through live dev API confirms all 7 endpoints + the
  requirement_key FK gate + the RELINK round-trip end-to-end. What'd
  push it higher: cross-owner "not yours → 404" branch on
  `findOwnedExists` carries from Day-9c (no second-owner fixture);
  parent-child `findByIdForDog` IS exercised so the related
  "wrong parent" bug class is covered.
- Architecture: 95 — three new repos follow the Day-9c template
  verbatim; `RELINK` is the canonical seam (second use after Day-2
  provisioning, documented inline); `requiredVaccinesRepository`
  extracted at rule-of-two (Boy-Scout cleanup of the Day-4b
  direct-Drizzle violation); `parseOrThrow` promoted at rule-of-N;
  mutation-route choreography helper deliberately NOT extracted at
  the rule-of-10 mark with documented rationale. What'd push it
  higher: the `requirement_key` validation is a two-step
  route-then-repo pattern; a denser one-step alternative exists
  but loses error-mapping precision.
- Clean Code: 95 — honest names throughout (`findByIdForDog`,
  `keyIsLive`, `RELINK` doc updated with both canonical uses);
  JSDoc on every new repo method; route-file doc walks through
  Day-9a/9c/9d sections with the choreography-helper non-extraction
  rationale; `parseOrThrow` doc explains the throw-over-Result
  decision. What'd push it higher: `routes/dogs.ts` at ~700 lines
  is on the upper end of the "keep monolithic" call; revisit if a
  future feature pushes it further.

### Day 10 — Txn: bookSession (Day School/Care) + 3 gates
- **Owner:** Allison
- **Depends on:** Day 9
- **Governing contract:** schema.sql txn-notes `bookSession` + BOOKING GATES
- **Goal:** Credit-debited booking with double-spend safety and the 3 gates.
- **Work:** per-`(dog,mode)` lock + `day_capacity FOR UPDATE` + `credit_ledger`
  debit; map gate `check_violation` → typed 422 (card/vaccine/agreement) with
  friendly copy; API pre-checks above the DB floor.
- **Exit:** tests: no double-spend under concurrency; each gate rejects; happy path books.
- **Handoff note:** the gate→HTTP error mapping table.

### Day 11 — Txn: enrollInGroupClass + cohort capacity
- **Owner:** Allison
- **Depends on:** Day 10
- **Governing contract:** schema.sql txn-notes `enrollInGroupClass` (line
  ~1298) + `cohorts` (line ~352) + `class_prereq_options` (line ~341) +
  the three BOOKING GATES (lines ~1184/1231/1272); DATA-CONTRACT §A
  amendment 2026-05-23 (Day 11) + §C `/enrollments` (line 495) + §C.1
  Model 2 (line 552).
- **Goal:** Capacity-safe cohort enrollment with R7 server-derived
  eligibility + the 3 trigger gates surfaced as typed 422s + DST-
  preserving weekly cadence.
- **Work:** ☑ 1 endpoint (`POST /enrollments` `[auth]` owner-only) in a
  new `routes/enrollments.ts` (~270 LOC; distinct from
  `routes/bookings.ts` per §C.1 Model 2 "Never POST /bookings"). The
  transaction protocol:
  ownership-gate-per-dog → `lockCohort(tx, cohort_id)` (Day-3b row lock
  primitive's FIRST live use) → liveness (`expiredAt !== null` → 404)
  → capacity assert against the locked snapshot (`cohort_full` 422 with
  structured `{capacity, filled, requested}` details) → R7 eligibility
  per dog against `class_prereq_options` (`eligibility_missing` 422
  with per-dog `{dog_id, missing_alternatives[]}` details) → 3 gate
  pre-checks (payment → vaccine → agreement, priority order, same
  shape as Day-10) → INSERT `len(dog_ids) × cohort.weeks` single-dog
  bookings + their `booking_dogs` rows + `cancel_deadline_at =
  scheduled_at − 48h` (per `lib/cancelWindow`) → atomic
  `cohortsRepository.bumpFilled(tx, cohort_id, +|dog_ids|)`. NO
  credit_ledger debit (group-class is paid per-purchase, Day 14). NO
  cache invalidation today (`keysToInvalidate: () => []` per the
  cache-invalidation lint convention; Day-19 staff cohort edits will
  add `cohorts:*` patterns). **Body shape per DATA-CONTRACT (frozen):
  `{ cohort_id, dog_ids[] }`** — NOT `{lead_dog_id, additional_dog_ids[]}`
  (the HANDOFF said the latter; the contract wins; each dog becomes a
  lead in its own per-week bookings). **New files:**
  `api/src/routes/enrollments.ts`, `api/src/lib/cohortSchedule.ts`
  (DST-preserving weekly cadence — `computeCohortSessionDates`).
  **Extended files:** `chicagoDate.ts` (+`chicagoWallPartsAt` paired
  with Day-10's `chicagoWallTimeToUtc`); `errors.ts` (+2 typed codes —
  `cohort_full` / `eligibility_missing`); `bookingErrors.ts`
  (+`CohortFullDetails` / `EligibilityGap` types + constructors);
  `cohortsRepository.ts` (+`bumpFilled` Tx-only);
  `bookingsRepository.ts` (`create` grew optional `cohortId?` +
  `sessionReportId?` — single primitive serves both day-program AND
  cohort paths, schema CHECK enforces `(category = 'group-class') =
  (cohort_id IS NOT NULL)`);
  `dogCompletedClassesRepository.ts` (+`findCompletedKeysForDogInTx`);
  `server.ts` (+register). **Test-harness fix (Boy Scout)** —
  `_fixture.ts` teardown reordered `credit_ledger → bookings →
  cohorts → classPrereqOptions → groupClasses` (the
  bookings→cohorts FK was masked when Day-10 didn't write
  `bookings.cohort_id`; Day-11 surfaced it) + cohort delete
  broadened from id-targeted to `classKey IN
  ('puppy','manners-1','manners-2')` so per-test cohort inserts
  don't dangle. **Tests:** 19 contract tests in
  `test/contracts/enrollment-create.test.ts` covering happy 1-dog +
  multi-dog + weekly cadence delta + `cancel_deadline_at = -48h`;
  `cohort_full` with structured details; R7 eligibility-fail (Lola
  missing manners-1) + eligibility-pass (Waffles has manners-1);
  all 3 gates against 'group-class'; cohort row-lock race
  (capacity=1, two concurrent → exactly one 201, one 422); idempotency
  replay (no double-bump filled, no second insertion pass); staff →
  403; unknown dog → 404; unknown cohort → 404; soft-expired cohort
  → 404; missing Idempotency-Key → 400; empty dog_ids → 400;
  duplicate dog_ids → 422.
- **Exit:** ☑ 408/408 tests green (389 prior + 19 Day-11); typecheck +
  lint + format clean. Dev API manual smoke confirmed: /health 200;
  missing Idempotency-Key → 400; empty dog_ids → 400 (Zod min(1));
  bad UUID → 400; duplicate dog_ids → 422 invalid_payload; staff
  principal → 403 forbidden — all through real Fastify pipeline via
  the X-Dev-Principal bypass header.
- **Handoff note:** rule-of-two now active on (a) the gate pre-check
  prelude (payment → vaccine → agreement; extract at Day-12 if it's
  rule-of-three) and (b) `insertBookingWithGateMapping` trigger
  fallback wrapper (booking-create.ts + enrollments.ts; extract at
  Day-12). New shared seam:
  `bookingsRepository.create({cohortId, sessionReportId})` — Day-12
  (approve B&T → INSERT booking) and Day-13 (cancel/refund) inherit.
  Known deferred: duplicate-enrollment prevention (same owner, same
  dog, same cohort, two different Idempotency-Keys, same body would
  replay; different bodies could double-enroll); flagged for Day-13
  cancel-refund revisit since "re-enroll after cancel" interacts.
  Cancel-window 48h for group-class TUNABLE pre-launch.

**Confidence-score self-review (Day-11 sign-off, all ≥ 95):**
- Correctness: 95 — 408/408 green; 19 contract tests cover every
  branch in §4.3 of HANDOFF + 4 extras (cadence delta, cancel_deadline,
  unknown cohort, soft-expired cohort, eligibility-pass, body
  validation × 3). Dev API smoke confirmed /health + 5 validation
  branches through real Fastify. Caught + fixed a latent teardown FK-
  ordering bug Day-10 had masked. What'd push higher: (a) duplicate-
  enrollment prevention deferred; (b) cohort cadence spanning a DST
  boundary is unit-tested at the chicagoWallTimeToUtc primitive level
  but not exercised end-to-end through the route.
- Architecture: 96 — `withMutation` is THE entrypoint (12th
  mutation); `bookingsRepository.create` extended additively
  (cohortId? + sessionReportId? — same primitive serves both
  day-program and group-class); new pure `lib/cohortSchedule.ts`
  for DST-preserving weekly cadence (distinct from Day-10's
  `bookingSchedule.ts` for day-program drop-off windows); single
  lock surface (cohort row lock); two new typed codes extend the
  §A discriminated union without changing existing arms; Boy-Scout
  teardown fix in `_fixture.ts` with explicit FK-chain comment so
  Day-12+ don't re-encounter it. Surfaced + acted on a real
  HANDOFF↔DATA-CONTRACT discrepancy. What'd push higher: gate
  pre-check + `insertBookingWithGateMapping` are both rule-of-two
  now; extract at rule-of-three on Day 12.
- Clean Code: 95 — honest names throughout; `requireOwner`
  literal-union `asserts`; route reads top-to-bottom with
  step-numbered txn-contract comments; JSDoc explains WHY (DST
  preservation, advisory-vs-row-lock for cohort,
  session_report_id NULL-at-enrollment); magic constants
  extracted; TypeScript strict, no `any`. What'd push higher:
  inline duplicate-enrollment caveat in the route docstring is
  slightly long-form (could be a one-line TODO); `addDays` in
  `cohortSchedule.ts` duplicates `parseDateUtcMs` from
  `bookingSchedule.ts` — extract at rule-of-three.

### Day 12 — Txn: pending requests + approve (portal verb 1)
- **Owner:** Allison
- **Depends on:** Day 11
- **Governing contract:** schema.sql txn-notes `approvePendingRequest` (~line 1307) +
  `pending_requests` table + the 3 BOOKING GATES; DATA-CONTRACT §C requests +
  §C.1 Model 3 + §A Amendment 2026-05-24 (Day 12 — POST/PATCH/cancel + approve
  bodies + deny semantic + rule-of-three extractions).
- **Goal:** Request submit/edit/cancel + staff approve→converted booking + B&T pay-step state.
- **Work:** ☑ 5 endpoints landed:
  - **`POST /requests` `[auth]`** — owner-side submission with per-category
    body validation (PL = multi-dog OK; B&T = single dog + length_weeks REQUIRED;
    boarding = multi-dog OK + no length_weeks). Flat Zod schema + in-code
    cross-field validator (`validatePostRequestBody`). 92-day lookahead on
    preferred_dates (matches Day-5b availability cap). Ownership gate per dog.
  - **`PATCH /requests/:id` `[auth]`** — owner edits (preferred_dates / notes /
    focus / length_weeks). Identity fields (category / lead_dog_id /
    additional_dog_ids) locked → 422. State-machine guard: only `status='submitted'`
    is editable; converted/cancelled → 409. PATCH on null clears scalars; partial
    updates leave omitted fields unchanged (Day-9c convention).
  - **`POST /requests/:id/cancel` `[auth]`** — owner self-withdrawal. Allowed
    from `submitted` AND `approved-awaiting-payment` (B&T pre-payment change of
    mind); converted/cancelled → 409. Leaves `approved_by_staff_id` NULL (the
    discriminator that distinguishes owner self-cancel from staff deny).
  - **`POST /staff/requests/:id/approve` `[staff]`** — portal verb 1. Transaction:
    `lockById` (row lock) → assert `status='submitted'` (409 else) → branch on
    category:
      • **board-and-train:** `markApprovedAwaitingPayment` — NO booking insert
        (Day-14 confirm-payment will create it); stamps approved_at +
        approved_by_staff_id; no notification.
      • **private-lesson:** validate body (scheduled_at + location REQUIRED) →
        `checkBookingGates(payment→vaccine→agreement)` → `insertBookingWith
        GateMapping` (single-dog or multi-dog) → `markConverted(convertedBookingId)`
        → enqueue `'booking-confirmed'` notification with deep_link to
        `/bookings/:id` + booking-dogs attached.
      • **boarding:** same as PL plus pickup_at REQUIRED + post-insert UPDATE
        to set `dropoff_at` + `pickup_at` (schema CHECK forbids these columns
        on non-stay categories).
  - **`POST /staff/requests/:id/deny` `[staff]`** — portal denial.
    `markCancelled({approvedByStaffId})` — status='cancelled' (the
    `request_status` enum has no `'denied'` state — see Handoff §6 for the
    documented semantic gap; the `approved_by_staff_id` field is the actor
    discriminator vs owner self-cancel).
  **Rule-of-three extractions** (Day-10 + Day-11 + Day-12 all use these now):
  - `api/src/lib/insertBookingWithGateMapping.ts` (NEW) — the try/catch wrapper
    that maps trigger `check_violation` back to typed `ApiError`. Day-10 +
    Day-11 had inline copies; Day-12 made the third use, extracted to one file.
    `routes/bookings.ts` + `routes/enrollments.ts` retrofitted to consume it.
  - `api/src/lib/bookingGatePreCheck.ts` (NEW) — the payment → vaccine
    (per-dog accumulate) → agreement sequence above the trigger floor. Same
    retrofit across both prior routes; signature is `(tx, {ownerId, dogIds,
    category})`. When Day-12b's `evaluation_required` lands, the priority
    order changes in ONE file.
  **Repo extensions:**
  - `requestsRepository` — +8 mutation methods (`findFullByIdInTx`, `lockById`,
    `create`, `addDogs`, `addPreferredDates`, `update`, `replacePreferredDates`,
    `markConverted`, `markApprovedAwaitingPayment`, `markCancelled`).
    `findDogsByRequestIds` + `findPreferredDatesByRequestIds` grew polymorphic
    runner (`Tx | typeof db`) so mutation routes read back uncommitted writes
    via the tx (uncommitted INSERTs aren't visible to a fresh pool connection).
    `replacePreferredDates` uses UPSERT + leftover-soft-expire (the schema's
    `(request_id, ordinal)` PK is NOT partial-on-expired, so naive soft-expire-
    then-INSERT collided — surfaced + fixed by the contract test).
  - `notificationsRepository` — +`enqueue(tx, {ownerId, type, title, body,
    deepLinkPath, dogIds, senderStaffId})`. First write path on this repo
    (was read-only); generic shape ready for Day-13 cancel + Day-16 scheduler.
  **State-machine notes:** the `request_status` enum has two effectively-dead
  values — `'approved'` (never used; non-B&T approve goes straight to
  `'converted'` per schema txn notes) and the missing `'denied'` state. Day-12
  doesn't relitigate; flagged in HANDOFF for a future amendment IF Day-19
  staff-portal UX requires distinguishing copy.
- **Exit:** ☑ 432/432 tests green (408 prior + 24 Day-12); typecheck + lint +
  format clean. Day-12 contract test file (`api/test/contracts/requests-
  mutations.test.ts`) covers every §4.5 Exit branch + 5 additional edge cases
  (idempotency replay assert by `converted_booking_id`; race on
  `pending_requests` row lock — two concurrent approves → exactly one 200 +
  one 409; B&T two-step parks correctly; boarding sets dropoff_at + pickup_at;
  body-validation negatives × 3). The 24 contract tests through real Fastify +
  Postgres are the manual-smoke equivalent — same pipeline the dev API uses
  via `X-Dev-Principal`.
- **Handoff note:** see HANDOFF for the (a) rule-of-three extraction
  retrofit, (b) the `denied` enum-value gap and the `cancelled` + actor-id
  workaround, (c) deferred items (confirm-payment → Day 14; `/staff/requests`
  GET queue → portal-UI thread; eval-gate pre-check → Day 12b), (d) wireOneRequest
  duplicated assembly across `routes/requests.ts` + `routes/staffRequests.ts`
  (rule-of-two; promotion blocked by repo coupling — declined). Day-12b's eval-
  gate `details.kind` priority would slot into `lib/bookingGatePreCheck.ts`
  cleanly (between payment and vaccine).

**Confidence-score self-review (Day-12 sign-off, all ≥ 94):**
- Correctness: 95 — full happy + idempotency + race + state-machine guard +
  identity-locked + cross-category invariants all covered by 24 contract
  tests. Lint + prettier + `tsc --noEmit` clean. **4 bugs caught + fixed by
  the contract suite mid-development**: `wireRequestsInTx` reading via pool
  not tx (fix: polymorphic runner); `replacePreferredDates` PK collision (fix:
  UPSERT + leftover soft-expire); `validateApproveBody` running before category
  branch (fix: move inside non-B&T branch); test 21's dupe-count assertion
  matched cross-test bookings (fix: assert by `converted_booking_id`). What'd
  push higher: (a) gate-trigger fallback on the approve INSERT isn't
  deterministically tested end-to-end (race window rare; mapper unit-tested
  Day 10); (b) cross-owner "owner A's request not visible to owner B" carries
  the Day-9c second-owner-fixture gap.
- Architecture: 96 — `withMutation` remains THE entrypoint (16 mutations now).
  Two rule-of-three extractions retrofitted across Day-10 + Day-11 + Day-12
  (`insertBookingWithGateMapping`, `checkBookingGates`). `routes/staffRequests.ts`
  new file mirrors Day-11's `routes/enrollments.ts` URL-structurally-distinct
  decision. `requestsRepository` grew 8 mutation methods + 2 polymorphic-runner
  conversions. `notificationsRepository.enqueue` is the first write path with
  a generic shape ready for Day-13/16. Single lock surface (pending_requests
  row lock). Surfaced the `'denied'` enum gap and documented the `'cancelled'`
  + `approved_by_staff_id` workaround. What'd push higher: (a) `wireOneRequest`
  duplicated across `routes/requests.ts` + `routes/staffRequests.ts` (rule-of-
  two; declined for now); (b) `requireOwner` action union at 3 sites — extract
  to `lib/principalNarrows.ts` at rule-of-four; (c) `setBoardingStayWindow`
  inline drizzle update — promote to `bookingsRepository.setStayWindow` at
  rule-of-two (likely Day 13 cancel for boarding).
- Clean Code: 94 — honest names throughout; literal-union asserts predicates;
  step-numbered txn-contract comments; JSDoc on every new public method
  explains WHY. Magic constants extracted at module scope (`MAX_PREFERRED_
  DATES`, `MAX_LOOKAHEAD_DAYS`, `MAX_LENGTH_WEEKS`, etc.). TypeScript strict,
  no `any`. Deliberate scope hygiene (no Stripe in approve; no eval-gate pre-
  check; no `/staff/requests` GET queue). What'd push higher: (a)
  `routes/requests.ts` at ~680 LOC is upper-end of "keep monolithic" —
  consider per-verb split if future days push past ~1000; (b)
  `validateApproveBody` flat if-else chain reads procedural — could be a
  discriminated switch on row.category; (c) `setBoardingStayWindow` has a
  dynamic `import { bookings }` inside the function body (Day-12's borrowed
  shape) — should be top-level.

### Day 12b1 — Evaluation gate backend (4th BOOKING GATE) ☑
- **Owner:** Allison (Claude assisted). FE deltas split off as **Day 12b2** ☐ — see next block.
- **Depends on:** Day 12
- **Governing contract:** DATA-CONTRACT §A "Amendment 2026-05-23"; DATA-CONTRACT §H eval gate bullet
- **Goal:** Promote the existing FE-only day-school/day-care eval gate
  to a server-enforced 4th BOOKING GATE alongside payment/vaccine/agreement,
  widened to also cover board-and-train + boarding (Rachel-confirmed
  2026-05-23 — all four programs require an in-school evaluation first).
- **Work (backend):**
  - **schema.sql** — new `bookings_eval_gate_check` BEFORE-INSERT trigger
    (mirrors `bookings_payment_gate_check` / `bookings_vaccine_gate_check`
    / `bookings_agreement_gate_check` shape): rejects when `NEW.category ∈
    ('day-school','day-care','board-and-train','boarding')` AND any
    `booking_dogs` dog has `dogs.evaluation_status <> 'passed'`. Staff-owned
    dogs (`capacity_exempt`) exempt — same uniform-exemption ruling that
    covers the other §H gates. The `evaluation` category bypasses the gate
    by construction (chicken-and-egg). Trigger raises `check_violation`
    with a structured ERRCODE the API maps to `evaluation_required`.
  - **api/src/lib/bookingErrors.ts** — extend `ApiErrorCode` union with
    `evaluation_required`; extend the gate-error `details` discriminator
    with `kind: 'evaluation_required', missing: { dog_id,
    evaluation_status }[]`; map the new check_violation ERRCODE to it.
  - **api/src/routes/bookings.ts (Day 10 POST /bookings)** — add an eval
    pre-check above the DB floor: walk lead + `additional_dog_ids`, build
    `missing[]` from any dog whose `evaluation_status !== 'passed'`,
    return 422 `evaluation_required` before opening the txn (friendly
    error, no orphan idempotency_keys row).
  - **api/src/routes/enrollments.ts** — group-class is NOT gated by eval
    (R7 prereq system instead). No change needed; gate priority order
    update is doc-only for group/private.
  - **api/src/routes/requests.ts (Day 12 POST /requests)** — for
    `category ∈ ('board-and-train','boarding')`, pre-check the lead dog's
    `evaluation_status` and return `evaluation_required` at the request
    boundary so owners can't submit a request for an un-evaluated dog
    (staff approve-verb would otherwise have to bounce it back).
  - **Gate priority** — update `BOOKING_GATE_PRIORITY` constant (or
    equivalent) to `['payment','evaluation','vaccine','agreement']`.
- **Exit:**
  - Schema: every category in the gate list rejects with the trigger
    when the dog is un-evaluated; `evaluation` category + staff-owned
    dogs pass through. ☑
  - API: `POST /bookings` (via `checkBookingGates`) and `POST /requests`
    (B&T/boarding lead-only pre-check) return 422 `evaluation_required`
    with per-dog `missing[]` before the txn opens; existing routes'
    wire shape unchanged for the happy path. ☑
  - 13 new contract tests in `test/contracts/evaluation-gate.test.ts`
    covering pre-check / bypass arms / trigger floor / staff-dog
    exemption / gate priority / trigger-fallback mapping. ☑
  - 445 total tests green; lint + prettier + `tsc --noEmit` clean. ☑
- **Implementation block (landed 2026-05-24):**
  - `.claude/backend/schema.sql` — new `assert_dog_evaluation_passed()`
    function + `bookings_eval_gate_check` trigger (lead-dog floor;
    'evaluation' category + staff-owned dogs bypass); BOOKING GATES
    transaction-contract comment renumbered to 4 floors with priority-
    order narration (payment → evaluation → vaccine → agreement).
  - `api/src/lib/errors.ts` — `ApiErrorCode` union gains
    `'evaluation_required'` (422). Additive — no existing wire shape
    changed.
  - `api/src/lib/bookingErrors.ts` — `EvaluationGap` interface +
    `UnpassedEvaluationStatus` narrow type + `evaluationRequiredError`
    constructor + `gateTriggerErrorToApiError` branch for the
    `'evaluation gate:'` text prefix.
  - `api/src/db/repositories/dogsRepository.ts` — new
    `findEvaluationStatusInTx(tx, dogIds)` batched lookup
    (polymorphic-runner shape).
  - `api/src/lib/bookingGatePreCheck.ts` — eval gate slots between
    payment and vaccine; `EVAL_GATED_CATEGORIES` set (`day-school`,
    `day-care`, `board-and-train`, `boarding`) mirrors the trigger
    predicate. PL / group-class / evaluation skip by category whitelist.
  - `api/src/routes/requests.ts` — `POST /requests` adds a lead-only
    eval pre-check for board-and-train + boarding (step 3 in the
    transactional flow). PL still bypasses at this boundary
    (staff-curated). Step comments renumbered.
  - `api/test/contracts/_fixture.ts` — Lola's `evaluationStatus` bumped
    from `'not-evaluated'` → `'passed'` so the pre-existing booking2 /
    booking5 (Lola-led day-care + boarding) seed cleanly under the new
    trigger; `evaluation-gate.test.ts` flips her status per-test with
    finally-restore (same shape as the vaccine-gate test's
    expire+restore). `snapshots/dogs.json` updated to match.
  - `api/test/contracts/evaluation-gate.test.ts` — 13 new tests (pre-
    check API, bypass arms, schema floor, staff-dog exemption,
    gate priority, trigger-fallback mapping).
- **Design choices logged in Day 12b1 (don't relitigate):**
  - **Trigger checks LEAD dog only** — mirrors the existing
    payment/vaccine/agreement triggers' shape (`NEW.lead_dog_id`); API
    pre-check accumulates `EvaluationGap` per dog across all
    `booking_dogs` so the FE renders the complete picture.
  - **PL is NOT eval-gated** — at submission OR approve. §A Amendment
    2026-05-23 step 1: "private-lesson is staff-curated." The
    `EVAL_GATED_CATEGORIES` set excludes it; the existing PL approve
    path in `routes/staffRequests.ts` inherits the bypass through the
    shared helper.
  - **POST /requests pre-check is LEAD-only for B&T/boarding** — §A
    Amendment 2026-05-23 step 5. Additional boarding dogs are caught
    by the full `checkBookingGates` call at staff approve time when
    the booking actually inserts.
  - **`UnpassedEvaluationStatus` narrow + `as` cast at gap construction**
    — the loop condition `evaluationStatus !== 'passed'` excludes
    `'passed'` by construction; the cast is provably safe and the type
    comment explains why. Same shape as the existing vaccine pre-
    check's `missing.map(...)` narrowing.
  - **Lola's fixture status bumped to `'passed'`** instead of adding a
    third fixture dog. Fixture state is test scaffolding; the
    real-photo dogs invariant applies to FE-displayed dogs, not the
    contract-test seed.
- **Handoff note:** Day 12b2 (FE deltas) is the next thread's work:
  extract `<EvaluationGateModal>` from `booking-flow/day-school.tsx`
  into `mobile/src/components/`, add the dog-profile program-tile
  gate, give `boardtrain.tsx` + `boarding.tsx` the same picker parity,
  and add the `'failed'` copy variant. The backend contract is locked;
  the FE deltas are mock-wire only (no real-API calls) until Day 18.

### Day 12b2 ☑ — Evaluation gate FE deltas (EvaluationGateModal extraction + program-tile gate + picker parity)
- **Owner:** Claude (FE)
- **Depends on:** Day 12b1 (done)
- **Governing contract:** DATA-CONTRACT §A "Amendment 2026-05-23" step 6
- **Goal:** Promote the existing inline FE eval gate (previously only
  on `booking-flow/day-school.tsx`) to a shared component used at four
  sites: day-school picker, boardtrain picker, boarding picker,
  dog-profile program tile.
- **Work shipped (FE — mock-wire, prototype-phase polish):**
  - **Extracted `<EvaluationGateModal>`** to
    `mobile/src/components/EvaluationGateModal.tsx`. Props as spec'd:
    `{ dog: Dog | undefined; visible: boolean; onClose: () => void;
    onBookEvaluation: (dogId: DogId) => void }`. Three copy branches
    keyed on `dog.evaluationStatus`: `'not-evaluated'` / `'pending'` /
    `'failed'`. Body copy enumerates all four gated programs (Day
    School, Day Care, Board & Train, boarding) so the message stays
    honest regardless of which surface triggered the modal. Day-school
    consumes the shared component in place of the prior inline block.
  - **Dog Profile program-tile entry gate.** Added
    `EVAL_GATED_PROGRAMS` Set (`'school' | 'daycare' | 'boardtrain' |
    'boarding'` — mirrors backend `EVAL_GATED_CATEGORIES`) at
    `mobile/app/dog-profile/[dogId]/[program].tsx`. When in a gated
    program AND `dog.evaluationStatus !== 'passed'`, the modal mounts
    on first render. Primary CTA →
    `pushPathWithParams('/booking-flow/evaluation', { dogId })`;
    `onClose` (Maybe-later tap + backdrop tap) routes `router.back()`.
  - **Booking-flow picker parity.** `<DogPickRow>`'s `ineligibleReason`
    prop hoisted from checkbox-only to both modes (1-line type change,
    backward compatible); radio's `accessibilityState` now also
    exposes `disabled` when ineligible. `boardtrain.tsx` and
    `boarding.tsx` pass `ineligibleReason="Free evaluation needed"`
    for un-passed dogs and branch in their parent `chooseDog`/`toggleDog`
    handlers to open the modal instead of selecting. Day-school
    continues to use `<DogSelectorRow isLocked={…}>` (horizontal pill
    primitive) — both primitives feed the same modal.
  - **Failed-eval copy variant** — third branch landed with
    Allison-approved warmer copy:
    - Title: "Let's give it another try"
    - Body: "{dog.name} just needs another chance! Book a follow-up to
      try again."
    - Primary CTA: "Book follow-up evaluation"; Secondary: "Maybe later"
  - **Mock data surgery (out-of-spec robustness improvement).** Charlie
    + Milo converted to persistent un-passed states to demo all three
    un-passed copy branches at app launch without temp JSON edits:
    - Charlie → `'failed'` with `evaluation_date` ~3 weeks ago.
    - Milo → `'pending'` with `evaluation_date` ~2 weeks out.
    Their past bookings (14 + 27), reports (7 + 20), notifications
    (3 entries), credit rows (2), and `dogReportPhotos` registry
    entries all scrubbed for narrative coherence. Asset files
    untouched on disk (re-registerable if either dog returns to
    `'passed'`). See CLAUDE.md File Locations for updated cohort tiers.
- **Verification:** tsc clean; eslint clean; **114/114 Jest tests
  pass** including the existing `<DogPickRow>` test suite after the
  ineligibleReason widening AND the new 4-test
  `<EvaluationGateModal>` suite covering all 3 copy branches +
  visible-false / dog-undefined fallback. Simulator smoke handled
  by Allison (4 sites × 3 copy variants).
- **Polish pass (same session, post-sign-off):**
  - Added `mobile/src/components/__tests__/EvaluationGateModal.test.tsx`
    — 4 tests, all branches covered.
  - Extracted `GATED_PROGRAMS_DISPLAY_LIST` constant in
    `EvaluationGateModal.tsx` (the 4-program enumeration was
    duplicated across two branches; JSDoc on the constant
    documents the three-source-of-truth obligation).
  - Extracted `findDogById(dogs, id: DogId | null): Dog | undefined`
    helper at `mobile/src/lib/findDog.ts`; consumed at 4 sites
    (boardtrain + boarding, in `chooseDog`/`toggleDog` AND in the
    modal-mount JSX expression — the modal mount collapsed from a
    4-line nested ternary to a single function call).
- **Second polish pass (home eval-reminder strip widening):**
  - Closed the previously-banked Architecture gap: the home page's
    `dogsNeedingEval` filter was `'not-evaluated'`-only, hiding
    Charlie ('failed') and Milo ('pending') from the
    actionable-reminders strip. Widened to `!== 'passed'`.
  - `EvalReminderCard` (`mobile/src/features/home/`) gained
    status-aware copy via a `copyForDog(dog)` helper — three
    branches matching the modal: 'not-evaluated' (existing
    "Schedule X's free evaluation!" copy unchanged), 'failed'
    ("X just needs another chance!" + "Book follow-up evaluation"),
    'pending' ("X's evaluation is {date}" + "View profile" tag
    "Scheduled" instead of "Action Needed"). Pending fallback
    "X's evaluation is scheduled" when no `evaluationDate`.
  - Per-status routing in `app/(tabs)/index.tsx`: 'not-evaluated'
    + 'failed' route to `/booking-flow/evaluation?dogId=…`;
    'pending' routes to `/dog-profile/${dogId}` (informational, no
    booking action needed).
  - Added `mobile/src/features/home/__tests__/EvalReminderCard.test.tsx`
    — 4 tests covering all 3 branches + the pending-without-date
    fallback. 114 → 118 total Jest tests.
- **Deviations from the literal HANDOFF spec (intentional):**
  1. **Body copy genericized** to enumerate all 4 gated programs
     (HANDOFF said "keep as-is"; original copy named only "Day School
     and Day Care," which lies when the modal fires from boardtrain /
     boarding).
  2. **`<DogPickRow ineligibleReason>` instead of `<DogSelectorRow
     isLocked>`** for boardtrain + boarding (HANDOFF mistakenly named
     `DogSelectorRow`; those flows use `DogPickRow`'s vertical-row
     primitive, which already had the affordance for checkbox mode).
- **Refactor observations banked (rule-of-N), post-polish-pass:**
  - ☑ `findDogById` lookup helper RESOLVED via the polish pass
    — now lives at `mobile/src/lib/findDog.ts`.
  - ☐ `ineligibleReason` conditional spread repeats in boardtrain +
    boarding `<DogPickRow>` consumers (rule-of-two). Kept inline —
    a `lockedRowProps(dog)` wrapper would add indirection without
    removing real complexity.
  - ☑ Modal's program-list literal RESOLVED via
    `GATED_PROGRAMS_DISPLAY_LIST` extraction in the polish pass.
  - ☑ Home page's `dogsNeedingEval` filter widened from
    `'not-evaluated'`-only to `!== 'passed'` (second polish pass).
    `EvalReminderCard` gained status-aware branches with
    per-status routing at the consumer site.

### Day 12b2+ — Demo notification suite + post-eval result screens + booking-confirmed screen
- **Owner:** Claude (FE; out-of-spec demo work, post-Day-12b2 polish)
- **Why:** PHASE-PLAN line 641 deferred the system-push deep-link
  routing FE half to Phase 3. Allison wanted a demo-able end-to-end
  notification → tap → screen flow on TestFlight builds, exercising
  the same `deepLinkPath` convention real production pushes will use.
  Forces us to land the FE routing pattern now rather than at backend-
  swap time, plus build the destination screens for the eval-result +
  request-accepted notification types that don't yet exist as routes.
- **Work shipped:**
  - **System-push response listener** at `app/_layout.tsx`. Uses
    `Notifications.useLastNotificationResponse()` (React hook, stable
    reference) + a module-scoped `handledNotificationIds: Set<string>`
    for dedup across remounts. Routes via `pushPath(data.deepLinkPath)`
    using the same shape the in-app `<NotifPopover>` already uses.
    Earlier attempt with `getLastNotificationResponseAsync` + an
    imperative `addNotificationResponseReceivedListener` subscription
    accumulated ~45 listener fires per tap across a dev hot-reload
    session; the hook + dedup pattern is now the locked convention.
  - **`sendDemoNotification(kind: DemoNotificationKind)` dispatcher**
    in `mobile/src/lib/pushNotifications.ts`. 7 variants:
    `'report-card'`, `'message'`, `'boardtrain-accepted'`,
    `'boarding-accepted'`, `'private-accepted'`, `'eval-passed'`,
    `'eval-failed'`. Each produces a `{ title, body, data:
    { deepLinkPath, kind } }` shape; the underlying schedule call
    fires 3 seconds out so the user can lock the phone or background
    the app to verify both lock-screen and foreground banner paths.
  - **`app/info/demos.tsx`** gained a "Notifications" section card
    with one button per kind. Surfaces an `Alert` if iOS notification
    permission is denied.
  - **Two new eval-result screens** at `app/eval-result/passed.tsx`
    and `app/eval-result/failed.tsx`. Passed: navy celebration with
    animated spring check + dog avatar + "Programs unlocked" list +
    "Book {name}'s first session" CTA. Failed: terracotta empathetic
    chrome + "What to work on" 3-item list + closing rooting-for-you
    card + "Reschedule evaluation" CTA. Both read `dogId` from URL
    params via `findDogById` and render dog-name-aware copy. Reachable
    from the eval-passed / eval-failed demo notifications and (in
    future) from the real eval-booking-flow's post-result step.
  - **New `app/booking-confirmed/[id].tsx`** — service-tinted
    "Confirmed!" screen for the three request-shaped categories
    (B&T / boarding / private-lesson). Mirrors the day-school
    `<ConfirmedView>` chrome (green check + animated spring + big
    italic "Confirmed!" + sessions card + Add to Calendar + Done) but
    tints the accent per `request.category` via `getAccentTokens`:
    terracotta for B&T, pink for boarding, purple for private. Loads
    the `PendingRequest` via `bookingService.findPendingRequestById`
    and renders per-category date + length + trainer details.
    Reachable from the 3 accept-flavored demo notifications.
  - **`<RequestDetailsModal>` ("See more details")** co-located in
    `app/booking-confirmed/[id].tsx`. Read-only sheet that surfaces
    everything the user originally filled out on the request: comfort
    level (private-lesson), preferred trainer (when staff focusTag
    is set + value ≠ 'any'), program length (B&T), preferred dates
    with ordinal badges + category-aware labels ("Preferred dates &
    times" for private-lesson with `'EEE, MMM d · h:mm a'` format;
    "Preferred start dates" for B&T with `'EEE, MMM d'` format),
    and the per-dog notes. Shown for `private-lesson` AND
    `board-and-train` categories (boarding excluded for now; trivial
    to add when needed — just extend the button guard).
  - **Mock data ID fix** — earlier demo notification deep-link IDs
    were truncated to `req-a1b2c3d4-0003-4e5f-8a` (Python `[:25]`
    slice from inspection); full UUIDs from `pending-requests.json`
    are now used. Without this fix the deep links would have 404'd.
  - **Message notification body** updated to follow Apple's iMessage
    convention: title is just the sender name (`'Rachel'`); body IS
    the actual message text, written long enough that iOS naturally
    truncates with ellipsis on the lock-screen banner. No
    pre-truncation or "tap to read" filler — iOS handles wrap +
    ellipsis based on banner width.
- **Demo flow (TestFlight + simulator):**
  1. Open Demos screen → tap any notification variant
  2. Lock phone or background the app within 3 seconds
  3. Lock-screen banner appears with the right title + body
  4. Tap the banner → app launches (cold-start) or foregrounds
     (warm) to the destination screen with the right dog/request
     pre-loaded
- **Verification:** tsc clean; eslint clean; **118/118 Jest tests
  pass** including the existing `<EvaluationGateModal>` + new
  `<EvalReminderCard>` 4-test suite. No new tests for the
  result/confirmed screens (prototype phase; simulator smoke is the
  validation).
- **Confidence-pass polish (same session, post-sign-off):**
  - **Promoted `COMFORT_LABEL` to `lib/focusTags`.** Rule-of-three
    resolved across booking-flow/private + request-detail/private
    + booking-confirmed. Options arrays now derive labels from the
    canonical mapping.
  - **Extracted `demoNotificationFixtures.ts`** (mock IDs for the
    Demos screen) so `pushNotifications.ts` is just dispatching
    logic — no mock-data coupling.
  - **Extracted `<RequestDetailsModal>`** to
    `mobile/src/features/booking-confirmed/RequestDetailsModal.tsx`.
    `booking-confirmed/[id].tsx` shrunk from 731 → 589 lines.
  - **Exported `contentFor(kind)`** from `pushNotifications.ts` as
    the testable pure-function boundary.
  - **+21 tests:** 8 for `contentFor` (all 7 kinds + an
    exhaustiveness sweep), 13 for `<RequestDetailsModal>` (every
    conditional section, comfort/trainer/length/notes edge cases,
    onClose). 118 → **139 Jest tests pass**.
  - Confidence scores **88/91/90 → 96/96/95** (Correctness /
    Architecture / Clean Code). No detriment to codebase — smaller
    files, less duplication, more coverage.
- **Out of scope (for Day 13+ or production push wiring):**
  - Backend push origination (Supabase Edge Function + APNs/FCM
    direct or Expo push service).
  - `device_tokens` table mapping registered Expo push tokens to
    signed-in users (PHASE-PLAN line 641 still has this open).
  - `setBellPulse(true)` fanout on real push receipt (the in-app
    bell pulse + haptic still need server-originated wire-up).
  - "See more details" on boarding-accepted (trivial when wanted —
    extend the button guard in `booking-confirmed/[id].tsx`).
- **Refactor observations banked:**
  - Two-source-of-truth for `COMFORT_LABEL` (private-lesson booking
    flow + booking-confirmed modal). Promote to `lib/focusTags`
    once a 3rd consumer shows up.
  - The `<RequestDetailsModal>` is currently co-located in
    `booking-confirmed/[id].tsx`. If we add it to boarding (3rd
    consumer beyond private-lesson + B&T), extract to its own file.

### Day 13 — Txn: cancelBooking + refunds + cancel window + staff-tunable policy ☑
- **Owner:** Allison
- **Depends on:** Day 12b1 (Day 12b2 is FE — does not block backend Day 13)
- **Governing contract:** schema.sql txn-notes `cancelBooking`; DATA-CONTRACT §I
- **Goal:** Cancellation with correct forfeit vs refund branching, plus
  Shanthi-tunable per-category windows from the staff portal.
- **Landed (2026-05-26):**
  - **`cancel_window_settings` table** — Phase-3 §A amendment. One row
    per service_category, seeded at 48h flat across all 7. Active policy
    storage; the per-category default table in `lib/cancelWindow.ts`
    becomes the API-side fallback only.
  - **POST /bookings/:id/cancel** — owner-self cancel txn. Three
    outcome branches:
    - FORFEIT: `now > cancel_deadline_at`. `cancel_forfeited=true`;
      no ledger, no refund; capacity flips via status='cancelled'.
    - CREDIT-BACK: one +1 `cancel-refund` ledger row per original
      `booking-debit` (multi-dog → N rows).
    - MONEY-BACK: `refunds` row at 'pending' with `amount = charge
      - sumNonFailedForCharge` (cumulative-cap rule honored). Stripe
      API call is post-commit stub today; Day-14 wires the real seam.
    - Group-class returns 422 — out of scope; cohort-withdraw is its
      own verb (deferred).
    - Enqueues `booking-cancelled` notification with category-aware
      body and forfeit-aware copy.
    - Cache pattern wipe: `avail:{location}:*` post-commit.
  - **GET /staff/cancel-window + PATCH /staff/cancel-window/:category**
    — staff portal verb 3 (after Day-12's approve/deny). Owner gets 403.
    Body validation: `hours_before` in [1, 720]. PATCH stamps
    `updated_at` + `updated_by_staff_id`. Affects future bookings only —
    existing rows keep their stamped deadline (cross-policy test
    pins this invariant).
  - **`lib/principalNarrows.ts`** — extracted `requireOwner` +
    `requireStaff` from 6 sites (bookings, dogs, enrollments, requests,
    staffRequests, vets). The `action` parameter is now a free-form
    verb phrase that appears after "only owners may" / "only staff may".
  - **`topUpCredits` test helper** — promoted to `_fixture.ts`
    (rule-of-three: booking-create + evaluation-gate + booking-cancel).
  - **New repos:** `cancelWindowSettingsRepository`, `chargesRepository`,
    `refundsRepository`. `bookingsRepository` extended with `lockById`,
    `findFullByIdInTx`, `markCancelled`. `creditLedgerRepository`
    extended with `findDebitsForBooking`, `refundForBooking`.
  - **`cancelWindow.ts`** refactored: pure `computeCancelDeadlineFromHours`
    + renamed fallback `defaultFreeCancelHoursBefore`. Callers do
    `await resolveHoursFor()` + `computeCancelDeadlineFromHours()`
    (no DB import in the lib; avoids the lib ↔ repo cycle).
  - **Test fixture teardown** — `charges` + `refunds` rows added to
    the FK delete order; `_harness.ts` after-hook wrapped in
    try/finally so `closeRedis` runs even on teardown failure.
    Earned 2026-05-26 (FK violation hung a subprocess for 2h+).
- **Exit:** all three branches (forfeit / credit-back / money-back)
  tested + staff verb tested + cross-policy invariance tested.
  468/468 tests green (was 445).
- **Handoff note:** cumulative-refund→`charges.refunded` flip is
  Day-15's webhook responsibility (when sum of succeeded refunds ==
  charge.amount_cents). Day-13 only writes the 'pending' row.

### Day 14 — Stripe test-mode core
- **Owner:** Allison
- **Depends on:** Day 13
- **Governing contract:** DATA-CONTRACT payments §G; schema.sql payments
- **Goal:** Cards + charges + credit purchase in Stripe test mode, payment-guaranteed.
- **Work:** ☑ `lib/stripe.ts` (Stripe SDK 22.x thin wrapper; `StripeClient`
  interface with 5 verbs + `defaultStripeClient`; DI seam through route opts
  so contract tests inject `_stripeStub.ts` and stay offline);
  `stripeCustomersRepository` (lazy-provisioning `findByOwner` + `create`);
  `chargesRepository` extended (`create`, `findByStripePaymentIntentId`,
  `markStatus` — last one pre-positioned for Day-15 webhook);
  `paymentMethodsRepository` extended (`findLiveByIdForOwner`, `create`,
  `clearDefault`, `setDefault`, `softExpire`; polymorphic-runner so pre-tx
  reads work too); `creditLedgerRepository.creditPurchase` (`+N delta`,
  `reason='purchase'`, with `package_key` + `charge_id` linking);
  `creditPackagesRepository.findByKey`. Routes: **POST
  /payment-methods/setup-intent** (lazy-provisions `stripe_customers` row +
  creates Stripe `SetupIntent`; idempotency-key flows to both Stripe and
  the DB), **PATCH /payment-methods/:id** (default-card toggle; clear-
  then-set inside one tx preserves the partial-unique invariant),
  **DELETE /payment-methods/:id** (soft-expire + post-commit Stripe
  detach; failures swallow-and-log; replay skips the detach),
  **POST /credit-packages/:key/purchase** (`paymentIntents.create
  + confirm` with stored card; writes `charges` row mirroring Stripe
  status; writes `credit_ledger` purchase grant only on `succeeded`;
  3DS/processing paths return the `client_secret` for Day-15 webhook
  reconciliation). **Cancel route money-back wire**: Day-13 stub
  replaced — `pendingStripeRefund` closure captures the refund row id +
  PI id + amount; post-commit `stripe.createRefund` fires (idempotency-
  keyed); failure swallow-and-log; replay skips. Tests:
  `_stripeStub.ts` (in-memory `StripeClient` with call recording +
  status overrides); `payment-methods-mutations.test.ts` (15 tests:
  setup-intent / PATCH default / DELETE soft-expire + detach +
  swallow / replay behavior); `credit-purchase.test.ts` (8 tests:
  succeeded path / requires_action / replay / 404s / 422 / staff);
  3 new booking-cancel tests for the refund wire (fires post-
  commit / swallow on failure / replay skips). Fixture: `_fixture.ts`
  now seeds `stripe_customers` row + resets `cancel_window_settings`
  to 48h on every seed (Day-13 leak fix); `credit_ledger` → `charges`
  teardown FK order corrected. **Post-review refactor pass** (per
  Allison's "easy for additions" review): extracted
  `stripeIntentStatusToChargeStatus` from `routes/creditPackages.ts`
  to `lib/stripe.ts` (Day-15 webhook will be the 2nd caller —
  promoted at the foreseen 2nd site rather than later);
  `MutationParams.postCommit?: (body) => Promise<void>` added to
  `db/mutation.ts` — generalizes the swallow/log/skip-on-replay
  pattern; DELETE /payment-methods + cancel-route money-back BOTH
  refactored to use it (the closure-captured refund handle still
  lives in the route scope, but the boilerplate is one declaration);
  `_stripeStub.calls` typed as a discriminated union so test
  assertions read typed `.args` without `as` casts; new contract
  test exercises `chargesRepository.markStatus` directly so the
  Day-15 webhook entry point isn't a bare pre-positioned method;
  `teardownFixture` JSDoc documents the FK precedence invariant
  with each entity's precedence rule + the 2026-05-26 earned hazard.
- **Exit:** ☑ **495/495 tests green** (468 prior + 27 new: 26 from
  the initial Day-14 pass + 1 from the refactor pass). tsc + eslint
  clean. Stripe CLI **manual smoke against test-mode passed
  end-to-end**:
  customer create → SetupIntent → PaymentIntent succeeded
  (synchronous-confirm path with stored `pm_card_visa`) → `charges` +
  `credit_ledger` written → cancel-booking → Stripe refund created
  server-side (`re_*` succeeded; DB row at 'pending' awaiting Day-15
  webhook).
- **Handoff note:** Stripe test keys live in `api/.env.local`
  (`STRIPE_SECRET_KEY=sk_test_*`, `STRIPE_WEBHOOK_SECRET=whsec_*`);
  `payments_enabled` is OFF until go-live (Day 20). The `payment_methods`
  write path is **NOT** synchronous in Day-14 by design — the FE confirms
  SetupIntent client-side via Stripe Elements and Day-15's
  `setup_intent.succeeded` webhook writes the row. PAYG
  (`charges.purpose='payg'`) is **deferred** — Day-14 scoped to cards /
  credit-purchase / refund-wire. PAYG adds the path inside POST
  /bookings; small follow-up. Day-15 wires `POST /webhooks/stripe`
  (signed) to reconcile: `payment_intent.succeeded/failed` flips
  `charges.status`; `setup_intent.succeeded` writes `payment_methods`
  row + `retrievePaymentMethod` for displayable bits;
  `charge.refund.updated` flips `refunds.status` + cumulative-refund
  rule flips `charges.status` to 'refunded'.

### Day 15 — Stripe webhooks + invoices + dunning worker
- **Owner:** Allison
- **Depends on:** Day 14
- **Governing contract:** DATA-CONTRACT payments; schema.sql invoices/refunds
- **Goal:** Async settlement + card-backed invoice auto-charge.
- **Work:** ☑ `POST /webhooks/stripe` `[public, signed]` — Fastify raw-
  body scope (mirrors Day-2 auth-webhook); `lib/stripe.ts` extended with
  `constructWebhookEvent` + narrow `StripeWebhookEvent` discriminated
  union (insulates app from `Stripe.Event` wide type; projection in
  `projectStripeEvent`). **Dedupe via new `stripe_events` table** (§A
  Day-15 amendment) — `claim → dispatch → markProcessed/release`
  lifecycle: insert-on-conflict claims the slot, dispatch runs in a
  `withActor('system:stripe-webhook', tx)` block (Day-2 precedent),
  success marks `processed_at`, failure releases the row so Stripe's
  retry re-enters dispatch. **4 event handlers** in `src/webhooks/
  stripeEventHandlers.ts`:
  - `payment_intent.succeeded` — flip charge → 'succeeded' (idempotent
    if already terminal); if `purpose='package'` AND no ledger row,
    write the credit_ledger purchase row using PI metadata
    (dog_id/package_key/credits/mode — Day-14 metadata now carries
    `mode` too for the async-confirm catch-up case).
  - `payment_intent.payment_failed` — flip charge → 'failed';
    defensive reverse of any provisional purchase ledger row via
    `reason='adjustment'` append.
  - `setup_intent.succeeded` — find owner via
    `stripeCustomersRepository.findByStripeCustomerId` (NEW reverse
    lookup); `stripe.retrievePaymentMethod` for displayable bits; INSERT
    `payment_methods` row idempotently (dedupe on stripe_payment_method_id);
    `isDefault=true` if owner has no other live cards.
  - `charge.refund.updated` — find refunds row by `stripe_refund_id`
    OR race-fallback by `(charge_id, amount, status='pending', stripe_refund_id IS NULL)`;
    flip status; on 'succeeded' apply the cumulative-refund rule
    (`SUM(succeeded) >= charge.amount` → `charges.status='refunded'`).
  - `unhandled` arm 200s + logs so a future Stripe event type doesn't
    break the receiver. **`POST /invoices/:id/pay`** [auth, $] — mirrors
    credit-purchase shape; pre-tx Stripe call; succeeded path writes
    charges row + flips invoice via `invoicesRepository.markPaid`;
    requires_action path writes charge at 'requires_payment' and
    returns client_secret. **New `peekCompletedIdempotency` helper** in
    `db/idempotency.ts` short-circuits the replay-against-paid-invoice
    case (the state-mutating-route pattern — pre-validation reads the
    field the mutation writes; idempotency replay would otherwise be
    blocked by the post-mutation pre-validation). **Invoice auto-charge
    worker** in `src/workers/invoiceAutoCharge.ts` — `runInvoiceAutoChargeOnce
    (opts)` claims a due batch via `FOR UPDATE SKIP LOCKED`, per-invoice
    runs Stripe `paymentIntents.create+confirm` (idempotency-keyed on
    `auto-charge:{invoice.id}:{attempts}`), succeeded → `markPaid`, fail
    → `recordFailedAttempt` with exponential backoff (1m / 1h / 24h /
    72h then park; `MAX_AUTO_CHARGE_ATTEMPTS=4`). Day-16 wires the
    recurring trigger. **`POST /requests/:id/confirm-payment`** [auth, $]
    — B&T `approved-awaiting-payment` → `converted`. Server-authoritative
    pricing via `lib/boardTrainPricing.ts` (anti-scam parity with §G —
    FE can't underpay). Pay-now: Stripe call + INSERT charges +
    `insertBookingWithGateMapping` (B&T category) + stamp dropoff/pickup +
    `markConverted` + booking-confirmed notification. Pay-later: same
    shape but INSERT `invoices` (status='open', payment_method_id
    required) instead of the Stripe call. **Day-14 latent gap closed**:
    cancel-route postCommit now also persists `stripe_refund_id` via
    `refundsRepository.markStripeId` so the webhook matches refunds
    deterministically (race-fallback exists for the rare pre-postCommit
    delivery window). **Repository extensions**:
    `stripeEventsRepository` (NEW — claim/markProcessed/release/findProcessedState/countUnprocessed),
    `stripeCustomersRepository.findByStripeCustomerId`,
    `refundsRepository` extended (`sumSucceededForCharge`,
    `markStripeId`, `findByStripeRefundId`,
    `findUnmatchedPendingForCharge`, `markStatus`, `RefundStatus`
    type), `chargesRepository.findById`, `invoicesRepository` (NEW —
    `findByIdForOwner` / `createOpen` / `markPaid` /
    `lockDueOpenForUpdate` (FOR UPDATE SKIP LOCKED) /
    `recordFailedAttempt` / `findOpenByOwner` / `findPastDueOpen`).
    **`lib/loadStripePaymentContext`** extracted at rule-of-two —
    credit-purchase + invoice-pay + B&T confirm-payment now all reuse.
    **`lib/wireOneRequest`** extracted at rule-of-two — staff-approve +
    B&T confirm-payment. **`lib/boardTrainPricing`** (server-side price
    table). **Stub extension**: `_stripeStub` now exposes `setNextEvent`
    + `constructWebhookEvent` (records calls in the discriminated
    union; throws `ApiError('bad_request')` when event=null to mirror
    bad-sig). **Fixture**: `teardownFixture` adds `stripe_events`
    pattern-delete (`LIKE 'evt_test_%'`) + `invoices` FK-ordered delete
    before payment_methods. **Tests added**: 25 new contract tests
    bringing suite to **520/520 green** (495 prior + 25):
    `stripe-webhook.test.ts` (12), `invoice-pay.test.ts` (6),
    `invoice-auto-charge-worker.test.ts` (4), `request-confirm-payment.test.ts` (5).
- **Schema amendment**: `stripe_events` table (DATA-CONTRACT §A Day-15
  amendment). 47 → 48 tables.
- **Exit:** ☑ **520/520 tests green**; tsc + eslint clean. **LIVE Stripe
  CLI smoke against test-mode passed** — all 4 trigger families
  (`payment_intent.succeeded` / `.payment_failed` / `setup_intent.succeeded`
  / `charge.refund.updated`) round-tripped through `constructWebhookEvent`
  → narrow event → dispatch → claim/processed. Orphan-event /
  refund-not-yet-recorded outcomes correctly classified (fixture data
  not in our DB — the DB-write paths are tested via contract tests).
  Unrelated Stripe events (`charge.succeeded`, `refund.created`, etc.)
  collapsed to `noop` via the `unhandled` arm — future-proof.
- **Handoff note:** webhook dedupe lives in `stripe_events` (new table,
  permanent retention); event id (`evt_*`) is the PK. The peek-then-
  replay pattern for state-mutating routes (`peekCompletedIdempotency`
  in `idempotency.ts`) is the canonical seam for future routes whose
  pre-validation depends on the field the mutation writes. **Known
  caveats**: (a) 3DS pay-later async path writes `charges` at
  'requires_payment' but leaves the invoice 'open' — the webhook
  flips the charge but doesn't re-settle the invoice (no
  `charges.invoice_id` link in schema). (b) Worker test's failure case
  uses soft-expire of the card; an explicit Stripe-decline test would
  need a `setNextIntentFailure()` stub knob (easy follow-up).
  (c) `WebhookHandlerResult.outcome` 10-arm string union; consider
  enumify if it grows. Confidence scores **95 / 96 / 95**.

### Day 16 — Scheduler worker ☑
- **Owner:** Allison
- **Depends on:** Day 15
- **Governing contract:** schema.sql `scheduled_notifications` notes
- **Goal:** Outbound push/notification scheduling, exactly-once.
- **Work:** ☑ `src/workers/scheduler.ts` — `runSchedulerTickOnce(opts)`
  composes three phases under `system:scheduler` actor:
  - **Phase 1** — `scheduled_notifications` claim + deliver. `FOR UPDATE
    SKIP LOCKED` on `(status='pending', scheduled_for <= now())` so
    concurrent ticks divide the queue. Per row: INSERT `notifications`
    + `notification_dogs` denorm via `notificationsRepository.enqueue`,
    mark schedule row `'sent'` + link `emitted_notification_id`. Push
    messages collected in-memory; dispatched post-commit (best-effort —
    DB is source of truth; transport failure logged-and-swallowed).
  - **Phase 2** — `runInvoiceAutoChargeOnce` (Day-15 composed). One
    cron firing handles BOTH outbound notifications AND invoice dunning.
  - **Phase 3** — `sweepExpiredIdempotencyKeys` (24h cutoff). Per
    schema.sql lines ~918-920 — the ONE table exempt from never-delete.
  **Trigger catalog** (`lib/enqueueBookingReminders.ts`, called from all
  4 booking-creation paths — `routes/bookings.ts` day-program,
  `routes/enrollments.ts` cohort, `routes/staffRequests.ts` approve,
  `routes/requestConfirmPayment.ts` B&T):
  - `booking-reminder:<bookingId>` — always, at `scheduledAt - 24h`,
    type `'booking-reminder'`. Uniform window across categories for v1.
  - `boarding-24h:<bookingId>` — only `'boarding'` / `'board-and-train'`,
    at `(dropoffAt ?? scheduledAt) - 24h`, type `'boarding-profile-check'`.
  - `report-published:<reportId>` — reserved (Day-19 publish surface).
  `dedupe_key UNIQUE` constraint makes re-enqueue idempotent (Postgres
  serializes ON CONFLICT DO NOTHING; an Idempotency-Key replay of the
  booking-creation tx no-ops on the schedule rows). Past-due
  `scheduled_for` is fine — booking placed <24h ahead → user gets the
  reminder near-immediately (doubles as a confirmation; the type
  distinguishes it from `'booking-confirmed'`). **New repositories**:
  `scheduledNotificationsRepository` (claim due / markSent / enqueue
  idempotent / findByDedupeKey / countDuePending), `deviceTokensRepository`
  (findLiveByOwner). **`db/idempotency.ts` extension**:
  `sweepExpiredIdempotencyKeys({olderThan})` — pool runner, returns
  delete count. **Expo seam**: `lib/expoPush.ts` — `ExpoPushClient`
  interface + `defaultExpoPushClient` (POSTs `https://exp.host/--/api/v2/push/send`)
  + `_expoPushStub.ts` mirroring the `_stripeStub` pattern. **`POST
  /workers/tick`** `[public, signed]` — bearer-secret gate
  (`SCHEDULER_WEBHOOK_SECRET` env, constant-time compare), calls
  `runSchedulerTickOnce`, returns the tick result summary. Injectable
  `runTick` opt for test isolation. **Schema amendment** (§A 2026-05-26):
  `notification_type` enum gains `'booking-reminder'` and
  `'boarding-profile-check'` — additive only. **Fixture**:
  `teardownFixture` adds explicit `scheduled_notifications` +
  `device_tokens` deletes (the FK `emitted_notification_id →
  notifications.id` has no ON DELETE so schedule rows must drop before
  notifications). **Tests added**: 18 new tests bringing suite to
  **538/538 green** (520 prior + 13 `scheduler-worker.test.ts` +
  4 `workers-tick.test.ts` + 1 sweep direct).
- **Schema amendment**: `notification_type` enum extended with 2 arms
  (DATA-CONTRACT §A Day-16 amendment). No new tables — 48 tables
  unchanged.
- **Exit:** ☑ **538/538 tests green** locally against the docker-compose
  test pg; tsc + eslint clean; live `POST /workers/tick` smoke against
  the dev API returned `{scheduled:0, invoices:0, swept:0}` (200);
  missing-bearer + wrong-bearer both 401. `runSchedulerTickOnce` with a
  pinned `now=2026-05-26T12:00:00Z` flips a seeded due row to `'sent'`,
  inserts a `notifications` row with the right `type` and
  `deep_link_path`, fans the push to all live device_tokens, and
  composes with the Day-15 invoice tick + the idempotency TTL sweep.
- **Production scheduler trigger (operational handoff to Day 20)**:
  pg_cron + pg_net is the locked primitive (matches Supabase-hosted
  Postgres; one less moving part than a separate process). Day-16
  ships the worker function + the signed HTTP entrypoint; Day-20 wires
  the cron schedule. SQL to schedule the recurring tick (commented in
  the schema or applied via a separate ops migration — NOT in the
  test-loaded schema.sql so the cron extension isn't required for
  contract tests):
  ```sql
  -- Production-only ops setup (NOT part of schema.sql DEV-RESET).
  -- Run once against the Supabase project's Postgres:
  CREATE EXTENSION IF NOT EXISTS pg_cron;
  CREATE EXTENSION IF NOT EXISTS pg_net;

  SELECT cron.schedule(
    'scheduler-tick-every-minute',
    '* * * * *',
    $$ SELECT net.http_post(
         url := 'https://api.nwa.example/workers/tick',
         headers := jsonb_build_object(
           'Authorization', 'Bearer ' || current_setting('app.scheduler_secret', true),
           'Content-Type', 'application/json'
         ),
         body := '{}'::jsonb
       ); $$
  );
  ```
  `app.scheduler_secret` is set per-session via Supabase's GUC mechanism
  so the bearer token isn't checked into SQL. Day-20 will document the
  full ops runbook (rotation, monitoring, pg_cron job_run_details).
- **Handoff note:** scheduler tick = `runSchedulerTickOnce(opts)`; the
  worker function is the unit of work, the trigger primitive is the
  cadence layer (pg_cron in prod, manual/CLI in dev, contract-test
  injection for green tests). Worker pattern locked at 2 sites
  (`invoiceAutoCharge` + `scheduler`); future workers follow the
  `runXxxOnce(opts) → result` shape. Three known follow-ups (none
  blocking Day 17): (a) real Expo POST not live-smoked — Day-18 FE swap
  provides device tokens to round-trip. (b) `runScheduledNotificationsTick`
  holds the tx open through per-row device-token lookups — fine today,
  flag for Day-20 scale-out. (c) trigger-enqueue test coverage is
  helper-level only; the 4 booking-creation route paths import + call
  the helper but a runtime trace isn't pinned by a test. **Confidence
  scores 94 / 95 / 96.**

### Day 17 — Media / Cloudflare R2 ☑
- **Owner:** Allison
- **Depends on:** Day 16
- **Governing contract:** DATA-CONTRACT §C.2; schema.sql `media_assets`
- **Goal:** Private R2 media with presigned upload/download + derivatives.
- **Work:** ☑ Private R2 media end-to-end. Three new routes + one new
  worker, all under the third-party-seam pattern locked by Day-14/16:
  - **`POST /uploads/sign` `[auth]`** — issues a single-use presigned R2
    PUT URL. Server-generates the object key
    (`{purpose}/{owner-or-staff-scope}/{uuid}.{ext}`) so clients can't
    guess or collide. Content-Type pinned in the SigV4 signature.
    No DB writes, no Idempotency-Key (pure URL-signing — retries get a
    fresh URL + key; orphan keys never referenced by POST /media stay
    in R2 until a Day-20+ cleanup sweep).
  - **`POST /media` `[auth]`** — verifies the upload via
    `r2.headObject(key)` BEFORE inserting the row (422
    `invalid_payload` with `{kind: 'media-upload-missing'}` if the
    object is absent — caught the "client claimed an upload that
    didn't land" branch). On success: INSERT `media_assets` row +
    enqueue `media_derivative_jobs` row in the same `withMutation` tx
    so the job rolls back with the asset on any later failure. Signs
    the response URL POST-commit (third-party-call-after-tx invariant
    from Day-14/15).
  - **`GET /media/:id` `[auth]`** — owner-scoped (`media_assets.
    owner_id = principal.ownerId`). Returns
    `{id, purpose, kind, url, expires_at, blurhash, width, height,
    duration_ms, derivatives: {label → url}}`. Base URL + all
    derivative URLs signed with 5-min TTL — FE gets all sizes in one
    trip. 404 (never 403) on cross-tenant access — no existence
    leakage.
  - **`DELETE /media/:id` `[auth]`** — soft-expires the row.
    **R2 object intentionally retained** per the never-delete
    invariant; Day-20+ cleanup sweep removes long-expired objects
    from the bucket.
  **Derivatives worker** — `src/workers/mediaDerivatives.ts`
  composed as the 4th phase of `runSchedulerTickOnce` under the
  same `system:scheduler` actor. **NEW 3-tx-scope pattern**
  (deviates from Day-15/16's all-in-tx pattern): (1) **claim-tx**
  atomically `SELECT FOR UPDATE SKIP LOCKED + UPDATE` flips
  `pending → processing` and commits immediately so the pg
  connection isn't held during sharp CPU work; (2) **out-of-tx
  processing** runs sharp pipeline (rotate→resize→webp at 200/600/
  1200) + blurhash (4×3 components over 32px raw sample) + writes
  derivatives back to R2 under
  `derivative/<label>/<asset-id>/<uuid>.webp`; (3) **settle-tx**
  per job updates `media_assets.derivatives` + `width/height/
  blurhash` and `markDone`s the job. On any sharp/R2 failure in
  step 2, the settle-tx instead `markFailed`s the job with
  `last_error` captured; source row stays usable at original
  size. **Video deferred** — `kind='video'` short-circuits to
  `markFailed` with `'video derivatives not yet implemented
  (ffmpeg deferred)'`; source remains usable.
  **R2 seam**: `lib/r2.ts` — `R2Client` interface
  (`signPutUrl/signGetUrl/headObject/getObjectBytes/putObjectBytes`)
  + `defaultR2Client` (AWS SDK v3 `@aws-sdk/client-s3` +
  `@aws-sdk/s3-request-presigner` with `region:'auto'` +
  R2 endpoint URL) + `test/contracts/_r2Stub.ts` (in-memory
  bucket Map, `seedObject` / `setNextHeadObjectMissing` /
  `throwOnNextPutObject` knobs, mirrors `_expoPushStub` shape).
  No `deleteObject` method — never-delete invariant enforced at
  the seam.
  **New repositories**: `mediaAssetsRepository`
  (create / findById / setDerivatives / softExpire) +
  `mediaDerivativeJobsRepository` (enqueue idempotent /
  lockDueForRun / markDone / markFailed / findByMediaAssetId).
  Both polymorphic-runner consistent.
  **Day-17 scope cut (documented)**: owner uploads only.
  Staff `report-photo`/`report-video` returns 422 with
  `{kind: 'media-staff-upload-deferred'}` — the staff portal
  authoring path lands Day-19 alongside the rest of the staff
  surface. The schema enum + R2 + worker already support it;
  Day-19 adds the route arm.
- **Schema amendment** (DATA-CONTRACT §A Day-17 2026-05-27):
  new 49th table `media_derivative_jobs` + new enum
  `media_derivative_job_status` (`pending/processing/done/failed`).
  FK→`media_assets.id` ON DELETE CASCADE, UNIQUE on `media_asset_id`
  (idempotent enqueue), partial index on `(created_at) WHERE
  status = 'pending'`. Append-only by nature (no `expired_at`,
  excluded from audit_capture, included in touch_updated_at).
- **Exit:** ☑ **562/562 tests green** locally against the docker-
  compose test pg (538 prior + 24 new: 6 `uploads-sign.test.ts` + 12
  `media-routes.test.ts` + 5 `media-derivatives-worker.test.ts` +
  1 scheduler-composition smoke). tsc + eslint clean. The
  derivatives worker test exercises the real sharp + blurhash
  pipeline against an in-memory PNG — the resulting WebP is
  decoded back to confirm `width=200 + format=webp`, proving the
  bytes that land in R2 are real, not stubbed. **Live R2 round-
  trip is the one Exit item deferred** — `.env` R2 creds still
  placeholder at sign-off; bucket provisioning + paste-credentials
  + smoke is a 5-min follow-up.
- **Dependencies added**: `@aws-sdk/client-s3` +
  `@aws-sdk/s3-request-presigner` (canonical R2 path; Cloudflare
  publishes no R2-specific SDK), `sharp` (libvips bindings; native
  deps), `blurhash` (pure JS encoder). The 5 pre-existing npm
  audit warnings (drizzle-orm + esbuild/drizzle-kit chain) are
  not introduced by Day-17 deps — flagged for a separate
  upgrade-stripe-style update day.
- **Production R2 setup (operational handoff)**: Cloudflare R2
  bucket `nwa-media-dev` (dev/staging) + production bucket
  `nwa-media` (Day-20 cutover). 4 env vars per environment:
  `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
  `R2_BUCKET`. CORS: allow `PUT` + `GET` from app origin (dev
  bucket = `*`; production tightens to the deployed app host).
  Lifecycle rules (Day-20): auto-expire `derivative/*` prefix
  after 90 days; sweep `media_assets WHERE expired_at < now() -
  30d`'s `object_key` from the bucket.
- **Handoff note:** R2 client seam = `R2Client`; the worker
  function is the unit of work, the trigger primitive is the
  cadence layer (composed into the scheduler tick today). Worker
  pattern now locked at 3 sites (`invoiceAutoCharge`, `scheduler`,
  `mediaDerivatives`) — the third introduces the **3-tx-scope
  pattern** (claim → process out-of-tx → settle) as a deliberate
  variant for CPU-bound work; promoted to a locked decision in
  `.claude/backend/BACKEND-ARCHITECTURE.md` "Worker tx-scope
  patterns" (Day-20 scale-out should refactor Day-15/16's
  all-in-tx workers to match). **Day-17 post-sign-off push**
  (2026-05-27): parallelized derivative-URL signing in
  `signMediaUrls` (Promise.all) so the 3 derivative URLs sign
  in one round-trip's worth of latency rather than three; added
  a true concurrent SKIP LOCKED race test
  (`runMediaDerivativesOnce — concurrent ticks divide queue via
  SKIP LOCKED`) using `Promise.all([tickA, tickB])` on 5 seeded
  jobs, asserting union scanned = N and zero overlap; added a
  mid-pipeline failure test (`throwOnPutObjectAfter(2)` — first
  2 derivative puts succeed, 3rd throws) confirming the source
  row's manifest stays empty (no half-populated state), job
  parked with captured error, and 2 orphan WebPs in R2 await
  the Day-20 cleanup sweep. Suite at **564/564 green**
  (+2 from 562 baseline). **Live R2 round-trip CLOSED** — Allison
  provisioned bucket `nwa-media-dev` (free-tier R2 subscription,
  scoped User API token with Object Read & Write on the bucket,
  CORS allowing PUT + GET from `*` for dev); `npm run smoke:r2`
  exercises signPutUrl → fetch PUT (70 bytes) → headObject
  (size + content-type confirmed) → signGetUrl → fetch GET
  (byte-for-byte downloaded match). The AWS SDK v3 + R2 endpoint
  URL + region:'auto' + SigV4 wiring is wire-verified, not just
  stub-verified. Staff `report-photo`/`report-video` 422 stays
  scoped to Day-19 staff portal. **Confidence scores 94 / 95 / 95**
  (Correctness / Architecture / Clean Code; initial 88 / 93 / 95 →
  push-pass 90 / 95 / 95 → live-smoke close-out 94 / 95 / 95).

### Day 18 — FE swap (mock → real API): split into 18a / 18b / 18c

The original single-day brief assumed FE foundations that didn't exist
yet — no Supabase Auth integration, no TanStack Query, no apiClient seam.
At 18a sign-off (2026-05-27) the day was split honestly into three
real-sized chunks:

- **Day 18a — FE foundations** (Claude, ☑ 2026-05-27). Stand up the
  data-layer seams the swap rides on: `lib/supabase` (SDK + AsyncStorage
  session persistence), `lib/apiClient` (fetch seam — base URL + Bearer
  JWT / X-Dev-Principal + Idempotency-Key + AbortController timeout +
  Fastify-envelope unwrap), `lib/queryClient` (TanStack QueryClient with
  policy defaults), `context/AuthContext` (session subscription +
  signIn/signUp/signOut). Wire `QueryClientProvider` + `AuthProvider` +
  `AuthGate` in `app/_layout.tsx`. Real `signInWithPassword` / `signUp`
  in `(auth)/login-signin.tsx` + `login-signup.tsx` (mock-mode
  fast-path preserved). `EXPO_PUBLIC_USE_MOCK_REPOS` flag (default
  `'true'`) — flipping to `'false'` brings the new stack online. Proof
  via `userRepository` refactored to mock/real facade + live
  `GET /me` round-trip against dev API (seeded owner row, byte-exact
  wire match). 8 new apiClient unit tests; 139 → 147 mobile tests green.

- **Day 18b — Repository swap + media wire + hook migration decision**
  (Claude, ☑ 2026-05-27). All 11 mock-only `mobile/src/repositories/*`
  rewrote to the Day-18a mock/real facade pattern (`useMockRepos ?
  mockImpl : realImpl` at module load) routing through `apiClient`.
  New `lib/idempotency.ts:newIdempotencyKey()` (v4 UUID via
  `crypto.randomUUID()`); mutation repos accept an optional
  `idempotencyKey` arg (mock impls ignore). Hook decision: **Path A
  confirmed** — all 11 server-data hooks migrated to TanStack
  `useQuery` / `useMutation` against a new `lib/queryKeys.ts`
  centralized factory; the bespoke `useState`/`useEffect`/`reloadKey`
  pattern is retired. Idempotency-Key flows from the mutation call
  site through `useMutation` variables (stable across retries) →
  service → repo. `useBookings.cancelBooking` / `cancelPendingRequest`
  ship the full `onMutate` (optimistic + snapshot) / `onError`
  (rollback) / `onSuccess` (analytics) / `onSettled` (invalidate)
  lifecycle per CLAUDE.md mandate. `useBookingFlow` data triad
  migrated to `useQueries`; the booking-flow state machine stays
  local (UI state). Added `lib/useMediaUrl(id)` — TanStack-cached
  `GET /media/:id` resolver with `staleTime: 4min` (no current
  consumer; lands with the first upload surface — `lib/images.ts`
  registry stays for static bundled assets). `.env.example` /
  `.env.dev` flipped: `EXPO_PUBLIC_USE_MOCK_REPOS=false` is the dev
  default; `EXPO_PUBLIC_DEV_PRINCIPAL=owner:11111111-...-111` set
  for the X-Dev-Principal bypass until Supabase is provisioned.
  Fixed AuthGate edge case before flag flip — it now bypasses when
  Supabase is unconfigured (the dev-principal-only path) to avoid a
  login → tabs → login redirect loop. Live `/me` round-trip green
  with the seeded fixture owner. 147/147 mobile tests still green
  (mock-mode default preserved). **Real-mode regressions on submit
  flows documented**: `bookingRepository.bulkInsertBookings` throws
  on the real side (hides two distinct endpoints — `POST /enrollments`
  vs `POST /bookings`); typed verbs (`enrollInCohort`, `bookSessions`)
  extract in a follow-up day. Several documented divergences
  (availability hardcoded fayetteville+school+90d, notifications
  first-page-only, groupClass missing `prereq_class_key` from api
  wire) work but limit real-mode UX until the surface widens.

- **Day 18c — Device-token verbs** (Claude, ☑ 2026-05-28). Backend
  additive on the Day-16 `device_tokens` table (no §A amendment — DDL
  already in place; §A gained a wire-shape *clarification* for the two
  paths). `api/src/routes/device-tokens.ts`: `POST /device-tokens
  [auth, owner-only]` UPSERTs against the partial-unique
  `device_tokens_uidx` (re-register re-touches the live row preserving
  `created_at`; revoked token re-inserts) and `DELETE
  /device-tokens/:token [auth, owner-only]` soft-expires (204 / 404,
  enumeration-defense). Both go through `withMutation` +
  `requireIdempotencyKey` + `requireOwner` (staff → 403); inline wire
  helper renames `expo_push_token`→`token` / `created_at`→`registered_at`.
  `deviceTokensRepository` gained `upsert` + `softExpireByToken` beside
  the Day-16 `findLiveByOwner`. FE: `registerDeviceTokenWithServer` /
  `unregisterDeviceTokenFromServer` thin apiClient wrappers in
  `lib/pushNotifications.ts`; a framework-free `lib/pushRegistration.ts`
  orchestrator (gate = `!useMockRepos && (session || devPrincipal)` +
  native platform, within-session dedup, module-held token,
  report-and-swallow); `DeviceTokenSync` effect in `app/_layout.tsx`
  (foreground + AppState) and `AuthContext.signOut` revokes before
  clearing the session. **Tests:** 11 new api contract cases (575 total
  green — incl. re-register-after-revoke proving the partial-unique
  re-registration path) + 10 FE unit cases (166 mobile total green —
  incl. the mock-mode + dev-principal gate branches); tsc + lint clean
  both sides. **Live device smoke deferred to the next TestFlight build**
  — the installed app is a TestFlight binary that predates this code, so
  the `device_tokens`-row-on-device check + the on-device push haptic
  ride the next `build-ios.sh`. (Also folded in off-scope: demo
  notifications now carry `sound: 'default'` so the lock-screen banner
  buzzes — a local notification needs a sound for the iOS alert haptic,
  not a server/EAS push.)

### Day 19a — Staff portal backend verbs ☑ (2026-05-28)
- **Owner:** Claude
- **Depends on:** Day 18
- **Governing contract:** DATA-CONTRACT portal verbs; ARCHITECTURE "Minimum staff portal"
- **Goal:** all 4 staff verbs round-trip against the API (the web client is 19b).
- **Landed:**
  - **Verb 1** — `GET /staff/requests?status=` cross-owner queue (approve/deny
    already shipped Day-12). `requestsRepository.findLive`.
  - **Verb 4** — `GET /staff/bookings` + `POST /staff/bookings/:id/{confirm,cancel,attendance}`.
    New `routes/staffBookings.ts`. Cancel reuses the SHARED
    `lib/cancelBookingService.cancelBookingInTx` (extracted from the owner
    cancel route — schema `cancelBooking` is owner-OR-staff authorized, one
    txn, `requireOwnerId: null` for staff). Attendance folds the roster
    check into a `RETURNING` UPDATE; confirm stamps `confirmed_at` only when
    NULL (preserves first-confirm time).
  - **Verb 3** — `GET /staff/threads` + `POST /staff/threads/:id/messages`
    (first message-WRITE path: INSERT staff message → bump last_message →
    `message-received` notification to owner). New `routes/staffThreads.ts`.
  - **Verb 2** — `POST /staff/reports` + `PATCH /staff/reports/:id`. R2
    content-by-program Zod validator (session requires `content`, curriculum
    forbids it; schema CHECK is the backstop), optional single-booking
    `session_report_id` back-link, `report-published` notification. New
    `routes/staffReports.ts`.
  - **Refactor (−451 LOC dup):** extracted `lib/wireManyRequests`,
    `lib/wireManyBookings`, `lib/wireManyThreads`, `lib/cancelBookingService`
    at rule-of-two/three; owner routes refactored onto them, all owner tests
    green.
  - **§A wire clarifications (additive, no DDL):** attendance response
    `{ booking_id, dog_id, attendance, checked_in_at }`; staff cancel returns
    the same `BookingWire` as owner cancel.
- **Verified:** api **623/623** contract tests green (48 new across
  `requests-mutations` queue tests (6) + `staff-bookings` (21 — incl. all 3
  cancel refund branches cross-owner + replay) + `staff-threads` (7) +
  `staff-reports` (13)); tsc + lint clean. Confidence **95/95/95** after a
  bar-raising pass (closed the staff-cancel forfeit/credit-back + replay
  coverage gaps).
- **Deferred to 19b (documented, justified — NOT defects):**
  - **report-photo/report-video media arm** (Day-17 `media-staff-upload-deferred`)
    — substantial ownership rework across POST/GET/DELETE `/media`
    (staff-author access + report→dog→owner resolve), orthogonal to report
    text authoring.
  - **group-class multi-week back-link** (every weekly booking for a
    cohort+dog) + the **`report_id`-vs-`session_report_id`** distinction —
    genuine R2 ambiguity; only the single-booking `session_report_id` link
    landed.

### Day 19b — Staff portal web client + 2 reads + seed + multi-week link ☑ (2026-05-28)
- **Owner:** Claude
- **Depends on:** Day 19a
- **Stack DECISION (resolved at thread start):** **React + Vite + TS** in a new
  top-level `portal/` dir. Reconciles Allison's "react native" answer against
  the ARCHITECTURE "no RN" lock — plain React reuses the contract types +
  TanStack patterns without RN-Web/Expo-web baggage. Vite dev-proxies `/api` →
  :3000, so **no CORS change to the API** (CORS is a Day-20 deploy concern).
- **Landed:**
  - **Portal** (`portal/`): all four verbs — requests (per-category approve /
    deny), bookings (confirm / cancel / per-dog attendance), threads (list +
    conversation + reply), report authoring (program-conditional form,
    react-hook-form + Zod). Type-only contract mirror (`api/contracts.ts`),
    `client.ts` (X-Dev-Principal + Idempotency-Key + typed `ApiError`),
    `queryKeys.ts`, TanStack Query, shared `useDogDirectory` lookup.
  - **2 cross-owner reads** (api): `GET /staff/threads/:id/messages` (reply was
    unusable without reading the convo) + `GET /staff/dogs` (name resolution +
    dog picker; the §B wire shapes carry no names). See DATA-CONTRACT §A
    Amendment 2026-05-28 (Day 19b).
  - **Dev seed** (`api/scripts/seed-dev.ts`, `npm run db:dev:seed`): the real
    cohort + 2 owners + 4 staff + bookings/requests/threads. Vacuous
    vaccine/agreement guards (those catalogs intentionally empty); refuses a
    non-local DB.
  - **Group-class multi-week back-link** (resolves a 19a deferral): a
    group-class report's `link_booking_id` propagates `session_report_id` to
    every weekly booking for the (cohort, dog) — per the §C enrollment rule.
    `report_id` (the other bookings→reports FK) left documented-open
    (Allison's call: session_report_id only).
- **Verified:** api **629/629** (+1 multi-week test; +5 from the 19b reads over
  the 623 baseline = 629); tsc + lint clean. Portal tsc strict clean + prod
  build clean. **Headless-browser smoke (Playwright): 10/10** — all four verbs
  render, dog names resolve, live attendance + reply mutations reflect in the
  UI, program-conditional content field toggles, zero console errors.
- **Contract gaps surfaced (documented, not blocking):** `BookingWire` has no
  `confirmed_at` (can't show confirm state); attendance isn't on any wire.
  Candidate §A amendments for a later pass.
- **Deferred to 19c (Allison's decision):** the staff-author media arm
  (report-photo/video upload) — substantial `/media` ownership rework + portal
  UI; sized + reviewed on its own.
- **Exit:** ✅ each verb round-trips through the web client (browser-verified);
  portal-creep bounded to the two name/conversation reads the client needs.

### Day 19c — Staff-author media arm ☑ (2026-05-29)
- **Owner:** Claude
- **Depends on:** Day 19b
- **Goal:** let staff attach report-photo/report-video media to reports.
- **Upload-path DECISION (2026-05-29):** **proxy through the API**, NOT the
  Day-17 presigned-PUT flow. The portal POSTs the file to a server endpoint
  that streams to R2 server-side (browsers are CORS-bound, so presign-direct
  would need a per-origin R2 bucket CORS rule + expose R2 to the browser;
  proxying keeps R2 server-side, zero bucket config). NEW pattern vs the
  locked presign flow — flag whether to promote (presign stays the mobile
  path). Report photos are small; server handling the bytes is cheap.
- **Landed:**
  - **Staff-author arm on `POST/GET/DELETE /media`** — `POST /media` gained a
    staff branch for `report-photo`/`report-video` that resolves `report_id →
    report.dog_id → dogs.owner_id` and stamps that owner on the row
    (`created_by='staff'`), so the dog's owner — not the staffer — reads it
    back via the owner-scoped GET. Owner principals → 403 on those purposes
    (symmetric to staff → 403 on owner purposes). `GET`/`DELETE /media/:id`
    now allow a staff principal cross-owner access (consistent with the rest
    of the portal: dogs/bookings/threads are all cross-owner); an owner is
    still scoped to their own rows (cross-tenant → 404). The 422
    `media-staff-upload-deferred` is gone.
  - **`POST /media/upload` `[staff]` — the portal proxy** (the DECISION
    above). Raw binary body + query metadata (`purpose`, `report_id`),
    **dependency-free**: a scoped `*` content-type parser reads the body as a
    Buffer (encapsulated via `app.register` so the other media routes keep
    JSON parsing — same pattern as the Stripe/auth webhook parsers), 25 MB
    limit. Server `putObjectBytes` → `withMutation`[resolve owner + create
    row + enqueue job] → signed-URL response. The PUT is pre-`withMutation`
    (third-party call off the tx); a retry replays the first row and leaves
    the PUT's object as a swept-later orphan, so the idempotency request hash
    is the STABLE metadata (not the per-call random key).
  - **Refactor (rule-of-two):** `lib/mediaKeys.ts` (`mediaObjectKey` +
    `assertContentTypeMatchesPurpose`, shared by `/uploads/sign` + the proxy);
    `createMediaRow` (INSERT + enqueue, shared by all three POST arms) +
    `resolveStaffReportLinkage` (shared by the register staff arm + the proxy)
    extracted in `routes/media.ts`. No new repo methods — the proxy reuses the
    Day-19a/b `reportsRepository.findByIdInTx` + `dogsRepository.findOwnerIdInTx`.
  - **Portal:** a photo/video uploader revealed on the report-author form
    AFTER publish (a `report_id` is required to attach). New `api.upload`
    binary seam in `client.ts`; `uploadReportMedia` POSTs the file to
    `/media/upload`; the returned signed URL renders an inline thumbnail.
- **Verified:** api **643/643** green (+7 over the 636 baseline: 7 proxy
  cases; the staff register-arm cases landed in the 636 baseline). tsc + lint
  clean both sides; portal tsc strict + prod build clean. **Headless-browser
  smoke (Playwright, real R2 `nwa-media-dev`): authored a report + uploaded a
  photo through the portal → thumbnail rendered, zero console errors. Live
  curl round-trip: staff upload → owner GET 200, a different owner 404.**
- **Exit:** ✅ staff upload a report photo from the portal; the owner sees it
  (browser smoke + live curl).
- **Carried-forward:** report photos link via the media row's `report_id` FK
  only, not embedded in `reports.content`, so the owner app's `PhotosCarousel`
  won't surface them without a future owner-side "media-by-report" read or
  content embedding. `report-video` parks at the worker (Day-17 ffmpeg
  deferral) — source stored + readable, no poster.

### Report-author enhancements — post-19c, Allison-requested (2026-05-29)
- **Owner:** Claude
- **Goal:** the report-author form captures the REAL per-program criteria +
  auto visit number — not a `{summary}` placeholder. (Resolves the 19a/b/c
  carried-forward "thin content" + "no committed portal test harness" items.)
- **Landed (portal `features/reports/`):**
  - **Per-program criteria editor** (`CriteriaEditor.tsx` + `curriculum.ts` —
    the 5 day-school levels mirrored from `mobile/src/lib/reportPrograms.ts`).
    Each skill scored over **5 attempt bubbles** → click a bubble → pass/fail
    popover; **≥4/5 ⇒ `pass`, else `learning`** (the owner-app enum has no
    `fail`), score `"{passes}/5"`. Foundation additional-skill tickboxes.
    Builds the `results` envelope.
  - **Session-content editors** (`SessionContentEditor.tsx` + typed pure
    builders in `sessionContent.ts`): private-lesson handout, boarding /
    board-train day journal (shared), group-class weekly recap — emit the real
    snake_case `content` docs the owner app's `to*Content` translators read.
  - **Auto visit count** via the NEW `GET /staff/dogs/:dogId/session-count`
    read (api) — read-only "Visit #N" (past category sessions + 1); manual
    input removed. **"Trainer's note"** relabel of the report body. **"Things
    to work on at home"** — numbered add-more list → `practice_at_home` (all
    programs). **Photo picker moved onto the form** (staged previews,
    upload-on-publish via the 19c proxy).
  - **Refactor + tests:** `resultsEnvelope.ts` + `sessionContent.ts` are pure;
    `useDraftList.ts` dedupes the three session editors; `useReportComposer.ts`
    owns the structured state. **Committed portal test harness added** (Vitest
    dev-dep + `npm test`): **24 unit tests** over the pure builders.
- **Verified:** api **647/647** (+4 session-count branch tests); portal **24/24**
  vitest + tsc-strict + prod build clean; browser smokes per editor with DB
  round-trips asserting the exact wire shapes (4/5⇒pass, 1/5⇒learning, all four
  content docs, `visit=1`, `practice_at_home`). DATA-CONTRACT §A "Amendment
  2026-05-29 (report-author enhancements)".
- **Confidence:** report-author overhaul **96/96/96**; media arm **95/95/95**.

### Day 19d — Real-mode completion + full-app smoke ☑ (2026-06-01)
- **Landed:** all five mock-only holes closed with typed verbs (no
  `bulkInsert`-style multiplexed signatures): (1) group-class enroll →
  `enrollInCohort` → `POST /enrollments`; (2) Day School/Care DIRECT booking →
  `bookSessions` → `POST /bookings`, wired into the confirm path (which had
  persisted NOTHING before, mock or real) with **rich per-gate 422 recovery**
  (`BookingGateModal` + `lib/bookingGate.ts`); (3) Past tab → per-dog
  `reportRepository.listByDog` (dropped the throwing `listAllSync`); (4)
  **Invoices full ledger** — new `GET /invoices` (`ledgerRepository`) +
  `payInvoice` → `POST /invoices/:id/pay`; (5) divergences documented as
  conscious flags (availability single-location fayetteville matches read+write;
  group-class prereq stays server-backstopped via `eligibility_missing`;
  notifications first-page sufficient for the bell). **Plus two
  Allison-requested extras:** **duplicate-booking guards everywhere** (typed
  `already_booked`/`already_enrolled`/`already_requested` 422s on all 3
  booking-creation surfaces, under-lock, cancelled-rebookable) + **group-class
  event-style cards** (bookings list groups weekly sessions by cohort+day into
  one `GroupClassTile` showing the class name + stacked dogs; wire grew
  `cohort_id` + `group_class_name`). Dev seed gained the group-class catalog (3
  classes, 6 cohorts, prereq, a completed-class for the eligibility demo) + the
  billing ledger rows. **Tests:** api 656/656, mobile 182 (+ tsc/lint), portal
  24/24. **Smoke:** Allison validated real mode (dogs/bookings/invoices) + the
  group-class enroll→card flow; the exhaustive per-screen walk continues into
  Day 20's go-live gate. See §A "Amendment 2026-06-01".
- **Owner:** Claude (FE + small api widenings) — Allison reviews the smoke.
- **Depends on:** Day 19c.
- **Governing contract:** DATA-CONTRACT §B/§C.1 booking-creation flows; the
  existing mock/real facade (Day-18b); ARCHITECTURE "Mock data strategy".
- **Why this day exists:** the mock app is feature-complete, but the **real
  (API-backed) path still has mock-only holes** — the Day-18b facade swap left
  several real impls as deliberate loud `throw`s (correct: surface, don't
  silently corrupt) plus documented divergences. The dev default is real mode
  (`EXPO_PUBLIC_USE_MOCK_REPOS=false`), so these are live gaps, not hypotheticals.
  "Unbreakable app" means real-mode is verified end-to-end BEFORE the Day-20
  go-live gate — this day closes the holes and proves it screen-by-screen.
- **Holes to close (audited 2026-05-30 — call sites cited):**
  1. **Group-class enrollment** — `bookingService.enrollInGroupClass` →
     `bookingRepository.bulkInsertBookings` THROWS in real mode. Extract typed
     `enrollInCohort` → `POST /enrollments` (Day-11 txn). Also unblocks
     `groupClassRepository.bumpFilled` (server-authoritative via the same txn).
  2. **Day School / Day Care direct booking** — the other half of the
     `bulkInsertBookings` comment. **RESOLVED (Allison 2026-05-30): Day School
     and Day Care are DIRECT-book — NO approval/request flow.** They book
     immediately via `bookSession` → `POST /bookings` (the Day-10 txn), gated by
     the **full §H/§G set: payment + evaluation + vaccine + agreement +
     capacity** (all already enforced by the booking BEFORE-INSERT triggers +
     `lockDayCapacity`; a blocked insert is a typed 422 the FE already renders).
     Extract typed `bookSessions` → `POST /bookings`; the FE surfaces any gate
     422 via the existing error abstraction. (The request→approve flow stays for
     the categories that need staff pricing/scheduling — B&T, boarding,
     private-lesson — NOT day-school/day-care.)
  3. **Past tab read** — `bookingService.listPast` calls
     `reportRepository.listAllSync()` which THROWS in real mode (a core READ
     screen, not just submit). Rework to resolve reports per-visible-dog
     (`listByDog`) or a dedicated read; the error-boundary currently contains
     it as a LoadFailure, but the Past tab is non-functional in real mode today.
  4. **Invoices tab** (off-plan) — `invoiceRepository.list` / `payInvoice` throw
     in real mode (`TODO(Day-19)`). Wire to `GET /invoices` + `GET /charges` +
     `POST /invoices/:id/pay` (routes exist since Day-15).
  5. **Documented divergences to widen:** availability hardcoded
     `fayetteville` + school + 90d (`availabilityRepository`); notifications
     first-page-only (no cursor follow); group-class api wire missing
     `prereq_class_key`. Each works narrowly but limits real-mode UX.
- **Work:** close 1–5 with typed repo verbs (no `bulkInsert`-style multiplexed
  signatures); each new verb gets api contract-test coverage where the endpoint
  shape isn't already proven; keep the mock impls intact (facade parity).
- **Exit:** **a real-mode full-app smoke** — flip `EXPO_PUBLIC_USE_MOCK_REPOS=
  false` against the dev API + seed, walk EVERY owner flow in the simulator
  (home / up-next / bookings upcoming+past / dog profiles + reports / book a
  Day-School + a group class / cancel / messages send / invoices pay /
  notifications), zero unhandled errors, every screen renders real data. The
  remaining audited holes (below) are either closed or consciously
  feature-flagged off for launch.
- **Handoff note:** record which flows are real-mode-verified vs.
  flagged-off; that list IS the Day-20 go-live precondition.

### Day 19e — Real-mode QA + change pass
- **Owner:** Allison finds (drives the app), Claude fixes.
- **Depends on:** Day 19d (feature-complete real mode).
- **Why this day exists:** the app is feature-complete against the live API, but
  no deliberate top-to-bottom QA pass has happened. This is the gap between
  "feature-complete" and "production-ready" — find bugs + change-requests now,
  while it's cheap, BEFORE Day 20 hardens the deploy / touches live infra.
- **Process:** Allison walks every owner flow in real mode (`npm run start:dev`)
  and logs everything — bugs AND "I want this different" — as a single
  punch-list (drop into the thread however: screenshots, fragments). Claude
  batch-fixes, keeping api/mobile/portal/docs commits scoped + tests green.
- **Flow checklist (nothing missed):** Home (up-next / dog row / announcements);
  Bookings (Upcoming / Past / Pending; day-school + group-class cards; cancel;
  dup-guard modals); Dog profiles (per-program tabs, reports / report cards /
  photos); Book flows (Day School, Day Care, group-class enroll + prereq/full/
  dup gates, request flows B&T / boarding / private); Invoices (ledger + pay);
  Messages (threads / send / new chat); Notifications (bell); Account (settings,
  payment methods, footer).
- **Exit:** punch-list cleared; a clean full-app real-mode smoke (zero unhandled
  errors, real data every screen). THAT signed-off smoke is the Day-20 go-live
  precondition (replaces "Day-19d smoke" in the Day-20 Exit).
- **Handoff note:** record which findings were fixed vs. deferred-with-reason.

#### Landed so far (2026-06-04) — first batch of the change pass ☑ (api 670/670 · mobile 199/199 + tsc · portal 24/24 + tsc · prettier clean)
The QA pass turned into a feature sprint (Shanthi-approved iteration). What landed:
1. **Recent Updates / announcements.** Typed CTA discriminated union + ONE generic
   `app/announcement/[id].tsx` detail screen (hero + body + optional CTA). CTA parsed
   at the wire boundary (`lib/parseAnnouncementCta.ts` — Zod, route allowlist +
   https-only; 9 unit tests). Schema += `announcements.cta_label/cta_kind/cta_target`
   (+CHECKs). 6 seeded Fayetteville updates. "Rich screen → deep-link, article →
   generic detail" routing split (Yappy Hour + Puppy Class deep-link to their rich
   screens). Shared `lib/announcementCategory.ts` (rule-of-two extraction).
2. **Event RSVP vertical.** `app/event/[id].tsx` (event card + spots bar + dog picker
   + confirm view). `EventWire` += `spots_filled` / `capacity?`; **`POST`/`DELETE
   /events/:id/rsvp`** (idempotent, soft-cap → 422 `event_full`, owner-only). Seed:
   Yappy Hour event (cap 25, Jordan RSVP'd 2 dogs). 15 events contract tests.
3. **Public Pups: event → group class.** `group_class_key` enum += `'public-pups'`
   (schema.sql + both live DBs + drizzle + mobile type/tuple); seeded as a 6-week
   course ($250 / cap-12 placeholders); removed from events seed + mock.
4. **Dog photos (real mode).** `resolveDogImage` tolerates the `images/` prefix (seed
   emits `dogs/...`, registry keyed `images/dogs/...`); initial-letter fallback added
   to `DogStory`.
5. **Messaging.** Built the missing `POST /threads/:id/read` (killed a 404 retry
   storm + flashing) + `POST /threads/:id/messages` (owner send, optimistic w/
   rollback); **polling** on both clients (open thread 4s, list 8s); own-message
   alignment keys off `sender_name` absence; portal `.bubble` → `.msg-bubble*` (CSS
   collision with the report's 22px circle).
6. **Buy-credits feature (FE, mobile-only this batch).** Dog-profile hub gained a
   full-width `<CreditBalanceCard>` (Day School + Day Care counts + "Tap to buy more
   credits") under the tile grid; reads via new `useDogCredits` (shares the
   `credits/list` query cache through `select` — one source of truth). Tapping opens
   a **3-step wizard** (location → type → package) — `CreditsSheet` generalized to a
   `variant` discriminated union (`'booking'` = the mid-booking over-credits prompt,
   `'manage'` = standalone buy) and a phased flow used by BOTH (booking pre-fills the
   type from `shortMode`). Package step = the 3 fixed packs + a **"Choose your own"**
   stepper (custom class count × per-class rate). Placeholder per-location pricing in
   new `lib/creditPackages.ts` (Fayetteville/Bentonville + per-class rate; bulk
   discount on custom amounts pending Shanthi). Manage confirm → green-check success
   (mirrors PayInvoiceModal). Hero lift on the hub made device-agnostic
   (`HERO_PAD_*_PCT × screenHeight`). 8 new unit tests over the pricing helpers.
   **Known prototype gap:** confirming a purchase shows success but does NOT mutate
   the balance yet (no service/ledger call) — the real purchase mutation lands with
   the location-scoped-credits work below.
- **DATA-CONTRACT §A** amended inline for announcement CTA + event RSVP + messaging
  read/send (additive only; frozen §B untouched).
#### Location-scoped credits ☑ (2026-06-04) — mobile + backend (api 674/674 · mobile 199/199 + tsc · §B Δ documented)
Credits are now per-(dog, mode, **location**) so the dog-profile card reflects the
owner's *set* location (Account → location). **Backend (§B Δ — deliberate frozen-wire
change, documented in DATA-CONTRACT):** `credit_ledger` += `location` (location_key
NOT NULL); `dog_credit_balance` view groups by `(dog_id, mode, location)`; every ledger
writer carries location (purchase → chosen location, booking-debit →
`bookings.location`, cancel-refund → the original debit's location); the booking balance
advisory lock is per-(dog, mode, location); `credit_packages` PK is composite
`(key, location)` with per-location `price_cents`, ledger `package_key` FK composite
`(package_key, location)`. `GET /dogs/:id/credits?location=` + `GET /credit-packages
?location=` take a required `location`; the purchase body gains `location`; the Stripe
webhook grant + reversal carry location. +4 contract tests (per-location balance +
catalog + missing-location 400) + lock test asserts per-location independence.
**Mobile:** `DogCredits` += location; per-location mock rows; `creditsRepository.list
(location)` + `creditsService.{listAll,findByDog}(location)` + `findCreditsForDog(...,
location)`; `useDogCredits` reads the set location; `useBookingFlow` over-credits check
is per-location (`DEFAULT_BOOKING_LOCATION`); fixed a latent real-mode bug (the real
credits repo mapped the API wire through the mock `*_credits` keys). Mock smoke: the
card shows the set-location pool.
- **STILL OPEN (separate feature, not part of "balances reflect location"):** the
  buy-credits **purchase is still a UI-only no-op** — wiring the real Stripe purchase
  from the *manage* wizard needs a payment-method step (the manage flow has none today)
  + aligning the mobile placeholder catalog (`lib/creditPackages.ts`, ids `8/12/20` +
  custom) with the backend `credit_packages` keys, AND a backend path for custom
  ("buy X classes") amounts (the package-purchase endpoint is package-keyed). The
  backend purchase endpoint is per-location-ready; the mobile wiring is the remaining
  work. Also still flagged: `BackButton` ×5 dup (unrelated to credits).
- **Still open / deferred:** seed placeholders (Yappy Hour address+coords, Public Pups
  price+cap) pending Shanthi; retiring `info/yappy-hour.tsx` (repoint dog-profile
  Resources link); `POST /threads` (start-new-thread, still 404); dog photos → R2;
  realtime → WS/SSE. **Code-consistency:** `BackButton` now duplicated across **5**
  screens (info/{puppy-class,yappy-hour,meet-rachel} + announcement/[id] + event/[id])
  — extraction overdue; deferred this commit (surgical scope; yappy-hour slated to
  retire → 4). `CalendarIcon`/`LocationIcon`/`CheckIcon`/`DogRow`/`ConfirmView`
  duplicated between `info/yappy-hour` + `event/[id]` — resolve when yappy-hour retires.

### Day 20 — Observability + deploy hardening + go-live gate
- **Owner:** Allison
- **Depends on:** Day 19d (real-mode must be verified end-to-end FIRST — a
  go-live gate over a half-wired real path isn't a gate).
- **Governing contract:** ARCHITECTURE launch scope; PHASE-PLAN next-phase
- **Goal:** Production-ready: monitored, rate-limited, recoverable, gated.
- **Work:** Sentry via `src/lib/observability.ts` seam; structured logs;
  Redis rate-limit; backups/PITR; staging→prod env split (finalize the
  env-selection decision opened Day 4 — host-injected env is the lean,
  `dotenv` dev-only; depends on the deploy-host choice made this day);
  **CORS for prod** (portal→API; the Vite dev-proxy is dev-only — the media
  upload proxies through the API so there's no browser→R2 CORS, but tighten the
  dev R2 bucket's `*` CORS for prod) + R2 cleanup sweep (orphaned + long-expired
  objects); portal-library modal migration (PHASE-PLAN); **live Stripe keys +
  flip `payments_enabled` only at real prod launch**.
- **Exit:** staging green end-to-end; **Day-19d real-mode smoke signed off**;
  signed-off go-live checklist.
- **Handoff note:** go-live runbook; what flips on launch day.

---

## Cross-cutting invariants (true on EVERY day — not optional)

- Never `DELETE`/destructively overwrite — soft-expire (`expired_at`) only.
- Every write sets `app.actor` or `audit_log` is blind. No exceptions.
- Every mutation is idempotent (the Day-3 wrapper) — clients retry.
- All calendar/day math in **America/Chicago**, never off raw UTC.
- The frozen wire shapes (DATA-CONTRACT §B) are the regression net — contract
  tests, not unit-test theater. A mismatch = STOP + surface, never edit the
  frozen contract silently.
- Backend code in `api/`, FE in `mobile/` — never mixed in one commit.
