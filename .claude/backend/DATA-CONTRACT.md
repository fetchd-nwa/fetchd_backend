# DATA-CONTRACT.md — Node API ⇄ FE wire contract + decision register

Locked 2026-05-18. The bridge between `.claude/backend/schema.sql` (the DB) and the FE
repository swap. **The Node API must emit JSON in exactly the shapes below so
the existing `src/repositories/*` `toX()` translators keep working unchanged.**
Read `BACKEND-ARCHITECTURE.md` first for system context.

The wire format is **snake_case, absolute ISO-8601 (`timestamptz`), UUID string
ids** — it mirrors today's mock JSON shape minus the mock-only quirks (no
anchor date-shift; no client-minted ids; structured fields instead of the
flat-string encodings). The FE branding (`as DogId` etc.) happens at the repo
boundary exactly as it does today; the FE does not change.

---

## A. Decision register — LOCKED rulings

These were ruled and committed by Allison this session. Rationale included so a
future reader doesn't relitigate.

| #      | Decision                                  | Ruling                                                                                                                                                                                                                                                                                                                                                 | Why                                                                                                                                                                               |
| ------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **R1** | `PendingRequest` single-dog vs. multi-dog | **Align to Booking's multi-dog shape** (lead dog + `additional_dog_ids`; DB uses a `pending_request_dogs` join table). Kill the N-rows-per-dog + `notes.joint` glue.                                                                                                                                                                                   | Approval becomes a structure-preserving request→booking transform, not a merge. Schema-defining.                                                                                  |
| **R2** | `Report` optional-soup vs. union          | **TS discriminated union on category/program; DB = base row + `program` discriminator + JSONB `content` (variant doc) + JSONB `results` (curriculum).**                                                                                                                                                                                                | Variant payloads are deep, document-shaped, read-mostly, authored as a unit by the portal. 4 detail tables would be schema overkill. This _is_ the portal's 4 author-form shapes. |
| **R3** | No entity carries an owner                | **Ownership root = `owners`; `dogs.owner_id`; `bookings`/`threads`/`pending_requests` carry a denormalized `owner_id`.** Authz flows owner→dog→everything.                                                                                                                                                                                             | The mock assumed one global user. Multi-tenant authz needs an ownership root; Node middleware enforces it (no RLS).                                                               |
| **R4** | Staff identity                            | **Real `staff` rows keyed to a Supabase UID + `role` claim** (same Supabase project). `lib/staff.ts` roster is the seed. Messages carry a polymorphic `owner                                                                                                                                                                                           | staff` sender.                                                                                                                                                                    | The staff portal needs real principals; one auth system, one JWT path. |
| **R5** | Dates / time                              | **Absolute `timestamptz` on the wire.** Anchor-relative shifting was a mock-only demo trick — stripped at the repo swap. Capacity day stays a calendar `date`, not an instant.                                                                                                                                                                         | Real timestamps are absolute; the day-shift mechanic does not exist server-side.                                                                                                  |
| **R6** | IDs + import seam                         | **Server UUID strings; FE brands at the boundary, unchanged.** Every migratable entity carries nullable `external_ref` + `source ('app'\|'gingr'\|'seed')` — `'seed'` added 2026-05-19 for curated preloads (e.g. starter vets), idempotent via the partial unique.                                                                                    | Clean-slate v1, but a _later_ Gingr import must be an additive backfill, never a contract/schema break.                                                                           |
| **R7** | `Dog.completed_class_keys`                | **Server-derived eligibility.** `dog_completed_classes` rows fed from completed group-class bookings; the API returns a computed `eligible` boolean per (dog, class). Client never gets raw history to judge.                                                                                                                                          | The mock field is explicitly flagged temporary; trusting a client flag for a paywall/prereq gate is wrong.                                                                        |
| **R8** | `focus_areas` flat strings                | **API emits the structured shape** (`staff_preference`, `descriptor_keys`); the `"staff:rachel"`/`"descriptor:high-energy"` string encoding was a mock-JSON authoring convenience, dropped. Δ 2026-06-17: the single `comfort_level` enum was replaced by a staff-defined, multi-select `descriptor_keys: string[]` (vocabulary in `dog_descriptors`). | No reason to keep a stringly-typed wire format once it's a real DB column; the comfort scale became an org-tunable trait list.                                                    |

Lifecycle consequence of R1+R3+R4: a `pending_request` has a real
`status: submitted → approved → converted | cancelled`, `approved_at`,
`approved_by_staff_id`, and `converted_booking_id`. The minimum staff portal
drives this — **not** auto-confirm (that workaround died when the portal entered
scope).

### Review status — 2026-05-18 (frozen)

The four flagged engineering deviations were walked with Allison and ruled:

- **R2 — Report storage = JSONB**: confirmed. Base columns + `program`
  discriminator + JSONB `results`/`content`. Future analytics path: query
  JSONB directly → generated columns for hot fields → projection/read-model
  table when serious BI lands. JSONB→relational is an easy SQL backfill and
  FE-invisible as long as the API contract shape holds (the API absorbs any
  re-nesting server-side). Prereq: validate report payloads with Zod at the
  Node write boundary.
- **Credits = append-only `credit_ledger` + balance view**: confirmed (not a
  mutable counter). Correct primitive once money is involved; built empty/cheap
  built day one (Stripe test mode in dev/staging — not deferred); credits expire via a **lot model** (Δ 2026-06-18, superseding the 2026-05-19 "never expire" decision — see the §B Credits entry); O(1) reads recovered via matview/Redis cache
  without losing the audit trail.
- **Dog age = `birthdate`, derive `age_months`**: confirmed (already in
  `schema.sql`; FE already collects DOB so zero FE work).
- **`toPendingRequest` adapter change**: acknowledged as a locked _consequence_
  of R1+R8, not a separate decision. One repo-layer translator, changes only
  when the backend lands.

The contract (this doc + `schema.sql` + `BACKEND-ARCHITECTURE.md`) is **frozen**.

**Amendment 2026-05-19 (launch scope, not the register).** The v1
_payments-deferral_ is dropped. Payments are **built from day one** against
Stripe **test mode** (test keys in dev/staging — fully functional, fake
money); **live keys only at the real production launch** (env split:
test=dev/staging, live=prod — test mode never charges a real card, so
prod-to-real-clients MUST use live keys). `payments_enabled` survives only as
an operational kill switch (RUNBOOK incident use), never a launch-scoping or
deferral device. Register R1–R8 are unchanged — this is a launch-scope
change, not a contract decision, so the freeze still holds.

**Amendment 2026-05-19 (hardening bake, not the register).** Six additive
hardenings; register R1–R8 unchanged, freeze holds (these are integrity /
scope, not contract-shape decisions). (1) **Soft-expire ↔ natural-key fix:**
every natural-key UNIQUE/PK on a soft-expire table is now a _partial_ index
(`WHERE expired_at IS NULL`) so expiring a row frees its key for a fresh live
row; `dog_completed_classes` gained a surrogate `id`. (2) **Vaccine gate**
(health): `required_vaccines` catalog + `dog_vaccines.requirement_key`; a
`bookings` BEFORE-INSERT trigger blocks a gated category when the lead dog
lacks a current required vaccine (staff dogs exempt; America/Chicago date
math). (3) **Agreement gate** (legal): `agreement_documents` +
`agreement_signatures` (append-only); trigger blocks a booking until the owner
has signed the current required waiver for the category. (4) **Refunds +
cancellation window:** `refunds` table (partial allowed, append-only) +
`bookings.cancelled_at/cancellation_reason/cancel_deadline_at/cancel_forfeited`.
(5) **Per-location capacity:** `bookings.location` + `day_capacity` re-keyed
`(location, date)`. (6) **Pricing + idempotency:** effective-dated
`service_rates` catalog; `idempotency_keys` for client-mutation dedupe (the
sole table exempt from never-delete — transport state, TTL-pruned). FE wire
impact: none beyond the additive `DayCapacity.location` / `Booking.location`
keys below; the three gates surface as typed 4xx errors the FE already
renders via the error abstraction.

**Amendment 2026-05-19 (vets, not the register).** Additive `vets` table +
`dogs.primary_vet_id` (single primary vet/clinic per dog so staff can call to
confirm vaccines / ask health questions; M2M `dog_vets` and per-shot
`dog_vaccines.issued_by_vet_id` deliberately deferred — YAGNI). Follows the
locked conventions (soft-expire, import seam, **partial** `(source,
external_ref)` unique per the hardening-bake fix — not a plain inline UNIQUE).
Dog wire shape gains optional `vet?` (resolved from `primary_vet_id`); the
current FE has no vet UI and ignores it. Register/freeze unchanged. Table
count 44 → 45.

Population/curation model: ~50 vets preloaded with `source='seed'` ('seed'
added to `record_source`, R6) + a stable `external_ref` slug → idempotent
re-seed via the partial unique. Owners pick from the list when creating a dog;
"not listed" → `POST /vets` with `source='app'`. **De-dup is a create-flow
concern** (search-existing-first typeahead, `GET /vets?q=`), never a DB
constraint — a fuzzy clinic name can't be UNIQUE. `PATCH/DELETE /vets`
**[staff]-only** (shared row); expiring a vet referenced by live dogs is
API-blocked. A `verified` flag + staff merge UI is **deferred to the admin
dashboard** (provenance `source='seed'` is the v1 trust signal — YAGNI until
that product exists).

**Amendment 2026-05-20 (Day 6a — OR-prereq, not the register).** The schema
freeze opened narrowly to fix a real business gap: a class can require ANY
ONE of multiple prereqs (the planned `public-manners` class will need
`manners-1` OR `manners-2`). The singular `group_classes.prereq_class_key`
FK couldn't express OR. Dropped that column; added a `class_prereq_options`
join table (M:N, soft-expire, surrogate `id` + partial-unique per the
hardening-bake fix). Multiple rows per `class_key` = OR alternatives;
zero rows = no prereqs. Pure OR-of-singles for now — if AND-chains arrive
(a class needing `manners-1` AND `puppy`), add `group_id smallint` to the
join and treat group_id as the AND-set, OR across groups (DNF). Register
R7 unchanged (eligibility is still server-derived). Table count 45 → 46.

**Clarification 2026-05-20 (Day 6b — `reports.results` JSONB envelope, doc-
only).** `reports.results` JSONB was internally contradictory: the block
comment said `Record<skillKey, SkillResult>` (skills grid only); the inline
column comment said "skill grid + practice + friends etc." The §B Report
wire has FOUR sibling curriculum keys (`results`, `practice_at_home?`,
`friends_today?`, `additional_skills_completed?`) but the table has only
two JSONB columns. Pinned: `reports.results` is an **envelope** holding all
four — `{ results: Record<skillKey, SkillResult>, practice_at_home?,
friends_today?, additional_skills_completed? }` (snake_case verbatim from
the mock JSON). The wire helper spreads the envelope to the four top-level
sibling keys per §B. No DDL change; both schema comments tightened. R2
unchanged. Day-12 (report mutation) pins the Zod validator against this
envelope shape.

**Clarification 2026-05-21 (Day 7b — `GET /notifications` cursor-pagination
shape, wire pin).** §C notifications listed `GET /notifications` without
specifying the page shape. Pinned at Day 7b:

- **Response envelope:** `{ items: NotificationWire[], next_cursor?: string }`.
  `items` is the page in DB order; `next_cursor` is omitted when no further
  page exists. Envelope over `Link`-header pagination because TanStack
  Query's `useInfiniteQuery` reads the cursor from the body cleanly and
  the FE doesn't carry header-parsing infrastructure.
- **Cursor:** base64url-encoded JSON `{ "r": "<received_at ISO-8601>",
"i": "<id UUID>" }`. Encodes the keyset values by value (not an opaque
  server-stored handle) so the API stays stateless and a debugger can
  inspect any cursor by hand.
- **Page boundary:** `(received_at, id) < (cursor.r, cursor.i)` ordered
  `received_at DESC, id DESC`. `id` is the deterministic tie-breaker for
  same-millisecond rows. The server fetches `limit + 1` rows and uses the
  `limit+1`-th row's anchor as `next_cursor` (omitted when ≤ `limit`).
- **Limit:** `?limit=` query param, default 50, max 200. Out-of-range
  values return 400 `bad_request`. Malformed cursor (bad base64, bad JSON,
  bad payload shape) returns 400 `bad_request` — never a silent fallback
  to page 1, which would mask client bugs.

**Amendment 2026-07-24 (Notifications Phase 1 — read/dismiss mutation verbs +
`dismissed_at` soft-tombstone).** The notifications feed gained three bodyless
mutation verbs (see §C) and a `notifications.dismissed_at timestamptz` column
(NULL = live), modeled on `device_tokens.expired_at`. No wire-shape or contract
change — all three verbs return **204 No Content** and `NotificationWire` is
unchanged (`dismissed_at` is server-internal, never emitted).

- **Read state** — `POST /notifications/:id/read` marks one row read
  (`read_at = COALESCE(read_at, now())`, idempotent); `POST /notifications/read-all`
  marks every unread row read. Both owner-only. A read row **stays in the feed**,
  now flagged `is_read: true`, and drops out of `unread-count`.
- **Dismiss = soft-tombstone** — `DELETE /notifications/:id` sets `dismissed_at`
  (idempotent via `COALESCE`); the row is **retained for audit** but filtered out
  of both `GET /notifications` and `GET /notifications/unread-count`
  (`dismissed_at IS NULL` on both reads). Dismiss ≠ read: a read row still shows,
  a dismissed one does not. No undo, no trash UI (Apple-style swipe-away),
  consistent across the owner's devices.
- **Anti-enumeration** — `owner_id` is in the UPDATE `WHERE`; 0 matched rows
  (missing, dismissed-already-is-fine via COALESCE, or another owner's) → 404,
  no separate ownership SELECT. Staff principals → 404 on `:id/read` / `DELETE`
  (read-all is a 204 no-op, matching the soft-empty-feed convention of the GETs).

**Amendment 2026-07-24 (Notifications Phase 2 — structured entity ref
(`deep_link_kind`/`deep_link_id`) + producer `deep_link_path` corrections +
cancel-time schedule teardown).** Companion to the Phase-1 amendment above; all
backend-side and wire-invisible this phase — no `WIRE_CONTRACT_VERSION` bump. The
two new columns stay server-internal until the Phase-3 contract bump derives the
path from them.

- **Structured entity ref (decision 3).** `notifications` and
  `scheduled_notifications` each gained `deep_link_kind text` + `deep_link_id
  uuid` (both nullable) — the entity a tap targets, carried as a (kind, id) pair
  instead of only a hand-written `deep_link_path` string. `NotificationWire` is
  UNCHANGED (neither column is emitted yet); producers still hand-write the path
  this phase. Phase 3 (landed 2026-07-25, amendment below) bumps the contract to
  move the notification wire SHAPES into `wire.ts` and derive the path from the
  structured (kind, id) pair via a shared `deepLinkToPath()` helper — the two
  columns stay server-internal, NOT emitted on `NotificationWire` — correct-by-
  construction, which kills the mis-parse class below at the root.

- **Producer `deep_link_path` corrections.** Six of the twelve producers were
  emitting a path with no matching FE route (dead-ended on Unmatched) or the
  wrong segment binding. Canonical (kind, id, path) for all twelve as of this
  phase:

  | type | kind | id | canonical path |
  | --- | --- | --- | --- |
  | booking-confirmed | `booking` | bookingId | `/bookings/:bookingId` |
  | booking-cancelled | `booking` | bookingId | `/bookings/:bookingId` |
  | booking-reminder | `booking` | bookingId | `/bookings/:bookingId` |
  | boarding-profile-check | `dog-manage` | leadDogId | `/dog-manage/:leadDogId` ← |
  | report-published | `report` | reportId | `/report-card/:dogId?reportId=:reportId` ← |
  | message-received | `thread` | threadId | `/chat/:threadId` ← |
  | payment-succeeded | `invoice` | invoiceId | `/account/invoices` ← |
  | payment-failed | `invoice` | invoiceId | `/account/invoices` ← |
  | membership-ended | `membership` | membershipId | `/account/memberships` |
  | credits-expiring | `dog-profile` | lot.dogId | `/dog-profile/:dogId` ← |
  | alumni-attendance | `dog-profile` | dogId | `/dog-profile/:dogId` |
  | spay-neuter-reminder | `dog-manage` | dogId | `/dog-manage/:dogId` |

  `←` marks the six changed this phase. WHY each moved:
  - **boarding-profile-check** `/bookings/:id` → `/dog-manage/:leadDogId`
    (decision 5) — the old alias opened booking detail, but the CTA is the
    pre-stay profile/vaccine/feeding intake, which lives on the dog-manage edit
    form. Producer resolves booking → lead dog.
  - **report-published** `/reports/:reportId` →
    `/report-card/:dogId?reportId=:reportId` — the old path dead-ended: the RN
    route `app/reports/[dogId]` binds the segment as `dogId`, so a report id fed
    there resolved no dog + an empty list. Producer now threads `body.dog_id`
    (the report id rides the query string).
  - **message-received** `/messages/:threadId` → `/chat/:threadId` — no
    `/messages/:id` route exists (the thread screen is `app/chat/[threadId]`);
    the old path landed on Unmatched.
  - **payment-succeeded / payment-failed** `/account/billing` →
    `/account/invoices` — no `/account/billing` route exists (`app/account`
    carries only `invoices` + `memberships`); both dead-ended. payment-failed is
    the only action-required push, so this one is high-impact.
  - **credits-expiring** `/credits` → `/dog-profile/:dogId` (decision 4) — no
    `/credits` route exists anywhere; the credit balance lives on the dog
    profile. Producer resolves lot → dog (`lot.dogId`); one notification per
    expiring lot.

  Reserved kinds with no producer yet: `credits`, `announcement`.

- **D4 — cancel-time schedule teardown.** Booking cancel now cancels the
  booking's pending `scheduled_notifications` — the `booking-reminder:<bookingId>`
  row (all categories) and, for boarding / board-and-train, the
  `boarding-24h:<bookingId>` row — in the SAME transaction as the cancel, so a
  cancelled booking never fires a stale reminder or profile-check. (The enqueue
  side is the §A Day-16 amendment; this closes the loop on cancel.)

**Amendment 2026-07-27/28 (Notifications Phase 4c — cancel attribution,
pay-in-person + payment-due, wire 1.2.0 → 1.3.0).** Per Allison's second
sim-QA round: (1) `bookings` gains `cancelled_by` (`'owner'|'staff'`, CHECK) +
`cancel_reason` (text, staff-supplied, optional) — every `cancelBookingInTx`
caller passes the actor; the staff cancel body accepts an optional trimmed
1–500-char `reason` (folded into the idempotency hash); `BookingWire`
additively emits both (omit-on-null, cancelled bookings only). (2) `invoices`
gains `payment_expected` (`'card'|'in-person'`, NOT NULL default `'card'`);
new **`POST /invoices/:id/pay-in-person`** (owner-only, idempotent, bodyless
204) flips it and, in the same tx, enqueues the new **`payment-due`** scheduled
notification (14th `notification_type` arm; dedupe `payment-due:<invoiceId>`;
`scheduled_for` = linked booking's drop-off else `due_at`, minus 1h, past-due
clamped to now; category `urgent-updates`). Charges NOTHING — the checkout
hard-stop remains portal-side per the adjudications. `GET /invoices` ledger
additively exposes `payment_expected` on open entries (an in-person invoice
renders non-payable in the app — card-paying it would double-bill drop-off).
Receipt copy helpers unified in `src/lib/invoiceReceiptCopy.ts`
(settle + auto-charge + pay-in-person all import; private copies deleted).

**Amendment 2026-07-27 (Notifications Phase 4b — entity-specific deep-link
destinations, wire 1.1.0 → 1.2.0).** Per Allison's sim-QA rulings: (1) the
`deepLinkToPath` `invoice` arm now emits `/account/invoices?invoiceId=:id` so a
payment notification opens the SPECIFIC invoice (client renders a detail modal;
paid = green Paid, open = outstanding + pay CTA); (2) the `membership` arm is
params-driven — `params.dogId` → `/dog-subscriptions/:dogId` (new owner-app
page), absent → `/account/memberships`; `membershipRoll` decides AT SEND TIME:
an owner with MULTIPLE memberships completing in the same tick gets the
overview target, a lone completion gets the dog's page. Old persisted paths
remain valid (client parser accepts both). Supporting additive reads, neither
in wire.ts (both are hand-mirrored surfaces): `LedgerEntryWire.invoice_id?` —
paid ledger entries are charge-keyed, so `GET /invoices` now exposes the
settled invoice via the `invoices.paid_charge_id` back-reference (the client's
match key for notification taps); `MembershipWire.payment_method?` `{ brand,
last4 }` — the §J.1 pinned billing card, joined live-only, omitted when the
bound card is no longer live.

**Amendment 2026-07-27 (Notifications Phase 4c — pay-in-person + cancel
attribution, wire 1.2.0 → 1.3.0).** Allison's second sim-QA round (R1–R6);
additive only (`CHANGELOG.md` [1.3.0]). Three DDL adds, applied via ALTER on
BOTH running DBs (dev :5432 + test :5433) and mirrored in `schema.sql` + the
hand-patched Drizzle `src/db/schema/schema.ts`:

- **R5 — WHO/WHY on a cancelled booking.** `bookings.cancelled_by text CHECK
  ('owner'|'staff')` + `bookings.cancel_reason text` (both nullable; NULL on
  legacy/not-cancelled rows; distinct from the still-unused
  `cancellation_reason`). Stamped by `bookingsRepository.markCancelled` — owner
  self-cancel (`POST /bookings/:id/cancel`, group-class withdraw) → `'owner'`,
  staff cancel (`POST /staff/bookings/:id/cancel`) → `'staff'` + the optional
  reason. That staff route now accepts a body `{ reason?: string }` (trimmed,
  1–500 chars, strict; reason rides the idempotency request hash so a replay
  with a different reason 422s as a mismatch). Wire: `BookingWire.cancelled_by?
  ('owner'|'staff')` + `cancel_reason? (string)` — emitted only on a cancelled
  booking, omit-on-null like `cancelled_at`. Owner app renders "You cancelled
  this on …" / "The school cancelled this on …" + the reason line in the
  booking modal's cancelled banner.
- **R3 — cash/check ("in person") pay is real.** `invoices.payment_expected
  text NOT NULL DEFAULT 'card' CHECK ('card'|'in-person')`. New verb **`POST
  /invoices/:id/pay-in-person`** `[auth, owner]` — Idempotency-Key required,
  bodyless **204**; charges NOTHING. Flips `payment_expected → 'in-person'`
  (filtered on `status='open' AND payment_expected='card'`, so a repeat call
  under a new key — or a paid/void target — 409s; same-key replay returns the
  stored 204 via the peek-first pattern) and, in the same tx, enqueues a
  **`payment-due`** scheduled notification (dedupe `payment-due:<invoiceId>`,
  one per invoice) anchored **~1h before the linked booking's drop-off**
  (`dropoff_at`, falling back to `scheduled_at` for non-stay categories) or ~1h
  before the invoice's `due_at` when no booking is linked; a past anchor clamps
  to now. Deep-links `invoice`/`/account/invoices?invoiceId=:id`; tags the
  booking's lead dog (else the invoice's `dog_id`). `notification_type` pgEnum
  += `'payment-due'` (**14 arms**, `NotificationType` pinned in
  `conformance.ts`); push-capable under the `urgent-updates` category. Copy
  helpers (`formatDollars`/`purposeLabel`) extracted to
  `src/lib/invoiceReceiptCopy.ts`, shared with the `payment-succeeded` receipt.
  Known deferrals, documented in-code: the auto-charge worker is NOT yet
  stopped for in-person invoices (`next_attempt_at` untouched), and
  `LedgerEntryWire` does not yet carry `payment_expected` (the client's
  in-person state is optimistic until it lands on the wire).

