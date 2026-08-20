-- =============================================================================
-- NWA School for Dogs — Phase 3 backend schema (PostgreSQL)
-- =============================================================================
-- Locked 2026-05-18. Source of truth for the Node.js API's database.
--
-- Design rulings baked in (see .claude/backend/DATA-CONTRACT.md "Decision register"):
--   R1  PendingRequest aligned to Booking's multi-dog shape (lead + join table)
--   R2  Report = base row + program discriminator + JSONB content/results
--   R3  Ownership root = owners; dogs.owner_id; bookings/threads carry owner_id
--   R4  Staff are real rows keyed to a Supabase Auth UID + role claim
--   R5  Absolute timestamptz everywhere; capacity day is a DATE, not an instant
--   R6  UUID PKs; every migratable entity carries (external_ref, source) so a
--       later Gingr import is an additive backfill, never a schema break
--   R7  Group-class prereq eligibility is server-derived, not a stored flag
--   R8  focus tags stored structured (columns), not the mock "kind:value" string
--
-- Mock-layer gotchas this schema deliberately FIXES (not ports forward):
--   - enrollInGroupClass is now ONE transaction (digest gotcha #4)
--   - cohort capacity is enforced by CHECK + row lock (gotcha #5)
--   - booking<->report link is an explicit FK, not a (dog,category,day) guess
--     (gotcha #8)
--   - IDs are server-generated UUIDs, no client Date.now() collisions (#3)
--   - credits are an append-only ledger, not a mutable counter
--
-- LIFECYCLE CONVENTION (locked 2026-05-19) — "nothing is ever lost":
--   - The Node API NEVER issues `DELETE` and never destructively overwrites.
--     "Delete"/"remove" = set `expired_at = now()` (soft-expire). Reads filter
--     `WHERE expired_at IS NULL`. Account/dog deletion = expire + PII-anonymize;
--     financial rows are retained for legal/tax (privacy-policy obligation).
--   - Soft-expire tables carry `expired_at timestamptz` (NULL = live). Join
--     tables too, so unlinking one association is non-destructive.
--   - Append-only / immutable-by-nature tables carry NO expiry marker —
--     corrections are new rows: credit_ledger, charges, invoices (status
--     transitions only), scheduled_notifications, notifications, audit_log.
--   - Every edit's prior state is preserved by `audit_log` (one generic table +
--     trigger capturing the OLD row as JSONB on UPDATE/DELETE).
--   - Financial owner FKs are `ON DELETE RESTRICT` as a hard backstop so a
--     stray manual DELETE can never destroy charges/invoices/ledger history.
--     (The app-never-deletes rule is the primary guarantee; this is defense.)
--   - Natural-key UNIQUE/PK constraints on soft-expire tables are PARTIAL
--     (`WHERE expired_at IS NULL`) so expiring a row frees its natural key for
--     a fresh live row (re-RSVP, re-opt-in, re-import the same Gingr id).
--     Re-linking a join row the API soft-expired = clear expired_at (UPDATE),
--     never a second INSERT (see txn-contract notes). The lone exception to
--     never-delete is `idempotency_keys` — transport-layer request dedupe, not
--     business state, TTL-pruned by a sweep (documented at that table).
--   - Booking-time gates are DB BEFORE-INSERT trigger floors mirroring the
--     payment guarantee (staff-owned dogs exempt): a live card on file, current
--     required vaccinations, and signed current-version required agreements.
--     The trigger floor checks the LEAD dog/owner; the API enforces the full
--     set across all booking_dogs (same floor-vs-full split as payments).
--
-- Conventions: snake_case; timestamptz (UTC) for instants; date for calendar
-- days; *_cents integers for money (never float); created_at on all tables.
-- BUSINESS TIMEZONE = America/Chicago (locked 2026-05-19). Instants stored
-- UTC, but ALL business-day math — day_capacity dates, the 8am/5pm day-program
-- window, today/tomorrow bucketing, the 24h-before-dropoff reminder — is
-- computed in America/Chicago. Never derive a calendar day straight from a UTC
-- timestamp (that was the mock's off-by-one bug class).
-- The Node API verifies the Supabase JWT, resolves it to an owners/staff row
-- by supabase_uid, and authorizes every request in app code (no RLS — the
-- deliberate Supabase-Auth-only design).
-- =============================================================================

-- ----------------------------------------------------------------------------
-- DEV RESET — full-rebuild teardown. COMMENTED OUT BY DEFAULT (safe in git).
-- For the local DataGrip reload loop: uncomment the 4 lines below to wipe +
-- rebuild a throwaway dev DB from this one file. Re-comment before committing.
-- HARD RULE: this MUST stay commented in git — a live DROP SCHEMA here would
-- nuke whatever database a programmatic/CI/staging/prod load runs against.
-- Phase 3 (IMPLEMENTATION.md Day 1) loads schema.sql into a fresh empty DB and
-- never relies on this; non-interactive loads must assert it stays commented.
-- ----------------------------------------------------------------------------
-- DROP SCHEMA public CASCADE;
-- CREATE SCHEMA public;
-- GRANT ALL ON SCHEMA public TO postgres;
-- GRANT ALL ON SCHEMA public TO public;

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()

-- ----------------------------------------------------------------------------
-- Enums
-- ----------------------------------------------------------------------------
CREATE TYPE service_category AS ENUM (
  'day-school', 'day-care', 'group-class', 'private-lesson',
  'board-and-train', 'boarding', 'evaluation'
);
CREATE TYPE booking_status     AS ENUM ('upcoming', 'past', 'cancelled');
CREATE TYPE booking_attendance AS ENUM ('pending', 'attended', 'no-show', 'excused');
CREATE TYPE request_status     AS ENUM ('submitted', 'approved', 'approved-awaiting-payment', 'converted', 'cancelled');
CREATE TYPE scheduled_status   AS ENUM ('pending', 'sent', 'cancelled');
CREATE TYPE invoice_status     AS ENUM ('open', 'paid', 'void');
CREATE TYPE evaluation_status  AS ENUM ('not-evaluated', 'pending', 'passed', 'failed');
CREATE TYPE report_program     AS ENUM (
  'foundation', 'advanced', 'loose-leash', 'house-manners', 'cgc',
  'private-lesson', 'boarding-session', 'group-class-session',
  'board-train-session'
);
CREATE TYPE thread_category    AS ENUM ('sessions', 'billing', 'enrollment', 'other');
-- Δ 2026-07-14 (Allison): where a PRIVATE LESSON happens — the owner picks at
-- request time, the approve conversion copies it onto the booking, and the
-- bookings card labels it ("At your home" / "Public spot"). NULL on every
-- other category.
CREATE TYPE lesson_setting     AS ENUM ('home', 'public');
CREATE TYPE notification_type  AS ENUM (
  'booking-confirmed', 'report-published', 'booking-cancelled',
  'announcement', 'message-received',
  -- Day-16 §A amendment 2026-05-26: scheduler outbound triggers. The
  -- delivered feed and the scheduled queue share this enum; adding the
  -- arms here lets the FE render a reminder differently from a fresh
  -- confirmation without inferring intent from the title.
  'booking-reminder', 'boarding-profile-check',
  -- Credit-expiry Phase-3 amendment 2026-06-20: the money-adjacent feed
  -- arms. `credits-expiring` is the scheduled-scan warning (a lot is
  -- within its location's warning_lead_days of expiry); `payment-failed`
  -- + `payment-succeeded` are the invoice auto-charge receipts — failed
  -- emitted ONLY when an invoice parks (terminal, MAX attempts), succeeded
  -- on every successful auto-charge. Shared by the delivered feed + the
  -- scheduled queue.
  'credits-expiring', 'payment-failed', 'payment-succeeded',
  -- §J.3 amendment 2026-07-09: the alumni monthly attendance scan — an
  -- alumni dog attended <2 qualifying sessions in the just-closed Chicago
  -- month, so its attendance flag was set (dog stays alumni; staff will
  -- re-check before the next booking).
  'alumni-attendance',
  -- §J.1 amendment 2026-07-14: the membership roll emits this feed entry
  -- when a subscription hits its term hard stop ("you'll be notified when
  -- your subscription ends" — the FE promise made on the subscribe page).
  'membership-ended',
  -- Shanthi ruling 2026-07-14: fires on the owner's stated spay/neuter
  -- planned date, prompting them to update the dog's profile.
  'spay-neuter-reminder',
  -- R3 (Allison sim-QA 2026-07-27): the cash/check invoice reminder. Fires ~1h
  -- before the linked booking's drop-off (or ~1h before the invoice's due time
  -- when no booking is linked), telling the owner to bring payment at drop-off.
  'payment-due',
  -- Allison 2026-07-29 (notification sweep). `invoice-overdue` is the safety
  -- net — an invoice still open INVOICE_OVERDUE_GRACE_DAYS past its due date.
  -- Every other payment path (auto-charge, pay-in-person at drop-off) should
  -- have settled it well before this fires, which is exactly the point: it's a
  -- precaution, not a dunning ladder, and it fires ONCE per invoice.
  'invoice-overdue',
  -- The owner's default card is within CARD_EXPIRY_WARNING_DAYS of lapsing (or
  -- lapsed yesterday), so auto-charges don't start failing silently.
  'card-expiring',
  -- A waitlisted request got a seat — either one opened up or staff overrode
  -- the cap. Deep-links to the booking that was just created.
  'waitlist-spot-open'
);
CREATE TYPE announcement_category AS ENUM ('urgent','team','class','event','promo','report');
CREATE TYPE staff_role         AS ENUM ('owner-shanthi', 'trainer', 'office');
-- Locations are a TABLE (`locations`, below), not an enum, since the robustness
-- Δ 2026-06-08: a school is an attributed entity (display_name/address/coords/
-- timezone) and adding one is a row INSERT, not an ALTER TYPE. The `slug` is the
-- stable natural key + the wire value; every `location` column FKs locations(slug).
CREATE TYPE booking_mode       AS ENUM ('school', 'daycare');  -- credits axis
-- R6 import seam + provenance. 'app' = user/staff-created; 'gingr' = migrated;
-- 'seed' = curated preload (e.g. the ~50 starter vets) — distinct so a
-- curated row is tellable from user-submitted, and re-running a seed is
-- idempotent via the partial (source, external_ref) unique.
CREATE TYPE record_source      AS ENUM ('app', 'gingr', 'seed');
CREATE TYPE sender_kind        AS ENUM ('owner', 'staff');
CREATE TYPE group_class_key    AS ENUM ('puppy', 'manners-1', 'manners-2', 'public-pups');
CREATE TYPE charge_purpose     AS ENUM ('package','payg','board-train','membership','group-class');
CREATE TYPE charge_status      AS ENUM ('requires_payment','succeeded','failed','refunded');
CREATE TYPE ledger_reason      AS ENUM ('purchase','booking-debit','cancel-refund','adjustment','membership-grant');
-- 2026-08-19 (`designs/client-keyed-refund-recovery.md` §4): 'unroutable' is a
-- TERMINAL fourth state, not a variant of 'pending'. It means "money is owed
-- back and no automatic path can ever send it" — the charge behind the refund
-- carries no stripe_payment_intent_id (pre-Stripe-wire seed money), so there is
-- nothing at Stripe to reverse and a human must resolve it out of band. Keeping
-- those rows at 'pending' made every worklist and every abandon report carry
-- them forever with an instruction nobody could follow. `ADD VALUE` is
-- effectively irreversible (Postgres cannot drop an enum value without a type
-- rebuild) — accepted, because the arm names a real, permanent business state.
CREATE TYPE refund_status      AS ENUM ('pending','succeeded','failed','unroutable');
CREATE TYPE rate_unit          AS ENUM ('per-day','per-night','per-session','per-week','flat');
CREATE TYPE media_kind         AS ENUM ('image', 'video');
CREATE TYPE media_purpose      AS ENUM ('dog-profile','owner-avatar','report-photo','report-video','message-attachment');
-- Day-17 §A amendment 2026-05-27: derivatives-worker job queue states. The
-- worker (runMediaDerivativesOnce, composed into the scheduler tick) claims
-- 'pending' rows via FOR UPDATE SKIP LOCKED, flips to 'processing', runs sharp
-- to populate media_assets.derivatives, then 'done' on success or 'failed'
-- with last_error captured. 'failed' rows are parked (no auto-retry today);
-- Day-20 observability decides whether to re-enqueue.
CREATE TYPE media_derivative_job_status AS ENUM ('pending','processing','done','failed');

-- ----------------------------------------------------------------------------
-- Identity (R3, R4) — the Supabase-Auth mirror rows
-- ----------------------------------------------------------------------------
-- ----------------------------------------------------------------------------
-- Locations (Δ 2026-06-08) — the physical schools, as an attributed entity.
-- `slug` is the natural PK + the value every `location` column FKs and the wire
-- emits (unchanged). Add a school = INSERT a row (no ALTER TYPE). `timezone`
-- replaces the hardcoded America/Chicago assumption for a future region.
-- ----------------------------------------------------------------------------
CREATE TABLE locations (
  slug         text PRIMARY KEY,                       -- 'fayetteville','bentonville'
  display_name text NOT NULL,                          -- 'Fayetteville, AR'
  address      text,
  latitude     double precision,
  longitude    double precision,
  timezone     text NOT NULL DEFAULT 'America/Chicago',
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- The two physical schools, seeded with the schema as reference data so every
-- `location` FK resolves on a fresh volume. address/coords are backfilled when
-- known; both share America/Chicago. Adding a school = adding a row here.
INSERT INTO locations (slug, display_name) VALUES
  ('fayetteville', 'Fayetteville, AR'),
  ('bentonville',  'Bentonville, AR');

CREATE TABLE owners (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supabase_uid      uuid UNIQUE NOT NULL,            -- the Supabase Auth user id
  name              text NOT NULL,
  email             text NOT NULL,
  phone             text NOT NULL,
  location          text NOT NULL REFERENCES locations(slug),
  avatar_image_path text,
  emergency_name    text,
  emergency_relationship text,
  emergency_phone   text,
  -- Home address (owner self-entered; native OS autofill on mobile). All
  -- nullable — existing/imported owners predate the field, and onboarding
  -- may skip it. No `country` column: NWA is Arkansas-only (YAGNI).
  address_line1     text,
  address_line2     text,
  address_city      text,
  address_state     text,
  address_zip       text,
  -- Notification prefs are a leaf preference document, not relational. JSONB.
  push_notifications_enabled  boolean NOT NULL DEFAULT true,
  push_notification_categories  jsonb NOT NULL DEFAULT '{}'::jsonb,
  email_notifications_enabled boolean NOT NULL DEFAULT true,
  email_notification_categories jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Public welcome-screen gallery opt-OUT (default true): when true, this owner's
  -- dogs may appear in the pre-login GET /welcome-dogs gallery. Owners toggle it
  -- in Account. Opt-out model per the 2026-06-14 product decision (public by
  -- default) — only name + photo are exposed, never PII.
  show_dogs_on_welcome boolean NOT NULL DEFAULT true,
  external_ref      text,                             -- R6: gingr id when imported
  source            record_source NOT NULL DEFAULT 'app',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  -- Account deletion = expire + scrub PII columns (name/email/phone/avatar/
  -- emergency_*/address_*). supabase_uid is retained for audit linkage; the Supabase
  -- Auth user is disabled there so it can never re-authenticate.
  expired_at        timestamptz
);
-- R6 import seam: one LIVE row per (source, external_ref). Partial so an
-- expired/anonymized account never blocks a re-import of the same Gingr id.
CREATE UNIQUE INDEX owners_source_ref_uidx
  ON owners (source, external_ref) WHERE expired_at IS NULL;

CREATE TABLE staff (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supabase_uid  uuid UNIQUE NOT NULL,                 -- staff log in via the SAME
                                                      -- Supabase project, role:'staff'
  name          text NOT NULL,                        -- seed = lib/staff.ts roster
  role          staff_role NOT NULL,
  location      text REFERENCES locations(slug),
  image_path    text,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expired_at    timestamptz                           -- NULL = live (never hard-deleted)
);

-- ----------------------------------------------------------------------------
-- Dogs (R3 ownership root). A dog belongs to EITHER an owner (a client) OR a
-- staff member (staff bring their own dogs; staff are never clients). Staff
-- dogs are capacity-exempt — see capacity_exempt + the API capacity logic.
-- ----------------------------------------------------------------------------
CREATE TABLE dogs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id           uuid REFERENCES owners(id) ON DELETE RESTRICT,
  staff_owner_id     uuid REFERENCES staff(id)  ON DELETE RESTRICT,
  name               text NOT NULL,
  breed              text NOT NULL,
  -- R5 improvement: store birthdate, derive age. The mock's age_months is a
  -- stale snapshot; a birthdate stays correct forever. API still emits
  -- age_months (computed) so the FE is unchanged.
  birthdate          date,
  age_months_override integer,   -- fallback when birthdate unknown (import)
  profile_image_path text,
  special_notes      text NOT NULL DEFAULT '',
  evaluation_status  evaluation_status NOT NULL DEFAULT 'not-evaluated',
  evaluation_date    timestamptz,
  -- Staff-gated boarding access. Boarding is not offered to everyone; staff flip
  -- this per dog. Default false = hidden until granted. Owner-facing surfaces
  -- (dog-profile boarding tile, boarding booking flow) hide boarding for dogs
  -- where this is false; not a server booking-gate trigger like evaluation.
  boarding_enabled   boolean NOT NULL DEFAULT false,
  -- §J.3 alumni attendance flag (2026-07-09). Set by the monthly scan when an
  -- ALUMNI dog (all 5 curriculum programs completed — dog_completed_programs)
  -- attended <2 qualifying sessions (group-class / day-school / day-care) in
  -- the just-closed Chicago month. The dog STAYS alumni and its credits keep
  -- no-expiry; the flag means "staff re-check (eval) before the next booking."
  -- Staff clear it (set NULL) after the re-check. Soft surface — not a
  -- booking-gate trigger like evaluation.
  alumni_attendance_flagged_at timestamptz,
  -- Spay/neuter (Shanthi ruling 2026-07-14): a PROFILE question, never a hard
  -- block. NULL = unanswered (pre-existing dogs; nothing diverts). FALSE
  -- diverts day-program bookings into the pending-request approval lane
  -- (staff eyes, not a wall — even a too-young intact dog diverts, per
  -- Allison 2026-07-14). planned_on: the owner's stated spay/neuter date —
  -- a scheduled reminder fires that day prompting a profile update. Only
  -- meaningful while not yet fixed (CHECK below).
  spayed_neutered    boolean,
  spay_neuter_planned_on date,
  -- Per-dog overrides of which optional dog-form sections this dog collects
  -- (trainingGoals / feeding / medications / notes / primaryVet / otherVaccines).
  -- A partial preference document — same JSONB-leaf pattern as
  -- owners.*_notification_categories — keyed by the FE DogFieldKey. '{}' = no
  -- override. The API layers it over the app-wide intake_field_settings default
  -- so the owner form only asks for what staff want for this dog (sign-up shows
  -- the app default; manage shows default + this dog's overrides). Staff-set,
  -- same control model as boarding_enabled.
  field_overrides    jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Primary vet on file so staff can call to confirm vaccines / ask health
  -- questions. FK wired after `vets` is created (forward ref — same deferred-
  -- ALTER pattern as credit_ledger→charges). NULL = none recorded.
  primary_vet_id     uuid,
  -- Staff-owned dogs do not count toward cohort/day capacity. Generated so
  -- capacity queries are a trivial `WHERE NOT capacity_exempt`.
  capacity_exempt    boolean GENERATED ALWAYS AS (staff_owner_id IS NOT NULL) STORED,
  external_ref       text,
  source             record_source NOT NULL DEFAULT 'app',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  expired_at         timestamptz,                     -- NULL = live; soft-delete only
  CHECK (birthdate IS NOT NULL OR age_months_override IS NOT NULL),
  -- A dog belongs to exactly one of: a client owner, or a staff member.
  CHECK ((owner_id IS NOT NULL) <> (staff_owner_id IS NOT NULL)),
  -- A planned spay/neuter date only makes sense while the dog isn't fixed.
  CHECK (spay_neuter_planned_on IS NULL OR spayed_neutered IS NOT TRUE)
);
CREATE INDEX dogs_owner_idx       ON dogs (owner_id);
CREATE INDEX dogs_staff_owner_idx ON dogs (staff_owner_id);
CREATE UNIQUE INDEX dogs_source_ref_uidx
  ON dogs (source, external_ref) WHERE expired_at IS NULL;

-- ----------------------------------------------------------------------------
-- Vets (locked 2026-05-19) — the dog's primary veterinarian / clinic contact
-- so staff can phone to confirm vaccinations or ask a health question. Its own
-- table (not JSON on the dog) so one clinic serving many dogs is ONE row — a
-- phone/address change updates once, not per dog. dogs.primary_vet_id is a
-- single primary contact; a M2M dog_vets join is YAGNI until a real second
-- case. Per-shot provenance (dog_vaccines.issued_by_vet_id) is an additive
-- future option, intentionally not modeled now. Soft-expire + import seam.
--
-- Population model: ~50 curated rows are preloaded with source='seed' + a
-- stable external_ref slug (idempotent re-seed via the partial unique). Owners
-- creating a dog pick from that list; "my vet isn't here" creates a row with
-- source='app' (the default). De-duplication of user-created rows is a
-- CREATE-FLOW concern (search-existing-first typeahead), NOT a DB constraint —
-- a fuzzy clinic name can't be UNIQUE. Staff verify/merge user rows in the
-- DEFERRED admin dashboard; PATCH/DELETE vets is staff-only (a shared row must
-- not be editable by one owner). Expiring a vet referenced by live dogs is
-- API-blocked; the ON DELETE SET NULL FK is only a stray-hard-delete backstop.
-- ----------------------------------------------------------------------------
CREATE TABLE vets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,                          -- vet or clinic name as the owner gives it
  phone        text,                                   -- load-bearing: staff call this
  email        text,
  address      text,
  notes        text,                                   -- staff context ("ask for Dr. X", hours)
  external_ref text,
  source       record_source NOT NULL DEFAULT 'app',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  expired_at   timestamptz                             -- NULL = live; soft-delete only
);
-- Partial unique (hardening-bake convention) — an expired vet never blocks a
-- re-import of the same clinic; app rows (NULL external_ref) stay distinct.
CREATE UNIQUE INDEX vets_source_ref_uidx
  ON vets (source, external_ref) WHERE expired_at IS NULL;
-- Forward-ref FK: vets is defined after dogs, so wire it here — exact mirror
-- of the credit_ledger→charges deferred-constraint pattern further below.
-- ON DELETE SET NULL: losing the vet lookup must never block/destroy the dog.
ALTER TABLE dogs
  ADD CONSTRAINT dogs_primary_vet_fk
  FOREIGN KEY (primary_vet_id) REFERENCES vets(id) ON DELETE SET NULL;
CREATE INDEX dogs_primary_vet_idx ON dogs (primary_vet_id);

-- Vaccination gating (locked 2026-05-19, health rule). Catalog of vaccines
-- that GATE bookings, data-driven so the rule isn't hardcoded in the trigger:
-- gates_categories lists the service categories each vaccine is mandatory for
-- (seed: rabies/dhpp/bordetella gate day-care, day-school, boarding,
-- board-and-train). A free-text dog_vaccines row with no requirement_key is a
-- display-only record and never gates. Soft-expire like group_classes.
CREATE TABLE required_vaccines (
  key              text PRIMARY KEY,                    -- 'rabies' | 'dhpp' | 'bordetella' | ...
  label            text NOT NULL,
  gates_categories service_category[] NOT NULL,         -- categories this vaccine is required for
  -- Shanthi ruling 2026-07-14: puppy classes don't require the full set (no
  -- rabies yet). Group-class bookings whose cohort's class_key is listed here
  -- skip THIS vaccine; only consulted when category = 'group-class'.
  exempt_class_keys group_class_key[] NOT NULL DEFAULT '{}',
  expired_at       timestamptz                          -- NULL = live (retire a requirement = expire)
);

CREATE TABLE dog_vaccines (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dog_id          uuid NOT NULL REFERENCES dogs(id) ON DELETE CASCADE,
  name            text NOT NULL,                        -- as entered/displayed
  -- Set when this record satisfies a gating requirement; NULL = display-only.
  requirement_key text REFERENCES required_vaccines(key),
  expires_at      date NOT NULL,
  expired_at      timestamptz                           -- NULL = live (soft-delete)
);
CREATE INDEX dog_vaccines_dog_idx ON dog_vaccines (dog_id);
CREATE INDEX dog_vaccines_req_idx ON dog_vaccines (dog_id, requirement_key)
  WHERE requirement_key IS NOT NULL AND expired_at IS NULL;

CREATE TABLE dog_medications (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dog_id    uuid NOT NULL REFERENCES dogs(id) ON DELETE CASCADE,
  name      text NOT NULL,
  dose      text NOT NULL,
  frequency text NOT NULL,
  expired_at timestamptz                              -- NULL = live (soft-delete)
);
CREATE INDEX dog_medications_dog_idx ON dog_medications (dog_id);

CREATE TABLE dog_feeding (                            -- 1:1 with dogs
  dog_id    uuid PRIMARY KEY REFERENCES dogs(id) ON DELETE CASCADE,
  brand     text NOT NULL,
  amount    text NOT NULL,
  frequency text NOT NULL,
  notes     text,
  expired_at timestamptz                              -- NULL = live (soft-delete)
);

-- Group classes a dog completed. R7: replaces the mock dog.completed_class_keys
-- denormalized field with real rows derived from completed group-class bookings.
-- The API computes prereq eligibility from this, never trusts a client flag.
CREATE TABLE dog_completed_classes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dog_id        uuid NOT NULL REFERENCES dogs(id) ON DELETE CASCADE,
  class_key     group_class_key NOT NULL,
  completed_at  timestamptz NOT NULL DEFAULT now(),
  expired_at    timestamptz                           -- NULL = live (soft-delete)
);
-- One LIVE completion per (dog, class); partial so an erroneously-recorded
-- completion can be expired and the class genuinely re-completed later.
CREATE UNIQUE INDEX dog_completed_classes_uidx
  ON dog_completed_classes (dog_id, class_key) WHERE expired_at IS NULL;

-- §J.3 (2026-07-09): day-school curriculum programs a dog completed — the "5
-- courses" (foundation / advanced / loose-leash / house-manners / cgc).
-- Staff-authored (report `results` are per-skill JSONB with no per-course
-- aggregate, so completion needs its own record — same reasoning as
-- dog_completed_classes above). ALUMNI STATUS IS DERIVED: a dog with all 5
-- live rows is alumni; no separate status row to drift. Becoming alumni
-- (5th row) clears expires_at on the dog's live credit lots (§J.3).
CREATE TABLE dog_completed_programs (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dog_id                 uuid NOT NULL REFERENCES dogs(id) ON DELETE CASCADE,
  program                report_program NOT NULL CHECK (program IN
    ('foundation', 'advanced', 'loose-leash', 'house-manners', 'cgc')),
  completed_at           timestamptz NOT NULL DEFAULT now(),
  completed_by_staff_id  uuid REFERENCES staff(id) ON DELETE RESTRICT,
  expired_at             timestamptz                -- NULL = live (soft-delete)
);
-- One LIVE completion per (dog, program); partial so an erroneously-recorded
-- completion can be expired and genuinely re-completed later.
CREATE UNIQUE INDEX dog_completed_programs_uidx
  ON dog_completed_programs (dog_id, program) WHERE expired_at IS NULL;

-- ----------------------------------------------------------------------------
-- Group classes + cohorts (capacity enforced — fixes digest gotcha #5)
-- ----------------------------------------------------------------------------
CREATE TABLE group_classes (
  key                group_class_key PRIMARY KEY,
  name               text NOT NULL,
  weeks              integer NOT NULL CHECK (weeks > 0),
  price_per_dog_cents integer NOT NULL CHECK (price_per_dog_cents >= 0),
  capacity           integer NOT NULL CHECK (capacity > 0),
  age_range          text,
  description        text NOT NULL,
  enrollment_type    text NOT NULL CHECK (enrollment_type IN ('open','cohort')),
  expired_at         timestamptz                      -- NULL = live (soft-delete)
);

-- Per-class prerequisite OR-alternatives (amended 2026-05-20, Day 6a). Each
-- row is one option; multiple rows for the same class_key = OR (the dog needs
-- to have completed ANY ONE). Zero rows = no prereqs. Example: a future
-- public-manners class with rows for both manners-1 AND manners-2 — the dog
-- passes either to be eligible. R7 eligibility is server-derived: walk this
-- table for the target class and check dog_completed_classes for any matching
-- option. If AND-chains arrive ("advanced needs manners-1 AND puppy"), add a
-- `group_id smallint` column and treat group_id as the AND-set; OR across
-- groups (DNF). Replaced the prior singular `group_classes.prereq_class_key`
-- FK, which couldn't express OR.
CREATE TABLE class_prereq_options (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_key         group_class_key NOT NULL REFERENCES group_classes(key) ON DELETE CASCADE,
  prereq_class_key  group_class_key NOT NULL REFERENCES group_classes(key),
  created_at        timestamptz NOT NULL DEFAULT now(),
  expired_at        timestamptz                      -- NULL = live (soft-delete)
);
CREATE UNIQUE INDEX class_prereq_options_uidx
  ON class_prereq_options (class_key, prereq_class_key) WHERE expired_at IS NULL;
CREATE INDEX class_prereq_options_class_idx ON class_prereq_options (class_key);

-- Per-class resource links (handouts / info-page articles) surfaced on the
-- dog-profile Group page. The gate is COMPLETION: a resource is shown to an
-- owner only once a dog has completed the class. Eligibility is derived from
-- dog_completed_classes at read time — the same completion source that gates
-- prerequisites (R7) — never a stored "unlocked" flag. Mirrors
-- class_prereq_options: keyed by class_key, soft-expire, FK ON DELETE CASCADE;
-- adds `position` for explicit display order within a class.
CREATE TABLE class_resources (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_key       group_class_key NOT NULL REFERENCES group_classes(key) ON DELETE CASCADE,
  title           text NOT NULL,
  subtitle        text,
  deep_link_path  text NOT NULL,                  -- allowlisted in-app route, e.g. '/info/puppy-class'
  position        smallint NOT NULL DEFAULT 0,    -- display order within a class
  created_at      timestamptz NOT NULL DEFAULT now(),
  expired_at      timestamptz                     -- NULL = live (soft-delete)
);
-- One LIVE link per (class, route); partial so a retired resource can be
-- re-added later.
CREATE UNIQUE INDEX class_resources_uidx
  ON class_resources (class_key, deep_link_path) WHERE expired_at IS NULL;
CREATE INDEX class_resources_class_idx ON class_resources (class_key) WHERE expired_at IS NULL;

CREATE TABLE cohorts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_key    group_class_key NOT NULL REFERENCES group_classes(key),
  location     text NOT NULL REFERENCES locations(slug),
  start_date   timestamptz NOT NULL,
  end_date     timestamptz,
  weekly_time  text NOT NULL,                          -- display label e.g. "6:00 PM"
  weeks        integer NOT NULL CHECK (weeks > 0),
  capacity     integer NOT NULL CHECK (capacity > 0),  -- snapshot of class cap
  filled       integer NOT NULL DEFAULT 0 CHECK (filled >= 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  expired_at   timestamptz,                            -- NULL = live (soft-delete)
  CHECK (filled <= capacity)                            -- gotcha #5: hard ceiling
);
CREATE INDEX cohorts_class_idx ON cohorts (class_key);

-- ----------------------------------------------------------------------------
-- Reports (R2: base row + discriminator + JSONB variant payloads)
-- ----------------------------------------------------------------------------
-- One reports row per session/cohort. Curriculum reports populate `results`
-- (JSONB envelope: `{ results: Record<skillKey, SkillResult>, practice_at_home?,
-- friends_today?, additional_skills_completed? }` — pinned Day 6b; the wire
-- helper spreads the envelope to four sibling top-level keys per §B Report);
-- the four variant report kinds populate `content` (JSONB doc; shape
-- documented per-variant in DATA-CONTRACT.md). The CHECK encodes "category
-- implies which payload" so the DB enforces what the mock only enforced
-- with runtime route guards.
CREATE TABLE reports (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dog_id              uuid NOT NULL REFERENCES dogs(id) ON DELETE CASCADE,
  date                timestamptz NOT NULL,
  trainer_staff_id    uuid REFERENCES staff(id),       -- day-care has none
  category            service_category NOT NULL,
  program             report_program NOT NULL,
  excerpt             text NOT NULL,
  full_text           text NOT NULL,
  visit_count         integer,
  verdict_headline    text,
  results             jsonb,   -- curriculum envelope: { results, practice_at_home?, friends_today?, additional_skills_completed? }
  content             jsonb,   -- variant doc: private_lesson | boarding_session | board_train_session | group_class_session
  external_ref        text,
  source              record_source NOT NULL DEFAULT 'app',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  expired_at          timestamptz,                     -- NULL = live (soft-delete)
  -- R2 consistency guard: variant programs must carry `content`.
  CHECK (
    (program IN ('private-lesson','boarding-session','board-train-session','group-class-session')
       AND content IS NOT NULL)
    OR
    (program IN ('foundation','advanced','loose-leash','house-manners','cgc'))
  )
);
CREATE INDEX reports_dog_date_idx ON reports (dog_id, date DESC);
CREATE UNIQUE INDEX reports_source_ref_uidx
  ON reports (source, external_ref) WHERE expired_at IS NULL;

-- ----------------------------------------------------------------------------
-- Media assets (locked 2026-05-19) — Cloudflare R2 object store; Postgres holds
-- ONLY metadata + the object key, never bytes. Upload: client gets a presigned
-- PUT from POST /uploads/sign, uploads direct to R2, then POST /media records
-- the row. Download: Node issues a short-lived presigned GET (ownership
-- enforced in middleware — no RLS). Derivatives (2-3 image sizes + blurhash;
-- one H.264 MP4 for video) generated at upload by a sharp/ffmpeg worker. The
-- photo/video refs inside reports.content (JSONB) + dogs.profile_image_path +
-- owners.avatar_image_path carry a media_assets.id; the API resolves id →
-- signed URL at read time so the FE shape is unchanged. No HLS (YAGNI).
-- ----------------------------------------------------------------------------
CREATE TABLE media_assets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  dog_id        uuid REFERENCES dogs(id) ON DELETE CASCADE,
  report_id     uuid REFERENCES reports(id) ON DELETE CASCADE,
  kind          media_kind NOT NULL,
  purpose       media_purpose NOT NULL,
  object_key    text NOT NULL,                -- R2 key; bucket is private
  content_type  text NOT NULL,
  bytes         bigint NOT NULL,
  width         integer,
  height        integer,
  duration_ms   integer,                      -- video only
  blurhash      text,                         -- images; consumed by expo-image
  derivatives   jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{label,object_key,w,h}] + mp4
  created_by    sender_kind NOT NULL,         -- owner upload vs staff (report authoring)
  external_ref  text,
  source        record_source NOT NULL DEFAULT 'app',
  created_at    timestamptz NOT NULL DEFAULT now(),
  expired_at    timestamptz                   -- NULL = live; expire row, then R2 object swept by a cleanup job
);
CREATE UNIQUE INDEX media_assets_source_ref_uidx
  ON media_assets (source, external_ref) WHERE expired_at IS NULL;
CREATE INDEX media_assets_owner_idx  ON media_assets (owner_id);
CREATE INDEX media_assets_dog_idx    ON media_assets (dog_id);
CREATE INDEX media_assets_report_idx ON media_assets (report_id);

-- ----------------------------------------------------------------------------
-- Media derivatives job queue (Day-17 §A amendment 2026-05-27). Worker queue,
-- one row per media_assets row that needs derivative processing. Same pattern
-- as scheduled_notifications: claim via FOR UPDATE SKIP LOCKED on
-- (status='pending'), worker processes sharp pipeline (200/600/1200 + blurhash
-- for images; video deferred), flips status='done' + writes the derivatives
-- jsonb back on media_assets. 'failed' rows are parked with last_error for
-- Day-20 observability. UNIQUE on media_asset_id makes enqueue idempotent
-- (a re-POST /media on the same key can't double-add).
-- Append-only by nature — no expired_at (cancel = status='failed').
-- ----------------------------------------------------------------------------
CREATE TABLE media_derivative_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  media_asset_id  uuid NOT NULL UNIQUE REFERENCES media_assets(id) ON DELETE CASCADE,
  status          media_derivative_job_status NOT NULL DEFAULT 'pending',
  attempts        integer NOT NULL DEFAULT 0,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX media_derivative_jobs_pending_idx
  ON media_derivative_jobs (created_at) WHERE status = 'pending';

-- ----------------------------------------------------------------------------
-- Bookings (R1 multi-dog via join table; explicit report FK fixes gotcha #8)
-- ----------------------------------------------------------------------------
CREATE TABLE bookings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id          uuid NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  lead_dog_id       uuid NOT NULL REFERENCES dogs(id),
  category          service_category NOT NULL,
  status            booking_status NOT NULL DEFAULT 'upcoming',
  scheduled_at      timestamptz NOT NULL,
  duration_minutes  integer,
  trainer_staff_id  uuid REFERENCES staff(id),
  notes             text,
  lesson_setting    lesson_setting,                    -- Δ 2026-07-14: private-lesson only ('home'|'public'), copied from the request at approve; NULL otherwise
  cohort_id         uuid REFERENCES cohorts(id),       -- set for group-class rows
  -- Explicit linkage replaces the mock (dogId,category,day) fuzzy join.
  -- report_id: the per-session report for this booking (1:1).
  -- session_report_id: the shared cohort report N weekly rows point at.
  report_id         uuid REFERENCES reports(id),
  session_report_id uuid REFERENCES reports(id),
  -- Confirmation + stay window (locked 2026-05-19; PHASE-PLAN backend-req §648).
  -- confirmed_at: set when staff confirms (NULL until then) — drives reminders.
  -- dropoff_at/pickup_at: boarding + board-and-train stay window, distinct from
  -- scheduled_at; the notification scheduler keys the 24h profile-check off
  -- dropoff_at. NULL for non-stay categories.
  confirmed_at      timestamptz,
  dropoff_at        timestamptz,
  pickup_at         timestamptz,
  -- Which physical school this session is at. Drives per-location day capacity
  -- (day_capacity is keyed by location) and the rate lookup. FKs locations(slug);
  -- owners/staff now reference the same locations table (unified Δ 2026-06-08).
  location          text REFERENCES locations(slug),
  -- Cancellation window (locked 2026-05-19). The category-specific free-cancel
  -- RULE is API logic; the schema stores the RESOLVED outcome the way
  -- day_capacity stores resolved overrides: cancel_deadline_at is the computed
  -- last free-cancel instant (set at creation); on cancel the API sets
  -- cancelled_at + cancel_forfeited (true = cancelled past the deadline →
  -- credit/charge forfeited, no refund). status still flips to 'cancelled'.
  cancelled_at        timestamptz,
  cancellation_reason text,
  cancel_deadline_at  timestamptz,
  cancel_forfeited    boolean NOT NULL DEFAULT false,
  -- R5 (Allison sim-QA 2026-07-27): WHO cancelled + WHY, surfaced in the owner
  -- app's cancelled-booking banner. cancelled_by = 'owner' (self-cancel) or
  -- 'staff' (the school cancelled it); cancel_reason is the optional free-text
  -- a staff caller supplies ("The school cancelled this on Jul 17" + the reason
  -- line). Both NULL on legacy-import + not-yet-cancelled rows. Distinct from the
  -- older, still-unused `cancellation_reason` column above.
  cancelled_by        text CHECK (cancelled_by IN ('owner','staff')),
  cancel_reason       text,
  external_ref      text,
  source            record_source NOT NULL DEFAULT 'app',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  expired_at        timestamptz,                     -- NULL = live; cancellation sets status, deletion expires
  -- #7 cross-column guards: cohort iff group-class; stay window only for stays.
  CHECK ((category = 'group-class') = (cohort_id IS NOT NULL)),
  CHECK (dropoff_at IS NULL OR category IN ('boarding','board-and-train'))
);
CREATE INDEX bookings_owner_idx       ON bookings (owner_id);
CREATE INDEX bookings_lead_dog_idx    ON bookings (lead_dog_id, scheduled_at);
CREATE INDEX bookings_cohort_idx      ON bookings (cohort_id);
CREATE INDEX bookings_status_time_idx ON bookings (status, scheduled_at);
CREATE INDEX bookings_dropoff_idx ON bookings (dropoff_at) WHERE dropoff_at IS NOT NULL;
CREATE INDEX bookings_location_time_idx ON bookings (location, scheduled_at);
CREATE UNIQUE INDEX bookings_source_ref_uidx
  ON bookings (source, external_ref) WHERE expired_at IS NULL;

-- All dogs on a booking (lead + additional). is_lead mirrors bookings.lead_dog_id
-- so single-dog and multi-dog queries are uniform.
CREATE TABLE booking_dogs (
  booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  dog_id     uuid NOT NULL REFERENCES dogs(id) ON DELETE CASCADE,
  is_lead    boolean NOT NULL DEFAULT false,
  -- Real attendance/check-in (locked 2026-05-19), per-dog because group +
  -- multi-dog sessions have independent presence. 'pending' until staff marks
  -- it at/after the session. Powers true attendance + no-show stats — which
  -- are consumed by the DEFERRED admin dashboard, NOT the 4-verb portal.
  attendance             booking_attendance NOT NULL DEFAULT 'pending',
  checked_in_at          timestamptz,
  checked_in_by_staff_id uuid REFERENCES staff(id),
  expired_at             timestamptz,                 -- NULL = live; unlinking a dog expires the row
  PRIMARY KEY (booking_id, dog_id)
);
CREATE INDEX booking_dogs_dog_idx ON booking_dogs (dog_id);

-- ----------------------------------------------------------------------------
-- After School Coaching opt-in (locked 2026-05-19) — a per-dog add-on that is
-- ONLY bookable against a Day School booking (the booking flow's `after-school`
-- phase / afterSchoolByDogId). The "only if in Day School" rule is enforced in
-- pure DDL, not app code: the composite FK targets bookings(id, category) and
-- the CHECK pins booking_category = 'day-school', so a row physically cannot
-- reference a non-day-school booking — no trigger required. (B&T's bundled
-- "4 months After School Coaching" is part of the B&T program/request, NOT
-- this user opt-in, and is intentionally not modeled here.)
-- ----------------------------------------------------------------------------
-- Composite-unique on bookings enables the subtype foreign key below.
CREATE UNIQUE INDEX bookings_id_category_uidx ON bookings (id, category);

CREATE TABLE after_school_optins (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id       uuid NOT NULL,
  booking_category service_category NOT NULL,
  dog_id           uuid NOT NULL REFERENCES dogs(id) ON DELETE CASCADE,
  owner_id         uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  school_day_count integer NOT NULL CHECK (school_day_count > 0),
  external_ref     text,
  source           record_source NOT NULL DEFAULT 'app',
  created_at       timestamptz NOT NULL DEFAULT now(),
  expired_at       timestamptz,                       -- NULL = live (soft opt-out)
  -- Subtype FK: the backing booking must exist AND be category 'day-school'.
  FOREIGN KEY (booking_id, booking_category)
    REFERENCES bookings (id, category) ON DELETE CASCADE,
  CHECK (booking_category = 'day-school')          -- "only if in Day School"
);
-- One LIVE opt-in per (booking, dog); partial so a soft opt-out doesn't block
-- re-opting the same dog into the same day-school booking.
CREATE UNIQUE INDEX after_school_optins_uidx
  ON after_school_optins (booking_id, dog_id) WHERE expired_at IS NULL;
CREATE UNIQUE INDEX after_school_optins_source_ref_uidx
  ON after_school_optins (source, external_ref) WHERE expired_at IS NULL;
CREATE INDEX after_school_optins_dog_idx   ON after_school_optins (dog_id);
CREATE INDEX after_school_optins_owner_idx ON after_school_optins (owner_id);

-- ----------------------------------------------------------------------------
-- Pending requests (R1: same multi-dog shape as bookings; R8 structured tags)
-- ----------------------------------------------------------------------------
CREATE TABLE pending_requests (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id            uuid NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  lead_dog_id         uuid NOT NULL REFERENCES dogs(id),
  category            service_category NOT NULL,
  status              request_status NOT NULL DEFAULT 'submitted',
  submitted_at        timestamptz NOT NULL DEFAULT now(),
  notes_per_dog       text,                            -- structured PendingNotes
  notes_joint         text,
  staff_preference    text,                            -- R8: 'any' | staff slug
  lesson_setting      lesson_setting,                  -- Δ 2026-07-14: private-lesson only ('home'|'public'); NULL otherwise
  -- R8 + Δ 2026-06-17: replaced the single comfort_level enum with a
  -- staff-defined, multi-select trait list (the `descriptor:<key>` wire tags).
  -- Stores keys; the label vocabulary lives in dog_descriptors. Flat text[] to
  -- match staff_preference's untyped-text style — no FK on array elements
  -- (same loose coupling as staff_preference → staff slug).
  descriptor_keys     text[] NOT NULL DEFAULT '{}',
  length_weeks        integer,                         -- board-and-train only
  -- Day-program divert (Shanthi ruling 2026-07-14): day-school / day-care
  -- submissions that trip the approval rules (3-month re-eval staleness /
  -- intact dog) land HERE instead of bookings. These columns carry what the
  -- staff-approve conversion needs to create the bookings verbatim; the
  -- session timestamps ride in pending_request_preferred_dates. All NULL /
  -- empty on the classic request categories (PL / B&T / boarding).
  location            text REFERENCES locations(slug),
  payment             text CHECK (payment IN ('credits','payg')),
  -- FK added AFTER payment_methods is created (below) — an inline REFERENCES
  -- here forward-references a table defined later and breaks fresh initdb.
  payment_method_id   uuid,
  divert_reasons      text[] NOT NULL DEFAULT '{}',    -- 'reevaluation-stale' | 'not-spayed-neutered'
  -- Approval lifecycle (real, produced by the minimal staff portal — not auto)
  approved_at         timestamptz,
  approved_by_staff_id uuid REFERENCES staff(id),
  -- When status='converted', the booking the portal-approval created.
  converted_booking_id uuid REFERENCES bookings(id),
  external_ref        text,
  source              record_source NOT NULL DEFAULT 'app',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  expired_at          timestamptz                      -- NULL = live; cancel sets status, deletion expires
);
CREATE UNIQUE INDEX pending_requests_source_ref_uidx
  ON pending_requests (source, external_ref) WHERE expired_at IS NULL;
CREATE INDEX pending_requests_owner_idx  ON pending_requests (owner_id);
CREATE INDEX pending_requests_status_idx ON pending_requests (status);

CREATE TABLE pending_request_dogs (
  request_id uuid NOT NULL REFERENCES pending_requests(id) ON DELETE CASCADE,
  dog_id     uuid NOT NULL REFERENCES dogs(id) ON DELETE CASCADE,
  is_lead    boolean NOT NULL DEFAULT false,
  expired_at timestamptz,                              -- NULL = live
  PRIMARY KEY (request_id, dog_id)
);

CREATE TABLE pending_request_preferred_dates (
  request_id   uuid NOT NULL REFERENCES pending_requests(id) ON DELETE CASCADE,
  ordinal      smallint NOT NULL,                      -- 1,2,3 ranked preference
  preferred_at timestamptz NOT NULL,
  expired_at   timestamptz,                            -- NULL = live
  PRIMARY KEY (request_id, ordinal)
);

-- ----------------------------------------------------------------------------
-- Day capacity (R5: a capacity day is a calendar DATE; sparse = override-only)
-- Per-LOCATION (locked 2026-05-19): each school runs its own openings, so the
-- key is (location, date). Only rows that DIFFER from the default rule are
-- stored. The Node API applies the business rule (weekend = closed; otherwise
-- DEFAULT_OPENINGS = 3) per location over the top of any override here. That
-- rule is API logic, not schema.
-- ----------------------------------------------------------------------------
CREATE TABLE day_capacity (
  location          text NOT NULL REFERENCES locations(slug),
  date              date NOT NULL,
  school_openings   integer NOT NULL CHECK (school_openings   >= 0),
  daycare_openings  integer NOT NULL CHECK (daycare_openings  >= 0),
  expired_at        timestamptz,                       -- NULL = live (override withdrawn = expire)
  PRIMARY KEY (location, date)
);

-- ----------------------------------------------------------------------------
-- Cancel-window settings (locked 2026-05-26, Day 13 §A amendment) — per-
-- category free-cancel hours, tunable from the staff portal (owner-only).
-- Same shape as day_capacity: a config table the API reads at booking-
-- creation time to stamp bookings.cancel_deadline_at; if a category row is
-- absent the API falls back to the TUNABLE per-category default table in
-- lib/cancelWindow.ts. Seeded at 48h flat across all categories (locked
-- 2026-05-26, Shanthi's call); staff portal PATCH /staff/cancel-window/
-- :category lets Shanthi tune any category.
--
-- One row per service_category; updated_by_staff_id stamps the actor on
-- the last edit (NULL = still the seeded default — useful for portal UX
-- "policy never customized" hint).
--
-- Resolved deadline math is API logic (lib/cancelWindow.computeCancelDeadline);
-- once a booking is created, bookings.cancel_deadline_at carries the resolved
-- instant forward. Changing the policy later does NOT retroactively re-stamp
-- existing rows — promise made at booking time honors at cancel time even if
-- policy moves later.
-- ----------------------------------------------------------------------------
CREATE TABLE cancel_window_settings (
  category               service_category PRIMARY KEY,
  hours_before           integer NOT NULL CHECK (hours_before > 0),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  updated_by_staff_id    uuid REFERENCES staff(id) ON DELETE SET NULL
);

INSERT INTO cancel_window_settings (category, hours_before) VALUES
  ('day-school',      48),
  ('day-care',        48),
  ('private-lesson',  48),
  ('group-class',     48),
  ('boarding',        48),
  ('board-and-train', 48),
  ('evaluation',      48);

-- Intake field settings (added 2026-06-17) — the app-wide default for which
-- optional dog-form sections we collect, tunable from the staff portal. Same
-- shape/role as cancel_window_settings: one row per field key, the API reads it
-- to seed the owner dog form (sign-up + the default for new dogs), and
-- dogs.field_overrides layers per-dog exceptions on top. A missing row falls
-- back to collected=true in API code (same code-side-default pattern as the
-- cancel window). `field_key` is the FE DogFieldKey (camelCase) so the JSONB
-- override keys, the wire, and this table share one vocabulary — no mapping.
-- updated_by_staff_id stamps the last editor (NULL = still the seeded default).
CREATE TABLE intake_field_settings (
  field_key             text PRIMARY KEY,
  collected             boolean NOT NULL DEFAULT true,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by_staff_id   uuid REFERENCES staff(id) ON DELETE SET NULL
);

INSERT INTO intake_field_settings (field_key) VALUES
  ('trainingGoals'),
  ('feeding'),
  ('medications'),
  ('notes'),
  ('primaryVet'),
  ('otherVaccines');

-- Dog descriptors (added 2026-06-17) — the org-wide list of trait pills an
-- owner can tag a dog with at private-lesson / board-and-train intake (replaced
-- the fixed low/medium/high comfort scale). Staff-defined and arbitrary: staff
-- add/relabel/remove from the portal. `key` is the stable id stored on a
-- request (pending_requests.descriptor_keys / the `descriptor:<key>` wire tag)
-- so relabeling never orphans a stored pick; `label` is the display text. Same
-- org-config role as intake_field_settings. `sort_order` drives chip render
-- order; `active=false` hides a descriptor from new intakes without deleting it
-- (stored picks on old requests still resolve their label).
CREATE TABLE dog_descriptors (
  key                 text PRIMARY KEY,
  label               text NOT NULL,
  sort_order          integer NOT NULL DEFAULT 0,
  active              boolean NOT NULL DEFAULT true,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by_staff_id uuid REFERENCES staff(id) ON DELETE SET NULL
);

INSERT INTO dog_descriptors (key, label, sort_order) VALUES
  ('nervous',               'Nervous',                1),
  ('shy-with-strangers',    'Shy with strangers',     2),
  ('reactive-on-leash',     'Reactive on leash',      3),
  ('good-with-dogs',        'Good with dogs',         4),
  ('high-energy',           'High energy',            5),
  ('food-motivated',        'Food motivated',         6),
  ('easily-overstimulated', 'Easily overstimulated',  7),
  ('easy-going',            'Easy-going',             8);

-- Credit-expiry settings (added 2026-06-20) — staff-tunable expiry window +
-- warning lead. Same org-config role as cancel_window_settings, but a two-tier
-- shape: ONE org-wide default row (location IS NULL) plus optional per-location
-- override rows (location = a slug). The API resolves a window as
-- per-location override → org-default → code default (lib/creditExpiry.ts
-- DEFAULT_CREDIT_EXPIRY_MONTHS = 12) when neither row exists.
--
-- expiry_window_months feeds the lot-expiry stamp at PURCHASE (non-retroactive,
-- same contract as the credit_ledger lot model: a later staff change affects
-- future grants only — already-stamped lots keep their expires_at).
--
-- warning_lead_days is staff-tunable NOW but has no consumer in P2; its reader
-- is the Phase-3 expiry-warning notification. Storing it here means P3 needs no
-- second migration — the staff editor sets it today.
--
-- A nullable PK is invalid, so exactly-one-default + one-row-per-location is
-- enforced by TWO partial unique indexes (the org-default uniqueness keys on the
-- constant `(location IS NULL)` so a second NULL row can't sneak in).
-- updated_by_staff_id stamps the last editor (NULL = still the seeded default).
CREATE TABLE credit_expiry_settings (
  location               text REFERENCES locations(slug),  -- NULL = org-wide default; a slug = per-location override
  expiry_window_months   integer NOT NULL CHECK (expiry_window_months > 0),
  warning_lead_days       integer NOT NULL CHECK (warning_lead_days >= 0),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  updated_by_staff_id    uuid REFERENCES staff(id) ON DELETE SET NULL
);

-- Exactly one org-default row (location IS NULL): the index keys on a constant
-- expression so any second NULL-location row collides.
CREATE UNIQUE INDEX credit_expiry_settings_org_default_uniq
  ON credit_expiry_settings ((location IS NULL)) WHERE location IS NULL;
-- At most one override row per location.
CREATE UNIQUE INDEX credit_expiry_settings_location_uniq
  ON credit_expiry_settings (location) WHERE location IS NOT NULL;

-- Seed the org-default: 12-month window, 60-day warning lead. Mirrors the
-- code default (DEFAULT_CREDIT_EXPIRY_MONTHS) so the resolve chain is a no-op
-- swap until staff tune it.
INSERT INTO credit_expiry_settings (location, expiry_window_months, warning_lead_days)
  VALUES (NULL, 12, 60);

-- ----------------------------------------------------------------------------
-- Credits — append-only ledger (replaces the mock mutable counter)
-- Δ 2026-06-18 (credit-expiry lot model): credits NOW expire, per Shanthi's
-- business rule — superseding the 2026-05-19 "credits do not expire" decision.
-- Multi-credit packs expire; single-day (1-credit) packs never do. Modeled as
-- LOTS, not a destructive sweep (the ledger stays append-only):
--   • A positive-delta row with lot_id NULL is a credit "lot" (source).
--     expires_at governs it — NULL = never (legacy/Gingr imports, 1-credit
--     packs, the never-expiring "pool"); a timestamp = forfeit once passed.
--   • A debit (delta<0) / refund (delta>0) row sets lot_id to the source lot
--     it draws from / returns to. lot_id NULL on a debit = drawn from the
--     never-expiring pool. Debit priority (Δ 2026-07-14, Allison ruling
--     "subscription credits first"): membership-grant lots first (soonest
--     expiry first; an alumni NULL-expiry membership lot after that dog's
--     expiring ones), then other lots soonest-expiry first, pool last —
--     see api creditLedgerRepository.findNextDebitLot.
-- NON-RETROACTIVE: expires_at is stamped once at purchase from the then-current
-- window (mirrors cancel_window_settings); a later window change affects future
-- purchases only. Existing + Gingr-imported credits stay NULL (grandfathered,
-- no backfill). Balance counts only live lots (see dog_credit_balance below).
-- Append-only by nature: NO expired_at — corrections are reversing entries.
-- ----------------------------------------------------------------------------
-- Per-location, effective-dated pricing. Two robustness Δs:
--   Δ 2026-06-04: the same pack `key` carries a different price per location.
--   Δ 2026-06-08: prices are effective-dated, mirroring service_rates — each
--     (key, location) tracks a sequence of rows with non-overlapping
--     [effective_from, effective_to) windows (effective_to NULL = open-ended
--     current). Repricing or retiring is "close the current row's effective_to
--     and (for a reprice) insert a new row" — never edit a priced row, so a
--     past purchase's package_id keeps pointing at the exact price it bought.
-- Hence a surrogate `id` PK (the (key, location) pair is no longer unique) and
-- UNIQUE(key, location, effective_from). Retirement is the effective window, not
-- a separate `active` flag (one mechanism, same as service_rates).
CREATE TABLE credit_packages (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key            text NOT NULL,                          -- e.g. 'school-8','school-12'
  location       text NOT NULL REFERENCES locations(slug),  -- which school this price is for
  mode           booking_mode NOT NULL,
  credits        integer NOT NULL CHECK (credits > 0),
  price_cents    integer NOT NULL CHECK (price_cents >= 0),
  label          text NOT NULL,
  is_popular     boolean NOT NULL DEFAULT false,
  effective_from date NOT NULL DEFAULT CURRENT_DATE,      -- when this price takes effect
  effective_to   date,                                    -- NULL = open-ended (current). Close to retire/reprice.
  UNIQUE (key, location, effective_from)
);

CREATE TABLE credit_ledger (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dog_id      uuid NOT NULL REFERENCES dogs(id) ON DELETE RESTRICT,
  mode        booking_mode NOT NULL,
  location    text NOT NULL REFERENCES locations(slug),  -- Δ 2026-06-04: which school these credits are for (per-location balances)
  delta       integer NOT NULL,                         -- + grant, - debit
  reason      ledger_reason NOT NULL,
  booking_id  uuid REFERENCES bookings(id),             -- set for booking-debit/refund
  package_id  uuid REFERENCES credit_packages(id),      -- Δ 2026-06-08: set for purchases; the exact priced version bought
  charge_id   uuid,                                     -- FK added after charges
  expires_at  timestamptz,                              -- Δ 2026-06-18: lot expiry on a source row (delta>0, lot_id NULL). NULL = never (1-credit pack, legacy/import, pool); else purchase + resolved window
  lot_id      uuid REFERENCES credit_ledger(id),        -- Δ 2026-06-18: on a debit/refund — the source lot it draws from / returns to. NULL on a debit = the never-expiring pool
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX credit_ledger_dog_mode_idx ON credit_ledger (dog_id, mode, location);
-- FIFO lot selection: live source lots for a (dog,mode,location), ordered by expiry.
CREATE INDEX credit_ledger_lot_fifo_idx
  ON credit_ledger (dog_id, mode, location, expires_at)
  WHERE delta > 0 AND lot_id IS NULL;
-- Allocation roll-up: debits/refunds grouped by the source lot they touch.
CREATE INDEX credit_ledger_lot_id_idx ON credit_ledger (lot_id) WHERE lot_id IS NOT NULL;

-- Lot-aware balance. Δ 2026-06-18: a row counts toward balance unless it
-- belongs to an EXPIRED lot. Three row kinds (disambiguated by lot_id + delta
-- sign): an allocation (lot_id set) counts iff its source lot is still live; a
-- source lot (delta>0, lot_id NULL) counts iff its own expires_at is live; a
-- pool debit (delta<0, lot_id NULL) always counts (the pool never expires).
-- Dropping an expired lot whole forfeits only its UNUSED remainder — its
-- already-applied debits drop with it, netting to exactly the unspent credits.
-- `now()` = transaction start; the booking txn reads this under the
-- (dog_id,mode,location) advisory lock. Redis caches the per-dog result.
CREATE VIEW dog_credit_balance AS
  SELECT cl.dog_id, cl.mode, cl.location, COALESCE(SUM(cl.delta), 0) AS balance
  FROM credit_ledger cl
  LEFT JOIN credit_ledger lot ON lot.id = cl.lot_id
  WHERE CASE
          WHEN cl.lot_id IS NOT NULL THEN (lot.expires_at IS NULL OR lot.expires_at > now())
          WHEN cl.delta > 0          THEN (cl.expires_at IS NULL OR cl.expires_at > now())
          ELSE true
        END
  GROUP BY cl.dog_id, cl.mode, cl.location;

-- ----------------------------------------------------------------------------
-- Payments (built day one; Stripe test keys dev/staging, live keys prod;
-- payments_enabled = operational kill switch, NOT a v1 deferral)
-- Append-only / retained: financial owner FKs are ON DELETE RESTRICT so a
-- stray delete can never destroy charge/invoice/ledger/membership history.
-- ----------------------------------------------------------------------------
-- PCI: raw PAN/CVC never touch this DB. We store only the Stripe token + the
-- displayable bits Stripe returns. Stripe Secret Key lives in the Node env.
CREATE TABLE stripe_customers (
  owner_id            uuid PRIMARY KEY REFERENCES owners(id) ON DELETE RESTRICT,
  stripe_customer_id  text UNIQUE NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payment_methods (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id                 uuid NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  stripe_payment_method_id text UNIQUE NOT NULL,
  brand                    text NOT NULL,               -- visa|mastercard|amex|discover|unknown
  last4                    text NOT NULL,
  exp_month                smallint NOT NULL CHECK (exp_month BETWEEN 1 AND 12),
  exp_year                 smallint NOT NULL,
  cardholder_name          text NOT NULL,
  is_default               boolean NOT NULL DEFAULT false,
  created_at               timestamptz NOT NULL DEFAULT now(),
  expired_at               timestamptz                  -- NULL = live; removing a card = expire (retain for charge history)
);
CREATE INDEX payment_methods_owner_idx ON payment_methods (owner_id);
-- At most one default *live* card per owner.
CREATE UNIQUE INDEX payment_methods_one_default
  ON payment_methods (owner_id) WHERE is_default AND expired_at IS NULL;

-- pending_requests.payment_method_id FK, deferred to here: pending_requests
-- (the 2026-07-14 approval-divert amendment) is created before this table
-- exists, so the constraint can't ride inline there.
ALTER TABLE pending_requests
  ADD CONSTRAINT pending_requests_payment_method_id_fkey
  FOREIGN KEY (payment_method_id) REFERENCES payment_methods(id);

CREATE TABLE charges (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id                uuid NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  stripe_payment_intent_id text UNIQUE,
  amount_cents            integer NOT NULL CHECK (amount_cents >= 0),
  currency                text NOT NULL DEFAULT 'usd',
  status                  charge_status NOT NULL DEFAULT 'requires_payment',
  purpose                 charge_purpose NOT NULL,
  booking_id              uuid REFERENCES bookings(id),
  -- Δ 2026-06-09: group-class enrollment is paid per-(cohort, dog) so a single
  -- dog can be unenrolled + refunded independently. Both NULL for non-enrollment
  -- charges (packages, B&T, payg). The pay-later twin lives on invoices.
  cohort_id               uuid REFERENCES cohorts(id),
  dog_id                  uuid REFERENCES dogs(id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX charges_owner_idx ON charges (owner_id);

ALTER TABLE credit_ledger
  ADD CONSTRAINT credit_ledger_charge_fk
  FOREIGN KEY (charge_id) REFERENCES charges(id);

-- ----------------------------------------------------------------------------
-- Invoices (locked 2026-05-19; PHASE-PLAN §651 + §260) — the "Pay later" path
-- for group-class enrollment and B&T approval. Distinct from `charges` (an
-- immediate Stripe PaymentIntent): an invoice is amount-owed-but-unpaid. When
-- later paid, a `charge` is created and the invoice flips to 'paid'. A B&T
-- request in `approved-awaiting-payment` resolves via either a charge (pay
-- now) or an open invoice (pay later) before it converts to a booking.
-- Retained financial record: status transitions only, never deleted.
-- ----------------------------------------------------------------------------
CREATE TABLE invoices (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id       uuid NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  amount_cents   integer NOT NULL CHECK (amount_cents >= 0),
  currency       text NOT NULL DEFAULT 'usd',
  status         invoice_status NOT NULL DEFAULT 'open',
  purpose        charge_purpose NOT NULL,
  booking_id     uuid REFERENCES bookings(id) ON DELETE SET NULL,
  cohort_id      uuid REFERENCES cohorts(id) ON DELETE SET NULL,
  dog_id         uuid REFERENCES dogs(id) ON DELETE SET NULL,   -- Δ 2026-06-09: per-dog group-class enrollment (pay-later twin of charges.dog_id)
  request_id     uuid REFERENCES pending_requests(id) ON DELETE SET NULL,
  -- §J.1 (2026-07-09): the subscription month this invoice bills. Set only on
  -- purpose='membership' rows (the scheduler rolls one per period); the settle
  -- path reads it to grant the month's credit lot (reason 'membership-grant').
  -- FK added AFTER CREATE TABLE memberships below (invoices is created first).
  membership_id  uuid,
  -- Anti-scam (locked 2026-05-19): every invoice is CARD-BACKED + auto-charged.
  -- No open-ended unpaid balance — payment_method_id is REQUIRED and the worker
  -- auto-charges at due_at (retrying via next_attempt_at/auto_charge_attempts),
  -- so a client cannot defer-and-ghost the way Gingr allowed.
  payment_method_id uuid NOT NULL REFERENCES payment_methods(id) ON DELETE RESTRICT,
  -- R3 (Allison sim-QA 2026-07-27): how the owner intends to settle. 'card' =
  -- the default card-backed auto-charge described above; 'in-person' = cash/check
  -- due at drop-off (POST /invoices/:id/pay-in-person flips it + schedules a
  -- payment-due reminder). Adjudicated "cash/check invoices due by drop-off"; the
  -- drop-off flagging + auto-charge stop are portal-side, later.
  payment_expected text NOT NULL DEFAULT 'card' CHECK (payment_expected IN ('card','in-person')),
  paid_charge_id uuid REFERENCES charges(id),
  issued_at      timestamptz NOT NULL DEFAULT now(),
  due_at         timestamptz NOT NULL,
  next_attempt_at timestamptz,
  auto_charge_attempts integer NOT NULL DEFAULT 0,
  paid_at        timestamptz,
  external_ref   text,
  source         record_source NOT NULL DEFAULT 'app',
  UNIQUE (source, external_ref),
  CHECK (status <> 'paid' OR paid_at IS NOT NULL)        -- #7: paid implies paid_at
);
CREATE INDEX invoices_owner_idx  ON invoices (owner_id);
CREATE INDEX invoices_open_idx   ON invoices (status) WHERE status = 'open';

-- ----------------------------------------------------------------------------
-- Invoice charge attempts (2026-08-12, `designs/auto-charge-unknown-outcome.md`).
--
-- The auto-charge worker used to keep TWO jobs in one integer: the dunning
-- ladder (`invoices.auto_charge_attempts`) AND the Stripe idempotency key's
-- identity (`auto-charge:{invoiceId}:{attempts}`). A transport failure — the
-- one class where we do NOT know whether money moved — incremented that counter
-- and thereby MINTED A NEW KEY, so the next tick asked Stripe for new money for
-- a charge that may already have succeeded. Splitting the jobs is the fix:
-- `auto_charge_attempts` keeps the ladder (known-failed attempts only) and the
-- key identity moves HERE, where `attempt_no` advances only when the previous
-- attempt is known-dead.
--
-- One row per attempt, written BEFORE the Stripe confirm so a worker that dies
-- mid-flight leaves the doubt on the books instead of in a log:
--   'pending'    -- we do not know (pre-call, crash, or transport-unknown)
--   'processing' -- Stripe has it and the money is in flight
--   'succeeded'  -- settled (charges/invoices rows carry the money truth)
--   'no-charge'  -- known-dead: declined / auth-required / canceled
-- The last two are terminal. `payment_method_id` + `stripe_payment_method_id` +
-- `amount_cents` + `stripe_customer_id` are the params FROZEN at mint time: a
-- re-issue under the same key must send byte-identical params or Stripe rejects
-- it (`idempotency_error`) — which is the desired loud failure, not a reason to
-- mint a fresh key. `stripe_customer_id` joined them 2026-08-12: it is part of
-- the request Stripe hashes the key against, and re-reading it from
-- `stripe_customers` at re-issue time meant a re-link between mint and verify
-- silently drifted the fingerprint into the permanent-park arm.
--
-- `reconcile_reason` is the DURABLE half of a park. Every park arm looks
-- identical in the invoice row (`next_attempt_at = NULL`), so the fact a human
-- most needs — WHY automation stopped, and in particular whether our records
-- disagree with Stripe's — used to live only in a log line.
--
-- NOT a wire surface (no `conformance.ts` pin, no client mirror) — worker
-- telemetry + the operator's answer to "what happened to this money?".
-- ----------------------------------------------------------------------------
CREATE TYPE invoice_attempt_outcome AS ENUM
  ('pending', 'processing', 'succeeded', 'no-charge');

CREATE TABLE invoice_charge_attempts (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id                uuid NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  attempt_no                integer NOT NULL,
  payment_method_id         uuid NOT NULL REFERENCES payment_methods(id) ON DELETE RESTRICT,
  stripe_payment_method_id  text NOT NULL,
  stripe_customer_id        text NOT NULL,  -- frozen with the other confirm params
  amount_cents              integer NOT NULL CHECK (amount_cents >= 0),
  idempotency_key           text NOT NULL UNIQUE,
  stripe_payment_intent_id  text,          -- NULL until a response/webhook names it
  outcome                   invoice_attempt_outcome NOT NULL DEFAULT 'pending',
  verify_count              integer NOT NULL DEFAULT 0,
  -- Why the verify lane handed this attempt to a human. NULL = never parked.
  --   'key-window-expired'  -- past the key window with no PI id and no webhook
  --   'in-flight-cap'       -- 'processing' longer than the cap allows
  --   'idempotency-conflict'-- Stripe rejected our frozen params on our own key
  --   'fresh-execution'     -- a re-issue EXECUTED instead of replaying: the
  --                         -- key window assumption did not hold, so a second
  --                         -- charge may exist for this debt
  reconcile_reason          text CHECK (reconcile_reason IN
                              ('key-window-expired', 'in-flight-cap',
                               'idempotency-conflict', 'fresh-execution')),
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (invoice_id, attempt_no)
);
-- THE interlock: at most one unresolved attempt per invoice, enforced by the
-- database, not by worker discipline. The charge lane cannot mint attempt N+1
-- while attempt N is in doubt even if its code path is wrong.
CREATE UNIQUE INDEX invoice_charge_attempts_unresolved_uq
  ON invoice_charge_attempts (invoice_id)
  WHERE outcome IN ('pending', 'processing');
-- The verify lane's worklist: oldest unresolved first.
CREATE INDEX invoice_charge_attempts_unresolved_idx
  ON invoice_charge_attempts (updated_at)
  WHERE outcome IN ('pending', 'processing');
-- The webhook's orphan match target (metadata carries the PI id, not our uuid).
CREATE INDEX invoice_charge_attempts_pi_idx
  ON invoice_charge_attempts (stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;

-- The 3 Day School payment modes from the DS: PAYG (charges.purpose='payg'),
-- packages (credit_packages + credit_ledger), memberships (below).
--
-- §J.1 ACTIVATED 2026-07-09 (was dormant scaffolding): a membership is a
-- credit-package SUBSCRIPTION — the package's credits granted each month on a
-- recurring charge, for a committed term of 3/6/9/12 months that HARD-STOPS
-- at ends_at (no auto-renew). Renewals are SELF-BILLED via the invoice
-- auto-charge lane (purpose='membership' + invoices.membership_id), NOT
-- Stripe Billing — stripe_subscription_id stays NULL and is retained only
-- for a possible future Billing migration. Month 1 charges synchronously at
-- POST /memberships (same charge→grant path as a package purchase); the
-- scheduler rolls each later period. A month's granted lot expires at that
-- period's end (expires_at = current_period_end; alumni dogs NULL) — that is
-- what makes the "X days left to use X credits" reminder ride the existing
-- credits-expiring scan. Pause is staff-mediated (paused_at set/cleared by
-- staff; the roll phase skips paused rows). status: active|completed|canceled
-- (completed = term ran out; canceled = staff/owner stop — status, not delete).
CREATE TABLE memberships (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id               uuid NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  -- §J.1: required — credit grants land per-dog like every package purchase.
  -- (Kept nullable in DDL for the dormant-era shape; the API requires it.)
  dog_id                 uuid REFERENCES dogs(id) ON DELETE RESTRICT,
  mode                   booking_mode NOT NULL,
  -- §J.1: the priced package version this subscription delivers monthly.
  -- FK the surrogate id (not key) so a later repricing never changes what an
  -- in-flight subscription bills — same pin-the-version rule as charges.
  package_id             uuid REFERENCES credit_packages(id) ON DELETE RESTRICT,
  term_months            integer CHECK (term_months IN (3, 6, 9, 12)),
  -- §J.1: the card every rolled invoice bills (invoices.payment_method_id is
  -- NOT NULL). Chosen at POST; if it dies later the auto-charge parks + the
  -- payment-failed push fires — the existing dunning lane, no special case.
  payment_method_id      uuid REFERENCES payment_methods(id) ON DELETE RESTRICT,
  stripe_subscription_id text UNIQUE,
  status                 text NOT NULL DEFAULT 'active',  -- cancellation = status, not delete
  started_at             timestamptz NOT NULL DEFAULT now(),
  current_period_start   timestamptz,
  current_period_end     timestamptz,
  ends_at                timestamptz,                     -- §J.1 hard stop (started_at + term)
  paused_at              timestamptz,                     -- §J.1 staff-mediated pause
  paused_by_staff_id     uuid REFERENCES staff(id) ON DELETE RESTRICT
);
CREATE INDEX memberships_owner_idx ON memberships (owner_id);
-- The roll phase's scan: active rows whose period has ended.
CREATE INDEX memberships_active_roll_idx
  ON memberships (current_period_end) WHERE status = 'active';
-- Membership uniqueness (Allison ruling 2026-07-16): one ACTIVE membership
-- per (dog, mode) — day-school + daycare may coexist on one dog; two of the
-- same mode may not. The POST /memberships pre-charge probe + advisory-locked
-- in-tx re-check give the friendly 409 / duplicate-refund paths; this partial
-- unique index is the constraint floor beneath both.
CREATE UNIQUE INDEX memberships_one_active_per_dog_mode
  ON memberships (dog_id, mode) WHERE status = 'active';
-- §J.1: invoices.membership_id FK, deferred to here — invoices is created
-- before memberships in this file (financial tables block ordering).
ALTER TABLE invoices ADD CONSTRAINT invoices_membership_id_fkey
  FOREIGN KEY (membership_id) REFERENCES memberships(id) ON DELETE SET NULL;

-- ----------------------------------------------------------------------------
-- Refunds (locked 2026-05-19) — a refund against a prior Stripe charge. Partial
-- refunds allowed (amount_cents <= the charge); the API, not the schema,
-- decides when cumulative refunds flip charges.status to 'refunded'. Append-
-- only / retained financial record (no expired_at), status transitions only,
-- mirroring charges. Refunding CREDITS instead of money is a credit_ledger
-- 'cancel-refund' entry — money-back vs credits-back are deliberately distinct.
-- ----------------------------------------------------------------------------
CREATE TABLE refunds (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id         uuid NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  charge_id        uuid NOT NULL REFERENCES charges(id) ON DELETE RESTRICT,
  booking_id       uuid REFERENCES bookings(id),          -- cancellation-driven refund
  stripe_refund_id text UNIQUE,
  -- The EXACT Stripe idempotency key the post-commit createRefund will use /
  -- used, written in the same tx as the row (2026-08-19,
  -- `designs/client-keyed-refund-recovery.md` §1.2). NULL means the row
  -- predates this column OR is 'unroutable' (no Stripe call will ever be
  -- made): either way, no automatic retry may touch it. The retry sweep's
  -- claim reads this instead of reconstructing keys it cannot know — three of
  -- the four pending-refund writers key on the CLIENT's request
  -- Idempotency-Key, which exists only in that request's closure, so before
  -- this column their failed refunds could never be retried by anything.
  -- `stripe_idempotency_key IS NULL` IS the deploy boundary, true row by row,
  -- which is why this design needs no date constant of its own.
  stripe_idempotency_key text,
  amount_cents     integer NOT NULL CHECK (amount_cents > 0),
  reason           text,
  status           refund_status NOT NULL DEFAULT 'pending',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refunds_owner_idx  ON refunds (owner_id);
CREATE INDEX refunds_charge_idx ON refunds (charge_id);

-- ----------------------------------------------------------------------------
-- Stripe webhook event ledger (locked Day 15 2026-05-26). Dedupe key for
-- redelivered events: Stripe re-sends after timeouts/5xx, so the receiver
-- must idempotently process by `event.id` (evt_*). Distinct from
-- `idempotency_keys` (owner/endpoint-scoped, TTL-swept) — webhook events
-- are server-to-server, not owner-actor, and we retain history. Pattern:
-- (1) INSERT ON CONFLICT DO NOTHING to claim the slot; (2) dispatch the
-- handler; (3) on success UPDATE processed_at = now(); on failure DELETE
-- the row so Stripe's next retry re-enters the dispatch. Permanent table
-- (no expired_at, no TTL); admin operations only.
-- ----------------------------------------------------------------------------
CREATE TABLE stripe_events (
  event_id     text PRIMARY KEY,
  event_type   text NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX stripe_events_type_received_idx
  ON stripe_events (event_type, received_at DESC);
CREATE INDEX stripe_events_unprocessed_idx
  ON stripe_events (received_at) WHERE processed_at IS NULL;

-- ----------------------------------------------------------------------------
-- Liability waivers / policy agreements (locked 2026-05-19). Same gate pattern
-- as the payment guarantee: a paid booking requires the owner to have signed
-- the CURRENT version of every required document that applies to the booking's
-- category. applies_to = '{}' (cardinality 0) = the document applies to ALL
-- categories (the general liability waiver); a non-empty array scopes it (e.g.
-- a boarding policy). The catalog is soft-expire; signatures are an append-only
-- legal fact — immutable: re-signing a new version is a NEW row, never an
-- edit/delete (so no expired_at, and excluded from the audit trigger).
-- ----------------------------------------------------------------------------
CREATE TABLE agreement_documents (
  key             text PRIMARY KEY,                       -- 'liability-waiver' | 'boarding-policy' | ...
  label           text NOT NULL,
  current_version integer NOT NULL CHECK (current_version > 0),
  required        boolean NOT NULL DEFAULT true,
  applies_to      service_category[] NOT NULL DEFAULT '{}'::service_category[],  -- '{}' = all categories
  body_url        text,                                   -- where the signed text lives (R2/media)
  expired_at      timestamptz                             -- NULL = live (retire a doc = expire)
);

CREATE TABLE agreement_signatures (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id     uuid NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  document_key text NOT NULL REFERENCES agreement_documents(key),
  version      integer NOT NULL CHECK (version > 0),      -- the version signed
  signed_at    timestamptz NOT NULL DEFAULT now(),
  ip           text,
  user_agent   text,
  external_ref text,
  source       record_source NOT NULL DEFAULT 'app',
  UNIQUE (owner_id, document_key, version)                 -- append-only: one signature per version
);
CREATE INDEX agreement_signatures_owner_idx
  ON agreement_signatures (owner_id, document_key);

-- ----------------------------------------------------------------------------
-- Effective-dated rate catalog (locked 2026-05-19). The price for a service at
-- a location is the row whose [effective_from, effective_to) window contains
-- the booking day (effective_to NULL = open-ended/current). Prices are never
-- edited or deleted: a change CLOSES the open row (set effective_to) and
-- INSERTs a new one, so historical bookings keep their as-charged rate.
-- location NULL = all locations. group_classes keeps its own per-class price
-- (separate pre-existing catalog, intentionally not migrated here — flagged in
-- DATA-CONTRACT). Window non-overlap is an API guarantee (a GiST exclusion
-- constraint is YAGNI for two locations × a handful of categories).
-- ----------------------------------------------------------------------------
CREATE TABLE service_rates (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category       service_category NOT NULL,
  location       text REFERENCES locations(slug),         -- NULL = all locations
  amount_cents   integer NOT NULL CHECK (amount_cents >= 0),
  unit           rate_unit NOT NULL,
  effective_from date NOT NULL,
  effective_to   date,                                    -- NULL = current/open-ended
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- Append-only money config (Δ 2026-06-20, staff rate editor): rows are NEVER
  -- value-overwritten — a price change closes the open row's effective_to and
  -- inserts a new one; a mistake/cancel sets voided_at (a soft-void excluded
  -- from "active"), never an UPDATE of amount/unit/note. created_by/voided_by
  -- stamp the actor for the change-history log (audit_log already captures the
  -- before-state on every effective_to close / void via current_setting actor).
  created_by_staff_id  uuid REFERENCES staff(id) ON DELETE SET NULL,
  voided_at            timestamptz,                       -- NULL = live; set = entry retracted (mistake / cancelled schedule)
  voided_by_staff_id   uuid REFERENCES staff(id) ON DELETE SET NULL,
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE INDEX service_rates_lookup_idx
  ON service_rates (category, location, effective_from DESC);

-- ----------------------------------------------------------------------------
-- Client-mutation idempotency (locked 2026-05-19). Mutating endpoints (book,
-- enroll, purchase, RSVP, sign) require an Idempotency-Key header (client
-- UUID). The API: SELECT by key — if a completed row exists, replay its stored
-- response; else INSERT 'in-flight', do the work, record the response.
-- request_hash guards against a key reused with a different body. This is the
-- ONE table EXEMPT from the never-delete rule — it is transport-layer dedupe,
-- not business state; a TTL sweep prunes rows past the retry-safety window
-- (e.g. 24h). No audit trigger, no expired_at, by design.
-- ----------------------------------------------------------------------------
CREATE TABLE idempotency_keys (
  key             text PRIMARY KEY,                       -- client-supplied UUID
  owner_id        uuid REFERENCES owners(id) ON DELETE CASCADE,
  endpoint        text NOT NULL,
  request_hash    text NOT NULL,
  response_status integer,
  response_body   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz                              -- NULL = in-flight
);
CREATE INDEX idempotency_keys_created_idx ON idempotency_keys (created_at);

-- ----------------------------------------------------------------------------
-- Messaging (R3: thread.owner_id; polymorphic message sender owner|staff)
-- ----------------------------------------------------------------------------
CREATE TABLE threads (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id        uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  participant_staff_id uuid REFERENCES staff(id),       -- the "WITH" staffer
  category        thread_category NOT NULL,
  title           text NOT NULL,
  sub_text        text NOT NULL,
  last_message    text NOT NULL DEFAULT '',
  last_message_at timestamptz NOT NULL DEFAULT now(),
  external_ref    text,
  source          record_source NOT NULL DEFAULT 'app',
  created_at      timestamptz NOT NULL DEFAULT now(),
  expired_at      timestamptz                           -- NULL = live (soft delete)
);
CREATE UNIQUE INDEX threads_source_ref_uidx
  ON threads (source, external_ref) WHERE expired_at IS NULL;
CREATE INDEX threads_owner_idx ON threads (owner_id, last_message_at DESC);

CREATE TABLE thread_dogs (
  thread_id uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  dog_id    uuid NOT NULL REFERENCES dogs(id) ON DELETE CASCADE,
  expired_at timestamptz,                               -- NULL = live
  PRIMARY KEY (thread_id, dog_id)
);

CREATE TABLE messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id       uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  sender_kind     sender_kind NOT NULL,
  sender_owner_id uuid REFERENCES owners(id),
  sender_staff_id uuid REFERENCES staff(id),
  text            text NOT NULL,
  sent_at         timestamptz NOT NULL DEFAULT now(),
  read_at         timestamptz,                          -- NULL = unread (R5: no bool)
  expired_at      timestamptz,                          -- NULL = live; "unsend"/delete = expire (text retained in audit_log)
  CHECK (
    (sender_kind = 'owner' AND sender_owner_id IS NOT NULL AND sender_staff_id IS NULL)
    OR
    (sender_kind = 'staff' AND sender_staff_id IS NOT NULL AND sender_owner_id IS NULL)
  )
);
CREATE INDEX messages_thread_idx ON messages (thread_id, sent_at);
-- unread_count is DERIVED (count of messages.read_at IS NULL not sent by owner,
-- expired_at IS NULL) — never a stored mutable column.

-- Photo/video attachments on a message (post-Day-19e). The message wire was
-- text-only; owners attach media uploaded through the existing pipeline
-- (purpose='message-attachment'). One row per attachment; `position` orders
-- them within the bubble. Append-only + immutable by nature (an attachment is
-- never edited; "unsend" soft-expires the parent message), so — like
-- media_derivative_jobs — it is intentionally OUT of the audit_capture list,
-- and a hard message delete cascades the links away. media_assets are
-- soft-expired (never hard-deleted), so a plain FK on media_asset_id is safe.
CREATE TABLE message_attachments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id      uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  media_asset_id  uuid NOT NULL REFERENCES media_assets(id),
  position        integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX message_attachments_message_media_uidx
  ON message_attachments (message_id, media_asset_id);
CREATE INDEX message_attachments_message_idx ON message_attachments (message_id, position);

-- ----------------------------------------------------------------------------
-- Events + RSVPs (#5, locked 2026-05-19) — recurring events (Public Pups) are
-- an event_series + one `events` row per dated occurrence (each its own date +
-- that week's location). One-off events have series_id NULL. RSVPs attach to
-- the occurrence (event_rsvps.event_id) so per-week / past attendance is real
-- data, not derived from a single mutated row.
-- ----------------------------------------------------------------------------
CREATE TABLE event_series (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,                         -- "Public Pups"
  cadence          text NOT NULL,                         -- e.g. 'weekly-saturday' (scheduling/display hint)
  default_duration_minutes integer,
  description      text,
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expired_at       timestamptz                            -- NULL = live (series ended = expire)
);

CREATE TABLE events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  starts_at        timestamptz NOT NULL,
  duration_minutes integer NOT NULL,
  loc_label        text NOT NULL,
  loc_address      text NOT NULL,
  loc_latitude     double precision NOT NULL,
  loc_longitude    double precision NOT NULL,
  description      text,
  is_recurring     boolean NOT NULL DEFAULT false,        -- display "always-show in This Week" flag
  series_id        uuid REFERENCES event_series(id),      -- #5: set for series occurrences; NULL = one-off
  -- Soft cap (locked 2026-05-19). NULL = uncapped. Enforced in the API for
  -- OWNER self-serve RSVPs only; staff (portal) may add attendees past it —
  -- deliberately NOT a DB CHECK (contrast cohorts.filled <= capacity, a hard
  -- cap). The yappy-hour capacity bar reflects this number.
  capacity         integer,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expired_at       timestamptz                          -- NULL = live (cancelled event = expire)
);

CREATE TABLE event_rsvps (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id   uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  owner_id   uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  rsvpd_at   timestamptz NOT NULL DEFAULT now(),
  expired_at timestamptz                                -- NULL = live; un-RSVP = expire
);
-- One LIVE RSVP per (event, owner); partial so un-RSVP then RSVP-again works.
CREATE UNIQUE INDEX event_rsvps_uidx
  ON event_rsvps (event_id, owner_id) WHERE expired_at IS NULL;

CREATE TABLE event_rsvp_dogs (
  rsvp_id uuid NOT NULL REFERENCES event_rsvps(id) ON DELETE CASCADE,
  dog_id  uuid NOT NULL REFERENCES dogs(id) ON DELETE CASCADE,
  expired_at timestamptz,                               -- NULL = live
  PRIMARY KEY (rsvp_id, dog_id)
);

-- ----------------------------------------------------------------------------
-- Notifications + announcements + push tokens
-- ----------------------------------------------------------------------------
-- notifications is a delivered in-app feed. Content is immutable (a
-- notification was either delivered or it wasn't), but two state columns are
-- mutable: read_at (NULL = unread) and dismissed_at (NULL = live). Dismiss is
-- a soft-delete tombstone — the owner "deletes" a notification by hiding it;
-- the row is retained for audit (matching device_tokens.expired_at), never
-- destroyed. Feed reads and the unread count filter dismissed_at IS NULL.
CREATE TABLE notifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id        uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  type            notification_type NOT NULL,
  title           text NOT NULL,
  body            text NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now(),
  read_at         timestamptz,                          -- NULL = unread
  dismissed_at    timestamptz,                          -- NULL = live; soft-delete tombstone (owner dismiss)
  deep_link_path  text,                                 -- producer writes this
  deep_link_kind  text,                                 -- structured deep-link ref (decision 3, 2026-07-24): entity kind…
  deep_link_id    uuid,                                 -- …+ entity id; path derivation moves to wire.ts deepLinkToPath() in Phase 3
  sender_staff_id uuid REFERENCES staff(id),            -- message-received only
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_owner_idx ON notifications (owner_id, received_at DESC);

-- ----------------------------------------------------------------------------
-- Scheduled / outbound notifications (locked 2026-05-19; PHASE-PLAN §648-649 +
-- "wire the real push entry path"). `notifications` is the delivered in-app
-- feed; THIS is the queue of pushes to emit at/after a time. Worker pattern
-- (idempotent): atomically claim due rows —
--   UPDATE scheduled_notifications SET status='sent', sent_at=now()
--    WHERE id IN (SELECT id FROM scheduled_notifications
--                  WHERE status='pending' AND scheduled_for<=now()
--                  ORDER BY scheduled_for FOR UPDATE SKIP LOCKED LIMIT N)
--   RETURNING *;
-- then emit push + INSERT the notifications row. dedupe_key makes enqueue
-- idempotent (a trigger enqueuing "boarding-24h:<bookingId>" can't double-add).
-- Append-only by nature: no expired_at (cancel = status='cancelled').
-- ----------------------------------------------------------------------------
CREATE TABLE scheduled_notifications (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id       uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  type           notification_type NOT NULL,
  trigger        text NOT NULL,            -- 'boarding-profile-check' | 'booking-reminder' | 'report-published' | ...
  dedupe_key     text UNIQUE,              -- #8: idempotent enqueue (e.g. 'boarding-24h:<bookingId>')
  scheduled_for  timestamptz NOT NULL,
  status         scheduled_status NOT NULL DEFAULT 'pending',
  title          text NOT NULL,
  body           text NOT NULL,
  deep_link_path text,
  deep_link_kind text,                     -- deliverOne propagates both to the emitted feed row
  deep_link_id   uuid,
  booking_id     uuid REFERENCES bookings(id) ON DELETE CASCADE,
  report_id      uuid REFERENCES reports(id) ON DELETE CASCADE,
  dog_id         uuid REFERENCES dogs(id) ON DELETE CASCADE,
  emitted_notification_id uuid REFERENCES notifications(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  sent_at        timestamptz
);
CREATE INDEX scheduled_notifications_due_idx
  ON scheduled_notifications (scheduled_for) WHERE status = 'pending';

CREATE TABLE notification_dogs (
  notification_id uuid NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  dog_id          uuid NOT NULL REFERENCES dogs(id) ON DELETE CASCADE,
  PRIMARY KEY (notification_id, dog_id)
);

-- Announcements are school-wide (optionally city-targeted). Not owner-scoped.
CREATE TABLE announcements (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category       announcement_category NOT NULL,
  title          text NOT NULL,
  body           text,
  published_at   timestamptz NOT NULL DEFAULT now(),
  deep_link_path text,                                  -- report → report-card (card-level legacy link)
  -- Recent-Updates detail CTA (Day 19e). A typed call-to-action the generic
  -- /announcement/[id] screen renders + dispatches. `cta_kind` discriminates the
  -- target: 'enroll' (target = group_class_key → in-app group-enroll flow),
  -- 'route' (target = allowlisted in-app path), 'external' (target = https URL →
  -- in-app browser). The FE parses (label, kind, target) into a typed union at
  -- the wire boundary. All-or-nothing: a CTA is fully present or fully absent.
  cta_label      text,
  cta_kind       text CHECK (cta_kind IN ('enroll','route','external')),
  cta_target     text,
  CONSTRAINT announcements_cta_all_or_none CHECK (
    (cta_label IS NULL AND cta_kind IS NULL AND cta_target IS NULL)
    OR (cta_label IS NOT NULL AND cta_kind IS NOT NULL AND cta_target IS NOT NULL)
  ),
  target_location text REFERENCES locations(slug),      -- NULL = all locations
  is_pinned      boolean NOT NULL DEFAULT false,        -- Public Pups always-show
  created_at     timestamptz NOT NULL DEFAULT now(),
  expired_at     timestamptz                            -- NULL = live (unpublish = expire)
);

CREATE TABLE device_tokens (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id        uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  expo_push_token text NOT NULL,
  platform        text NOT NULL CHECK (platform IN ('ios','android')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  expired_at      timestamptz                           -- NULL = live (token revoked = expire)
);
-- One LIVE token per (owner, device token); partial so a revoked token can be
-- re-registered (same device re-grants push) without a UNIQUE collision.
CREATE UNIQUE INDEX device_tokens_uidx
  ON device_tokens (owner_id, expo_push_token) WHERE expired_at IS NULL;

-- ----------------------------------------------------------------------------
-- Audit log (locked 2026-05-19) — the append-only history that makes "even
-- edits never lose data" true. One generic table + one trigger captures the
-- OLD row (as JSONB) on every UPDATE/DELETE of the soft-expire tables, so any
-- prior state — including a soft-expire — is fully recoverable. Actor is read
-- from `app.actor` (the API does `SET LOCAL app.actor = '<kind>:<id>'` per
-- request); NULL if unset. Never edited or pruned.
-- ----------------------------------------------------------------------------
CREATE TABLE audit_log (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  table_name text NOT NULL,
  row_pk     text NOT NULL,            -- stringified PK of the affected row
  op         text NOT NULL,            -- 'UPDATE' | 'DELETE'
  before     jsonb NOT NULL,           -- the OLD row
  actor      text,                     -- current_setting('app.actor', true)
  txid       bigint NOT NULL DEFAULT txid_current(),
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_table_row_idx ON audit_log (table_name, row_pk, at DESC);

CREATE OR REPLACE FUNCTION audit_capture() RETURNS trigger AS $$
BEGIN
  INSERT INTO audit_log (table_name, row_pk, op, before, actor)
  VALUES (
    TG_TABLE_NAME,
    COALESCE((to_jsonb(OLD) ->> 'id'),
             (to_jsonb(OLD) ->> 'key'),
             (to_jsonb(OLD) ->> 'dog_id'),
             (to_jsonb(OLD) ->> 'booking_id'),
             (to_jsonb(OLD) ->> 'request_id'),
             (to_jsonb(OLD) ->> 'thread_id'),
             (to_jsonb(OLD) ->> 'rsvp_id'),
             (to_jsonb(OLD) ->> 'notification_id'),
             (to_jsonb(OLD) ->> 'date')),
    TG_OP,
    to_jsonb(OLD),
    current_setting('app.actor', true)
  );
  RETURN NULL;  -- AFTER trigger; return value ignored
END;
$$ LANGUAGE plpgsql;

-- ----------------------------------------------------------------------------
-- updated_at touch trigger (tables that carry updated_at)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'owners','dogs','vets','reports','bookings','pending_requests','charges','refunds',
    -- Day-17 §A amendment 2026-05-27: worker queue carries updated_at so
    -- the dashboard can surface stalled 'processing' rows.
    'media_derivative_jobs',
    -- 2026-08-12: the verify lane claims unresolved attempts by `updated_at`,
    -- so every outcome/verify_count write must move it or a resolved-then-
    -- reopened row could sort ahead of a genuinely older one.
    'invoice_charge_attempts'
  ]) LOOP
    EXECUTE format(
      'CREATE TRIGGER %I_touch BEFORE UPDATE ON %I
       FOR EACH ROW EXECUTE FUNCTION touch_updated_at();', t, t);
  END LOOP;
END $$;

-- Attach audit_capture to every soft-expire entity + join table (AFTER
-- UPDATE OR DELETE). Append-only/immutable-by-nature tables are intentionally
-- excluded (credit_ledger, charges, invoices, invoice_charge_attempts, refunds,
-- agreement_signatures,
-- scheduled_notifications, notifications, media_derivative_jobs, audit_log) as
-- is idempotency_keys (transport dedupe, TTL-pruned). day_capacity is
-- included — it carries expired_at. service_rates is included so closing an
-- effective_to is audited.
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'owners','staff','dogs','vets','dog_vaccines','required_vaccines','dog_medications',
    'dog_feeding','dog_completed_classes','group_classes','cohorts','reports',
    'media_assets','bookings','booking_dogs','after_school_optins',
    'pending_requests','pending_request_dogs','pending_request_preferred_dates',
    'day_capacity','payment_methods','memberships','agreement_documents',
    'service_rates','threads','thread_dogs','messages','event_series','events',
    'event_rsvps','event_rsvp_dogs','announcements','device_tokens'
  ]) LOOP
    EXECUTE format(
      'CREATE TRIGGER %I_audit AFTER UPDATE OR DELETE ON %I
       FOR EACH ROW EXECUTE FUNCTION audit_capture();', t, t);
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- Payment guarantee (locked 2026-05-19, anti-scam — NWA lost ~$1k/client on
-- Gingr because training proceeded with no card on file + no upfront pay). DB
-- backstop IN ADDITION to the API: a paid booking cannot be created unless the
-- owner has a live card on file. Staff-owned dogs (capacity_exempt) are exempt
-- — staff aren't billed. Full coverage (credits/membership/charge/card-backed
-- invoice) is asserted in the booking txn (see notes below); this trigger is
-- the unconditional "no card, no booking" floor no code path can bypass.
-- Only real once Stripe is LIVE (v1 is test-mode/payments-gated) — built now,
-- protective at the prod launch when live keys land.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assert_payment_guarantee() RETURNS trigger AS $$
DECLARE lead_is_staff_dog boolean;
BEGIN
  SELECT (d.staff_owner_id IS NOT NULL) INTO lead_is_staff_dog
  FROM dogs d WHERE d.id = NEW.lead_dog_id;
  IF COALESCE(lead_is_staff_dog, false) THEN
    RETURN NEW;                               -- staff dogs: not billed, exempt
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM payment_methods pm
    WHERE pm.owner_id = NEW.owner_id AND pm.expired_at IS NULL
  ) THEN
    RAISE EXCEPTION
      'payment guarantee: owner % has no card on file — booking blocked (anti-scam)',
      NEW.owner_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER bookings_payment_guarantee
  BEFORE INSERT ON bookings
  FOR EACH ROW EXECUTE FUNCTION assert_payment_guarantee();

-- ----------------------------------------------------------------------------
-- Vaccination gate (locked 2026-05-19, health rule). Same floor pattern as the
-- payment guarantee: a booking in a gated category cannot be created unless the
-- lead dog has a LIVE, non-expired record for every required_vaccines row that
-- gates that category. Staff-owned dogs are exempt. RULED 2026-05-19 (Allison):
-- the staff-dog exemption applies to ALL THREE gates incl. this health one —
-- the health-vs-billing distinction was raised and the uniform exemption was
-- chosen deliberately (staff self-manage their own dogs' vaccines out of band).
-- Do not re-flag. Expiry is compared in America/Chicago (business TZ invariant)
-- — never off raw UTC. The API enforces this across ALL booking dogs and
-- surfaces it earlier in the UX; this trigger is the unbypassable LEAD-dog floor.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assert_vaccines_current() RETURNS trigger AS $$
DECLARE
  lead_is_staff_dog boolean;
  missing            text;
  today_ct           date := (now() AT TIME ZONE 'America/Chicago')::date;
BEGIN
  SELECT (d.staff_owner_id IS NOT NULL) INTO lead_is_staff_dog
  FROM dogs d WHERE d.id = NEW.lead_dog_id;
  IF COALESCE(lead_is_staff_dog, false) THEN
    RETURN NEW;                               -- staff dogs exempt (consistent)
  END IF;
  SELECT string_agg(rv.label, ', ') INTO missing
  FROM required_vaccines rv
  WHERE rv.expired_at IS NULL
    AND NEW.category = ANY (rv.gates_categories)
    -- Shanthi 2026-07-14: class-key exemption — a group-class booking whose
    -- cohort's class is listed on the requirement skips it (puppy classes
    -- don't require rabies; puppies won't have it yet).
    AND NOT (NEW.category = 'group-class' AND EXISTS (
      SELECT 1 FROM cohorts c
      WHERE c.id = NEW.cohort_id
        AND c.class_key = ANY (rv.exempt_class_keys)
    ))
    AND NOT EXISTS (
      SELECT 1 FROM dog_vaccines dv
      WHERE dv.dog_id = NEW.lead_dog_id
        AND dv.requirement_key = rv.key
        AND dv.expired_at IS NULL
        AND dv.expires_at >= today_ct
    );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION
      'vaccine gate: dog % missing/expired required vaccination(s): % (category %)',
      NEW.lead_dog_id, missing, NEW.category USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER bookings_vaccine_guard
  BEFORE INSERT ON bookings
  FOR EACH ROW EXECUTE FUNCTION assert_vaccines_current();

-- ----------------------------------------------------------------------------
-- Agreement gate (locked 2026-05-19, legal). Same floor pattern: a booking
-- cannot be created unless the owner has signed the CURRENT version of every
-- required agreement_documents row applicable to the booking's category
-- (applies_to empty = all categories). Staff-owned dogs exempt. The API
-- surfaces the unsigned waiver earlier in the UX; this is the hard floor.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assert_agreements_signed() RETURNS trigger AS $$
DECLARE
  lead_is_staff_dog boolean;
  missing            text;
BEGIN
  SELECT (d.staff_owner_id IS NOT NULL) INTO lead_is_staff_dog
  FROM dogs d WHERE d.id = NEW.lead_dog_id;
  IF COALESCE(lead_is_staff_dog, false) THEN
    RETURN NEW;                               -- staff dogs exempt (consistent)
  END IF;
  SELECT string_agg(ad.label, ', ') INTO missing
  FROM agreement_documents ad
  WHERE ad.expired_at IS NULL
    AND ad.required
    AND (cardinality(ad.applies_to) = 0 OR NEW.category = ANY (ad.applies_to))
    AND NOT EXISTS (
      SELECT 1 FROM agreement_signatures s
      WHERE s.owner_id = NEW.owner_id
        AND s.document_key = ad.key
        AND s.version = ad.current_version
    );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION
      'agreement gate: owner % has not signed current required agreement(s): % (category %)',
      NEW.owner_id, missing, NEW.category USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER bookings_agreement_guard
  BEFORE INSERT ON bookings
  FOR EACH ROW EXECUTE FUNCTION assert_agreements_signed();

-- ----------------------------------------------------------------------------
-- Evaluation gate (added 2026-05-23 per Rachel; Day 12b). Dog-readiness floor:
-- Day School, Day Care, Board & Train and Boarding all require an in-school
-- evaluation before the dog can attend. Same floor pattern as the other three
-- BOOKING GATES: unbypassable BEFORE-INSERT, lead-dog check, staff-owned dogs
-- exempt (uniform-exemption ruling — staff self-manage out of band), API
-- pre-checks across all booking_dogs and surfaces the friendly typed error
-- before this trigger ever fires. The 'evaluation' category itself BYPASSES
-- the gate by construction (the booking that records the eval can't require
-- the eval to exist first). Free-text categories without a prereq (group-class
-- has its own R7 prereq system; private-lesson is staff-curated) are NOT
-- gated — the trigger's category whitelist enforces this so the bypass is
-- visible in one place.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assert_dog_evaluation_passed() RETURNS trigger AS $$
DECLARE
  lead_is_staff_dog boolean;
BEGIN
  -- 'evaluation' category is the dog's path TO passing — never gated.
  IF NEW.category = 'evaluation' THEN
    RETURN NEW;
  END IF;
  -- Only the four gated categories run the check; PL + group-class + any
  -- future free-text category fall through.
  IF NEW.category NOT IN ('day-school','day-care','board-and-train','boarding') THEN
    RETURN NEW;
  END IF;
  SELECT (d.staff_owner_id IS NOT NULL) INTO lead_is_staff_dog
  FROM dogs d WHERE d.id = NEW.lead_dog_id;
  IF COALESCE(lead_is_staff_dog, false) THEN
    RETURN NEW;                               -- staff dogs exempt (consistent)
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM dogs d
     WHERE d.id = NEW.lead_dog_id AND d.evaluation_status = 'passed'
  ) THEN
    RAISE EXCEPTION
      'evaluation gate: lead dog % must have evaluation_status = passed (category %)',
      NEW.lead_dog_id, NEW.category USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER bookings_eval_gate_check
  BEFORE INSERT ON bookings
  FOR EACH ROW EXECUTE FUNCTION assert_dog_evaluation_passed();

-- =============================================================================
-- Transaction contract notes (enforced in the Node API service layer):
--
--  GLOBAL: the API never issues DELETE and never destructively overwrites.
--    "Delete"/"remove"/"unlink" = UPDATE ... SET expired_at = now(). Reads
--    filter `WHERE expired_at IS NULL`. RE-LINKING a previously soft-expired
--    join row (re-add the same dog, re-RSVP) = UPDATE ... SET expired_at=NULL
--    on the existing row, NOT a second INSERT — natural-key UNIQUEs are now
--    partial on `expired_at IS NULL` so either approach is collision-safe.
--    Account deletion = expire owner + NULL/scrub PII columns; financial rows
--    (charges/invoices/refunds/ledger/memberships) are RESTRICT-protected and
--    retained for legal/tax. The audit_log trigger preserves the prior state
--    of every UPDATE/DELETE.
--
--  IDEMPOTENCY: every mutating endpoint (book, enroll, purchase, RSVP, sign,
--    add-card) requires an Idempotency-Key header. The API, inside the txn:
--    SELECT idempotency_keys WHERE key=$1 — if completed_at IS NOT NULL and
--    request_hash matches, replay response_status/response_body; if it exists
--    in-flight, 409; else INSERT in-flight, do the work, set the response +
--    completed_at. A TTL sweep prunes keys past the retry window (the only
--    table exempt from never-delete).
--
--  enrollInGroupClass(cohort, dogIds): ONE transaction —
--    SELECT ... FROM cohorts WHERE id = $1 FOR UPDATE;        -- lock row
--    assert filled + len(non-staff dogIds) <= capacity;       -- gotcha #5
--    INSERT len(dogIds) * cohort.weeks booking rows
--      (+ booking_dogs, cohort_id, session_report_id when the cohort report
--       exists);
--    UPDATE cohorts SET filled = filled + len(non-staff dogIds);
--  Commit or roll back as a unit. (capacity_exempt dogs excluded from filled.)
--
--  approvePendingRequest(requestId, staffId): ONE transaction —
--    UPDATE pending_requests SET status='converted', approved_at=now(),
--      approved_by_staff_id=$staff;   (B&T: 'approved-awaiting-payment' first,
--      then 'converted' on confirm-payment)
--    INSERT bookings (+ booking_dogs) from the request's lead+dogs+preferred
--      date the staffer picked; set pending_requests.converted_booking_id;
--    enqueue a 'booking-confirmed' notification.
--
--  BOOKING GATES (4 BEFORE-INSERT trigger floors on bookings; all exempt
--    staff-owned dogs; all check the LEAD dog/owner — the API enforces the
--    full set across every booking_dogs row and surfaces them earlier in UX,
--    in priority order payment → evaluation → vaccine → agreement so the
--    user fixes the most-fundamental gap first):
--      1. PAYMENT GUARANTEE (anti-scam): owner has a live payment_methods row
--         AND coverage = sufficient credits OR active membership OR a
--         successful charge OR a card-backed auto-charged invoice. No bare
--         "pay later". All paid services (group/B&T/private/day-school/care).
--      2. EVALUATION GATE (dog readiness — added Day 12b): lead dog has
--         evaluation_status='passed'. Gates day-school, day-care,
--         board-and-train, boarding. 'evaluation' category bypasses by
--         construction; group-class + private-lesson are not eval-gated.
--      3. VACCINE GATE (health): lead dog has a live, in-date dog_vaccines
--         row for every required_vaccines that gates the category (date math
--         in America/Chicago).
--      4. AGREEMENT GATE (legal): owner has signed the current version of
--         every required agreement_documents applicable to the category.
--
--  bookSession (Day School/Care with credits): ONE transaction —
--    SELECT ... FROM day_capacity WHERE location=$loc AND date=$d FOR UPDATE
--      (materialize the default-rule row first if absent); assert remaining
--      openings for (location,date,mode) > count of non-staff dogs — the
--      day-capacity analogue of the cohort row lock;
--    lock per (dog_id,mode): pg_advisory_xact_lock(hashtext(dog||mode)) OR
--      run SERIALIZABLE;                                       -- no double-spend
--    INSERT booking (+ booking_dogs);
--    INSERT credit_ledger (delta = -1, reason='booking-debit', booking_id)
--      per dog per mode; assert post-balance >= 0 OR a charge/membership
--      covers it. (payments_enabled = runtime kill switch, not a deferral.)
--
--  cancelBooking(bookingId): ONE transaction (Day 13) —
--    1. lockById(tx, bookings) — row lock, serialize concurrent cancel
--       attempts on the same booking. 404 if not found, 409 if already
--       cancelled, 403 if principal is neither owner nor staff.
--    2. UPDATE bookings SET status='cancelled', cancelled_at=now(),
--       cancel_forfeited = (now() > cancel_deadline_at). The deadline was
--       stamped at creation from cancel_window_settings (live policy at
--       book time) — changing the policy later doesn't retroactively re-
--       stamp existing rows.
--    3. IF NOT forfeited: credit booking back —
--         For credit-funded bookings: SELECT credit_ledger rows with
--           reason='booking-debit' AND booking_id=$id → INSERT one
--           +1 'cancel-refund' row per (dog, mode) debit. Append-only;
--           balance recomputes to its pre-booking value.
--         For money-funded bookings: SELECT charges WHERE booking_id=$id
--           AND status='succeeded' → INSERT refunds row (status='pending',
--           amount_cents <= the charge minus any prior succeeded refunds
--           for that charge). The Stripe refund API call is queued POST-
--           COMMIT (same shape as Day-10's payment_intents create).
--           Day-15 webhook flips refunds.status → 'succeeded'; charges.
--           status → 'refunded' only when cumulative succeeded refunds ==
--           charge.amount_cents (API logic, NOT a schema invariant).
--    4. IF forfeited: no ledger entry, no refund row. cancel_forfeited =
--       true, status = 'cancelled', and we still proceed through capacity
--       release so the seat doesn't sit blocked.
--    5. Capacity release:
--         - day_capacity is dynamic (assertCapacityWithinLock counts
--           non-cancelled rows). Flipping status='cancelled' IS the
--           release; no decrement needed.
--         - cohorts.filled is an explicit counter; for group-class
--           bookings, decrement by the non-staff dog count under the
--           same cohort row lock the enroll path uses.
--    6. Enqueue 'booking-cancelled' notification (deep-links to
--       /bookings/:id so the owner sees it in the bell popover).
--    Post-commit: invalidate caches for the booking list, dog credit
--    balance, capacity (avail:{location}:*), and dog profile.
-- =============================================================================

-- =============================================================================
-- Table descriptions (pg_description) — DataGrip right-click > Description shows
-- these instead of an auto-generated blurb. Keep one concise purpose sentence
-- per table; update alongside any structural change.
-- =============================================================================
COMMENT ON TABLE  owners                         IS 'Pet-owner accounts; the Supabase-Auth mirror row (keyed by supabase_uid). Ownership root for dogs, bookings and threads. Soft-expire only.';
COMMENT ON TABLE  staff                          IS 'NWA staff/trainers; Supabase-Auth mirror row with a role claim. Authors reports, approves requests, replies to threads, marks attendance. Staff are never clients.';
COMMENT ON TABLE  dogs                           IS 'A dog, owned by EITHER a client owner OR a staff member (XOR). Staff-owned dogs are capacity-exempt. Carries profile, evaluation gate, care sub-records.';
COMMENT ON TABLE  vets                           IS 'Dog''s primary vet / clinic contact (name, phone, email, address) so staff can call to confirm vaccines or ask health questions. One clinic = one row, many dogs.';
COMMENT ON COLUMN dogs.primary_vet_id            IS 'FK → vets.id; the dog''s primary veterinarian on file. NULL = none recorded. ON DELETE SET NULL.';
COMMENT ON TABLE  required_vaccines              IS 'Catalog of vaccines that GATE bookings; gates_categories is the data-driven rule the booking vaccine trigger reads (no hardcoded list).';
COMMENT ON TABLE  dog_vaccines                   IS 'Per-dog vaccination records with expiry; drives vaccine-due warnings. requirement_key set = satisfies a required_vaccines gate, NULL = display-only.';
COMMENT ON TABLE  dog_medications                IS 'Per-dog medication entries (name/dose/frequency) shown in Care Notes.';
COMMENT ON TABLE  dog_feeding                    IS 'Per-dog feeding instructions (1:1 with dogs).';
COMMENT ON TABLE  dog_completed_classes          IS 'Group classes a dog has completed; server-derived source for prerequisite eligibility (e.g. Manners-2 requires Manners-1).';
COMMENT ON TABLE  group_classes                  IS 'Catalog of group-class offerings (Puppy, Manners 1/2): price, capacity, enrollment type, prerequisite.';
COMMENT ON TABLE  cohorts                        IS 'A scheduled run of a group class (start date, weekly time, capacity, filled). Hard capacity ceiling enforced.';
COMMENT ON TABLE  class_resources                IS 'Per-group-class resource links (handouts / info pages) shown on the dog-profile Group page; gated by completion — surfaced only once a dog has a live dog_completed_classes row for the class.';
COMMENT ON TABLE  reports                        IS 'Trainer report cards. Base row + program discriminator + JSONB results/content (curriculum, private-lesson, stay, cohort variants).';
COMMENT ON TABLE  media_assets                   IS 'Metadata + Cloudflare-R2 object key for every photo/video (dog, owner, report). Never stores the bytes themselves.';
COMMENT ON TABLE  media_derivative_jobs          IS 'Worker queue: one row per media_assets row needing derivative processing (sharp images / ffmpeg video). Append-only by nature; status flips pending → processing → done | failed.';
COMMENT ON TABLE  bookings                       IS 'A confirmed scheduled session of any service category; the unified booking record (all six categories read back here).';
COMMENT ON TABLE  booking_dogs                   IS 'Dogs on a booking (lead + additional) plus per-dog real attendance / check-in.';
COMMENT ON TABLE  after_school_optins            IS 'Per-dog After School Coaching opt-in; DDL-gated so it can only attach to a day-school booking.';
COMMENT ON TABLE  pending_requests               IS 'Owner-submitted requests awaiting staff approval (private lesson, boarding, board-and-train) before they convert to bookings.';
COMMENT ON TABLE  pending_request_dogs           IS 'Dogs attached to a pending request (lead + additional), mirroring booking_dogs.';
COMMENT ON TABLE  pending_request_preferred_dates IS 'The owner ranked preferred date/time slots for a pending request.';
COMMENT ON TABLE  day_capacity                   IS 'Sparse per-(location, calendar-day) capacity overrides for Day School/Care; the per-location default rule is applied in the API when no row exists.';
COMMENT ON TABLE  cancel_window_settings         IS 'Owner-tunable per-category free-cancel hours (Day 13). One row per service_category; seeded 48h flat. API reads at booking creation to stamp bookings.cancel_deadline_at; the resolved deadline travels with the booking.';
COMMENT ON TABLE  credit_expiry_settings         IS 'Staff-tunable credit-expiry window + warning lead (2026-06-20). One org-default row (location IS NULL) + optional per-location override rows; partial unique indexes enforce exactly-one-default and one-per-location. API resolves per-location → org-default → code default (12mo) to stamp credit_ledger lot expiry at purchase (non-retroactive). warning_lead_days has no P2 consumer (its reader is the Phase-3 expiry-warning notification).';
COMMENT ON TABLE  credit_packages                IS 'Effective-dated catalog of purchasable credit packages (mode, credit count, price) per location. Reprice/retire by closing effective_to + inserting a new row — never edit a priced row.';
COMMENT ON TABLE  credit_ledger                  IS 'Append-only credit transactions (purchase grants, booking debits, refunds) modeled as expiring LOTS (Δ 2026-06-18): a source row (delta>0, lot_id NULL) carries expires_at; debits/refunds carry lot_id. Balance counts only live lots. Corrections are reversing entries.';
COMMENT ON TABLE  stripe_customers               IS 'Maps an owner to their Stripe customer id (1:1).';
COMMENT ON TABLE  payment_methods                IS 'Owner saved Stripe payment methods (token + displayable brand/last4); raw PAN never stored. Removal = expire (retained for charge history).';
COMMENT ON TABLE  charges                        IS 'Stripe PaymentIntent records (package purchase, pay-as-you-go, board-and-train, membership, group-class). Retained financial record.';
COMMENT ON TABLE  invoices                       IS 'Card-backed pay-later (anti-scam): every invoice has a required payment_method + due_at and is auto-charged by the worker — no open-ended unpaid balance. Distinct from charges; flips to paid when settled.';
COMMENT ON TABLE  invoice_charge_attempts        IS 'One row per auto-charge attempt, written BEFORE the Stripe confirm. Owns the Stripe idempotency key identity (attempt_no advances only when the previous attempt is known-dead) and the frozen params a same-key re-issue must resend. A partial unique index allows at most one unresolved (pending/processing) attempt per invoice.';
COMMENT ON TABLE  memberships                    IS 'Recurring Day School membership subscriptions (Stripe subscription-backed). Cancellation = status, never deleted.';
COMMENT ON TABLE  refunds                        IS 'Refunds against a prior Stripe charge (partial allowed). Append-only retained financial record; money-back, distinct from a credit_ledger cancel-refund.';
COMMENT ON TABLE  agreement_documents            IS 'Catalog of liability waivers / policy docs that gate bookings; applies_to empty = all categories. current_version drives the signature gate.';
COMMENT ON TABLE  agreement_signatures           IS 'Append-only legal fact: an owner signed document_key at version. Immutable — a new version is a new row, never edited/deleted.';
COMMENT ON TABLE  service_rates                  IS 'Effective-dated price catalog per (category, location). Append-only: never value-overwritten — a change closes the open row (effective_to) + inserts a new one; a mistake/cancel sets voided_at (soft-void, excluded from active, predecessor reopens). created_by/voided_by stamp the actor; the rows + audit_log are the change history.';
COMMENT ON TABLE  idempotency_keys               IS 'Client-mutation request dedupe (Idempotency-Key header). The ONE table exempt from never-delete: transport state, TTL-pruned by a sweep.';
COMMENT ON TABLE  threads                        IS 'Owner-to-staff message threads, organized by topic/category.';
COMMENT ON TABLE  thread_dogs                    IS 'Dogs a message thread is about (zero or more).';
COMMENT ON TABLE  messages                       IS 'Individual chat messages within a thread; polymorphic owner-or-staff sender. Unsend/delete = expire (text retained in audit_log).';
COMMENT ON TABLE  message_attachments            IS 'Photo/video attachments on a message → media_assets (purpose=message-attachment). Append-only; position orders within the bubble. Hard message delete cascades.';
COMMENT ON TABLE  event_series                   IS 'The recurring definition behind a repeating event (e.g. Public Pups, weekly). Each concrete week is its own events row via events.series_id.';
COMMENT ON TABLE  events                         IS 'A dated event occurrence (Public Pups week, Yappy Hour) with location; series_id NULL = one-off. Optional soft attendance cap (staff-overridable).';
COMMENT ON TABLE  event_rsvps                    IS 'An owner RSVP to an event; un-RSVP = expire.';
COMMENT ON TABLE  event_rsvp_dogs                IS 'Dogs included in an event RSVP.';
COMMENT ON TABLE  notifications                  IS 'Delivered in-app notification feed (bell popover); append-only, deep-link path is producer-written.';
COMMENT ON TABLE  scheduled_notifications        IS 'Worker queue of pushes/notifications to emit at or after a time (boarding 24h check, booking reminders, report-published). dedupe_key makes enqueue idempotent.';
COMMENT ON TABLE  notification_dogs              IS 'Dogs a notification is about; drives the stacked-avatar in the bell row.';
COMMENT ON TABLE  announcements                  IS 'School-wide (optionally city-targeted) home-screen announcements; is_pinned keeps recurring ones (Public Pups) always visible.';
COMMENT ON TABLE  device_tokens                  IS 'Registered Expo push tokens per owner/device for outbound push; revoked token = expire.';
COMMENT ON TABLE  audit_log                      IS 'Append-only history: the OLD row (JSONB) of every UPDATE/DELETE on soft-expire tables. Makes "nothing is ever lost, even edits" true. Never edited or pruned.';
COMMENT ON VIEW   dog_credit_balance             IS 'Derived per-(dog,mode,location) credit balance over the append-only ledger; counts only LIVE lots (excludes expired-lot credits, Δ 2026-06-18). The fast read; Redis-cached.';