**Amendment 2026-07-25 (Notifications Phase 3 — notification surface enters the
contract (wire 1.1.0) + D3 push-preference enforcement + producer path
derivation).** Companion to the Phase-1/Phase-2 amendments above and the first
`WIRE_CONTRACT_VERSION` bump of the notifications work — **1.0.0 → 1.1.0**
(additive; `CHANGELOG.md` [1.1.0]). Fulfills the Phase-2 promise that the
structured deep-link ref "migrates in Phase 3": the wire SHAPES move into
`src/contracts/wire.ts`, and every producer Phase 2 touched now DERIVES
`deep_link_path` instead of hand-writing it. The persisted `deep_link_path`
VALUES are byte-identical to Phase 2 — the existing tests pin them, and that
identity is the proof the derive is equivalence-preserving, not a behavior
change. The notification surface is no longer hand-mirrored per-repo: it is
contract-guarded and generated verbatim into both clients.

1. **Notification wire surface now lives in `wire.ts` (contract-guarded).** Nine
   additive additions, no removals or retypes:
   - `NotificationType` — 13-arm union mirroring the `notification_type` pgEnum
     (`src/db/schema/schema.ts`), pinned by `Expect<Equal<NotificationType,
DrizzleEnum<typeof notificationType>>>` in `conformance.ts` (following the
     existing enum-conformance rows) so the wire union and the DB enum can never
     drift.
   - `NotificationWire` `{ id, type, title, body, received_at, is_read,
deep_link_path?, dog_ids?, sender_staff_id? }` — **moved** from
     `src/lib/notificationWire.ts`, which now RE-EXPORTS it (plus
     `NotificationType` + `NotificationDeepLinkKind`) so every
     `../lib/notificationWire.js` importer is untouched; that module keeps only
     its backend-only pieces (`NotificationRowForWire` projection +
     `toNotificationWire` shaper). Its Phase-2 local `NotificationDeepLinkKind`
     pin (the "migrates in Phase 3" comment) is deleted — now fulfilled.
   - `NotificationListResponse` `{ items, next_cursor? }` + `UnreadCountResponse`
     `{ unread_count }` — **moved** from the inline shapes in
     `src/routes/notifications.ts` (the Day-7b cursor envelope, now typed by the
     contract); the route consumes the contract envelopes instead of its locals.
   - `NotificationPushData` `{ type, deep_link_path?, notification_id }` — pins
     the snake_case Expo push `data` keys IN the contract, next to the wire the FE
     reads on tap, so the D2 push/wire key mismatch (`deep_link_path` sent vs
     `deepLinkPath` read) can never recur.
   - `NotificationDeepLinkKind` (9-arm union) + `NOTIFICATION_DEEP_LINK_KINDS`
     readonly value tuple, `NotificationDeepLink` `{ kind, id, params? }`, and the
     pure helper `deepLinkToPath(link)`.
   - The Phase-2 `notifications` / `scheduled_notifications` `deep_link_kind` /
     `deep_link_id` columns STAY server-internal — they are NOT emitted on
     `NotificationWire`. The wire still carries only the derived `deep_link_path`;
     the structured (kind, id) pair is the producer's INPUT to `deepLinkToPath`,
     not an FE-visible field. (This is the correction to the Phase-2 forward
     reference above, which had said Phase 3 would "emit the structured ref": it
     doesn't — it contracts the shapes and derives the path.)

2. **`deepLinkToPath` is the single path grammar (decision 8).** Every emit site
   Phase 2 touched now computes `deep_link_path = deepLinkToPath({ kind, id,
params? })` from the contract instead of hand-writing a string. The grammar,
   in one place, correct-by-construction over the whole 9-arm kind vocabulary:
   `booking` → `/bookings/:id`; `report` →
   `/report-card/:params.dogId?reportId=:id` (**throws** `Error` when
   `params.dogId` is missing/empty — fails loud at emit time, never ships a
   dead-end path); `thread` → `/chat/:id`; `invoice` → `/account/invoices`;
   `membership` → `/account/memberships`; `dog-profile` → `/dog-profile/:id`;
   `dog-manage` → `/dog-manage/:id`; `credits` → `/dog-profile/:id` (alias of
   `dog-profile`, decision 4); `announcement` → `/announcement/:id`. `credits` +
   `announcement` stay reserved (no producer today). The Phase-2 canonical (type,
   kind, id, path) table above is unchanged — this amendment moves WHERE the path
   is computed, not WHAT it resolves to.

3. **D3 — push-preference enforcement (`src/lib/pushPreferences.ts:shouldSkipPush`,
   consulted in `src/workers/scheduler.ts:deliverOne`).** The feed INSERT ALWAYS
   happens — the DB is the source of truth, and `deliverOne` writes the
   `notifications` row before it looks at any preference. The PUSH is then skipped
   (zero Expo messages, feed entry intact) when EITHER:
   - `owners.push_notifications_enabled = false` — the master switch mutes every
     push; OR
   - `push_notification_categories[category] === false` for this notification's
     category.
     MISSING key = enabled: the `push_notification_categories` jsonb defaults to
     `'{}'`, so ONLY an explicit boolean `false` opts out (a missing key, a
     non-boolean, or `true` all fall through to "send"). Only six scheduled types
     ever reach the push channel today, so the type→category map is written TOTAL
     over exactly those six (`Record<PushCapableType, PushCategoryKey>`):

   | notification type | push category |
   | --- | --- |
   | booking-reminder | booking-reminders |
   | boarding-profile-check | booking-reminders |
   | alumni-attendance | booking-reminders |
   | payment-failed | urgent-updates |
   | credits-expiring | urgent-updates |
   | spay-neuter-reminder | urgent-updates |

   The two category keys (`booking-reminders`, `urgent-updates`) are the mobile
   `NotificationCategoryKey` values (`mobile/src/types/user.ts`, the account-screen
   `NotificationCategoryPanel` toggles). The map is backend-local (NOT in
   `wire.ts`) — it is an enforcement detail, not a wire shape. Every other
   `NotificationType` arm is feed-only (or never enqueued to
   `scheduled_notifications`), so no per-category toggle governs it.

**Amendment 2026-05-22 (Day 9d — VaccineWire grows `id` + `requirement_key?`).**
The §B Dog `vaccines:[{name,expires_at}]` sub-shape was forced open by
Day-9d's `PATCH /dogs/:id/vaccines/:vid` and `DELETE
/dogs/:id/vaccines/:vid` — the URL needs the vaccine row id, which the
wire hadn't carried. Additive amendment so the FE (Day-18 swap) ignores
the new keys until it consumes them; no breaking change.

- **`id: string`** — required, always emitted. The `dog_vaccines.id` PK.
  Matches the existing MedicationWire convention (medications already
  carry `id`).
- **`requirement_key?: string`** — optional, omitted when null. The
  `dog_vaccines.requirement_key` FK to `required_vaccines.key` (text).
  Surfaces an existing DB column that wasn't on the wire; lets the FE
  link a vaccine row to its gating-catalog entry without re-doing the
  name-match (Day-10 booking-gate UX benefits; today display-only).
  POST/PATCH bodies accept the same field — round-trip consistent.
  New §B VaccineWire: `{ id, name, expires_at, requirement_key? }`.
  Server normalizes empty-string `requirement_key` to `null` (omit-on-null
  convention). FK validation: PATCH/POST reject 422 `invalid_payload` if
  `requirement_key` references a non-live `required_vaccines` row.

Day-12+ may extend the same cursor shape to other DESC-by-timestamp lists
(messages, charges); reuse when the keyset is `(timestamptz, id)`.

**Amendment 2026-05-22 (Day 10 — POST /bookings body + typed gate errors +
cancel-deadline policy + DST fix + pattern-wipe seam).** Day-10 opens the
booking-write surface (day-school / day-care, credit-debited, multi-date).
Six pieces ship together; all are additive or doc-only (no R1-R8 change).

1. **POST /bookings body — pinned from §C's `dates[]` placeholder.**
   `{ category: 'day-school'|'day-care', lead_dog_id, additional_dog_ids?,
dates: 'YYYY-MM-DD'[], dropoff_time?: 'HH:MM', location:
'fayetteville'|'bentonville', notes? }`. Returns 201 + `BookingWire[]`
   (one per date, ASC). `dates[]` is `string[]` for now — per-date
   `{date, dropoff_time}` objects added when a real use case demands;
   today the top-level `dropoff_time` applies to every date in the
   request. Limits: `dates.length ∈ [1, 30]`, all distinct, all
   today-or-future in America/Chicago, all within 92-day lookahead
   (matches GET /availability cap). Up to 5 dogs per request. Idempotency-
   Key required (per the GLOBAL IDEMPOTENCY rule). Other service
   categories use different endpoints — group-class via POST /enrollments
   (Day 11), B&T/boarding/private-lesson/evaluation via the
   pending-request flow (Day 12).

2. **§B Booking wire — unchanged.** The read side reads back the §B shape
   verbatim; no fields added or removed by Day-10.

3. **Error envelope grows an optional typed `details` payload.**
   `{ error: { code, message, details?: { kind, ... } } }`. The
   `details.kind` discriminator equals the error `code` for the typed
   gate errors; absent on every pre-Day-10 error path (existing routes
   unchanged on the wire). FE branches on `code` for recovery copy +
   on `details.{missing,gaps,...}` for deep-link recovery. Day 11+
   extends the union — cohort-full, request-already-converted,
   cancel-forfeited each add a `kind` arm.

4. **New `ApiErrorCode` values (all 422, all carry typed `details`):**
   - `payment_required` — owner has no live `payment_methods` row.
     `details: { kind: 'payment_required' }`.
   - `vaccine_missing` — at least one booking_dog lacks a current
     required vaccine for the category. `details: { kind, missing:
{ dog_id, requirement_key, label }[] }`.
   - `agreement_unsigned` — owner has not signed every required
     agreement at the current version for the category. `details: { kind,
missing: { document_key, label }[] }`.
   - `insufficient_credits` — at least one (dog, mode) would go
     negative. `details: { kind, gaps: { dog_id, mode, balance,
required }[] }`.
   - `insufficient_capacity` — `(location, date, mode)` day-program
     capacity is exhausted for the requested count. `details: { kind,
  location, date, mode, openings_remaining, requested }`.
     Gates fire in priority order (payment → vaccine → agreement); first
     failure aborts with full WITHIN-gate detail. Multi-gate consolidation
     (one error carrying multiple `kind` arms) is a deferred refinement;
     the single-gate-at-a-time shape ships today.

5. **`bookings.cancel_deadline_at` set at creation, per-category rule in
   `src/lib/cancelWindow.ts`.** §I lock honored ("cancel_deadline_at
   is set at creation"). Per-category hours-before-scheduled-at:
   - day-school / day-care / private-lesson / evaluation → 24h
   - group-class → 48h (cohort capacity reserved)
   - boarding → 72h (multi-night)
   - board-and-train → 168h / 7 days (multi-week)
     Math is pure UTC offset (`scheduledAt - hours * 3_600_000`); no
     wall-clock subtraction, so DST never silently shifts a "24h" promise
     to 23h or 25h. Numbers are TUNABLE — Shanthi to confirm pre-launch.
     Day-13's cancel route reads this same module; Day-13 may add a
     per-cohort override path (analogous to day_capacity overrides over
     the default rule).

6. **`scheduled_at` composition for day programs lives in
   `src/lib/bookingSchedule.ts`** — combines the body's `dropoff_time`
   (default 07:30, must be within `DAY_PROGRAM_DROPOFF_WINDOW` 07:30-09:00
   inclusive) with `chicagoWallTimeToUtc` so the create-side date math
   matches the read-side bucket math (`lib/bookingBucket.sessionEndTime`)
   exactly. Per the §B Booking Δ 2026-05-20 — `scheduled_at` for
   day-school / day-care IS the user-authored drop-off time.

**DST fix in `chicagoWallTimeToUtc` (latent Day-3b bug, surfaced by
Day-10's drop-off window).** The prior two-probe Math.max heuristic
returned the WRONG UTC for spring-forward day wall times in the
post-jump-but-pre-naive-UTC-catch-up window (~03:00-07:59 wall), which
overlaps the day-program drop-off window (07:30-08:00 specifically).
Replaced with fixed-point iteration on the offset Chicago has at the
candidate UTC; converges in 1-2 iterations on every normal day,
oscillates on the spring-forward gap (resolved by Math.max as a
fallback, preserving IANA fold=0 "skip the gap forward"). All prior
DST tests pass unchanged; a new regression-lock test exercises every
wall hour in the bad window. Wire shape: none — pure backend
correctness fix.

**Cache-invalidation seam grew `patternsToInvalidate?`.** `withMutation`
already supported `keysToInvalidate?` (exact-key wipes); Day-10 needs
`avail:{location}:*` pattern wipes per the §3 cache map. Added
`patternsToInvalidate?: (body: T) => string[] | Promise<string[]>`
alongside `keysToInvalidate`. Same post-commit, non-replay-only,
swallow-and-log lifecycle; calls `lib/cache.invalidatePattern` (SCAN +
batched UNLINK). The §3 mirror in `lib/cache.ts` is the
documentation-as-contract for which pattern wipes on which mutation —
Day-12 mutations touching soft-expire entities use this seam.

**Amendment 2026-06-20 (staff per-location service-rate editor — LANDED;
hardened to append-only / void / no-trap).** The write side of the price
catalog. Owner-facing pricing stays read-only at `GET /rates`; staff manage it.
Real NWA per-location PAYG pricing is TBD + differs by location. `service_rates`
gained `created_by_staff_id`, `voided_at`, `voided_by_staff_id` (additive);
values (`amount_cents`/`unit`/`note`) are **never UPDATEd** after insert — only
`effective_to` (window mgmt) + the void columns change. It's already in the
`audit_log` trigger list, so every close/void is captured with the staff actor.

1. **`GET /staff/rates` `[staff]`** → `StaffRateWire[]` — non-voided rows active
   or scheduled at today (expired + voided excluded), ordered category → location
   (nulls last) → effective_from. `StaffRateWire = { id, category, location:
   LocationKey|null, amount_cents, unit, effective_from, effective_to:
   string|null, note: string|null, created_by_staff_id: string|null }` — unlike
   the owner `RateWire` it carries `id` + `effective_to` + `created_by` and always
   emits `note`/`location`. Owner → 403.

2. **`GET /staff/rates/history?category=&location=` `[staff]`** →
   `StaffRateHistoryWire[]` — the full change log for one track (every row incl.
   expired + voided), newest first (by `created_at`). Adds `created_at`,
   `voided_at`, `voided_by_staff_id` to `StaffRateWire`. The append-only rows ARE
   the history; `audit_log` additionally holds the before-state + actor of each
   close/void.

3. **`POST /staff/rates` `[staff]` `[idempotent]`** → 200 `StaffRateWire`. Body
   `{ category, location, amount_cents, unit, effective_from?, note? }`.
   **Effective-dated supersede, append-only:**
   - row starting ON `effective_from` (same-day) → **void it** + INSERT the
     replacement (never an in-place overwrite).
   - else the predecessor spanning `effective_from` → close it (`effective_to =
     effective_from`); the new row ends at the soonest scheduled successor (or
     stays open) — a scheduled future rate is **slotted in before**, NEVER
     blocked (no 409 conflict path exists).
   Validation: `amount_cents ∈ [1, 1_000_000]`; `effective_from` defaults to today
   (Chicago), must be **≥ today** (else 422); **day-school / day-care must be
   `unit: 'per-day'`** (else 422). `created_by_staff_id` stamped.

4. **`POST /staff/rates/:id/void` `[staff]` `[idempotent]`** → 200 `StaffRateWire`
   (the voided row). Soft-voids the entry + **reopens its predecessor** (the row
   that ended at this row's `effective_from` → its `effective_to` extends to this
   row's) so cancelling a scheduled change leaves no pricing gap. Voiding the
   only/first row leaves the track unset (legit "no rate"). 404 unknown/
   already-voided; owner → 403.

**No-trap guarantee:** every row (current or scheduled) is voidable; voiding
reopens the predecessor; setting a rate never conflicts. Any state is reachable
and recoverable. All writes run under `withServiceRateLock` (per-track advisory
lock). **Defense-in-depth:** the PAYG charger (`resolvePaygPlan`) refuses (500) a
resolved day-program rate whose `unit ≠ 'per-day'`, so a bad seed/SQL row can't
mis-bill. Code: `serviceRatesRepository` (supersedeRate/voidRate/findHistoryForTrack/
findTrackById), `routes/staffRates.ts`, `routes/bookings.ts`; tests
`staff-rates.test.ts`. **Still deferred:** the portal real Supabase auth (the
portal milestone — until then the editor rides the API dev-bypass).

**Amendment 2026-06-19 (PAYG for day-school / day-care — mobile signal +
backend branch LANDED).** Day programs can be paid pay-as-you-go instead of
from a credit balance — the over-credits sheet already offers it. The FE wire
signal shipped first; **the backend PAYG branch then landed** (POST /bookings
schedules a `'payg'` invoice instead of debiting; cancel voids it within the
window). A real-mode PAYG booking now books + schedules the auto-charge; before
the branch it 422'd `insufficient_credits`.

1. **POST /bookings body grows two optional fields (additive, backward-
   compatible).** `payment?: 'credits'|'payg'` (omitted = `'credits'`) and
   `payment_method_id?` (required when `payment: 'payg'` — the card to
   auto-charge). Per request = per (lead_dog, mode, location) group, so one
   submit can mix a credits group and a PAYG group.

2. **Backend behavior when `payment: 'payg'` (LANDED 2026-06-19).** SKIPs the
   Day-10 credit pre-check + the `credit_ledger` `booking-debit` for that group;
   inserts the booking as usual; instead schedules a PAYG auto-charge — reuses
   `charge_purpose='payg'` + `invoices` / the auto-charge worker (Day-14/16),
   due 1h before `scheduled_at` (drop-off), card = `payment_method_id`. **Amount
   per booking date = the active day-program `service_rates` row's `amount_cents`
   × the roster size** (lead + additional dogs) — one combined charge per date
   (one statement line, one Stripe fee), mirroring the credits path's
   one-debit-per-dog total. day-school / day-care are seeded `per-day` (not
   `per-session`). The rate is **locked at booking time** (resolved once against
   today's Chicago date), so a later catalog change never re-prices an existing
   booking — same "pay today's price" semantics as credits. 404 `not_found` if
   no active rate for (category, location). The card is validated owned + live
   in-tx (404 collapse). Cancel-within-window VOIDs the open invoice (worker
   skips voided rows); past-window forfeits (it charges per policy). The
   cancel-void is safe by construction: `cancel_window_settings.hours_before > 0`
   (DB CHECK, integer ⇒ ≥ 1h) guarantees the free-cancel deadline ≤ the due time.
   Idempotency-keyed; the invoice schedule rolls back with the booking on any
   in-txn failure, and a replay returns the stored 201 without re-scheduling.
   `insufficient_credits` MUST NOT fire for a PAYG group (a `'credits'` group is
   byte-unchanged: pre-check + debit + 422 when short). **Owner push on the
   auto-charge succeeding / declining is deferred to credit-expiry Phase 3** (the
   auto-charge worker is shared across PAYG / B&T / group-class invoices, so that
   notification is designed there across all purposes, not PAYG-only).
   Code: `routes/bookings.ts` (`resolvePaygPlan`), `cancelBookingService.ts`,
   `invoicesRepository.findOpenForBooking`; tests `booking-payg.test.ts`.

3. **Mobile side (landed 2026-06-19).** `BookSessionsInput` +
   `BookSessionsBody` carry `payment` / `payment_method_id`; `useBookingFlow`
   tracks PAYG selections per (dog, location, mode) from the over-credits
   sheet and tags those requests; the mock books a PAYG group without
   debiting. Inert until the backend branch lands.

**Amendment 2026-05-23 (Day 11 — POST /enrollments + cohort capacity +
R7 in-txn + two new typed gate errors).** Day-11 opens the cohort-
enrollment write surface. The wire shape was _already_ described in §C
(line 495) and §C.1 Model 2 (line 552-560); this amendment pins the
body shape, adds the two new typed error arms to the Day-10
discriminated union, and locks one composition decision.

1. **POST /enrollments body — pinned from §C's high-level prose.**
   `{ cohort_id: uuid, dog_ids: uuid[] }`. Returns 201 + `BookingWire[]`
   length = `|dog_ids| × cohort.weeks` (one booking per dog per week),
   ASC by `scheduled_at` primary + `dog_id` secondary (deterministic
   across runs). `dog_ids` ∈ [1, 5], all distinct, all owner-owned
   (404 if not). Idempotency-Key required. **No `lead_dog_id` /
   `additional_dog_ids[]` split** — group-class enrollments produce
   N×W single-dog bookings (each dog becomes a lead in its own
   per-week bookings), not one multi-dog booking. This is structurally
   different from POST /bookings (Day 10) and matches §C.1 Model 2
   "Never POST /bookings".

2. **`bookings` columns stamped at enrollment.** Per row:
   `category = 'group-class'`, `status = 'upcoming'`,
   `cohort_id = $cohort_id`, `lead_dog_id = $dog`, `location =
cohort.location`, `cancel_deadline_at = scheduled_at − 48h`,
   `notes = NULL`, `session_report_id = NULL`. The shared per-(cohort,
   dog) report does not exist at enrollment time; Day-19 staff "author
   report" verb creates the report row and back-links every weekly
   booking for the (cohort, dog) via `bookings.session_report_id`.

3. **Two new `ApiErrorCode` values (422, typed `details`).**
   - `cohort_full` — `cohort.filled + |dog_ids| > cohort.capacity`
     against the LOCKED cohort row. `details: { kind: 'cohort_full',
cohort_id, capacity, filled, requested }`.
   - `eligibility_missing` — at least one dog lacks any of the
     cohort's class's OR-prereqs (R7). `details: { kind:
  'eligibility_missing', gaps: { dog_id, missing_alternatives:
  GroupClassKey[] }[] }`.
     Both extend the Day-10 discriminated union by adding `kind` arms
     without changing existing arms (Day-10's amendment §3 explicitly
     reserved the union for this growth).

4. **Soft-expired cohort surfaces as 404 not_found** (no new code).
   The `lockCohort` primitive intentionally doesn't filter
   `live(cohorts)`; the route checks `expiredAt !== null` on the
   locked row and returns 404 (the cohort "doesn't exist" for
   enrollment purposes). Same response as an id that never existed;
   ids don't enumerate across soft-expire boundaries.

5. **Weekly cadence preserves Chicago wall time across DST.** New
   helper `src/lib/cohortSchedule.ts:computeCohortSessionDates`
   reads the cohort's `start_date` as Chicago wall parts (via new
   `chicagoWallPartsAt` paired with the Day-10 DST-fixed
   `chicagoWallTimeToUtc`), advances the calendar date by `k × 7`
   days, and recomposes. A cohort that meets "Tuesday at 6 PM" stays
   at 6 PM Chicago after spring-forward / fall-back. Pure UTC +
   `7×24h` would silently shift the wall clock by an hour twice a
   year. Wire shape unchanged — DST math is backend-internal.

6. **NO credit_ledger debit on enrollment.** Group-class is paid
   per-purchase (Day 14 Stripe charge), NOT per-credit;
   `credit_ledger.mode` enum is ('school', 'daycare') only.
   `bookings_payment_guarantee` trigger still fires (must have a live
   `payment_methods` row); the route pre-checks this above the
   trigger floor for the typical case.

**Amendment 2026-06-09 (group-class enrollment payments + per-dog withdraw).**
Day-11 left group-class enrollment free at the DB level (item 6 above:
"paid per-purchase later" stub). This wires the money model, per (cohort,
dog) so a single dog can be pulled + refunded independently.

1. **POST /enrollments body += payment.** Now `{ cohort_id, dog_ids,
payment_method_id: uuid, pay_later?: boolean }` (default pay-now). Amount
   is server-authoritative (`group_classes.price_per_dog_cents` per dog), never
   client-passed. **Pay-now:** one Stripe PaymentIntent confirmed per dog
   BEFORE the enroll txn (a declined card blocks enrollment), then a succeeded
   `charges` row per dog (`purpose='group-class'`, `cohort_id`+`dog_id`). **Pay-
   later:** a card-backed open `invoices` row per dog, `due_at = cohort_start −
24h` — the existing invoice auto-charge worker bills it then. Multi-dog
   pay-now = one PI per dog (per-dog refunds). Wire RESPONSE unchanged (still
   `BookingWire[]`).
2. **NEW `POST /enrollments/:cohortId/withdraw` `[auth, $]` — body
   `{ dog_id }`.** Returns 200 `{ withdrawn: true, refunded_cents: integer }`.
   Under the cohort lock: 409 `conflict` if the dog isn't enrolled or the first
   session has already started (self-serve withdraw closes at class start;
   staff can still cancel via the portal). Otherwise soft-cancels that dog's
   weekly bookings, decrements `cohorts.filled`, and settles money — VOIDs an
   unpaid pay-later invoice (`refunded_cents=0`, never charged) or REFUNDs a
   succeeded charge (`refunds` row at 'pending' + post-commit Stripe refund,
   mirroring the booking-cancel money-back branch).
3. **NEW `GET /enrollments` `[auth]`** → `Enrollment[]` (§B), the owner's
   current per-(cohort, dog) enrollments for the mobile "Currently enrolled"
   section. Owner-only.
4. **§A schema (additive).** `charges` += `cohort_id`/`dog_id` (nullable; set
   for a group-class enrollment charge) and `invoices` += `dog_id` (the pay-
   later twin; `cohort_id` already existed). The invoice→charge settlement
   (worker + manual pay) propagates both onto the charge so a withdraw after
   the auto-charge fires still finds + refunds the dog's payment. `credit_ledger`
   is untouched — group-class is money-paid, not credit-paid (item 6 holds).

**Amendment 2026-06-09 (group-class resources, completion-gated).** The
dog-profile Group page's "Resources" section moves from hardcoded link cards
to data. **NEW `class_resources`** table (§A, additive): per-class link cards
(`class_key` FK → `group_classes`, `title`, `subtitle?`, `deep_link_path`,
`position`, soft-expire), mirroring `class_prereq_options`. **The gate is
completion**, not a stored flag: a resource is shown only once the dog has a
live `dog_completed_classes` row for that `class_key` — the same R7 completion
source that gates prerequisites. No schema change to `dog_completed_classes`;
it already IS the gate. Read shape (when the endpoint lands): resources for a
dog = live `class_resources` WHERE `class_key` ∈ that dog's completed classes,
ordered by `(class_key, position)`. Gating granularity is **per-dog** (the
section lives on a per-dog page); an owner-level "any of my dogs completed it"
read would be a query change only, not a schema change. Endpoint + mobile
wiring are a follow-up — this amendment lands the table only.

**Amendment 2026-06-10 (boarding access — staff-granted, per dog).** Boarding
isn't offered to everyone. **NEW `dogs.boarding_enabled boolean NOT NULL DEFAULT
false`** (§A, additive). Surfaced on `DogWire.boarding_enabled` so owner-facing
clients hide boarding (the dog-profile boarding tile + the boarding booking-flow
dog picker) for dogs where it's false. It is **NOT** a server booking-gate
trigger like `evaluation_status` (no DB CHECK/trigger) and is **NOT** owner-
settable — deliberately absent from the owner `PATCH /dogs/:id` so owners can't
self-grant. Staff control it; the staff write path (a `[staff]` route) + the
staff-portal toggle are the paired follow-up. Default false = hidden until
granted; seed grants Waffles only.

**Amendment 2026-06-09 (private-lesson billing — charge AFTER, never before).**
Locked invariant, no code today: a private lesson is **never charged at
booking or staff-approval time** — the owner's card is charged only **after the
lesson happens**. There is no upfront private-lesson charge in the system now
(booking is request → staff-approve, no `charges` row; `charge_purpose` has no
`private-lesson` value, and private-lesson is not credit-backed — see
`lib/bookingMode.ts`), so this locks the rule before any billing path is built,
not a behavior change. When private-lesson billing IS implemented, the charge
must fire on a post-completion trigger (staff marks the lesson done → charge),
mirroring the "settle on completion" shape — not at intake. Cancelling an
upcoming lesson therefore never needs a refund (nothing was charged).

**Amendment 2026-05-23 (Day 12b — evaluation gate, 4th booking gate).**
Rachel (NWA Fayetteville staff) confirmed: board-and-train and boarding
also require an in-school evaluation before booking. The existing FE
prototype gates day-school/day-care at the picker via
`dog.evaluation_status` (`booking-flow/day-school.tsx` opens
`<EvaluationGateModal>` with the "Book free evaluation" CTA when a not-
passed dog is selected); B&T + boarding had no such gate. This
amendment promotes evaluation to a server-enforced 4th BOOKING GATE
alongside payment/vaccine/agreement (§H pattern), widens it to all four
gated categories (day-school, day-care, board-and-train, boarding), and
adds a typed error code. Register R1-R8 unchanged — integrity hardening,
not a contract-shape decision; freeze still holds.

1. **Gated categories.** `day-school`, `day-care`, `board-and-train`,
   `boarding`. The `evaluation` category itself bypasses the gate
   (chicken-and-egg — the booking that PASSES the eval can't require
   the eval to exist first). `group-class` and `private-lesson` do NOT
   gate (group classes have their own prereq system via R7;
   private-lesson is staff-curated).

2. **Schema floor (Day 12b — new trigger).** New BEFORE-INSERT trigger
   `bookings_eval_gate_check` on `bookings` (mirrors the
   payment/vaccine/agreement triggers' shape — `check_violation` raise
   with structured ERRCODE the API maps to a typed 422). Rejects when
   `category ∈ ('day-school','day-care','board-and-train','boarding')`
   AND the lead dog OR any `booking_dogs` dog has
   `dogs.evaluation_status <> 'passed'`. **Staff-owned dogs exempt**
   (uniform exemption — same ruling logged in §H for the other three
   gates; staff self-manage their own dogs' eval out of band). API
   pre-checks above the floor for the friendly typed error.

3. **New `ApiErrorCode` (422, joins the §A.5 Day-10 union):**
   `evaluation_required`. `details: { kind: 'evaluation_required',
missing: { dog_id, evaluation_status: 'not-evaluated' | 'pending'
| 'failed' }[] }`. The FE branches on `kind` to render the
   "Free evaluation needed" / "Evaluation in progress" / "Evaluation
   needs to be repeated" copy variants (the existing modal already
   distinguishes `'pending'` from `'not-evaluated'`; `'failed'` is a
   new copy variant — staff-mediated retry path).

4. **Gate priority order (updated):** payment → **evaluation** →
   vaccine → agreement. Evaluation is the dog-readiness floor before
   health/legal which assume the dog is approved to attend. Pre-Day-12b
   `details.kind` discriminator union is `payment_required |
vaccine_missing | agreement_unsigned | insufficient_credits |
insufficient_capacity`; Day-12b adds `evaluation_required` to the
   union (additive; existing routes unchanged on the wire).

5. **API surface (Day 12).** `POST /requests` for `board-and-train`
   and `boarding` pre-checks the lead dog's `evaluation_status` and
   returns `evaluation_required` at the request boundary — owners
   can't submit a B&T/boarding request for an un-evaluated dog (saves
   staff a round-trip; the staff portal's approve verb would have to
   bounce it back otherwise). `POST /bookings` (Day School/Care, Day 10) gains the same pre-check; the existing FE picker gate becomes
   the cosmetic layer above the typed-error fallback. The booking
   trigger remains the unbypassable floor in case any future endpoint
   forgets to pre-check.

6. **FE impact (scheduled Day 12b for prototype mock-wire; Day 18 for
   real API).** Two FE changes the next prototype-touching day owns:
   (a) **dog-profile program tile gate** — tapping a school /
   boardtrain / boarding tile on `app/dog-profile/[dogId]/index.tsx`
   when the dog's `evaluationStatus !== 'passed'` opens
   `<EvaluationGateModal>` (extracted from `booking-flow/day-school.tsx`
   for reuse) BEFORE navigation. Primary CTA `Book free evaluation` →
   `router.push('/booking-flow/evaluation?dogId=${dogId}')` (the same
   route already wired from the day-school picker and the home-page
   "needs eval" reminder); secondary `Maybe later` dismisses without
   navigating into the locked program. (b) **booking-flow picker
   parity** — `booking-flow/boardtrain.tsx` and
   `booking-flow/boarding.tsx` adopt the same `<DogSelectorRow>`
   `isLocked = dog.evaluationStatus !== 'passed'` treatment that
   day-school already uses, and the same modal opens on a locked tap.
   Component extraction: lift the inline `<EvaluationGateModal>` from
   `booking-flow/day-school.tsx` (lines ~270-355) into
   `mobile/src/components/EvaluationGateModal.tsx` per the rule-of-two
   (was 1 site, becomes 4: day-school picker, boardtrain picker,
   boarding picker, dog-profile program tile).

**Amendment 2026-05-24 (Day 12 — POST/PATCH/cancel /requests + approve/deny
portal verbs + rule-of-three extractions).** Day-12 opens the
request-and-approval surface (Model 3 in §C.1) — 5 endpoints, no new wire
shapes added (the §B `PendingRequest` shape was already pinned at Day 6a).
Register R1–R8 unchanged; freeze still holds.

1. **POST /requests body — pinned per-category.**
   `{ category: 'private-lesson' | 'board-and-train' | 'boarding', lead_dog_id,
additional_dog_ids?, preferred_dates: ISO[1..3], notes?:{per_dog?,joint?},
focus?:{staff_preference?,descriptor_keys?}, length_weeks? }`. Returns 201 +
   `PendingRequestWire`. Per-category invariants enforced server-side:
   - **board-and-train:** `additional_dog_ids` MUST be omitted (single-dog
     only per §C.1 Model 3); `length_weeks` REQUIRED.
   - **private-lesson + boarding:** `length_weeks` MUST be omitted (B&T-only
     field per §B).
   - All categories: dogs distinct (lead not in additionals); preferred_dates
     1-3 distinct ISO timestamps, future, within 92-day lookahead (matches
     POST /bookings + GET /availability caps).
     Idempotency-Key required. Empty-string scalars normalize to null at the
     trust boundary (omit-on-null wire round-trip).

2. **PATCH /requests/:id body — pinned partial-update shape.**
   `{ preferred_dates?, notes? | null, focus? | null, length_weeks? | null }`.
   Identity fields (category / lead_dog_id / additional_dog_ids) — 422
   `invalid_payload` if present (owner re-submits a new request if identity
   changes). `null` on a scalar means CLEAR; `undefined` means LEAVE
   UNCHANGED. State-machine guard: only `status='submitted'` is editable;
   converted/cancelled → 409 `conflict`. Preferred-dates replacement uses
   UPSERT-by-ordinal + leftover soft-expire (the schema's `(request_id,
ordinal)` PK is NOT partial-on-expired — surfaced + worked around at
   Day-12; a future hardening pass may amend the PK).

3. **POST /requests/:id/cancel — owner self-withdrawal.** Empty body.
   `status` → `'cancelled'`, `approved_by_staff_id` stays NULL (the actor
   discriminator distinguishing owner self-cancel from staff deny). Allowed
   from `'submitted'` AND `'approved-awaiting-payment'` (B&T pre-payment
   change of mind); `'converted'`/`'cancelled'` → 409 `conflict`.

4. **POST /staff/requests/:id/approve body — pinned per-category.**
   `{ scheduled_at?: ISO, pickup_at?: ISO, location?: location_key, notes? }`.
   Per-category requirements (validated against the LOCKED request row's
   category, not the body — body shape isn't known until the lock acquires):
   - **board-and-train:** body MAY be empty. NO booking inserted; status →
     `'approved-awaiting-payment'`; approved_at + approved_by_staff_id
     stamped. The Day-14 confirm-payment verb will create the booking + flip
     to `'converted'`.
   - **private-lesson:** `scheduled_at` + `location` REQUIRED. Status →
     `'converted'`; gate pre-check fires (payment → vaccine → agreement),
     booking inserted, `converted_booking_id` stamped, `'booking-confirmed'`
     notification enqueued with `deep_link_path: '/bookings/:id'`.
   - **boarding:** same as PL plus `pickup_at` REQUIRED (must be strictly
     after `scheduled_at`); post-insert UPDATE sets the booking's
     `dropoff_at` + `pickup_at` (schema CHECK constrains those columns to
     stay categories only).
     Returns 200 + the UPDATED `PendingRequestWire` (NOT the BookingWire — the
     created booking is a side effect; FE follows `converted_booking_id` if
     needed). Idempotency replay returns the same body byte-identically + does
     not double-insert. Concurrent approves on the same request serialize on
     the `pending_requests` row lock → exactly one 200, the rest 409 `conflict`.

5. **POST /staff/requests/:id/deny — staff portal denial.** Empty body
   (reason field reserved for future use). Status → `'cancelled'` with
   `approved_by_staff_id` stamped (the discriminator vs owner self-cancel).
   **Documented schema gap:** the `request_status` enum has no `'denied'`
   state; Day-12 maps to `'cancelled'` + actor-id rather than open the
   freeze. A future §A amendment OR Day-19 staff-portal pickup may add
   `'denied'` to the enum; FE branches on `approved_by_staff_id IS NOT NULL`
   to render "Denied by [staff]" vs "Cancelled by you" copy in the meantime.

6. **Rule-of-three extractions (Day-10 + Day-11 + Day-12 all reuse).** Two
   new pure helpers landed:
   - `src/lib/insertBookingWithGateMapping.ts` — the try/catch wrapper
     mapping trigger `check_violation` to typed `ApiError`. `routes/bookings.ts`
     - `routes/enrollments.ts` retrofitted to use it; `routes/staffRequests.ts`
       consumes it for PL/boarding approves.
   - `src/lib/bookingGatePreCheck.ts` — the `payment → vaccine
  (per-dog accumulate) → agreement` sequence above the trigger floor.
     Same retrofit. Day-12b's `evaluation_required` gate will slot in
     between payment and vaccine via a single-file edit when it lands.
     No new typed `ApiErrorCode` values added — `conflict` (409, Day-9b
     origin) covers all state-machine rejects (already-approved /
     already-converted / already-cancelled / edit-on-non-submitted).

7. **Repository extensions (additive, no wire impact).** `requestsRepository`
   gained 8 mutation methods + polymorphic-runner conversions on
   `findDogsByRequestIds` + `findPreferredDatesByRequestIds` so mutation
   routes read uncommitted writes via the tx. `notificationsRepository`
   gained `enqueue(tx, {ownerId, type, title, body, deepLinkPath, dogIds,
senderStaffId})` as the first write path (was read-only); generic shape
   ready for Day-13 (`'booking-cancelled'`) + Day-16 (scheduler-driven).

**Amendment 2026-05-25 (Day 12b1 — evaluation gate backend ship; spec
already pinned at Amendment 2026-05-23).** Day-12b1 lands the 4th BOOKING
GATE end-to-end on the backend: schema trigger, typed error code, gate
pre-check helper update, and the lead-only request-boundary pre-check.
No wire-shape surprises — every shape was already pinned in the Day-12b
spec amendment above. Register R1–R8 unchanged; freeze still holds. FE
deltas remain pending as **Day 12b2** (Claude-owned next thread).

1. **Schema (`schema.sql`):** new `assert_dog_evaluation_passed()`
   function + `bookings_eval_gate_check` BEFORE-INSERT trigger on
   `bookings`. Mirrors the existing payment/vaccine/agreement triggers
   exactly: LEAD-dog floor, staff-owned dogs exempt (uniform-exemption
   policy per §H), `RAISE EXCEPTION` with structured prefix
   `'evaluation gate:'` + `ERRCODE = 'check_violation'`. The
   `'evaluation'` category bypasses by construction (chicken-and-egg);
   only `day-school`, `day-care`, `board-and-train`, `boarding` are
   gated. BOOKING GATES transaction-contract comment block renumbered
   to 4 floors with priority-order narration
   (`payment → evaluation → vaccine → agreement`).

2. **Typed error code (`src/lib/errors.ts`):** `ApiErrorCode` union
   gains `'evaluation_required'` (422). Additive to the Day-10
   gate-error family.

3. **Typed details (`src/lib/bookingErrors.ts`):**
   `EvaluationGap = { dog_id, evaluation_status }` joins the
   discriminated `details` union as
   `{ kind: 'evaluation_required', missing: EvaluationGap[] }`.
   `UnpassedEvaluationStatus = 'not-evaluated' | 'pending' | 'failed'`
   narrows the gap by construction (`'passed'` is excluded).
   `evaluationRequiredError(missing)` is the public constructor.
   `gateTriggerErrorToApiError` extends with the
   `text.startsWith('evaluation gate:')` branch (race-window fallback).

4. **Gate priority order (`src/lib/bookingGatePreCheck.ts`):**
   `payment → evaluation → vaccine → agreement`. The eval gate slots
   between payment and vaccine; only fires when
   `category ∈ EVAL_GATED_CATEGORIES` (the same set the trigger
   predicate uses). `private-lesson` + `group-class` + `'evaluation'`
   skip by category whitelist. Per-dog accumulate via
   `dogsRepository.findEvaluationStatusInTx(tx, dogIds)` so a multi-dog
   booking_dogs surface yields the complete picture in one round-trip
   (same shape as the vaccine gate's per-dog accumulate).

5. **Request boundary (`src/routes/requests.ts`):** `POST /requests`
   for `category ∈ ('board-and-train','boarding')` adds a LEAD-only
   eval pre-check between the ownership gate (step 2) and the
   `requestsRepository.create` (step 4). Per §A Amendment 2026-05-23
   step 5. PL bypasses at this boundary (staff-curated); additional
   boarding dogs are caught at staff approve time via the shared
   `checkBookingGates` helper.

6. **Repository extension (`dogsRepository.findEvaluationStatusInTx`).**
   Batched lookup with polymorphic-runner shape (Day-9c precedent);
   returns `{dogId, evaluationStatus}[]` for live dogs in the input
   set.

7. **Fixture + snapshot adjustments.** Lola's
   `evaluationStatus` bumped from `'not-evaluated'` → `'passed'` in
   `_fixture.ts` so the existing booking2 (Lola lead, day-care) +
   booking5 (Lola lead, boarding) seed cleanly under the new trigger.
   Tests that need a non-passed dog flip her per-test with
   finally-restore. `snapshots/dogs.json` updated to match (now emits
   `evaluation_date` for Lola — additive).

8. **Test coverage (`test/contracts/evaluation-gate.test.ts`).** 13
   new contract tests cover: pre-check at POST /bookings (single-dog
   - multi-dog accumulation), pre-check at POST /requests (B&T +
     boarding), POST /staff/requests/:id/approve race for boarding;
     bypass arms for PL submit + PL approve + group-class enrollment;
     schema trigger floor (direct INSERT day-school + un-passed →
     `'evaluation gate:'` check_violation, 'evaluation' category
     bypass, staff-owned dog bypass); gate priority (payment beats
     eval); unit test for `gateTriggerErrorToApiError` mapping.
     **445/445 total tests green** (432 prior + 13 new).

**Amendment 2026-07-14 (Shanthi rulings via text — 3-month re-evaluation
staleness gate, puppy-class vaccine exemption, spay/neuter profile field).
BUILT same day — see the "AS BUILT" block at the end of this amendment for
the resolved decisions + wire deltas; owner-authoritative (validation model:
Shanthi's domain corrections are the source of truth).**

Context: Allison asked whether every enrollment request should be staff-
approved, or only privates / B&T / boarding (today's request-approve set).
Shanthi's first answer was "each reservation type," but her stated REASON
was catching dogs "without a previous evaluation or an evaluation that
happened too long ago." Allison counter-proposed automating exactly that
gap — force staff approval only when the dog hasn't been in recently —
and Shanthi accepted it as the mechanism: "That would absolutely work but
make it 3 months if you can. We require pups to be reevaluated if we
haven't seen them in over 3 months unless they're super alumni. I think
that's perfect." Three rulings fall out:

1. **3-month staleness gate (new booking rule; replaces the blanket
   approve-everything idea).** A dog NWA hasn't seen in over **3 months**
   must go through staff approval (re-evaluation semantics) before an
   otherwise-instant booking confirms; fresh dogs keep instant booking.
   **Alumni are exempt** — Shanthi's "super alumni" maps onto the §J.3
   derived alumni (5 live `dog_completed_programs` rows), the same
   population whose credits never expire. Open decisions to pin at build
   time: (a) "seen" should mean the dog's last ATTENDED visit (any
   category), not last booking created — attendance rows / completed
   bookings are the signal; (b) mechanism — either divert day-school /
   day-care into the existing pending-request lane when stale, or a typed
   422 (`reevaluation_required`, §H-style) with a staff override; the
   request-lane divert matches Shanthi's mental model ("force that to get
   approved"); (c) B&T / boarding / private already pass through staff
   approval — no second gate needed there, but the staff queue should
   surface a "last seen {date} / needs re-eval" badge so approvers see
   staleness without checking Gingr-style history by hand.

2. **Puppy-class vaccine exemption.** "We don't require full vaccines for
   puppy classes since they won't have their rabies yet." Today's vaccine
   gate is per-CATEGORY (`required_vaccines.gates_categories
   service_category[]`), but puppy is a CLASS KEY (`'puppy'`) inside
   `group-class` — finer granularity than the catalog can express. Build
   options when `required_vaccines` gets seeded for real: an
   `exempt_class_keys text[]` column on `required_vaccines`, or class-key
   scoping for the group-class arm of the gate. Dev seed currently ships
   zero `required_vaccines` rows (gate vacuous), so nothing regresses
   before this is designed.

3. **Spay/neuter is a PROFILE QUESTION, not a gate.** Required by policy
   after age 1, with explicit exceptions for dogs that need to reach a
   target weight first — and Shanthi ruled it must NOT block
   reservations: "just something they should answer in their profiles."
   Build: a spay/neuter status field on `dogs` + the Dog wire + the one
   shared `<DogForm>` (all three FE surfaces inherit it). Three states,
   not a boolean (the weight-wait exception is a real state). No trigger,
   no gate arm, ever — re-confirm with Shanthi before anyone promotes it.

**AS BUILT (same day; Allison rulings resolved the open decisions —
api 825/825, mobile jest 260/260):**

- **Mechanism = server-side divert into the pending-request lane** (Allison:
  "we want them to approve the pending request"). `POST /bookings` runs
  `lib/bookingApprovalDivert.resolveApprovalDivert` after the ownership gate;
  any reason ⇒ gates + PAYG card/rate are still validated (staff never
  approve into a guaranteed bounce), then a `pending_requests` row is created
  (status `submitted`) and the route answers **202 `DivertedBookingWire`**
  `{ diverted: true, divert_reasons, request }`. 201 `BookingWire[]` is
  unchanged for fresh dogs. Duplicate open request per (dog, category) →
  the existing 422 `already_requested`; the divert branch runs under the
  same (dog, mode) advisory locks as the booking core, so two concurrent
  submissions for the same dog can't race the duplicate guard into two
  open requests (Δ same day, test-verified).
- **"Seen" = last ATTENDED day-school / day-care session ONLY** (Allison
  narrowed it: group classes and private lessons do NOT reset the 3-month
  clock; `booking_dogs.attendance = 'attended'` is the signal). A dog with
  no attended day program EVER is stale — its first booking gets staff eyes.
  Approval alone does NOT freshen; attending the approved session does
  (staff attendance verb writes the row the rule reads). Alumni exempt
  (§J.3 derived); staff-owned dogs exempt (uniform gate exemption). This is
  a WORKFLOW rule, deliberately NOT a trigger floor — staff paths (approve
  conversion, staff on-behalf booking) are the legitimate override.
- **Intact divert (Allison extension):** `dogs.spayed_neutered = FALSE`
  diverts too — even a too-young intact dog ("that is ok but should still
  go automatically into pending request"). NULL (unanswered — every
  pre-existing dog) never diverts. Reasons: `'reevaluation-stale'` |
  `'not-spayed-neutered'`, both possible on one request.
- **Approve conversion:** `POST /staff/requests/:id/approve` gained a
  day-program arm — no body fields; the request carries location / payment
  ('credits' | 'payg' + payment_method_id) / exact session instants
  (`pending_request_preferred_dates`), and the conversion runs the SAME
  creation core as the direct path (`lib/createDayProgramBookings.ts`,
  extracted from POST /bookings): gates, credit debits or PAYG open
  invoice, capacity, overlap guard, reminders, then `markConverted`
  (first booking id) + a `booking-confirmed` notification. A bounce
  (credits spent meanwhile / capacity gone) is a typed 422 to the portal;
  the request stays `submitted`.
- **Schema:** `dogs.spayed_neutered boolean` + `dogs.spay_neuter_planned_on
  date` (+ CHECK planned⇒not-true); `pending_requests.location / payment /
  payment_method_id / divert_reasons`; `required_vaccines.exempt_class_keys
  group_class_key[]` + the vaccine trigger's group-class exemption clause;
  `notification_type` += `'spay-neuter-reminder'`. Applied to both local DBs.
- **Wire:** `PendingRequestWire` += optional `location` / `payment` /
  `divert_reasons` (omit-on-null — classic requests byte-identical);
  `DogWire` += optional `spayed_neutered` / `spay_neuter_planned_on`;
  new `DivertedBookingWire`.
- **Spay/neuter surface:** POST/PATCH `/dogs` accept the pair (planned date
  requires an explicit `spayed_neutered: false` in the same body — 422
  otherwise; answering "fixed" auto-clears the date). A planned date
  schedules a `spay-neuter-reminder` push for 9:00 AM Chicago that day
  (`lib/enqueueSpayNeuterReminder.ts`; dedupe `spay-neuter:<dogId>:<date>`,
  cancelled + re-enqueued/revived when the date moves or the answer flips).
- **Vaccine exemption:** trigger + `dogVaccinesRepository.findMissingForCategory`
  both honor `exempt_class_keys` (enrollments thread the cohort's class key
  through `checkBookingGates.groupClassKey`). Rabies-for-puppy is DATA, not
  code — staff seed it when `required_vaccines` gets populated for real.
- **Seed / fixture:** dev seed + contract fixture now plant recently-ATTENDED
  day programs per dog (staleness anchors) and `spayed_neutered: true` on
  seed dogs — without them every demo/test booking would divert. Seed also
  STOPPED planting fake `cus_seed_*` stripe_customers (they 500'd the
  add-card flow; the route lazily provisions real test-mode customers).
- **FE:** ~~minimal this round: the 202 rides the gate lane into a
  `<BookingGateModal>` "Sent to the school for approval" arm~~ **(SUPERSEDED
  — full pending-approval phase BUILT 2026-07-16 later round.** The flow now
  catches `BookingDivertedToApprovalError` BEFORE gate parsing and enters a
  first-class `'diverted'` phase (`SentRequestView`, navy/gold by mode,
  mixed-outcome aware: "your other N sessions are booked"); the
  `approval_pending` gate arm was deleted. Mobile now CONSUMES the wire's
  optional `location` / `payment` / `divert_reasons` (`PendingRequest`
  domain fields) and the 202 body's `request.id`. New read-only detail
  route `/request-detail/day-program` (reasons card, session list,
  location/payment meta, owner withdraw via POST /requests/:id/cancel);
  pending filter chips grew day-school/day-care; new `/bookings/[id]`
  route ALIASES the API's notification `deep_link_path` convention onto
  the Bookings tab's `openBooking` quick-info lane — previously every
  real-mode booking-confirmed/reminder/cancel tap dead-ended unmatched.)
  Still open FE work: ~~the DogForm spay/neuter question + planned-date
  input~~ (BUILT 2026-07-16: the form question already existed —
  `FixedChipRow` — and is now WIRED end-to-end on the manage path: `Dog` +
  `RawDog` + `DogPatch` carry the pair, `fixedFromDog`/`spayPatchFrom` are
  the two mapping directions, jest-covered; the SIGNUP path still persists
  nothing — that's go-live blocker #5, POST /dogs unwired, and the form
  values are ready for it), and the portal queue's divert-reason badge
  (other repo).
- **Tests:** `booking-approval-divert.test.ts` (17) — divert/instant/alumni/
  intact/both-reasons/dup-guard, approve conversion incl. PAYG + the full
  divert→approve→attend→instant loop, bounce-stays-submitted (credits spent /
  capacity filled / same-day overlap created between divert and approval —
  each a typed 422, request stays `submitted`), the concurrent double-submit
  race (exactly one open request), trigger-level vaccine exemption, spay
  wire + reminder lifecycle (move/fixed/revive). `credit-purchase.test.ts`
  gained quantity edges: declined/unactioned card ⇒ zero credits, no lot;
  same-key replay ⇒ one charge + one lot (Stripe re-called by design under
  the same idempotency key).

**Amendment 2026-07-16 (Allison rulings via selector round — §J.1 membership
edge cases). BUILT same day — verified finals api 844/844, mobile jest
269/269 (full suite, post-merge with the same-day sim-feedback round).**

1. **Roll-while-parked: an unpaid month FREEZES the subscription instead of
   stacking debt.** The roll scan (`membershipsRepository.lockDueForRoll`)
   now skips any membership with an OPEN invoice — mid-dunning or parked
   (`next_attempt_at IS NULL`) — so month N+1 never opens while month N is
   unpaid. Auto-resume is settlement itself: paying the invoice clears the
   skip, and a LATE settle (billed period already over — the same predicate
   as the grant's late-settle floor) also re-aligns the membership clock
   onto the freshly-granted floor month (`alignPeriodAfterLateSettle`:
   current period ← [settle-now, now + 1 clamped month), `ends_at` shifted
   by the same delta) so the frozen gap is NEVER catch-up-billed. The align
   verb self-filters to active + un-paused — a completed/canceled clock
   stays frozen (the grant still lands; the owner paid), a staff-paused one
   belongs to resume's gap-shift. Term exhaustion stays COUNT-based and
   therefore exact through any park. Known edge (documented in the roll):
   no staff verb VOIDS a membership invoice today; if one lands it must
   re-align the clock the same way. Tests:
   `membership-roll-parked.test.ts` (2, composed scheduler ticks:
   freeze → late pay → aligned resume → count-exact hard stop; canceled
   clock never moves).

2. **Membership uniqueness: one ACTIVE membership per (dog, mode).**
   Allison: "a dog could have a membership for day school and a membership
   for daycare, but they can't have 2 memberships for day school" —
   MODE-keyed, not package-keyed (a second same-mode package 409s too).
   Three layers: (a) POST /memberships pre-Stripe probe → 409 `conflict`
   before any money moves; (b) in-tx re-check under the new
   `membership:<dogId>:<mode>` advisory lock (`withMembershipCreateLock`) —
   a concurrent subscribe that won during THIS request's Stripe round-trip
   makes this charge a duplicate: recorded, pending-refunded in-tx,
   Stripe-refunded post-commit (settle-lost-race pattern), response 201
   carrying the WINNER's membership + the new wire field
   `MembershipCreateWire.charge_refunded: true` (with `credits_granted: 0`);
   (c) DDL floor: partial unique index
   `memberships_one_active_per_dog_mode ON memberships (dog_id, mode)
   WHERE status = 'active'` (schema.sql §J block; applied to both local
   DBs after a duplicate-active pre-clean — 0 rows needed it). PAUSED
   memberships still block (status stays 'active'); canceled/completed
   free the slot. FE: the CreditsSheet subscription step disables
   "Subscribe monthly" with an explanatory note when the dog already holds
   an active same-mode membership (reads the shared memberships query; the
   409 backstops a stale cache). Tests: `membership-uniqueness.test.ts`
   (6, incl. a deterministic lost-race simulation via a stripe-stub side
   effect, and the index floor).

3. **Dual-location subscribe: SKIPPED (deliberate §J.1 deviation).** The
   strict §J.1 reading ("every package the picker offers") would put a
   subscription option on DualLocationBody; Allison ruled it off — the
   single-location flow and the Dog Profile buy path cover subscribing,
   and a membership is per-dog, not per-booking. Revisit only if a real
   owner asks.

4. **Same-day small rounds:** (a) `GET /dogs/:id/credits` wire +=
   `warning_lead_days` (required) — the resolved per-location staff-tuned
   lead, so the app's "expiring soon" chip (`CreditBalanceCard`) warns in
   lockstep with the credits-expiring push (closes the "no client consumer"
   note; mobile falls back to its 60-day default in mock mode; snapshots
   updated). (b) FE idempotency hardening: `useIdempotencyKeySeries`
   (signature-keyed attempt-series) now keys the CreditsSheet one-time
   purchase, the §J subscribe (replacing the sheet-open ref, which 422'd a
   retry whose inputs had changed), and DualLocationBody's per-location
   loop — where a fresh key per tap could double-charge an already-bought
   location on retry. (c) Spay/neuter FE wiring — see the struck-through
   note in the 2026-07-14 AS-BUILT above.

**Amendment 2026-07-16 (sim-feedback round — subscription-credits-first
debit, private-lesson `lesson_setting`, private trainer preference goes
live). BUILT same day — api 844/844, mobile jest 269/269.**

1. **Debit ordering: subscription credits spend FIRST (Allison ruling).**
   `creditLedgerRepository.findNextDebitLot` (new; `debitForBooking` now
   uses it instead of taking `findLiveExpiringLots`' first row):
   `membership-grant` lots before everything — soonest-expiry first within
   the bucket, an alumni NULL-expiry membership lot after that dog's
   expiring ones but still ahead of every purchase lot — then other live
   lots soonest-expiry first, never-expiring pool last; `created_at ASC`
   breaks ties. Supersedes pure expiry-order (under which a
   near-expiry purchase lot beat a fresh membership grant, and an alumni
   dog's membership credits were spent LAST). `findLiveExpiringLots` is
   unchanged and still feeds the `GET /credits` expiring-lots display +
   warning scan — NULL-expiry membership lots deliberately don't surface
   as "expiring". Known tradeoff (flagged to Allison): a purchased lot can
   now expire while subscription credits burn first. Tests: 2 new in
   `credit-expiry-lots.test.ts`.

2. **`lesson_setting` — where a private lesson happens ('home' | 'public').**
   New enum + nullable column on BOTH `pending_requests` and `bookings`
   (private-lesson only; NULL elsewhere; guarded 422 on other categories at
   POST and PATCH). Owner picks at request time (required by the FE's
   submit gate); the staff approve conversion copies it request → booking;
   `PendingRequestWire` + `BookingWire` gain omit-on-null `lesson_setting`.
   The bookings card labels it "At your home" / "Public spot" — and now
   also labels day-school / day-care / group-class cards with the school
   (`location` was already on the wire for every booking; the FE finally
   consumes it). Seed: Lola's lesson `'home'`, Waffles' pending request
   `'public'`. Tests: 2 new in `requests-mutations.test.ts`. Staff-portal
   display of the setting in the approve queue is the known-open half
   (other repo).

3. **Private-lesson trainer preference is now user-facing.** No contract
   change — `pending_requests.staff_preference` / `focus.staff_preference`
   existed end-to-end since R8 but the private FE never populated it. The
   private intake now carries the B&T `StaffPickerRow` ("First available" +
   the five trainers) and resubmit preserves the tag instead of silently
   dropping it.
invoice + dunning surface lands).** Day-15 ships the async-settlement
half Day-14 staged: a signed `POST /webhooks/stripe` receiver that
reconciles charges/refunds/payment-methods on terminal Stripe events,
a `POST /invoices/:id/pay` settlement endpoint, an invoice auto-charge
worker with backoff, and `POST /requests/:id/confirm-payment` (B&T
pay-now or pay-later). One additive schema amendment; the rest is
endpoint shape + repo extensions.

1. **Schema (`schema.sql`):** new `stripe_events` table — webhook
   dedupe ledger keyed on Stripe's `event.id` (`evt_*`). PK + two
   indexes (`(event_type, received_at DESC)` for ops queries;
   partial on `processed_at IS NULL` for the unprocessed-watch).
   Permanent (no soft-expire / TTL — audit history is the point).
   Distinct from `idempotency_keys` (owner/endpoint-scoped, TTL-swept,
   has `request_hash` — none of those semantics fit webhook events).
   Tables 47 → 48.

2. **Receiver dedupe lifecycle.** `stripeEventsRepository.claim(eventId,
eventType)` inserts on-conflict-do-nothing; returns `'claimed'` or
   `'duplicate'`. On `'claimed'`, handler runs in `withActor('system:
stripe-webhook', tx)` (Day-2 system-actor precedent). Success →
   `markProcessed` (stamp `processed_at`). Failure → `release` (DELETE
   so Stripe's retry re-enters dispatch). Process crash leaves row at
   `processed_at IS NULL` — admin replay surface lands Day-19 / Day-20.

3. **Narrow `StripeWebhookEvent` type (`src/lib/stripe.ts`).** Five
   arms: `payment_intent.succeeded` / `payment_intent.payment_failed` /
   `setup_intent.succeeded` / `charge.refund.updated` / `unhandled`.
   The seam's `constructWebhookEvent` returns this narrow union;
   `projectStripeEvent` does the wide→narrow projection. Insulates
   app code from Stripe's `Stripe.Event` SDK type — the dispatch loop
   never imports Stripe types directly. The `unhandled` arm carries
   `rawType` for logging; future event types arrive as new arms
   without breaking the receiver.

4. **`POST /invoices/:id/pay` `[auth, $]`.** Owner pays an open invoice
   via the bound `payment_method_id`. Shape mirrors Day-14 credit-
   purchase: pre-validate (404 / 409) → pre-tx Stripe call (idempotency-
   keyed) → `withMutation` INSERT charges + `invoices.markPaid` (atomic
   `paid_charge_id` + `paid_at` flip). Returns `{ charge_id,
charge_status, stripe_payment_intent_id, client_secret,
invoice_status }`. 3DS / requires_action: charges at 'requires_payment',
   invoice stays 'open' (known caveat — no `charges.invoice_id` link
   today so the webhook can't re-settle the invoice; next attempt
   completes).

5. **`POST /requests/:id/confirm-payment` `[auth, $]`.** B&T conversion
   verb. Body: `{ payment_method_id, scheduled_at, dropoff_at,
pickup_at, location, notes?, pay_later?, due_at? }`. Pay-now
   branch: Stripe call → INSERT charges + `insertBookingWithGateMapping`
   (B&T category) + stamp `dropoff_at`/`pickup_at` + `markConverted`
   - `notifications.enqueue` (booking-confirmed). Pay-later branch:
     same booking insert + `invoicesRepository.createOpen` (status='open',
     `payment_method_id` required by §G card-backing invariant) +
     `markConverted`. **Server-side B&T price authority** in
     `lib/boardTrainPricing.ts` (currently single SKU: 2-week = $2,000).
     The FE NEVER passes the amount — anti-scam parity with §G ("payment
     guarantee").

6. **Invoice auto-charge worker (`src/workers/invoiceAutoCharge.ts`).**
   `runInvoiceAutoChargeOnce(opts)` claims a due batch via
   `invoicesRepository.lockDueOpenForUpdate` (`FOR UPDATE SKIP LOCKED`).
   Per-invoice: Stripe `paymentIntents.create+confirm` (idempotency-
   keyed on `auto-charge:{invoice.id}:{attempts}` so a retry of THIS
   attempt re-uses Stripe's PI; a fresh attempt mints new). Succeeded →
   `markPaid`. Failed / async → `recordFailedAttempt(nextAttemptAt =
now()+backoff(attempts))`. **Backoff schedule**: 1m / 1h / 24h / 72h
   then park (`nextAttemptAt = null`); `MAX_AUTO_CHARGE_ATTEMPTS = 4`.
   Day-16 wires the scheduler trigger; today the function is one-shot
   (CLI / test hook).

7. **`peekCompletedIdempotency` helper (`src/db/idempotency.ts`).**
   New pool-level peek for completed idempotency records. The
   state-mutating-route pattern: routes whose pre-validation checks a
   field the mutation writes (invoice.status open → paid) call this
   FIRST and replay on hit. Without it, a legitimate replay would 409
   on the post-mutation pre-validation before `withIdempotency` could
   replay the original 201. Throws `idempotency_mismatch` 422 on key
   collision with a different body — same boundary semantic as
   `withIdempotency`'s mismatch path.

8. **Day-14 latent gap closed.** Cancel-route postCommit now also
   persists `stripe_refund_id` on the refunds row after Stripe returns
   (`refundsRepository.markStripeId`), so the `charge.refund.updated`
   webhook matches by id deterministically. Race-recovery fallback
   exists (`findUnmatchedPendingForCharge` matches by `(charge_id,
amount, status='pending', stripe_refund_id IS NULL)`) for the rare
   webhook-arrives-before-postCommit window.

9. **`stripeCustomersRepository.findByStripeCustomerId`** — reverse
   lookup (Stripe `cus_*` → our owner_id) used by `setup_intent.
succeeded` handler to find which owner the new card belongs to.
   Polymorphic-runner shape (Tx | typeof db).

10. **Test coverage (`test/contracts/`).** 25 new contract tests
    bringing the suite to **520/520 green** (495 prior + 25):
    `stripe-webhook.test.ts` (12: signature 400 / duplicate dedupe /
    succeeded flip + ledger write / idempotent re-process / failed
    flip / setup_intent first-card default / setup_intent idempotent
    skip / refund cumulative flip / refund race-recovery /
    not-yet-recorded fallback / unhandled noop),
    `invoice-pay.test.ts` (6: succeeded + paid / requires_action +
    stays open / 404 / 409 / 403 / replay idempotent),
    `invoice-auto-charge-worker.test.ts` (4: succeeded marks paid /
    soft-expired pm parks / scheduleNextAttempt parks at MAX /
    empty queue), `request-confirm-payment.test.ts` (5: pay-now charges
    - booking + converted / pay-later invoice + booking + converted /
      wrong state 409 / staff 403 / unknown 404). **Live Stripe CLI smoke**
      against test-mode passed end-to-end for all 4 trigger families;
      signature verifier + dispatch round-trip proven.

**Amendment 2026-05-26 (Day 16 — `notification_type` enum extension;
scheduler worker + booking-reminder triggers land).** Day-16 ships the
outbound notification surface the Day-15 invoice worker shares cadence
with: an exactly-once `scheduled_notifications` claim/dispatch worker,
booking-reminder + boarding-profile-check triggers wired into all four
booking-creation paths, and the `idempotency_keys` TTL sweep that was
deferred from Day-3a. One additive enum amendment; otherwise endpoint
shape + repo extensions + a new signed HTTP entrypoint.

1. **Schema (`schema.sql`):** `notification_type` enum extended with
   `'booking-reminder'` and `'boarding-profile-check'`. Both the
   delivered feed (`notifications.type`) and the outbound queue
   (`scheduled_notifications.type`) use the same enum — adding the
   arms here lets the FE render a reminder distinctly from a fresh
   confirmation without inferring intent from the title. Additive
   only; tables count unchanged (48).

2. **Scheduler worker (`src/workers/scheduler.ts`).**
   `runSchedulerTickOnce(opts) → SchedulerTickResult` composes three
   phases under `withActor('system:scheduler', tx)`: (a)
   `scheduled_notifications` claim + INSERT `notifications` +
   markSent with `emitted_notification_id` link; (b) compose
   `runInvoiceAutoChargeOnce` (Day-15) so one cron firing handles
   both outbound notifications AND invoice dunning; (c)
   `sweepExpiredIdempotencyKeys` (24h cutoff). Push attempts happen
   post-commit, best-effort — DB is source of truth; transport
   failures are logged-and-swallowed, in-app feed entry still lands.

3. **`scheduled_notifications` claim shape.** `FOR UPDATE SKIP LOCKED`
   on `(status='pending', scheduled_for <= now())` so concurrent
   ticks divide the queue without blocking. `dedupe_key UNIQUE`
   makes re-enqueue idempotent — an Idempotency-Key replay of a
   booking-creation tx ON CONFLICT DO NOTHING's the schedule rows.

4. **`Booking → schedule rows` trigger (`src/lib/enqueueBookingReminders.ts`).**
   Called from all 4 booking-creation paths (`routes/bookings.ts`
   day-program, `routes/enrollments.ts` cohort,
   `routes/staffRequests.ts` approve PL+boarding,
   `routes/requestConfirmPayment.ts` B&T conversion) AFTER the
   booking row + any time-stamping completes. Two enqueues, both
   in-tx with the booking insert (rolls back together on any later
   failure):
   - `booking-reminder:<bookingId>` — always, at `scheduledAt - 24h`,
     type `'booking-reminder'`. Uniform window across all 7
     categories for v1.
   - `boarding-24h:<bookingId>` — only for `'boarding'` /
     `'board-and-train'`, at `(dropoffAt ?? scheduledAt) - 24h`,
     type `'boarding-profile-check'`. Surfaces a pre-stay reminder
     for the boarding intake paperwork (vaccines, feeding, meds).
     Past-due `scheduled_for` is accepted — booking placed <24h ahead
     gets the reminder near-immediately (doubles as confirmation; the
     distinct type differentiates it from `'booking-confirmed'`).

5. **Expo push seam (`src/lib/expoPush.ts`).** `ExpoPushClient`
   interface mirrors `StripeClient` (Day-14). `defaultExpoPushClient`
   POSTs `https://exp.host/--/api/v2/push/send`; the `_expoPushStub`
   contract-test impl records calls without network. Owner with
   zero registered devices still gets the in-app feed entry —
   push is a channel, not the notification itself. Day-18 FE
   ships the device-token registration verbs (Day-16 read side
   only).

6. **`POST /workers/tick` `[public, signed]`.** Production trigger
   entrypoint for pg_cron + pg_net. Auth via constant-time bearer
   compare against `SCHEDULER_WEBHOOK_SECRET` env. Calls
   `runSchedulerTickOnce`, returns the tick result. No body
   parsing (heartbeat). Injectable `runTick` opt for test
   isolation. Operational SQL for the recurring trigger lives in
   IMPLEMENTATION.md Day-16 (NOT in `schema.sql` — pg_cron +
   pg_net extensions are prod-only ops; contract tests call the
   worker function directly).

7. **`idempotency_keys` TTL sweep (`src/db/idempotency.ts`).**
   `sweepExpiredIdempotencyKeys({olderThan})` deletes rows
   older than the retry-safety window (24h default). Composed
   into the scheduler tick; failure is logged-and-swallowed (next
   tick retries). Honors the schema's "ONE table EXEMPT from
   never-delete" carve-out (schema.sql lines ~918-920).

8. **New repositories.** `scheduledNotificationsRepository` (claim
   due / markSent / enqueue idempotent / findByDedupeKey /
   countDuePending — polymorphic runner). `deviceTokensRepository`
   (findLiveByOwner — Day-16 ships read side only; write
   verbs at Day-18). All polymorphic-runner-consistent.

9. **Worker actor `system:scheduler`.** Distinct from Day-15's
   `system:stripe-webhook` so the audit log can disambiguate
   "Stripe webhook reconciled this" from "scheduler tick delivered
   this." `withActor` accepts arbitrary strings — the
   non-user-actor pattern is now at 2 sites (this + Day-15
   webhook + the Day-15 invoice worker which reuses
   `system:stripe-webhook`).

10. **Test coverage (`test/contracts/`).** 18 new tests bringing
    the suite to **538/538 green** (520 prior + 18):
    `scheduler-worker.test.ts` (13: empty queue / single due flips
    - INSERTs notification + dispatches push / multi-row + multi-
      device fan-out / future-dated skip / push transport failure
      DB still settled / per-ticket error counted / dedupe_key
      UNIQUE no-op / non-boarding enqueues 1 row / boarding
      enqueues 2 with dropoff anchor / TTL sweep precision /
      invoice composition / SKIP LOCKED race exactly-once / cutoff
      filter), `workers-tick.test.ts` (4: valid bearer 200 / missing
      auth 401 / non-Bearer 401 / wrong secret 401), and one direct
      sweep-helper test. **Live `/workers/tick` smoke** against the
      dev API returned `{scheduled:0, invoices:0, swept:0}` (200);
      missing-bearer + wrong-bearer both 401 with the typed
      `unauthenticated` error code.

**Amendment 2026-06-20 (credit-expiry Phase 3 — money-adjacent notifications
+ parked-invoice staff surface).** Wires the three deferred money feed arms
onto existing infra: the invoice auto-charge worker now emits receipts +
failure notices, a new scheduled scan warns owners of soon-to-expire credit
lots, and staff get a parked-invoice worklist. Additive only — one enum
amendment, no table changes, no existing wire shape changes.

1. **Schema (`schema.sql`):** `notification_type` enum extended with three
   arms: `'credits-expiring'`, `'payment-failed'`, `'payment-succeeded'`. Both
   the delivered feed (`notifications.type`) and the outbound queue
   (`scheduled_notifications.type`) share the enum. `credits-expiring` and
   `payment-failed` flow through the scheduled queue (feed + push);
   `payment-succeeded` is written straight to the feed by the worker (a receipt,
   feed-only). Additive only; tables count unchanged. The introspect round-trip
   regenerates the enum verbatim — no fix-script rule (a pure DB enum, not a
   local brand).

2. **Auto-charge notifications (`src/workers/invoiceAutoCharge.ts`).** The
   worker's status-flip txns now also emit the owner-facing receipt/failure:
   - **SUCCEEDED auto-charge** → `payment-succeeded` ("We charged your card
     $X for your {purpose label}."), INSERTed inside the SAME tx as the
     `charges` row + `markPaid`, so a rolled-back charge never leaves a
     phantom receipt.
   - **PARKED invoice** (terminal at `MAX_AUTO_CHARGE_ATTEMPTS`, or a
     missing/expired card/customer — both record `next_attempt_at = NULL`) →
     `payment-failed` ("We couldn't process your payment of $X for your
     {purpose label}. Please update your card."). A parked invoice is ACTION-
     REQUIRED (the owner must fix their card), so it routes through the PUSH
     channel: `recordFailed` enqueues a `scheduled_notifications` row
     (`type='payment-failed'`, `trigger='payment-failed'`, `scheduled_for=now`,
     `dedupe_key='payment-failed:<invoiceId>'`) inside the SAME tx as the
     attempt record. The scheduler's delivery phase then INSERTs the feed
     `notifications` row AND dispatches Expo push on its next tick — feed + push,
     delivered together. The `dedupe_key` UNIQUE makes it one push per parked
     invoice, ever. Trade vs. a direct feed insert: the feed entry lands on the
     next scheduler tick rather than instantly in the worker tx.
   - **NOTIFY-ON-PARK-ONLY (anti-spam invariant):** an intermediate retry (a
     non-null `next_attempt_at`) emits NOTHING. The owner hears exactly once —
     when there's nothing left to retry and they must act. `recordFailed`
     returns early before the notify when `nextAttemptAt !== null`.
   - Copy varies by `charge_purpose` via a pure `purposeLabel` helper (payg →
     "day program session", board-train → "Board & Train program",
     group-class → "group class enrollment", package/membership covered for
     totality). Both notifications deep-link `/account/invoices` (kind `invoice`,
     id = invoiceId; corrected in the §A Notifications Phase 2 amendment) and link
     the billed dog via `notification_dogs` when the invoice carries a `dog_id`.

3. **`credits-expiring` scheduled scan (`src/lib/enqueueCreditExpiryWarnings.ts`).**
   A 5th scheduler-tick phase (own tx, own log-and-swallow boundary). Per tick:
   resolve each location's `warning_lead_days` (per-location override →
   org-default → `DEFAULT_WARNING_LEAD_DAYS = 60`), compute that location's
   cutoff (`now + lead_days`), then scan LIVE, NON-EXHAUSTED, EXPIRING credit
   lots (`credit_ledger` purchase rows: `delta > 0`, `lot_id IS NULL`,
   `expires_at IS NOT NULL`, `expires_at > now()`, remaining > 0) whose
   `expires_at <= cutoff` for their location, joined to `dogs.owner_id`
   (staff-owned dogs excluded — no owner to notify). Enqueues one
   `credits-expiring` scheduled notification per lot, delivered by the next
   tick's Phase-1 dispatch. **DEDUP:** the `scheduled_notifications.dedupe_key`
   UNIQUE keyed `credits-expiring:<lotId>` makes the enqueue idempotent — a lot
   warned on one tick is NEVER re-enqueued on a later tick (the same ON CONFLICT
   DO NOTHING floor the booking-reminder scan uses). The reused live-lot
   predicate is the canonical one from `findLiveExpiringLots`.

4. **`resolveWarningLeadDays` (`creditExpirySettingsRepository`).** Sibling of
   `resolveExpiryWindowMonths`: per-location override → org-default →
   `DEFAULT_WARNING_LEAD_DAYS` (60), one-round-trip read. The field was stored
   since Phase 2 with no consumer; this is its reader.

5. **`GET /staff/invoices?parked` `[staff]` (`src/routes/staffInvoices.ts`).**
   The parked-invoice worklist. `requireStaff` (owner → 403); inline wire type
   (NOT portal-mirrored, matching `staffCreditExpiry`/`staffCancelWindow`).
   PARKED = `status='open'` AND `next_attempt_at IS NULL` — the single signal
   that covers BOTH a MAX-attempts park AND a first-attempt missing-card/customer
   park (which never reaches MAX). `invoicesRepository.findParked` accepts a
   `minAttempts` arg for forward-compat, but it is NOT the predicate's source of
   truth — `next_attempt_at IS NULL` is. `?parked` is REQUIRED — an unscoped
   list isn't in scope, so omitting it is a 400. Wire shape per row:
   `{ id, owner_id, amount_cents, status, purpose, dog_id, due_at,
   auto_charge_attempts }`; ordered by `due_at` ASC (longest-overdue first).

6. **Test coverage (`test/contracts/`).** 13 new tests, full suite
   **765/765 green** (at the P3 landing; later settle-harden + payment-failed-push
   raised it to 772): `invoice-auto-charge-worker.test.ts` +3 (payment-succeeded
   on success / payment-failed on PARK / NO notification on an intermediate
   retry — the anti-spam invariant), `credit-expiry-warnings.test.ts` (4:
   in-window enqueues once + second tick does NOT re-enqueue (dedup) /
   out-of-window not enqueued / `resolveWarningLeadDays` fallback chain /
   per-location override widens the window), `staff-invoices.test.ts` (3:
   parked-only filter / owner → 403 / missing `?parked` → 400). The
   `workers-tick` shape fixture grew the `creditExpiryWarnings` field.

**Amendment 2026-05-27 (Day 17 — Cloudflare R2 media surface lands).**
Day-17 ships the private R2 media flow specced in §C.2: presigned
upload/download, owner-scoped media rows + ownership-checked GETs, and
a sharp derivatives worker composed as the 4th phase of the scheduler
tick. Additive only — one new schema table + one new enum; no existing
wire shape changes.

1. **Schema (`schema.sql`).** New 49th table `media_derivative_jobs`
   (one row per `media_assets` row needing derivative processing;
   UNIQUE on `media_asset_id` for idempotent enqueue; partial index
   on `(created_at) WHERE status = 'pending'` for the worker scan;
   FK→`media_assets.id` ON DELETE CASCADE). New enum
   `media_derivative_job_status AS ENUM ('pending','processing',
'done','failed')`. The table is **append-only by nature** (no
   `expired_at`, excluded from `audit_capture`, included in
   `touch_updated_at`) — failed rows are parked, not deleted; status
   flips pending → processing → done | failed are the lifecycle.

2. **Routes (`src/routes/`).** Three new auth-gated routes plus
   one signed PUT-only catalog stub:
   - **`POST /uploads/sign`** → presigned R2 PUT URL + server-
     generated key (`{purpose}/{owner-or-staff-scope}/{uuid}.{ext}`),
     15-min TTL, content-type pinned in the SigV4 signature. No DB
     writes (pure URL signing); no Idempotency-Key. Wire shape:
     `{ url, headers, key, expires_at }`. Rejects content-type/
     purpose mismatches at 400 and byte-size > 25 MB at 400.
   - **`POST /media`** → verifies upload via `r2.headObject(key)`
     (422 `invalid_payload` with `{kind: 'media-upload-missing'}` if
     absent), INSERTs `media_assets`, enqueues
     `media_derivative_jobs` in the same `withMutation` tx, signs
     the response URL POST-commit. Idempotency-Key required; replay
     returns the same row + same job (no double insert).
   - **`GET /media/:id`** → owner-scoped (cross-tenant → 404, never
     403). Returns `{ id, purpose, kind, url, expires_at, blurhash,
width, height, duration_ms, derivatives: { label → url } }`.
     Base + all derivative URLs presigned with 5-min TTL — FE gets
     all sizes in one trip.
   - **`DELETE /media/:id`** → soft-expires the row. **R2 object
     retained** per the never-delete invariant; Day-20+ cleanup
     sweeps long-expired objects from the bucket.

3. **Day-17 scope cut (DOCUMENTED, NOT PERMANENT).** Owner uploads
   only today. Staff `report-photo`/`report-video` uploads return
   422 with `{kind: 'media-staff-upload-deferred'}` — the staff
   portal authoring path lands Day-19. The schema enum + R2 + the
   derivatives worker all support both purposes today; Day-19 adds
   the staff route arm + the `report_id → owner_id` join logic.

4. **R2 client seam (`src/lib/r2.ts`).** `R2Client` interface
   (`signPutUrl/signGetUrl/headObject/getObjectBytes/putObjectBytes`)
   - `defaultR2Client` (AWS SDK v3 via `@aws-sdk/client-s3` +
     `@aws-sdk/s3-request-presigner`, `region:'auto'`, R2 endpoint URL
     `https://<account_id>.r2.cloudflarestorage.com`). **No
     `deleteObject` method** — never-delete invariant enforced at the
     seam. Same DI shape as `StripeClient` (Day-14) and `ExpoPushClient`
     (Day-16); contract tests inject `_r2Stub.ts` (in-memory bucket
     Map + `seedObject/setNextHeadObjectMissing/throwOnNextPutObject`
     knobs).

5. **Derivatives worker (`src/workers/mediaDerivatives.ts`).**
   `runMediaDerivativesOnce(opts) → MediaDerivativesTickResult`
   composed as the 4th phase of `runSchedulerTickOnce` under the
   same `system:scheduler` actor. **NEW 3-tx-scope pattern**
   (deliberate deviation from Day-15/16's all-in-tx pattern):
   (a) **claim-tx** atomically `SELECT FOR UPDATE SKIP LOCKED +
UPDATE` flips `pending → processing` and commits immediately so
   the pg connection isn't held during sharp CPU work; (b)
   **out-of-tx processing** runs sharp pipeline
   (rotate→resize→webp at 200/600/1200) + blurhash + writes
   derivatives back to R2 under
   `derivative/<label>/<asset-id>/<uuid>.webp`; (c) **settle-tx**
   updates `media_assets.derivatives + width + height + blurhash`
   and `markDone`s the job. On any sharp/R2 failure in step 2 the
   settle-tx instead `markFailed`s with `last_error` captured.
   **Video deferred** — `kind='video'` short-circuits to a
   `failed-video` outcome; source stays usable at original size.

6. **`SchedulerTickResult` shape extension (additive).** Now
   `{ scheduledNotifications, invoiceAutoCharge, mediaDerivatives,
idempotencyKeysSwept }`. `mediaDerivatives:
{ scanned: number, results: MediaDerivativeAttemptResult[] }`.
   `MediaDerivativeAttemptResult` has a discriminated `outcome`:
   `'done' | 'failed-video' | 'failed-other'`.

7. **`POST /workers/tick` body shape (additive).** The tick result
   JSON now carries `mediaDerivatives`; consumers that picked the
   Day-16 keys forward (callers should be only pg_cron + tests)
   ignore the new key. The Day-16 log line gains
   `mediaDerivativesScanned: <number>`.

8. **New repositories.** `mediaAssetsRepository` (create / findById /
   setDerivatives / softExpire — `findById(id, runner=db)` so route
   GETs work without an open tx, mutations + worker pass their tx).
   `mediaDerivativeJobsRepository` (enqueue idempotent /
   lockDueForRun / markDone / markFailed / findByMediaAssetId —
   polymorphic-runner consistent). Both follow the Day-9b+ repo
   shape.

9. **`media_purpose` enum behavior pin.** All 5 arms remain valid
   per schema, but Day-17 the route accepts only 3 owner-side
   arms (`dog-profile`, `owner-avatar`, `message-attachment`).
   `report-photo` and `report-video` return 422 today; Day-19
   route arm flips them to 201. The wire shape contract doesn't
   change — both are still valid `media_purpose` values for any
   ROW that exists in `media_assets`.

10. **Dependencies added.** `@aws-sdk/client-s3` +
    `@aws-sdk/s3-request-presigner` (canonical R2 path —
    Cloudflare publishes no R2-specific SDK), `sharp` (libvips
    native bindings; ~7 MB platform-specific install — already in
    the Node container/local), `blurhash` (pure JS encoder; ~5 KB).
    No `ffmpeg` today — `kind='video'` parks the job until a later
    day adds the binary-distribution story. Pre-existing npm audit
    warnings (drizzle-orm + esbuild) are unchanged by Day-17 deps.

11. **Operational R2 setup (handoff to Day-20).** Cloudflare R2
    bucket per env (`nwa-media-dev` / `nwa-media`). 4 env vars
    per env: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
    `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`. CORS: allow `PUT` +
    `GET` from the app origin (dev: `*`; prod: deployed host).
    Day-20 lifecycle rules: auto-expire `derivative/*` after 90 d;
    sweep `media_assets WHERE expired_at < now() - 30 d`'s
    `object_key` from the bucket.

12. **Test coverage (`test/contracts/`).** 24 new tests bringing
    the suite to **562/562 green** (538 prior + 24):
    `uploads-sign.test.ts` (6: image purpose happy / 3 image-
    accepting purposes / video→image-purpose 400 / image→video-
    purpose 400 / 25 MB cap / unknown enum), `media-routes.test.ts`
    (12: owner-avatar 201 + job enqueued / dog-profile ownership
    happy + 404 / missing R2 422 / report-photo 422 / staff 403 /
    bad dog_id combo 400 / GET signed URL + derivatives shape /
    cross-tenant 404 / unknown 404 / DELETE soft-expire + R2
    retained / idempotency replay → same row + same job),
    `media-derivatives-worker.test.ts` (5: empty queue / image →
    3 webp derivatives + blurhash + dims + real sharp decode
    roundtrip / video → parked failed-video / R2 putObject throws
    → parked failed-other / claim-atomicity status filter), and 1
    composition smoke in `scheduler-worker.test.ts`. **Live R2
    round-trip smoke deferred** — `.env` R2 creds still placeholder
    at sign-off; bucket provisioning + paste-credentials + smoke
    is a 5-min follow-up.

**Clarification 2026-05-28 (Day 18c — `POST`/`DELETE /device-tokens` wire
pin, no DDL).** §B's "Push & staff bookings" catalog listed the two paths
without pinning the request/response field names; the `device_tokens` table
(Day-16) was already in place. Pinned at Day 18c — the wire uses
client-friendly names mapped from the schema columns (same convention as
`payment_methods.exp_month`), so this is documentation of the silence, not a
breaking change:

- **`POST /device-tokens` `[auth, owner-only]`** — request body
  `{ token: string, platform: 'ios' | 'android' }` (`token` ↔ column
  `expo_push_token`). UPSERT against the partial-unique
  `device_tokens_uidx (owner_id, expo_push_token) WHERE expired_at IS NULL`:
  a re-register of a live token re-touches `platform` in place (preserving
  `created_at`), a previously-revoked token inserts a fresh live row.
  Returns 201 `{ id, owner_id, token, platform, registered_at }`
  (`registered_at` ↔ `created_at`, ISO-8601). Idempotency-Key required
  (`withMutation`).
- **`DELETE /device-tokens/:token` `[auth, owner-only]`** — soft-expire by
  token, owner-scoped. 204 on success; 404 when the token isn't a live row
  for this owner (missing + not-yours collapse to one 404,
  enumeration-defense). Idempotency-Key required.
- **Auth scope:** both owner-only; staff principals get 403. Staff device
  tokens are out of scope (no portal app yet) — future extension is a
  separate surface, not a widening of this route.

**Amendment 2026-05-28 (Day 19a — staff portal backend verbs land).** The §B
"Push & staff bookings" + "Reports" + "Messaging" + "Pending requests"
catalogs listed the staff verbs; Day-19a ships their backends. Additive —
no DDL, no change to existing owner-facing shapes.

- **Verb 1 — `GET /staff/requests?status=` `[staff]`** — cross-owner queue,
  emits `PendingRequestWire[]` (the owner read's shape, status-filtered,
  newest `submitted_at` first). Approve/deny shipped Day-12.
- **Verb 4 — bookings.** `GET /staff/bookings [staff]` → cross-owner
  `BookingWire[]` (live, non-cancelled, scheduled-asc). `POST /staff/
bookings/:id/confirm [staff]` → stamps `confirmed_at` only when NULL
  (idempotent; 409 cancelled), returns `BookingWire`. `POST /staff/bookings/
:id/cancel [staff]` → returns `BookingWire`; runs the SAME cancel txn as
  the owner self-cancel (schema `cancelBooking` is owner-OR-staff
  authorized — one transaction, identical forfeit/refund branching,
  cross-owner). `POST /staff/bookings/:id/attendance [staff]` → body
  `{ dog_id, status: 'attended'|'no-show'|'excused' }`, sets
  `booking_dogs.attendance` + `checked_in_at` + `checked_in_by_staff_id`;
  **response `{ booking_id, dog_id, attendance, checked_in_at }`** (the §B
  BookingWire carries no per-dog attendance, so the verb returns the row it
  touched; 404 if the dog isn't on the booking's roster, 409 if cancelled).
- **Verb 3 — messaging.** `GET /staff/threads [staff]` → cross-owner
  `ThreadWire[]`. `POST /staff/threads/:id/messages [staff]` → body
  `{ text }`, INSERTs a `sender_kind='staff'` message, bumps
  `threads.last_message`/`last_message_at`, enqueues a `message-received`
  notification to the owner (`deep_link_path: /chat/:threadId`,
  `sender_staff_id` = actor). Returns 201 `MessageWire`. First message-WRITE
  path in the codebase.
- **Verb 2 — report authoring.** `POST /staff/reports [staff]` → base row
  (`dog_id, date, category, program, excerpt, full_text`, optional
  `trainer_staff_id` default = acting staff, `visit_count?`,
  `verdict_headline?`) + `results?` envelope + `content?` variant doc.
  **Content-by-program rule:** session programs (`private-lesson`,
  `boarding-session`, `board-train-session`, `group-class-session`) REQUIRE
  `content`; curriculum programs (`foundation`, `advanced`, `loose-leash`,
  `house-manners`, `cgc`) FORBID it (422; schema `reports_check` is the
  backstop). Optional `link_booking_id` back-links ONE booking's
  `session_report_id` (booking's lead dog must match). Enqueues a
  `report-published` notification (`deep_link_path:
  /report-card/:dogId?reportId=:reportId`, `dog_ids: [dog_id]`). Returns 201
  `ReportWire`. `PATCH /staff/reports/:id
[staff]` edits content fields (identity columns locked; no re-notify).
- **Still DEFERRED past 19a (→ 19b):** `report-photo`/`report-video` media
  POSTs remain 422 `media-staff-upload-deferred` (the staff-author media
  ownership rework wasn't built in 19a); and the group-class **multi-week**
  back-link + the `report_id`-vs-`session_report_id` distinction (only the
  single-booking `session_report_id` link landed).

**Amendment 2026-05-28 (Day 19b — staff portal web client + two cross-owner
reads + multi-week link land).** Additive — no DDL.

- **NEW `GET /staff/threads/:id/messages` `[staff]`** → cross-owner
  `MessageWire[]` for one thread (the reply verb needs the staffer to read
  the conversation first; the owner-side read is owner-scoped). 404 when the
  thread doesn't exist (checked via `threadsRepository.existsLive` — an empty
  live thread reads as `[]`, not 404). 403 for an owner principal.
- **NEW `GET /staff/dogs` `[staff]`** → cross-owner dog directory:
  `{ id, name, breed, owner_id, owner_name, profile_image_path? }[]`, ordered
  by name, owner-owned live dogs only (staff-owned school cats excluded). The
  four verbs reference dogs by UUID and the §B shapes carry no names; this is
  the portal's name resolution + the report-author dog picker. Unbounded — a
  Day-20 pagination item like the other `GET /staff/*` reads.
- **Multi-week report back-link (resolves the 19a deferral, per the
  group-class enrollment rule §C):** `POST /staff/reports` with a
  `link_booking_id` pointing at a **group-class** booking now propagates
  `session_report_id` to EVERY live weekly booking for that `(cohort, dog)`,
  not just the one. Non-group-class is unchanged (single booking). The other
  `bookings.report_id` FK is left **documented-open** (untouched); only
  `session_report_id` carries the staff-authored report linkage today.
- **Known contract gaps surfaced by the portal (candidate §A amendments, not
  yet changed):** `BookingWire` carries no `confirmed_at`, so a client can't
  show confirmation state (confirm stays idempotent); per-dog `attendance`
  isn't on any wire (the attendance verb returns only the row it touched).
- **Still DEFERRED (→ 19c):** the `report-photo`/`report-video` staff-author
  media arm (POSTs remain 422 `media-staff-upload-deferred`).

**Amendment 2026-05-29 (Day 19c — staff-author media arm lands; resolves the
19a/b deferral).** Additive — no DDL (the `media_purpose` enum + `media_assets`
schema already supported both purposes since Day-17). The Day-17 422
`media-staff-upload-deferred` is now gone.

- **`POST /media` staff arm.** A `[staff]` principal posting `report-photo` /
  `report-video` is now accepted: the route resolves `report_id →
report.dog_id → dogs.owner_id` and stamps THAT owner on the row
  (`created_by='staff'`), so the dog's owner reads it via the owner-scoped GET.
  `report_id` is required for those purposes; `dog_id` is derived (a
  client-supplied `dog_id` → 400). An OWNER posting `report-photo`/`-video` →
  403 (staff-authored), mirroring a STAFF posting an owner purpose → 403.
  Unknown/expired report → 404.
- **`GET` / `DELETE /media/:id` staff access.** A `[staff]` principal may now
  read + soft-expire ANY live media row (cross-owner trusted — the staff portal
  reads dogs/bookings/threads cross-owner; reviewing a report needs the dog's
  photos regardless of which owner authored them). An OWNER stays scoped to
  their own rows; a cross-tenant miss is a 404 (never reveal existence).
- **NEW `POST /media/upload` `[staff]` — the portal proxy.** The portal (a
  browser) POSTs the raw file bytes here and the SERVER streams them to R2,
  then records the row + enqueues the derivatives job; response is the same
  `MediaWire` (signed URL) as `POST /media`. Bytes ride in the request body
  (raw, read as a Buffer); `purpose` (`report-photo`|`report-video`) +
  `report_id` ride in the query string; `Content-Type` is the file's MIME;
  `Idempotency-Key` required. 25 MB cap; content-type/purpose mismatch → 400;
  staff-only (owner → 403). **Why a second upload path:** browsers are
  CORS-bound, so presign-direct (`POST /uploads/sign` + client PUT) would need
  a per-origin R2 bucket CORS rule + expose R2 to the browser. Proxying keeps
  R2 server-side (zero bucket config). Presign stays the **mobile** path
  (native clients aren't CORS-bound; direct upload avoids proxying large
  photos through the API). Report photos are small, so server-side bytes are
  cheap. NEW pattern vs the locked presign flow (flagged for promotion review).
- **Still open (carried forward, NOT this amendment):** report photos link via
  the `media_assets.report_id` FK only — they are not embedded into
  `reports.content`, so the owner app surfaces them only once a future
  owner-side "media-by-report" read (or content embedding) lands. `report-video`
  derivatives still park at the worker (Day-17 ffmpeg deferral).

**Amendment 2026-05-29 (report-author enhancements — post-19c, Allison-requested).**
Additive — no DDL. Deepens the portal's report-author form to capture the real
per-program criteria + auto visit number; resolves the carried-forward "thin
`{summary}` content placeholder" item.

- **NEW `GET /staff/dogs/:dogId/session-count?category=<service_category>` `[staff]`**
  → `{ count: number }` — the dog's PAST (status=`past`, non-cancelled) sessions
  in that category, dog on the `booking_dogs` roster (lead or additional),
  cross-owner. Powers the report author's auto visit number (the report being
  written = `count + 1`). 400 on a bad category enum; 403 for an owner principal.
  Repo: `bookingsRepository.countPastSessionsForDog`.
- **`POST /staff/reports` `results` envelope is now authored richly** (no wire
  change — the §B Report `results` shape was always the contract; the portal
  just authors it now instead of sending a `{summary}` stub). Curriculum
  programs send the scored skill grid (`results: { <skillKey>: { status, score }
}` where the portal derives `status`/`score` from a 5-attempt pass/fail tally,
  ≥4/5 ⇒ `pass` else `learning`) + `additional_skills_completed`; ALL programs
  may send `practice_at_home: [{ text }]` ("things to work on at home"). Session
  programs send their typed `content` variant doc (private-lesson handout /
  boarding+board-train journal / group-class weekly recap) — the real shapes the
  owner app's `to*Content` translators read, not a placeholder. `visit_count` is
  the auto value from the session-count read above.

**Amendment 2026-06-01 (Day 19d — real-mode completion + duplicate guards +
group-class display). Additive — no DDL.** Closes the mock-only owner-app holes
the Day-18b facade left as loud throws and adds two Allison-requested features.

1. **NEW `GET /invoices` `[auth]`** → the owner's billing **ledger**:
   `LedgerEntryWire[]`, newest first. One entry per completed/refunded `charge`
   - per open `invoice`, mapped to the FE `InvoiceEntry` kinds:
     `{ id, kind:'session'|'credit-pack'|'membership'|'payg',
status:'paid'|'open'|'refunded', amount_cents, date, dog_id?, category?,
mode? }`. Kind ← `charge.purpose`; dog/mode from `credit_ledger` (packages) or
     the linked booking; category falls back to a purpose-derived value when no
     booking. **No `payment` field** — `charges` carries no payment-method link
     (the FE renders no card chip). Staff → `[]`. Repo:
     `ledgerRepository.listForOwner`. (Owner-app `payInvoice` wires to the existing
     Day-15 `POST /invoices/:id/pay`, which charges the invoice's bound card.)
2. **Three new 422 duplicate-guard `ApiErrorCode`s** (typed `details.kind`,
   checked inside the create txn under the existing locks; cancelled rows never
   block, so re-book/re-request after cancel works):
   - `already_booked` (POST /bookings) — dog already has a live booking for this
     (category, Chicago day). `details:{kind, conflicts:[{dog_id,category,date}]}`.
   - `already_enrolled` (POST /enrollments) — dog already enrolled in the cohort
     (closes the Day-11 caveat). `details:{kind, cohort_id, dog_ids[]}`.
   - `already_requested` (POST /requests) — dog already has an OPEN
     (submitted/approved/awaiting-payment) request of this category.
     `details:{kind, category, dog_ids[]}`.
     FE narrows via `lib/bookingGate.ts` → `<BookingGateModal>` (booking/enroll) +
     a typed Alert (request flow).
     **Δ 2026-07-09 — scoped to residential:** the guard now fires ONLY for
     `board-and-train` / `boarding` (a dog can't have two overlapping multi-week
     stays in flight). **Private-lesson requests are EXEMPT and may stack** —
     they're short staff-scheduled slots and an owner may keep several pending.
3. **Booking wire grows `cohort_id?` + `group_class_name?` (group-class only).**
   `cohort_id` is the stable key the FE groups weekly sessions by (one
   event-style card per cohort + day, dogs stacked); `group_class_name` titles
   the card. Resolved in `wireManyBookings` via a batched cohort→class join
   (`cohortsRepository.resolveClassNamesByIds`). Absent on non-group bookings.
4. **No other new endpoints.** Real-mode group-class enroll + day-school direct
   booking use the EXISTING `POST /enrollments` (Day-11) + `POST /bookings`
   (Day-10); the FE gained typed repo verbs (`enrollInCohort`, `bookSessions`) +
   gate-422 recovery. Past tab reworked to per-dog reads.

**Amendment 2026-06-01 (Day 19e — announcement detail CTA). Additive — 3
nullable columns, no endpoint change.** Recent Updates became type-driven: one
generic `/announcement/[id]` detail screen renders any announcement (hero +
explanation + optional CTA button), replacing per-topic `/info/*` deep links.

1. **`announcements` grows `cta_label`, `cta_kind`, `cta_target`** (all
   nullable; DB CHECK `cta_kind IN ('enroll','route','external')` + an
   all-or-none CHECK so a CTA is fully present or fully absent). `deep_link_path`
   is unchanged and still drives the `report` card's direct link.
2. **`AnnouncementWire` grows `cta?: { label, kind, target }`** — a nested object
   so the three correlated fields travel as a unit (omitted when absent).
   `kind` discriminates `target`: `enroll` (target = `group_class_key`, → in-app
   `/booking-flow/group?class=`), `route` (target = an FE-allowlisted in-app
   path), `external` (target = https URL → in-app browser). The FE parses
   `kind`+`target` into a typed discriminated union at its wire boundary (the
   route allowlist + https check are enforced there — an unknown kind or
   off-allowlist route is rejected at parse time, never dispatched).
3. **No new endpoint.** `GET /announcements?location=` is unchanged; the CTA
   rides the existing list payload. Cache key/TTL unchanged (FLUSHALL after a
   re-seed, per the group-class catalog note).

**Amendment 2026-06-01 (Day 19e — event RSVP writes land; data-driven event
screen). Additive wire keys + the two specced RSVP endpoints implemented.**
The owner app's `/event/[id]` screen is now data-driven (renders any `events`
row), so a new event = a row + an announcement pointing at `/event/{id}`, never
a new screen. This required the §C `POST/DELETE /events/:id/rsvp` (long specced)
to actually ship.

1. **`EventWire` grows `spots_filled` (required) + `capacity?` (omit when NULL =
   uncapped).** `spots_filled` is a batched count of live `event_rsvp_dogs` over
   the event's live `event_rsvps`; both `GET /events` and `GET /events/:id` emit
   them so the screen can render the spots bar. `events.series_id` stays
   deferred. Additive — the prior FE ignored the keys.
2. **`POST /events/:id/rsvp` `[auth, owner]`** — body `{ dog_ids: uuid[] }` (1–5,
   distinct), Idempotency-Key required. Sets the owner's RSVP for the event to
   EXACTLY `dog_ids` (replace = expire the old RSVP + dogs, INSERT a fresh RSVP —
   the `event_rsvp_dogs` `(rsvp_id, dog_id)` PK forbids reusing a row for a
   re-added dog). Enforces `events.capacity` as a **soft cap for owner self-serve**
   under a per-event row lock (`live_dogs − owner_current + |dog_ids| > capacity`
   → 422 `event_full`); staff/portal may still exceed it (not a DB CHECK).
   Ownership-gated per dog (404, no cross-owner enumeration). Returns 200 +
   `EventRsvpWire`. Owner-only (staff → 403).
3. **`DELETE /events/:id/rsvp` `[auth, owner]`** — soft-expires the owner's live
   RSVP (+ dogs). Idempotent no-op when none. Idempotency-Key required. Returns
   200 `{ ok: true }`. Owner-only.
4. **New `ApiErrorCode`: `event_full` (422)** — joins the state-block 422 family.
5. **No cache.** Events aren't read-through cached, so the RSVP writes invalidate
   nothing.

**Amendment 2026-06-01 (Day 19e — messaging mark-read endpoint lands). No DDL.**
The owner app fires a mark-read on chat open, but `POST /threads/:id/read` was
never built — the real `messageRepository.markThreadRead` 404'd, and the chat
screen's mark-read effect retried it forever (infinite unhandled-rejection loop

- UI flashing). This ships the endpoint.

1. **`POST /threads/:id/read` `[auth, owner]`** — sets `read_at = now()` on the
   thread's live, unread, non-owner messages (exactly the §B `unread_count`
   set). Idempotent (Idempotency-Key required; re-running is a no-op once read),
   owner-scoped (`ownsThread`; staff/unknown/non-owned → 404, no enumeration),
   **204 No Content**. Repo: `messagesRepository.markThreadReadForOwner`.
2. **`POST /threads/:id/messages` `[auth, owner]`** — owner sends a message
   (`sender_kind='owner'`). INSERTs + bumps the thread preview
   (`bumpLastMessage`), idempotent, owner-scoped (staff/non-owned → 404), body
   `{ text }` (trimmed, 1–4000), **201 + the created `MessageWire`** (owner
   messages omit `sender_name`, per the existing §B convention). No
   notification — staff read owner messages via the portal (notifications are
   owner-scoped; no staff bell feed). Repo: `messagesRepository.createOwnerMessage`.
3. **No new table/column** — `messages.read_at` already exists; the mark-read +
   send are the missing write verbs over `messages`. The FE was also fixed: the
   chat mark-read effect fires once per thread open (no loop), `sendMessage` is
   now a real optimistic mutation (was local-only), and the open thread + list
   **poll** (`refetchInterval`) so staff replies appear without a refresh — true
   realtime (WebSocket/SSE) is a Day-20+ upgrade.
4. **"Is me" is keyed off `sender_name` absence**, not the owner id — the wire
   already omits `sender_name` only for owner messages, so the FE alignment
   works across mock + real (the old `=== 'owner-allison'` broke on real uuids).

## B. Per-entity wire shape (response JSON the Node API emits)

Shapes below are the contract. Field = exact JSON key the FE `toX()` reads
today (verbatim from the repo-extraction pass); only the noted deltas change.

**Dog** — `{ id, name, breed, age_months, profile_image_path, vaccines:[{id,name,expires_at,requirement_key?}], medications:[{id,name,dose,frequency}], feeding:{brand,amount,frequency,notes?}, special_notes, evaluation_status, boarding_enabled, is_alumni, evaluation_date?, completed_class_keys?, alumni_attendance_flagged_at?, field_overrides? }`

- Δ R7: `completed_class_keys` is server-derived (still emitted for FE compat).
- Δ R5: `age_months` is computed from `birthdate` server-side; FE unchanged.
- Δ 2026-05-19: optional `vet?:{ id, name, phone?, email?, address?, notes? }`
  resolved server-side from `dogs.primary_vet_id` (additive; the current FE has
  no vet UI and ignores the key until one exists). Editable via `PATCH
/dogs/:id { primary_vet_id }`.
- Δ 2026-05-22 (Day 9d): VaccineWire grew `id` (required) +
  `requirement_key?` (optional, omit-on-null). Forced by `PATCH/DELETE
/dogs/:id/vaccines/:vid` needing the id in the URL. Additive — FE
  ignores until it consumes. See §A "Amendment 2026-05-22".
- Δ 2026-06-17: `field_overrides?` — per-dog map of which optional dog-form
  sections this dog collects (`{ trainingGoals?, feeding?, medications?, notes?,
primaryVet?, otherVaccines? }`, each bool; omit when empty). Staff-set,
  backed by `dogs.field_overrides jsonb`. The **app-wide default** lives in
  `intake_field_settings` (one row per field key, staff-tunable from the portal;
  code falls back to `collected=true` for a missing row). The owner dog form
  shows the app default at sign-up and `default + per-dog overrides` on manage
  (FE merges via `resolveDogFieldVisibility`). Staff-editable only (not the
  owner). Additive — current FE consumes `field_overrides`; the app-wide default
  is a client const until a settings read endpoint lands.
- Δ 2026-07-14 (§J.3): `is_alumni` (required bool — DERIVED: all 5 live
  `dog_completed_programs` rows) + `alumni_attendance_flagged_at?`
  (omit-on-null ISO — the monthly attendance flag; staff clear it). Additive.

**Booking** — `{ id, dog_id, additional_dog_ids?, category, status, date, trainer?, duration_minutes?, notes?, session_report_id?, location?, cancelled_at?, cancel_forfeited?, cohort_id?, group_class_name? }`

- Δ 2026-06-01 (Day 19d): `cohort_id?` + `group_class_name?` — group-class only;
  the FE groups weekly sessions by `cohort_id` + day into one event-style card
  titled `group_class_name`. Additive; see §A "Amendment 2026-06-01".
- DB normalizes dogs into `booking_dogs`; API **denormalizes** back to
  `dog_id` (lead) + `additional_dog_ids[]` so the FE shape is unchanged.
- Δ: `status` is authoritative now (DB-driven), not advisory; the runtime
  `getSessionEndTime` bucketing can move server-side or stay in the service.
- Δ 2026-05-19: additive `location` (`location_key`), `cancelled_at`,
  `cancel_forfeited` (true = cancelled past the free-cancel window → no
  refund). All optional; existing FE `toBooking` ignores unknown keys.
- Δ 2026-05-20 (Day 5): runtime bucketing **server-side**, by category:
  day-school / day-care → end-of-day-program window in America/Chicago
  (`DAY_PROGRAM_PICKUP_WINDOW.close = 17:30`); boarding / board-and-train →
  `pickup_at` (NULL = stay not yet approved → indefinite-upcoming until
  Day-12 sets it); group-class / private-lesson / evaluation →
  `scheduled_at + duration_minutes` with per-category fallback (50 / 60 /
  30 min). `view=upcoming|past` uses status `AND` end-time so the worker
  (Day-16) is allowed to lag without making reads wrong. `status='cancelled'`
  rows are excluded from both views. **Wire-shape nullability:** `location`,
  `cancelled_at`, `cancel_forfeited` are OMITTED when null/false (Day-4a
  optional convention); `cancel_forfeited` is always-emitted-as-boolean only
  when the booking is cancelled.
- Δ 2026-05-20 (Day 5): `scheduled_at` for **day-school / day-care** is the
  user-authored drop-off time anywhere within the drop-off window (`DAY_PROGRAM_DROPOFF_WINDOW = 07:30 → 09:00` America/Chicago); pick-up
  is anywhere within the pick-up window (`16:30 → 17:30`). The booking has
  no `pickup_at` for day programs — parents arrive when they arrive, and
  the booking is considered active until the pick-up window closes. Windows
  assumed identical across both locations until per-location windows are
  modeled (deferred). Existing FE constants
  (`bookingService.DAY_PROGRAM_PICKUP_HOUR = 17`) are off by 30 min vs. the
  actual rule — corrected on Day 18 FE swap.

**PendingRequest** — `{ id, dog_id, additional_dog_ids?, category, submitted_at, preferred_dates:[iso], notes?:{per_dog?,joint?}, focus:{staff_preference?,descriptor_keys?}, length_weeks?, status, approved_at?, converted_booking_id? }`

- Δ R1: gains `additional_dog_ids`. Δ R8: `focus` object replaces
  `focus_areas:string[]`. Δ: `notes` is the structured object (the mock's
  `toPendingNotes` lossy `{perDog:raw}` collapse is gone). Δ: real `status`.
- The FE `toPendingRequest` + `parseFocusTags` adapt to read the structured
  shape directly — this is a small, contained repo-layer change (acceptable;
  it's the _one_ place R1/R8 surface FE-side).
- Δ 2026-06-17: `focus.descriptor_keys: string[]` (multi-select staff-defined
  trait pills) replaced the single `comfort_level`. Used by private-lesson AND
  board-and-train intake. Keys resolve to labels against the org-wide
  `dog_descriptors` list (the staff portal's setting; FE const
  `STAFF_DOG_DESCRIPTORS` until a read endpoint lands). Backed by
  `pending_requests.descriptor_keys text[]`; the wire tag is `descriptor:<key>`.
  Stored keys are stable so relabeling a descriptor never orphans a pick; a key
  that no longer resolves is dropped at parse/display.

**Report** — base `{ id, dog_id, date, trainer?, category, program, excerpt, full_text, visit_count?, verdict_headline? }` + curriculum `{ results?, practice_at_home?, friends_today?, additional_skills_completed? }` + exactly one variant doc keyed by program: `private_lesson_content` | `boarding_session_content` | `board_train_session_content` | `group_class_session_content`. Sub-shapes per the existing `to*Content` translators (verbatim — `session_focus`, `check_in_date`, `week_number`, etc.). DB stores curriculum bits in `results` JSONB and the variant doc in `content` JSONB; the API rehydrates the named keys the FE expects.

**Thread** — `{ id, category, title, sub_text, participant:{id,name,role,image_path?}, related_dog_ids:[], last_message, last_message_at, unread_count }`

- Δ: `unread_count` is **derived** server-side (`messages.read_at IS NULL`,
  not sender=owner), never a stored mutable column.

**Message** — `{ id, thread_id, sender_id, sender_name?, text, sent_at, is_read }`

- DB has polymorphic `sender_kind`+`sender_owner_id|sender_staff_id`; API
  flattens to `sender_id` (+ `sender_name`) so the FE shape is unchanged.
  `is_read` derived from `read_at`.

**Credits** — `{ dog_id, school, daycare }` where `school`/`daycare` are the
**derived ledger balance** (`dog_credit_balance` view), not a stored counter.
FE `toCredits` unchanged (`school_credits`→`school` etc. — API emits the
`school`/`daycare` keys the view produces; confirm key naming at impl).

- Δ 2026-05-20 (Day 5): a dog with no `credit_ledger` rows yet emits the
  zero sentinel `{ dog_id, school: 0, daycare: 0 }` rather than 404; the
  API LEFT JOINs the view so a freshly-provisioned dog always answers.
- **Δ 2026-06-04 (location-scoped credits):** balances are now per-(dog, mode,
  **location**). Wire is `{ dog_id, location, school, daycare }`;
  `GET /dogs/:id/credits?location=<key>` takes a **required** `location` query
  param (the owner app passes its set location; missing/invalid → 400
  `bad_request`). `dog_credit_balance` groups by `(dog_id, mode, location)`;
  every `credit_ledger` row carries `location` (purchase → the chosen location,
  booking-debit → the booking's location, cancel-refund → the original debit's
  location); the booking balance advisory lock is per-(dog, mode, location). The
  zero sentinel carries the queried `location`.
- **Δ 2026-06-18 (credit-expiry lot model):** credits now **expire** (supersedes
  the 2026-05-19 "never expire" decision). The wire gains `expiring_lots: [{
mode, remaining, expires_at }]` — the dog's LIVE expiring lots (count + lapse
  date, soonest first) so the app can warn "N credits expire on {date}".
  Never-expiring credits (single-day 1-credit packs, legacy/Gingr imports, the
  pool) are omitted from `expiring_lots` but still counted in `school`/`daycare`.
  `school`/`daycare` now reflect only LIVE lots (expired-lot credits excluded).
  Model: `credit_ledger` purchase rows are _lots_ with `expires_at` (NULL =
  never; >1-credit pack = purchase + a staff-tunable window, stamped once,
  non-retroactive); debits FIFO the soonest-expiry lot first (pool last) and
  carry `lot_id`; a free-window cancel refunds to the original lot if alive,
  else mints a fresh-window lot. (Phase 1 — window is a code-side 1yr default;
  Phase 2 makes it staff-tunable.)
- **Δ 2026-07-16:** the wire gains `warning_lead_days` (required int) — the
  resolved per-location staff-tuned expiry-warning lead (override →
  org-default → server default 60), so the app's "expiring soon" chip warns
  on the same window as the server's `credits-expiring` push. Additive; the
  FE falls back to its client-side 60-day default when absent (mock mode).

**DayCapacity** — `{ location, date:'YYYY-MM-DD', school_openings, daycare_openings }`.
API applies the **per-location** business rule (weekend=closed, default 3)
over sparse `day_capacity` overrides now keyed `(location, date)`. Δ
2026-05-19: `location` added; availability queries take `&location=`. The
FE/`availabilityService` rule moves server-side or stays in the ported
service; the wire shape is otherwise unchanged.

- Δ 2026-05-20 (Day 5): rule moved server-side. `GET /availability?from=&to=&mode=&location=`
  emits one `DayCapacity` row per calendar date in `[from, to]` for the
  given `location`. `mode` (school/daycare) does **not** filter — both
  `school_openings` and `daycare_openings` are always emitted; the FE
  selects which to display. Default rule fires when no override row exists.
  Range cap: **92 dates (≈3 months)** — locked Day 5b per the FE's "book
  up to 3 months in advance" requirement; larger windows return 422
  `invalid_payload`. Reversed bounds (`to < from`) also 422
  `invalid_payload`. The 60-day prior estimate was superseded.

**CreditPackage** (Δ 2026-05-20, Day 5) — `{ key, mode, credits, price_cents, label, is_popular }`.
`GET /credit-packages` filters to `active = true` server-side (retired packs
never surface). `key` (PK) replaces the FE's local `id` (e.g., `'school-8'`,
`'daycare-10'`). `price_cents: integer` — never dollars on the wire
(financial-amount convention; FE divides by 100 for display). `mode`
distinguishes school-only vs daycare-only packs. The FE `CreditsSheet`'s
local marketing `description` field is FE-only copy — no schema column;
revisit if marketing text proliferates. Ordering: `mode` ASC, `credits` ASC
(stable for snapshot tests).

- **Δ 2026-06-04 (per-location pricing):** packages are per-location — PK is
  composite `(key, location)`, so the same `key` carries a different
  `price_cents` per school. Wire gains `location`:
  `{ key, location, mode, credits, price_cents, label, is_popular }`.
  `GET /credit-packages?location=<key>` takes a **required** `location` query
  param; the purchase body gains `location` and resolves `(key, location)`.
- **Δ 2026-06-08 (effective-dated pricing; wire UNCHANGED):** `credit_packages`
  is now effective-dated, mirroring `service_rates` — surrogate `id` PK +
  `effective_from`/`effective_to` (NULL = open-ended current), UNIQUE
  `(key, location, effective_from)`. Repricing/retiring closes `effective_to` +
  inserts a new row (never edits a priced row); the `active` boolean is gone (the
  effective window is the retire switch). `GET /credit-packages` resolves the
  one live window per key at `today_in_chicago`, so the wire is unchanged. The
  `credit_ledger.package_key` composite FK is replaced by a single
  `package_id uuid REFERENCES credit_packages(id)` — a purchase records the exact
  priced version bought (immutable across later reprices). The purchase route's
  Stripe metadata carries `package_id` (load-bearing FK the async webhook stamps)
  alongside `package_key` (human-readable dashboard reconciliation).

**Enrollment** (Δ 2026-06-09) — `GET /enrollments` → one row per live (cohort,
dog) the owner is enrolled in, for the mobile "Currently enrolled" section:
`{ cohort_id, dog_id, class_key, class_name, location, start_date, weekly_time,
weeks, first_session_at, payment_status, can_withdraw }`. `payment_status ∈
'paid' | 'pay-later' | 'pending'` (derived: a succeeded charge → paid; else an
open invoice → pay-later; else pending). `can_withdraw: boolean` = the first
session hasn't started (the self-serve withdraw window; the withdraw verb
re-checks it under the cohort lock). `start_date`/`first_session_at` are ISO
timestamptz; `weekly_time: string | null`.

**Rate** (Δ 2026-05-20, Day 5) — `{ category, location, amount_cents, unit,
effective_from, note? }`. `GET /rates?category=&location=` resolves the
single active row for the (category, location) pair, preferring a
location-specific row (`service_rates.location = $loc`) over a null-location
row (applies-to-all). "Active" = `effective_from <= today_in_chicago AND
(effective_to IS NULL OR today_in_chicago < effective_to)`. 404 if no rate
matches. `category: ServiceCategory`. `location: location_key | null` —
emitted as `null` (not omitted) so the FE distinguishes "no specific
location" from absence. `amount_cents: integer`. `unit ∈ 'per-day' |
'per-night' | 'per-session' | 'per-week' | 'flat'`. `effective_from:
'YYYY-MM-DD'`. `note?: string` — staff-facing context; omit when null/
empty. Both query params required (`category` always; `location` may be
the literal string `'null'` to force the all-locations match — TBD if a
client needs that; default semantics emit the best match for the location
given). The FE has no current shape for this — the rate is consumed by
booking-flow review screens (Day 18+).

**GroupClass** (Δ 2026-05-20, Day 6a) — `{ key, name, weeks,
price_per_dog_cents, capacity, age_range?, description, enrollment_type }`.
`price_per_dog_cents: integer` — cents on the wire (financial-amount
convention, matches `Booking` / `Rate` / `CreditPackage`); replaces the
FE's local `price_per_dog: number` (dollars). FE adapts on Day 18 (one-line
divide-by-100 for display). `key: GroupClassKey`. `enrollment_type ∈ 'open' |
'cohort'`. **Prereqs are NOT carried on the class** — fetch via
`GET /dogs/:id/group-eligibility?class=<key>` (R7 server-derived). Day-6a
amendment dropped the singular `prereq_class_key` from the schema in favor
of the `class_prereq_options` join (see §A amendment block). Ordering:
enum-natural (`puppy`, `manners-1`, `manners-2`, future additions in
`group_class_key` declaration order). Optional-omit on `age_range?`.

**Cohort** (Δ 2026-05-20, Day 6a) — `{ id, class_key, location,
start_date, end_date?, weekly_time, weeks, capacity, filled }`. Additive
`capacity: integer` (per-cohort snapshot from `group_classes.capacity` at
cohort creation — server is source of truth in case a future cohort runs
at a custom cap). `start_date` / `end_date` emit ISO timestamptz.
`weekly_time: string` is a display-friendly label (e.g., `"6:00 PM"`);
time-of-day source of truth remains `start_date`. Ordering: `start_date`
ASC. FE's current `toCohort` reads everything except `capacity` — adding
`capacity` is additive (unknown keys ignored on the FE side).

**GroupEligibility** (Δ 2026-05-20, Day 6a, NEW) — `{ class_key, eligible:
boolean, missing_prereq_options? }` where `missing_prereq_options:
GroupClassKey[]` is the OR-list the dog could complete to unlock the class.
`GET /dogs/:id/group-eligibility?class=<key>`. Owner-scoped (dog ownership-
checked, 404 same response as not-yours / not-found so ids don't enumerate).
Logic: walk live `class_prereq_options` for the target class; if zero
options or the dog has any matching live `dog_completed_classes` row,
`eligible: true` and the key is omitted. If options exist and none match,
`eligible: false` and `missing_prereq_options` emits the live OR-list
(sorted by `group_class_key` enum declaration order for snapshot
stability). R7 (server-derived eligibility) holds; this is the wire shape
that operationalizes it.

**User/owner, Event, EventRsvp, Notification, Announcement, PaymentMethod**:
wire keys exactly as the current `toX()` translators read them (see the
repo-extraction digest for the verbatim per-key maps). No shape changes
beyond R5 (absolute dates) and R6 (uuid ids). Δ 2026-06-01 (Day 19e):
**Announcement** grew `cta?: { label, kind, target }`; **Event** grew
`spots_filled` + `capacity?` (additive; see §A "Amendment 2026-06-01 (Day
19e)"). Δ 2026-07-25 (Notifications Phase 3): **Notification** is now a
contract-guarded shape — `NotificationWire` (+ the `NotificationListResponse` /
`UnreadCountResponse` envelopes, `NotificationPushData`, and the
`NotificationDeepLink` / `deepLinkToPath` deep-link vocabulary) live in `wire.ts`
v1.1.0, not hand-mirrored per-repo; see §A "Amendment 2026-07-25".

## C. Mutation / endpoint surface

The complete Node API surface (~70 endpoints / 12 resources), derived from
every repository + service method + the 4 portal verbs + auth. Transaction
boundaries are in `schema.sql` (bottom) and `BACKEND-ARCHITECTURE.md §5`.

**Conventions:** every route requires a valid Supabase JWT. Unmarked =
**authenticated owner, auto-scoped to their own data** (Node middleware, not
RLS). **[staff]** = `role:staff` (the minimum staff portal). **[$]** marks a payment endpoint — **built from day one**, Stripe **test-mode** keys in dev/staging and **live** keys in prod (env split); `payments_enabled` is a runtime kill switch only, never a launch-scoping/deferral device. **[public]** = unauthenticated but
signature-verified. The FE's `src/repositories/*` swap from mock-JSON reads to
`fetch` against these — services/hooks/screens do not change. **Every mutating
request carries an `Idempotency-Key` header (client UUID)** — the API replays
the stored response on retry (`idempotency_keys`); transport concern,
invisible to the repository layer.

**Identity / session**

- `GET /health` [public] · `POST /auth/webhook` [public, signed] — Supabase "user created" → upsert mirror row
- `GET /me` [auth] — owner|staff profile + mirror row · `PATCH /me` — profile / emergency contact / notification prefs

**Dogs**

- `GET /dogs` · `GET /dogs/:id` · `POST /dogs` · `PATCH /dogs/:id` · `DELETE /dogs/:id`
- `POST /dogs/:id/evaluation` — schedule eval
- `GET|POST /dogs/:id/vaccines` · `PATCH|DELETE /dogs/:id/vaccines/:vid` — POST/PATCH may set `requirement_key` (satisfies a gating vaccine)
- `GET /vets?q=` — list / typeahead search (create-flow searches this FIRST to avoid dupes) · `GET /vets/:id`
- `POST /vets` [auth] — owner create-if-missing ("my vet isn't listed"); `source='app'`. `PATCH /vets/:id` · `DELETE /vets/:id` **[staff]** only — a vet row is shared across many owners' dogs; one owner must not rename/expire it. Expiring a vet referenced by live dogs is API-blocked.
- `dogs.primary_vet_id` set via `POST /dogs` or `PATCH /dogs/:id`; the vet is resolved onto the Dog read so staff can call to confirm vaccines. Curated ~50 preloaded with `source='seed'`.
- `GET /required-vaccines` — gating catalog (`key,label,gates_categories[]`); FE shows which are missing/expired before a gated booking
- `GET|POST /dogs/:id/medications` · `PATCH|DELETE /dogs/:id/medications/:mid`
- `PUT /dogs/:id/feeding` (1:1)

**Bookings**

- `GET /bookings?view=upcoming|past` — runtime-bucketed by session end-time
- `GET /bookings/up-next` · `GET /bookings/:id` · `GET /dogs/:id/bookings?view=`
- `POST /bookings` — book Day School/Care (multi-dog body; credit-debit txn) [$ if over-balance — charge/membership covers shortfall]
- `POST /bookings/:id/cancel` — cancel + credit-back or money-back refund branching (Day 13); group-class returns 422 (cohort-withdraw is a separate verb)
- `GET /staff/cancel-window` [staff] · `PATCH /staff/cancel-window/:category` [staff] — Day-13 admin-config surface: Shanthi tunes the per-category free-cancel hours from the staff portal. Affects future bookings only; existing rows keep their stamped `cancel_deadline_at`.

**Pending requests**

- `GET /requests?status=` · `GET /requests/:id`
- `POST /requests` (lead+dogs, preferred_dates, notes{per,joint}, focus, length_weeks) · `PATCH /requests/:id` (preferred_dates/notes/focus/length_weeks only) · `POST /requests/:id/cancel`
- `GET /staff/requests?status=submitted` [staff] — portal queue
- `POST /staff/requests/:id/approve` [staff] — **portal verb 1**, txn: request→converted + create booking(+booking_dogs) + converted_booking_id + booking-confirmed notification
- `POST /staff/requests/:id/deny` [staff]

**Availability & credits**

- `GET /availability?from=&to=&mode=&location=` — per-location capacity (weekend/default rule server-side)
- `GET /dogs/:id/credits` — ledger balance per mode · `GET /credit-packages`
- `POST /credit-purchases` [$] — Stripe charge → credit_ledger
- `GET /rates?category=&location=` — current effective `service_rates` (effective-dated; the API resolves the active window)

**Agreements (waivers)**

- `GET /agreements` — required docs + whether the owner has signed the current version (per category)
- `POST /agreements/:key/sign` — record an `agreement_signatures` row at `current_version` (gates bookings until signed)

**Group classes**

- `GET /group-classes` · `GET /group-classes/:key` · `GET /group-classes/:key/cohorts` · `GET /cohorts/:id`
- `GET /dogs/:id/group-eligibility?class=` — server-derived prereq (R7)
- `POST /enrollments` [gated for pay-now] — txn: lock cohort → capacity assert → N×M bookings → fill bump

**Reports**

- `GET /dogs/:id/reports` · `GET /reports/:id` · `GET /dogs/:id/reports/latest` · `GET /dogs/:id/reports/resolve?reportId=&program=`
- `POST /staff/reports` [staff] — **portal verb 2**, base + results|content by program; links bookings.report_id/session_report_id · `PATCH /staff/reports/:id` [staff]
- `GET /staff/dogs` [staff] — cross-owner dog directory (Day-19b) · `GET /staff/dogs/:dogId/session-count?category=` [staff] — past-session count for the report author's auto visit number (post-19c)

**Messaging**

- `GET /threads` · `GET /threads/:id` · `GET /threads/:id/messages`
- `POST /threads` (new — still deferred) · `POST /threads/:id/messages` — **built Day-19e** (owner send, sender_kind=owner; 201) · `POST /threads/:id/read` — **built Day-19e** (sets read_at; idempotent; owner-only; 204)
- `GET /staff/threads` [staff] · `POST /staff/threads/:id/messages` [staff] — **portal verb 3** (sender_kind=staff)

**Events**

- `GET /events` · `GET /events/:id` · `GET /events/rsvps` — **Day-19e**: `GET` wire grew `spots_filled` + `capacity?` (data-driven `/event/[id]` screen)
- `POST /events/:id/rsvp` · `DELETE /events/:id/rsvp` — **built Day-19e** (idempotent; soft cap → 422 `event_full`; owner-only) · `GET /dogs/:id/event-attendance` still deferred (no consumer)

**Notifications & announcements**

- `GET /notifications` · `GET /notifications/unread-count` · `POST /notifications/:id/read` · `POST /notifications/read-all` · `DELETE /notifications/:id` — **Notifications Phase 1 (2026-07-24)**: the three mutation verbs are owner-only, idempotent, bodyless **204**. `:id/read` / `read-all` set `read_at` (a read row stays in the feed, flagged `is_read`, and drops from `unread-count`); `DELETE` is a **soft-tombstone** (`dismissed_at`) — the row is retained for audit but filtered out of the feed + unread-count. 0-affected-rows (not-yours/unknown/staff) → 404; `read-all` for staff is a 204 no-op. See §A Amendment 2026-07-24.
- `GET /announcements?location=`

**Payments** [$] — built day one; Stripe **test mode** in dev/staging, **live** in prod (env split)

- `GET /payment-methods` · `POST /payment-methods/setup-intent` · `POST /payment-methods` · `PATCH /payment-methods/:id` (default) · `DELETE /payment-methods/:id` — **Day 14**: setup-intent + PATCH default + DELETE soft-expire (post-commit Stripe detach); **Day 15**: `POST /payment-methods` is the `setup_intent.succeeded` webhook target that writes the row (no synchronous client POST today)
- `POST /credit-packages/:key/purchase` [$] — Day 14. Synchronous-confirm
  PaymentIntent against stored card; writes `charges` + `credit_ledger`
  purchase grant in one tx when Stripe returns `succeeded`. 3DS / async
  paths return `client_secret` and let the Day-15 webhook reconcile.
  **Δ 2026-07-14**: optional body `quantity` (int 1–100, default 1) buys N
  units of the package in ONE charge / ONE ledger lot (`amount = N ×
  price_cents`, `delta = N × credits`; expiry keys off the TOTAL, so N > 1
  of the never-expiring single-day pack gets the multi-credit window).
  PI metadata `credits` carries the total (webhook reconcile needs no
  quantity awareness); `quantity` rides along for dashboard readability.
  Powers the app's "choose your own amount" wheel (N × single-day pack).
- `GET /charges` · `GET|POST /memberships` · `DELETE /memberships/:id` —
  **§J.1 BUILT 2026-07-14**: `POST /memberships` `{dog_id, package_key,
  location, term_months(3|6|9|12), payment_method_id}` [$, idempotent] —
  month-1 charges SYNCHRONOUSLY (non-succeeded intent ⇒ PI cancelled + 422,
  no async-reconcile arm for creation — v1 limit); creates the active
  membership + the month's `membership-grant` lot (`expires_at =
  current_period_end`, alumni NULL). `GET` lists the owner's; `DELETE`
  cancels (status flip; granted lots stay). Renewals are self-billed:
  the scheduler ROLL phase opens each later month as a card-backed
  `invoices` row (`purpose='membership'`, `membership_id`) and
  `settleInvoiceCharge` grants on the winning settle. Term hard stop =
  billed-period COUNT (1 sync + membership invoices), not a date compare.
  Δ 2026-07-16: one ACTIVE membership per (dog, mode) — 409 pre-charge,
  advisory-locked in-tx re-check (race loser refunded, wire +=
  `charge_refunded`), partial unique index floor; the roll skips any
  membership with an open invoice (unpaid month freezes, late settle
  re-aligns — see Amendment 2026-07-16).
- `POST /staff/memberships/:id/pause` · `POST /staff/memberships/:id/resume`
  [staff] — §J.1 staff-mediated pause. Resume shifts `current_period_end` +
  `ends_at` forward by the pause gap (the clock stops while paused).
- `GET|POST /staff/dogs/:dogId/completed-programs` ·
  `DELETE /staff/dogs/:dogId/completed-programs/:program` ·
  `POST /staff/dogs/:dogId/clear-alumni-flag` [staff] — §J.3. Recording the
  5th program = became-alumni ⇒ `clearExpiryForDog` (live lots → NULL).
  The DELETE does NOT re-stamp lot expiries (documented in the route).
- `POST /webhooks/stripe` [public, signed] — **Day 15** — receives `payment_intent.succeeded`/`.payment_failed`/`setup_intent.succeeded`/`charge.refund.updated`. Dedupes via `stripe_events` table; runs under `system:stripe-webhook` actor. Other event types collapse to `unhandled`+200 (future-proof).
- `GET /invoices` · `POST /invoices/:id/pay` [$] — **Day 15** for `POST /pay` (pay-later settlement, mirrors credit-purchase shape). `GET /invoices` deferred to Day-19 staff portal (no current FE consumer; `invoicesRepository.findOpenByOwner` is ready when needed).
- `POST /invoices/:id/pay-in-person` — **Notifications Phase 4c (2026-07-27, R3)**: owner elects cash/check at drop-off. Charges nothing — flips `invoices.payment_expected` → 'in-person' + enqueues the `payment-due` reminder (~1h before the linked booking's drop-off, else the invoice's `due_at`; past → now) in one tx. Bodyless 204; repeat under a new key → 409. See §A Amendment 2026-07-27 (Phase 4c).
- `POST /requests/:id/confirm-payment` — **Day 15** — B&T `approved-awaiting-payment` → `converted`. Server-authoritative pricing via `lib/boardTrainPricing.ts`. Pay-now (charges row + booking) or pay-later (open invoice + booking).
- `GET /refunds` — refund history; refunds are created by the cancel txn (`POST /bookings/:id/cancel`), not a direct client endpoint. Past the `cancel_deadline_at` window the booking is `cancel_forfeited` (no refund); within it → credit `cancel-refund` (credit bookings) or a `refunds` row + Stripe refund (money bookings). **Day 14**: cancel route's money-back branch now fires `stripe.createRefund` post-commit (Day-13 stubbed the seam).
- `POST /workers/tick` [public, signed] — **Day 16** — production scheduler trigger. Bearer secret (`SCHEDULER_WEBHOOK_SECRET`) compared constant-time; pg_cron + pg_net signs into this. Runs `runSchedulerTickOnce` (**7 phases as of §J 2026-07-14**: `scheduled_notifications` claim + dispatch / §J.1 membership roll / invoice auto-charge / media-derivatives / credits-expiring scan / §J.3 alumni-attendance monthly scan / `idempotency_keys` TTL sweep). Worker runs under `system:scheduler` actor.

> `scheduled_notifications` + `media_derivative_jobs` are server-internal
> worker queues — no client endpoints; the worker emits pushes /
> `notifications` rows + processes media derivatives on each tick.

**Media** [auth] — **Day 17** — private R2 with presigned PUT/GET (DATA-CONTRACT §C.2)

- `POST /uploads/sign` — issue presigned R2 PUT URL + server-generated key (`{purpose}/{owner-or-staff-scope}/{uuid}.{ext}`), 15-min TTL; content-type pinned in the signature, 25 MB cap. No DB writes, no Idempotency-Key. Returns `{ url, headers, key, expires_at }`.
- `POST /media` — verifies the upload via `r2.headObject(key)` (422 `invalid_payload {kind: media-upload-missing}` if absent); INSERTs `media_assets` + enqueues `media_derivative_jobs` in one `withMutation` tx; signs the response URL POST-commit. Idempotency-Key required. **Day-19c:** owner arm (dog-profile/owner-avatar/message-attachment) + staff arm (`report-photo`/`report-video`, resolves `report_id → dog → owner`); cross-role POST → 403.
- `POST /media/upload` [staff] — **Day-19c portal proxy.** Raw file bytes in the body + `purpose`/`report_id` in the query; the server streams to R2 (no browser→R2 CORS), then INSERTs `media_assets` + enqueues the job. Returns the same `MediaWire`. 25 MB cap; Idempotency-Key required. (Presign stays the mobile path.)
- `GET /media/:id` — owner-scoped (cross-tenant → 404); **Day-19c:** a `[staff]` principal reads any live row (cross-owner). Returns `{ id, purpose, kind, url, expires_at, blurhash, width, height, duration_ms, derivatives: { label → url } }` with base + all derivative URLs presigned (5-min TTL).
- `DELETE /media/:id` — soft-expires the row; R2 object retained (Day-20+ cleanup sweep removes long-expired objects). Idempotency-Key required. **Day-19c:** owner-scoped, `[staff]` cross-owner.
- **Day-17 scope cut**: `report-photo`/`report-video` POSTs return 422 `{kind: media-staff-upload-deferred}` today; the staff portal authoring path lands Day-19.

**Push & staff bookings**

- `POST /device-tokens` · `DELETE /device-tokens/:token` — Expo push registration
- `GET /staff/bookings` [staff] · `POST /staff/bookings/:id/confirm` [staff] · `POST /staff/bookings/:id/cancel` [staff] — **portal verb 4**
- `POST /staff/bookings/:id/attendance` [staff] — per-dog check-in `{ dog_id, status: attended|no-show|excused }` → sets `booking_dogs.attendance` + `checked_in_at`/`checked_in_by_staff_id`. Booking-_outcome_ action in the verb-4 family (recording a fact); the **stats** over it are the deferred admin dashboard, not the portal.

## C.1 Booking creation flows (all six categories)

Six service categories, **three creation models**. `GET /bookings` and
`GET /dogs/:id/bookings` are the unified read surface for _confirmed_ sessions
of all six — they differ only in how a row gets _created_.

**Model 1 — Direct, credit/charge-debited.** Day School · Day Care.

- `POST /bookings` `{ category, lead_dog_id, additional_dog_ids[], dates[] }`.
- ONE txn: insert booking (+booking_dogs); per dog per mode insert
  `credit_ledger` debit (delta −1, reason `booking-debit`); assert post-balance
  ≥ 0 **or** covered by a membership **or** a PAYG `charge` ([$]).
- 8 AM–5 PM, `duration_minutes 540`; runtime end-time forced to 17:00.
- Day School only: optional **After School Coaching opt-in** sub-phase (per-dog,
  with a school-day count). Persisted as an `after_school_optins` row; the
  **"only if in Day School" gate is enforced in the schema** (composite FK to a
  `day-school` booking + `CHECK booking_category='day-school'`), not just the
  flow — sent in the `POST /bookings` payload (or `POST /bookings/:id/after-school`).
  Distinct from B&T's bundled After School Coaching (part of the B&T program, not
  this opt-in).
- Cancel `POST /bookings/:id/cancel` → status `cancelled` + `credit_ledger`
  refund (delta +1) if it was credit-funded.

**Model 2 — Enrollment, capacity-gated, real bookings.** Group Class.

- `POST /enrollments` `{ cohort_id, dog_ids[] }`.
- ONE txn: `SELECT … cohorts FOR UPDATE` → assert `filled + |dogs| ≤ capacity`
  → insert |dogs| × cohort.weeks booking rows (category `group-class`,
  `cohort_id`, shared `session_report_id`) → `cohorts.filled += |dogs|`.
- Eligibility (Manners-2 needs Manners-1) is **server-derived**
  (`GET /dogs/:id/group-eligibility`), never a client flag (R7).
- Payment: pay-now (`charge`, [$]) or pay-later (invoice) at the review phase.
  No pending/approval — capacity is the only gate. Never `POST /bookings`.

**Model 3 — Request → staff approval → booking.** Private Lesson ·
Board & Train · Boarding. **These never hit `POST /bookings` directly.**

- `POST /requests` creates a `pending_requests` row (status `submitted`),
  NOT a booking. Per-category body:
  - **Private Lesson** — multi-dog; per-dog descriptor pills (optional) +
    `notes.perDog`; shared `notes.joint` when N>1; 3 ranked `preferred_dates`.
    Pricing $/booking.
  - **Board & Train** — **single dog** (radio, not multi); `length_weeks`
    fixed = 2; goals in `notes.perDog`; optional descriptor pills; 3 ranked
    drop-off `preferred_dates`; staff preference. Pricing: flat program fee
    (`boardTrainPricing` keyed on `length_weeks`; $2,000 / 2-week standard).
  - **Boarding** — drop-off + pick-up datetimes (2 preferred-date slots),
    staff preference, notes. Pricing $/night.
- Edit `PATCH /requests/:id` (preferred_dates / notes / focus / length_weeks
  only — identity fields locked). Withdraw `POST /requests/:id/cancel`.
- **Staff approves** (`POST /staff/requests/:id/approve` [staff], portal verb
  1. → ONE txn: `pending_requests.status` → `converted`, set `approved_at` /
     `approved_by_staff_id`, insert `booking` (+booking_dogs) on the
     staffer-chosen date, set `converted_booking_id`, enqueue a
     `booking-confirmed` notification.
- **Board & Train payment step**: `POST /staff/requests/:id/approve` sets
  `pending_requests.status = approved-awaiting-payment` (real enum state). The
  user then pays — **now** (a `charges` row, [$]) or **later** (an `invoices`
  row, status `open`) — via `POST /requests/:id/confirm-payment`, which flips
  the request to `converted` and creates the `Booking`. Until paid it is NOT a
  `Booking`.
- **Confirmation + reminders**: staff confirm sets `bookings.confirmed_at`.
  Boarding/B&T carry `dropoff_at`/`pickup_at` distinct from `scheduled_at`. A
  `scheduled_notifications` row (worker-emitted: scan `status='pending' AND
scheduled_for<=now()` → push + insert `notifications` row → mark `sent`)
  drives the 24 h-before-dropoff profile-check and booking reminders —
  `notifications` is only the _delivered_ feed, never the schedule.
- Post-approval the row is a normal `Booking` (`category` ∈ `private-lesson` |
  `board-and-train` | `boarding`), reads back via `GET /bookings` like any
  other; trace origin via `pending_requests.converted_booking_id`.

**Evaluation (locked 2026-05-19).** A first-class **bookable session** —
`service_category = 'evaluation'`, a normal `bookings` row (free; no
credit-debit). Bookable / reschedulable / cancellable / reportable and shows in
Up Next like any session. Completing it (staff confirm/report) sets
`dogs.evaluation_status` — the gate the booking flows read to allow/deny other
services. Not its own table; reuses all booking machinery.

**Not a booking — Events.** Public Pups / Yappy Hour RSVPs are `event_rsvps`,
not `bookings`. They surface _in the Bookings tab UI_ alongside sessions but
are a separate resource (`/events`, `/events/:id/rsvp`) — never modeled as a
`booking` row. **Event capacity** is a _soft_ cap (`events.capacity`, NULL =
uncapped): owner self-serve RSVPs are blocked when full, but staff (portal) can
add attendees past it — deliberately not a DB CHECK, unlike cohort capacity.

## C.2 Media / file storage (locked 2026-05-19)

Photos + videos: **Cloudflare R2** (S3-compatible, zero-egress, CDN). Postgres
`media_assets` holds metadata + object key only — **never bytes**.

- **Upload:** `POST /uploads/sign` → Node authorizes via JWT, returns a
  short-lived **presigned PUT** to a private R2 bucket → client uploads
  **directly to R2** (never proxied through Node) → `POST /media` records the
  `media_assets` row → a sharp/ffmpeg worker generates derivatives.
- **Download:** assets are owner-private (no RLS). `GET /media/:id` → Node
  checks ownership/`[staff]` → returns a short-lived **presigned GET** (or
  signed CDN URL). FE `toX()` resolves `media_assets.id` → that URL; screens
  (expo-image, PhotosCarousel, PhotoLightbox, 72×72 ReportListRow thumb)
  consume URLs unchanged.
- **Derivatives at upload:** images → 2–3 fixed sizes + `blurhash`
  (expo-image already consumes blurhash); video → one web-friendly **H.264
  MP4** (no HLS — YAGNI for short trainer clips; client uses `expo-video`).
  Listed in `media_assets.derivatives`.
- **Linkage:** `dogs.profile_image_path`, `owners.avatar_image_path`, and the
  photo/video refs inside `reports.content` (JSONB) carry a `media_assets.id`,
  not a path/URL. The mock's static Metro registry (`lib/images.ts`,
  `dogReportPhotos.ts`) retires post-backend.
- **ShareableReportCard** PNG (view-shot) stays ephemeral/device-only — not an
  uploaded asset.
- Endpoints: `POST /uploads/sign` · `POST /media` · `POST /media/upload`
  (Day-19c portal proxy, `[staff]`) · `GET /media/:id` · `DELETE /media/:id`
  (owner or `[staff]` author). Staff report-authoring attaches report media
  via `POST /media/upload` (the row carries the report's dog-owner).

## D. Not re-litigated (verified contract-ready)

`focus` is already a clean discriminated union FE-side (`lib/focusTags.ts`);
`notes` is already structured `{perDog,joint}` FE-side. R1/R8 only change the
_wire_ format (drop the mock's flat-string + lossy `{perDog:raw}` collapse) —
the domain types are already right. The repo-layer `toPendingRequest` is the
single adapter that changes.

## D.1 Staff analytics — deferred to the admin dashboard (data-ready)

Staff reporting/stats — "dogs in after-school training," "what days are most
booked with what," "group-class attendance / no-show rate," and similar — is
**explicitly the deferred admin dashboard product, NOT the 4-verb minimum
portal** (locked scope, ARCHITECTURE.md "Minimum staff portal"). This is a
_surface/scope_ deferral, **not a data gap**: the schema already supports every
such query —

- after-school counts → `after_school_optins` ⋈ active day-school `bookings`
- days-most-booked-by-category → `bookings(scheduled_at, category)` group-by
- cohort attendance / no-show → `bookings(cohort_id)` ⋈ `booking_dogs.attendance`
  - `cohorts(filled, capacity)`

No `/staff/stats/*` endpoints are specced for v1. Real check-in data **is**
captured now (`booking_dogs.attendance`, set via the verb-4 attendance action),
so the metrics are computable the day the dashboard is built — don't
re-litigate "is it in the schema."

## E. Still open (does not block this contract)

JWT verify mechanics (JWKS default); ORM (Drizzle/Prisma); self-host vs.
managed Postgres. All deferred to Node-API stand-up. (Media storage = R2,
**locked 2026-05-19** — see §C.2; no longer open.)

## F. Lifecycle & integrity conventions (locked 2026-05-19)

- **The API never `DELETE`s and never destructively overwrites.** Delete /
  remove / unlink = `UPDATE … SET expired_at = now()`. Every list/read filters
  `WHERE expired_at IS NULL`. A generic `audit_log` (table + trigger) preserves
  the OLD row on every UPDATE/DELETE — every edit is fully recoverable.
- **Account/dog deletion = expire + PII-anonymize**, never row removal.
  Financial tables (`charges`, `invoices`, `credit_ledger`, `memberships`,
  `payment_methods`, `stripe_customers`) are `ON DELETE RESTRICT` and retained
  for legal/tax — this is what satisfies the privacy-policy retention clause
  and the App-Store/Play delete-account mandate simultaneously.
- **Append-only / immutable by nature** (no `expired_at`; corrections are new
  rows): `credit_ledger`, `charges`, `invoices` (status transitions only),
  `refunds`, `agreement_signatures`, `scheduled_notifications`,
  `notifications`, `audit_log`.
- **Soft-expire ↔ natural-key (2026-05-19):** every natural-key UNIQUE/PK on a
  soft-expire table is a _partial_ unique index (`WHERE expired_at IS NULL`),
  so an expired row never blocks a fresh live one (re-RSVP, re-opt-in,
  re-import a Gingr id). Re-linking a soft-expired join row = `UPDATE … SET
expired_at = NULL` on the existing row, not a second INSERT (either is now
  collision-safe). `dog_completed_classes` gained a surrogate `id` PK.
- **`idempotency_keys` is the sole never-delete exception** — transport-layer
  request dedupe, not business state; a TTL sweep prunes rows past the
  retry-safety window. No `audit_log`, no `expired_at`, by design.
- **Staff dogs (#2):** a dog belongs to **either** an `owner` **or** a `staff`
  (`owner_id` XOR `staff_owner_id`). Staff-owned dogs are `capacity_exempt`
  (generated column) and excluded from cohort/day-capacity counts. Staff are
  never clients; the owner app only surfaces the signed-in owner's own dogs.
- **Concurrency:** the credit-debited booking txn locks per `(dog_id,mode)`
  (`pg_advisory_xact_lock` or `SERIALIZABLE`) before asserting balance ≥ 0 — no
  double-spend (#3). `scheduled_notifications` workers claim `FOR UPDATE SKIP
LOCKED`; `dedupe_key` makes enqueue idempotent (#8).
- **#7 invariants enforced in DDL:** `cohort_id` iff `category='group-class'`;
  stay window only for boarding/B&T; invoice `paid` ⇒ `paid_at`. **#4** (cascade
  asymmetry) is moot — nothing hard-deletes.
- **Recurring events (#5):** `event_series` (the recurring definition) + one
  `events` row per dated occurrence (own date + that week's location);
  `events.series_id` NULL = one-off. RSVPs attach to the occurrence so per-week
  and past attendance are real data, not derived from one mutated row.
- **Business timezone (#6) = America/Chicago.** Instants stored UTC; ALL
  business-day math (day_capacity, 8am/5pm window, today/tomorrow, 24h
  reminder) computed in America/Chicago. Contract invariant — never bucket a
  calendar day off a raw UTC timestamp.
- **FE impact:** none. The API filters `expired_at`; repository `toX()` shapes
  are unchanged. `Dog.owner_id` is null only for staff dogs, which the owner
  app never fetches.

## G. Payment guarantee (anti-scam, locked 2026-05-19)

NWA bled ~$1k/client on Gingr because training proceeded with no card on file
and no upfront pay. New rule, enforced **DB-trigger + API**:

- **A live card on file is required before ANY paid booking/enroll.** A
  Postgres `BEFORE INSERT` trigger on `bookings` rejects the row when the owner
  has no non-expired `payment_methods` — an unbypassable floor (stray script /
  future endpoint can't skip it). The API checks first with a friendly error.
- **Staff-owned dogs are exempt** (`dogs.staff_owner_id` / `capacity_exempt`) —
  staff aren't billed.
- **Coverage at commit, all paid services** (group, B&T, private, day-school,
  day-care): the booking txn requires prepaid **credits** OR an active
  **membership** OR a successful **charge** OR a **card-backed invoice**. Bare
  "pay later with no collateral" no longer exists.
- **Pay-later survives only card-backed + auto-charged:** `invoices` now has a
  required `payment_method_id` + `due_at`; a worker auto-charges at `due_at`
  (`next_attempt_at` / `auto_charge_attempts` for retry/dunning). No open-ended
  unpaid balance to ghost.
- **Caveat:** protects real money only when Stripe is **live**. v1 is
  test-mode / `payments_enabled`-gated — built + testable now, enforcing for
  real at the prod launch when live keys land. Makes the _system_ scam-proof,
  not a test-mode v1.

## H. Booking gates — vaccine + agreement + evaluation (locked 2026-05-19; eval added 2026-05-23)

Three more `bookings` BEFORE-INSERT trigger floors, **identical pattern to the
payment guarantee** (§G): unbypassable, lead-dog/owner floor, **staff-owned
dogs exempt**, API enforces the full set across all `booking_dogs` and surfaces
the requirement earlier in the UX.

**Staff-dog exemption — RULED 2026-05-19, do not re-litigate.** The exemption
applies to all gates in this section _including the health/vaccine one_ and
the eval one. The objection ("vaccination is health, not billing — an
unvaccinated staff dog in a commingled session is a risk regardless of owner")
was explicitly raised and weighed; Allison chose the **uniform exemption**
anyway (staff self-manage their own dogs' vaccine/agreement/eval status out of
band; staff are never clients and operate the portal). This is a frozen policy
ruling, not a pattern accident — a future audit should not re-flag it.

- **Vaccine gate (health).** `required_vaccines` is the data-driven catalog
  (`gates_categories[]` lists the categories each vaccine is mandatory for —
  seed: rabies/dhpp/bordetella gate day-care, day-school, boarding,
  board-and-train). A `dog_vaccines` row satisfies a gate only when its
  `requirement_key` is set, it is live (`expired_at IS NULL`), and
  `expires_at >= today` **in America/Chicago**. Free-text vaccine rows
  (`requirement_key` NULL) are display-only and never gate. A blocked insert
  raises a `check_violation` the API maps to a typed 422 listing the missing
  vaccines.
- **Agreement gate (legal).** `agreement_documents` is the waiver/policy
  catalog; `applies_to = '{}'` ⇒ applies to **all** categories (the general
  liability waiver), a non-empty array scopes it. A booking is blocked until
  the owner has an `agreement_signatures` row at the doc's `current_version`.
  Signatures are append-only (a new version = a new row); re-signing is never
  an edit. Same typed-error mapping.
- **Evaluation gate (dog readiness — added 2026-05-23 per Rachel).** Day
  School, Day Care, Board & Train, and Boarding all require the lead dog
  AND every `booking_dogs` dog to have `dogs.evaluation_status = 'passed'`.
  The `evaluation` category itself bypasses the gate (the booking that
  records the eval can't require the eval). Free-text categories without
  a prereq (group-class, private-lesson) do not gate — group has its own R7
  server-derived prereq system; private-lesson is staff-curated. Blocked
  insert raises `check_violation` → typed 422 `evaluation_required` with
  per-dog `evaluation_status` (`'not-evaluated' | 'pending' | 'failed'`)
  so the FE renders the right copy variant. Pre-Day-12b history: the FE
  prototype gated day-school/day-care at the picker only (no server floor);
  Day-12b makes the floor unbypassable and widens it to B&T + boarding.
  See §A "Amendment 2026-05-23" for the full spec.
- **Gate priority order:** payment → **evaluation** → vaccine → agreement.
  Eval is the dog-readiness floor before health/legal which assume the dog
  is approved to attend. First failure aborts with full WITHIN-gate detail
  per the Day-10 envelope (§A.5).
- **FE impact:** none structural — all gates surface as the existing typed
  4xx → the error abstraction already renders category-specific recovery copy
  ("add Bumblebee's rabies record", "sign the liability waiver", "book a
  free evaluation for Bumblebee"). `GET /required-vaccines` + `GET
/agreements` + the existing `Dog.evaluation_status` field let the FE
  pre-empt every gate.

## I. Refunds & cancellation window (locked 2026-05-19; staff-tunable 2026-05-26)

- **Cancellation window.** The category-specific free-cancel _rule_ is API
  logic backed by the `cancel_window_settings` DB table (Day 13 §A
  amendment — owner-tunable from the staff portal at PATCH
  `/staff/cancel-window/:category`). Schema stores the **resolved
  outcome** (mirrors how `day_capacity` stores resolved overrides):
  `bookings.cancel_deadline_at` is set at creation by computing
  `scheduledAt − resolveHoursFor(category)`; on cancel the API sets
  `cancelled_at` and `cancel_forfeited = now() > cancel_deadline_at`.
  `status` still → `cancelled`. Editing the DB policy moves future
  bookings only — existing rows honor the deadline they were stamped
  with at booking time. Initial seed: 48h flat across all 7
  categories. API-side fallback (`lib/cancelWindow.ts:
defaultFreeCancelHoursBefore`) covers the unreachable "row missing"
  case with per-category sensible defaults (24/48/72/168 hr).
- **Refund.** Within the window: credit-funded bookings get a `credit_ledger`
  `cancel-refund` (+delta); money-funded bookings get a `refunds` row
  (`status pending` → Stripe refund → webhook flips to `succeeded`). Partial
  refunds are allowed (`amount_cents <= charge`); `charges.status` flips to
  `refunded` only when cumulative refunds equal the charge — **API logic, not
  schema**. Past the window → `cancel_forfeited`, no refund. Money-back
  (`refunds`) vs credits-back (`credit_ledger`) are deliberately distinct
  records. `refunds` is append-only/retained like `charges`.

**Amendment 2026-06-20 (staff-tunable credit-expiry settings — Phase 2; LANDED).**
The window that decides when purchased credit lots die is now staff-tunable
instead of a flat code constant. New `credit_expiry_settings` table — two-tier:
ONE org-default row (`location IS NULL`) + optional per-location override rows
(`location =` a slug). Columns: `expiry_window_months integer NOT NULL CHECK (>0)`,
`warning_lead_days integer NOT NULL CHECK (>=0)`, `updated_at`, `updated_by_staff_id`.
Exactly-one-default + one-row-per-location are enforced by TWO partial unique
indexes (`((location IS NULL)) WHERE location IS NULL` and `(location) WHERE
location IS NOT NULL`) — a nullable PK is invalid. Seeded org-default `(NULL, 12,
60)` mirrors the code default. NOT in the `audit_log` trigger list (settings
table, same as `cancel_window_settings`/`intake_field_settings`).

The resolve moved from `lib/creditExpiry.ts`' private constant to
`creditExpirySettingsRepository.resolveExpiryWindowMonths(location, tx?)`:
**per-location override → org-default → code default (`DEFAULT_CREDIT_EXPIRY_MONTHS`
= 12)**. The pure lib now takes the resolved `windowMonths` as a param —
`resolvePurchaseExpiry(grantedCount, windowMonths, now)` /
`resolveRefundExpiry(windowMonths, now)` (the `location` arg is gone; it's
consumed upstream when resolving). The 3 grant sites resolve the window in their
existing tx then pass it in: `creditPackages.ts` (sync purchase),
`webhooks/stripeEventHandlers.ts` (webhook catch-up + orphan reconstruct),
`creditLedgerRepository.refundForBooking` (fresh-lot refund when the source lot
died). **NON-RETROACTIVE, unchanged:** the window is stamped onto the lot's
`expires_at` once at purchase; a later staff change moves FUTURE grants only —
already-stamped lots keep their expiry. Single-credit packs still never expire
(null), regardless of the window number.

1. **`GET /staff/credit-expiry-settings` `[staff]`** → `CreditExpirySettingWire[]`
   — the org-default row (location null) first, then every override by slug. At
   least 1 row (the seed). `CreditExpirySettingWire = { location: LocationKey|null,
   expiry_window_months, warning_lead_days, updated_at, updated_by_staff_id:
   string|null }`. Owner → 403.

2. **`POST /staff/credit-expiry-settings` `[staff]` `[idempotent]`** → 200
   `CreditExpirySettingWire`. Body `{ location: LocationKey|null,
   expiry_window_months, warning_lead_days }`. **Upsert by location** (null = the
   org-default): a repeat write to the same location updates in place (ON CONFLICT
   on the matching partial index — the org-default branch uses raw SQL since the
   `(location IS NULL)` expression index isn't expressible via drizzle's typed
   conflict target). Validation: `expiry_window_months ∈ [1, 120]`,
   `warning_lead_days ∈ [0, 365]` (the DB CHECKs enforce `>0` / `>=0` as the floor).
   `updated_by_staff_id` stamped. Owner → 403.

`warning_lead_days` was stored consumer-less at P2; it now has BOTH its
readers: the Phase-3 `credits-expiring` push scan (landed 2026-06-20, §A
Amendment "credit-expiry Phase 3") and — Δ 2026-07-16 — the owner app's
"expiring soon" chip via the resolved value on the `GET /dogs/:id/credits`
wire, so the two warning surfaces move together when staff tune it. Inline
wire type in `routes/staffCreditExpiry.ts` (NOT portal-mirrored yet — mirrors
how `staffCancelWindow.ts` keeps its wire inline). Code:
`creditExpirySettingsRepository` (resolveExpiryWindowMonths/findAll/upsert),
`lib/creditExpiry.ts` (window-as-param), the 3 grant sites,
`routes/staffCreditExpiry.ts`; tests `staff-credit-expiry.test.ts` +
`credit-expiry-lots.test.ts`. **Still deferred:** a who-edited audit column
beyond `updated_by_staff_id`; portal real Supabase auth (rides the API
dev-bypass).

## J. Credit-package subscriptions + the alumni gate (ruled 2026-07-09, Allison)

Business rules dictated 2026-07-09; the four open pins were resolved by
Allison the same day (answers folded in below — no ⚠ pins remain).
Implementation began 2026-07-09; **API + mobile FE LANDED 2026-07-14**
(endpoints in §C; Dog wire deltas in §B; contract tests
`staff-alumni` / `alumni-attendance-scan` / `memberships`).

### J.1 Any day-program credit package can become a monthly subscription

- **Every day-school and day-care credit package** (the §B CreditPackage
  catalog) can be converted into a **monthly subscription**: the package's
  credits are granted each month on a recurring charge, instead of as a
  one-time purchase. ("Any package" and "day-program packages" are the same
  set today — the catalog contains only `mode ∈ (school, daycare)` rows; group
  classes are a separate table and are not subscribable.)
- **Term: 3, 6, 9, or 12 months — HARD STOP at term end** (Allison,
  2026-07-09 pin answer). No auto-renew, no month-to-month tail; the owner
  starts a new subscription when the term ends.
- **Where it lives in the FE:** the "Add more credits" flow (the `CreditsSheet`
  package picker on mobile). Every package the picker offers also offers
  "make it a subscription" with the term choice. **Ruled exception
  (2026-07-16, Amendment above):** the DUAL-LOCATION picker
  (`DualLocationBody`) deliberately does NOT offer subscribing — the
  single-location flow and the Dog Profile buy path cover it; revisit only
  if a real owner asks. Also 2026-07-16: the subscribe option is DISABLED
  (with a note) when the dog already holds an active same-mode membership.
- **Pause is staff-mediated, not self-serve.** The subscription UI carries a
  standing reminder: *reach out to staff if you need to pause for any reason.*
  No owner-facing pause endpoint — staff pause it (staff verb).
- **A subscription month's credits expire at that period's end**
  (`expires_at = current_period_end` on the granted lot — NOT the §I 1-yr
  window; alumni dogs §J.3 still get NULL). This is what makes Allison's
  "you have **X days left** to use **X credits**" notification real: the
  EXISTING `credits-expiring` scan (§I) already warns on approaching lot
  expiry, so period-scoped lots get the subscription-usage reminder for free —
  no new notification lane needed.
- **Mechanism — reuses the dormant `memberships` table + the invoice
  auto-charge lane, NOT Stripe Billing.** The schema has carried a
  `memberships` table (owner_id, dog_id, mode, stripe_subscription_id UNIQUE,
  status, started_at, current_period_end), a `ledger_reason='membership-grant'`
  arm, and a `charge_purpose='membership'` arm since Day-0 — all dormant.
  §J.1 activates them (supersedes this section's earlier `credit_subscriptions`
  sketch — one subscription concept, not two): additive columns
  `package_id` (FK `credit_packages(id)` — pins the priced version),
  `term_months` CHECK IN (3,6,9,12), `ends_at` (hard stop), `paused_at`,
  `paused_by_staff_id`. `dog_id` becomes required for credit subscriptions
  (grants land per-dog like every §B purchase). `stripe_subscription_id`
  stays NULL — renewals are **self-billed**: month 1 charges synchronously at
  POST (same path as a package purchase: charge → grant), then a scheduler
  phase rolls each later month by creating a card-backed `invoices` row
  (`purpose='membership'`) that the EXISTING auto-charge worker settles
  (`settleInvoiceCharge` grants the month's lot with
  `reason='membership-grant'` on the winning settle — retries/dunning/parked
  + `payment-failed` push all inherited). Pause = skip rolling while
  `paused_at` is set. Hard stop AS BUILT (2026-07-14, supersedes the
  date-compare sketch this section originally carried): term exhaustion is a
  billed-period COUNT (1 sync month + this membership's invoices = exactly
  `term_months` periods); `ends_at` is informational only. Δ 2026-07-16
  (Amendment above): the roll ALSO skips any membership with an open invoice
  (an unpaid month freezes the subscription; a late settle re-aligns the
  clock), and one ACTIVE membership per (dog, mode) is enforced end to end.

### J.2 Card on file — standing rule (reaffirms §G, now product-wide)

- **We must always have a card on file.** Not just at booking commit: a live
  card is a standing account requirement.
- **No card on file ⇒ the user cannot book.** Already enforced (§G): the
  `bookings` BEFORE-INSERT payment-guarantee trigger + the API's friendly
  error (`payment_required` 422 → mobile `BookingGateModal`). This ruling
  elevates it from an anti-scam floor to an explicit product rule — the FE
  surfaces "add a card" **proactively** (at the booking flow's book gate,
  before the user builds a booking that will bounce), not only reactively.
- Subscriptions (§J.1) require a `payment_method_id` at POST and on every
  rolled invoice — same card-backed rule as all §G pay-later.
- **Known follow-up (not built):** nothing yet blocks removing the LAST card
  while future obligations exist (open subscription / future card-backed
  invoices). Flagged for a later ruling.

### J.3 Alumni status — credits never expire, attendance-flagged (THE GATE)

Very important gate (Allison's words). All four 2026-07-09 pin answers folded
in — the earlier "lapse/revoke" sketch is superseded by the **flag** model.

- **How a dog becomes alumni: passing all 5 day-school courses** (Allison).
  The 5 courses are the curriculum programs — `foundation`, `advanced`,
  `loose-leash`, `house-manners`, `cgc` (`report_program` enum's 5 curriculum
  values; report `results` are per-skill, so course completion needs its own
  record). New table **`dog_completed_programs`** (mirrors
  `dog_completed_classes`): `dog_id`, `program` (CHECK: the 5 curriculum
  values), `completed_at`, `completed_by_staff_id` — staff-authored (portal
  verb), UNIQUE (dog_id, program). **Alumni is derived: all 5 rows present.**
  No separate status row to drift.
- **Alumni credits have no expiration date.** (a) Lots granted while alumni
  get `expires_at = NULL` at every grant site (purchase route, webhook
  catch-up/reconstruct, refund re-mint, subscription month). (b) **On
  becoming alumni (5th program recorded), the dog's existing live lots'
  `expires_at` is cleared to NULL** — "if you are alumni, no expiration
  date" applies to what they already hold, not just future grants.
- **Maintenance: attend ≥2 qualifying sessions per Chicago calendar month.**
  Qualifying categories (pin answer): **group classes + day school + day
  care** (`booking_dogs.attendance='attended'`); private lessons and
  boarding/B&T do NOT count.
- **Falling short does NOT revoke alumni and does NOT expire credits** (pin
  answer — supersedes "lapses"). It sets an **attendance flag**:
  `dogs.alumni_attendance_flagged_at timestamptz NULL`. The dog *stays*
  alumni; the FE reads the flag as *"if this dog books again we'll need an
  eval / extra check from staff."* Staff clear the flag after the re-check
  (staff verb). **Soft surface only in v1** — no booking 422; the flag rides
  the dog wire and staff see it.
- **Enforcement job:** a monthly scheduled phase in the existing scheduler
  tick (`runSchedulerTickOnce` lane): on the 1st (Chicago), for each alumni
  dog count attended qualifying `booking_dogs` in the just-closed Chicago
  month (`chicagoWallTimeToUtc` month bounds); `< 2` ⇒ stamp
  `alumni_attendance_flagged_at` (if NULL) + enqueue an owner notification
  (`scheduled_notifications` type `alumni-attendance`, dedupe key
  `alumni-attendance:<dogId>:<YYYY-MM>` — the dedupe row also makes the scan
  once-per-month-per-dog, so a staff clear later that month is not re-flagged).
- **Wire (§B Dog):** `is_alumni: boolean` (derived) +
  `alumni_attendance_flagged_at: string|null`. Mobile: alumni badge on the
  dog profile hero; amber flag warning on `CreditBalanceCard` (same pattern
  as the expiry warning row).
