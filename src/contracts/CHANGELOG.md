# Wire contract changelog

Per-version ledger for `src/contracts/wire.ts` (`WIRE_CONTRACT_VERSION`). Every
edit to wire.ts bumps the version and gets an entry here; the prose _decision
register_ stays `.claude/backend/DATA-CONTRACT.md` (cross-reference its dated
`Δ`/`§` entries). After any bump, resync both generated clients — staff portal
and mobile app — each via its own `npm run sync:contracts`, in their own repos'
commits, and update the orchestrator's `STATUS.md`
(`<umbrella>/STATUS.md`).

Entry format: `## [x.y.z] — YYYY-MM-DD` + Added/Changed/Removed bullets naming
`Interface.field` or the enum, with a `(Δ date, DATA-CONTRACT §…)` cross-ref
where one exists.

## [1.12.0] — 2026-08-21

Additive. The withdraw response states what happened to the owner's money
(Allison 2026-08-21: "as a user it should be very clear what is happening
with my money. no uncertains"; designs/partial-success-enrollment.md
ADDENDUM 3).

- New: `EnrollmentWithdrawResultWire`, `WithdrawMoneyOutcome`. POST
  /enrollments/:cohortId/withdraw now types its response in the contract
  (previously an inline route shape — a DRIFT-26-class gap, partially
  closed). `refunded_cents` semantics unchanged; `money_outcome` names the
  settlement; `released_cents` carries the freed hold's amount.
- Old clients read the old fields unchanged; mobile ≤1.11.0 discards the
  body entirely, so the degrade is a non-event.
- Request body (documented here; request bodies remain outside wire.ts —
  the §1.2 known gap, unchanged): `POST /enrollments` gains optional
  `retry_of?: string` — the Idempotency-Key under which this dog's latest
  EXECUTED payment attempt ran; clients echo the `verify_key` from the
  dog's most recent result row and omit the field when absent (ADDENDUM 3
  §A3.13 as repaired by §A3.14). The authorize step re-issues the confirm
  under that derived key first, adopting a settled hold / reporting a
  still-verifying one / minting fresh only on a terminal prior attempt —
  at most one live hold per dog by construction (invariant proved in
  §A3.14). Omitting the field hashes identically to today's body (the
  1.11.0 `allow_partial` precedent).
- New: `EnrollmentDogResultWire.verify_key` — present iff
  `charge_unverified` (the only refusal leaving a live intent); the key
  naming the live attempt, for the echo rule above.
- New: `WithdrawMoneyOutcome` gains `'refund_manual'` +
  `EnrollmentWithdrawResultWire.owed_cents` (present iff `'refund_manual'`)
  — a refund owed on a charge with no payment-intent wiring (pre-Stripe
  seed rows) is stated truthfully as arranged-by-hand instead of the false
  "no charge on file"; `owed_cents` is the R9 remainder, computed for the
  sentence, never minted here (ADDENDUM 3 §A3.15). `refunded_cents`'s
  `> 0`-iff-`'refunded'` invariant is untouched.

Server-side (no wire shape): the withdraw arm settles EVERY charge-row
state under manual capture — cancel a live hold (released), refund a
capture that won the race (refunded), commit to automatic
release-or-refund for an in-flight payment (release_pending) — and the
capture reconciler asks the live-bookings question before capturing,
releasing instead of capturing when nothing is owed. Closes the round-3
blocker (withdraw-then-capture of a cancelled enrollment).

NOTE ON NUMBERING: [1.11.0]'s note reserving "the next minor" for the
remaining money-safety slice (memberships wire move, B&T conversion) now
points past this bump — that slice takes the next minor at its own
landing, unchanged in substance. This bump got there first because a
proven capture-of-cancelled-money outranks a planned refactor.

## [1.11.0] — 2026-08-20

Additive. Per-dog partial success on POST /enrollments (Allison 2026-08-12:
"it should report per dog … not transactional where we fail the entire
thing"; designs/partial-success-enrollment.md).

- New request field `allow_partial?: boolean` (default false — old bodies
  hash and behave identically). With it, the route enrolls every dog that
  passes its checks and reports every dog that doesn't, per dog, with the
  exact reason.
- New: `EnrollmentResultWire`, `EnrollmentDogResultWire`,
  `EnrollmentDogFailureReason`, `EnrollmentVaccineGapWire`. 201 = >=1
  enrolled; 200 = 0 enrolled. Without the field: 201 BookingWire[] unchanged.
- Old clients cannot render a partial outcome, so they are never handed one —
  the field is the degrade boundary, not the version.

Server-side (no wire shape): POST /enrollments pay-now converts to manual
capture (authorize -> enroll -> capture), the enrollments slice of
designs/money-safety-rollback-and-replay.md. A failed or abandoned enrollment
now releases holds instead of refunding captures. Partial success removes the
reason the hazard-ranked single blocker existed: every dog reports its own.

NOTE ON NUMBERING: [1.10.0] reserved 1.11.0 for the manual-capture round.
This bump delivers that round's enrollments slice (wire-invisible) together
with the envelope; the remaining slice (memberships wire move, B&T
conversion) takes the next minor at its own landing.

## [1.10.0] — 2026-08-12

Additive. `InvoiceDeepLinkReason` gains `'payment-unconfirmed'` (and the
`INVOICE_DEEP_LINK_REASONS` tuple with it). No field, endpoint, or shape
changes; an older client that does not know the arm falls back to its neutral
`'ledger'` framing rather than crashing — verified against mobile's parser
before the bump.

This exists because the auto-charge worker can finish an attempt **without
knowing whether Stripe took the money** — a transport failure after the request
left the process. Both existing arms assert an outcome: `payment-failed` says
it did not go through, `payment-due` says it has not been tried. The worker was
using `payment-failed` for the unknown case, so an owner whose money may
already have moved read "it didn't go through — try another card," and the
client's key changes with the card, which mints a second PaymentIntent. Two
charges, no refund, no reconciliation.

The arm carries "we don't know yet, don't pay again" from the push through to
the settle sheet, which is the only channel both tap paths (OS push cold start
and the in-app list) share. See `designs/auto-charge-unknown-outcome.md`.

NOTE ON NUMBERING: `STATUS.md` previously reserved "1.10.0" for the manual-capture
round. That work has not landed and now takes **1.11.0**; this bump got there
first because a live double-charge outranks a planned refactor.

## [1.9.0] — 2026-08-04

Additive. New `InvoiceDeepLinkReason` (`'payment-failed' | 'payment-due'`);
`deepLinkToPath`'s `invoice` arm accepts optional `params.reason` and emits it
as a `&reason=` query param so a payment notification's tap can open the settle
surface under the framing the push promised. Omitted = today's path; historical
rows unaffected. An invalid reason throws at emit, matching the `report` arm's
fail-loud rule — a broken deep link is not persisted.

This exists because Allison's 2026-07-31 payment-failed and payment-due sheet
copy shipped, passed its tests, and was **invisible to every owner**: no
production host ever passed a reason, so the sheet always mounted under its
neutral `'ledger'` default. The copy was right; nothing carried it.

Server-side (no wire shape): Stripe card errors THROWN by an off-session
confirm are now normalized at the Stripe seam into the same non-succeeded
result the returning fork produces, so `charge_blocker` (201 channel) and
`payment_failed` + `details.charge_blocker` (402 channel) now genuinely cover
both Stripe behaviors — the residual named against `[1.8.0]` ("the thrown
channel is unbuilt on the settle routes") closes. Non-card errors — connection,
rate-limit, invalid-request — rethrow untouched, so a network failure to Stripe
is never relabelled a decline.

### Changed (doc-only)

- **`InvoicePayWire.charge_blocker`** — presence gloss corrected. It claimed
  presence IFF `charge_status: 'requires_payment'`, which is false: a `canceled`
  raw status maps to `charge_status: 'failed'` and still carries a blocker.
  Branch on the blocker's presence, never on a status pairing.
  `CreditPurchaseWire.charge_blocker` cross-references it and inherits the fix.

### Not in the wire delta, named

The `payment_failed` error envelope and its `details.charge_blocker` stay
outside `wire.ts` — error codes ride the envelope, per the 2026-08-03
addendum's rule. The envelope being unversioned is a pre-existing known gap and
is not widened here.

## [1.8.0] — 2026-08-03

Additive (Allison 2026-08-03: **"we need this to be clear, not generic"**). She
rejected merged copy for the failed-payment arm. The client could not be
specific because the wire destroyed the distinction, so the wire now carries it.
No field is removed or retyped and no DDL changes; a client that ignores the new
field behaves exactly as it did at 1.7.1.

### Added

- **`ChargeBlocker`** — `'authentication_required' | 'declined' | 'processing'`.
  Why a confirm stopped short of `succeeded`, at the domain level.
  `ChargeStatus` cannot carry this: it is pinned to the `charge_status` pgEnum,
  and `stripeIntentStatusToChargeStatus` (`src/lib/stripe.ts:104-110`) collapses
  FIVE Stripe statuses — `requires_payment_method`, `requires_confirmation`,
  `requires_action`, `processing`, `requires_capture` — into the single value
  `requires_payment`. "Needs verification", "was declined" and "still
  processing" are three different true sentences with three different next
  actions for the owner, and the collapse destroyed exactly that. Widening
  `ChargeStatus` would be a DDL change; this is deliberately not that.
- **`InvoicePayWire.charge_blocker?`** — present iff the response reports a
  non-succeeded confirm (`invoice_status: 'open'` + `charge_status:
  'requires_payment'`). Absent on settled arms, and absent on stored idempotency
  replays of pre-1.8.0 responses, so clients must keep deriving pessimistically
  when it is missing.
- **`CreditPurchaseWire`** — **moved in** from `routes/creditPackages.ts:64-70`,
  shape unchanged, and gains the same `charge_blocker?`. A second money endpoint
  was sitting outside the versioned contract with nothing for `check:contracts`
  to guard — the same condition that let the invoice card picker drift into
  charging a card the owner never tapped (see 1.7.0).

### Not added, deliberately

- No `charge_blocker` on `POST /requests/:id/confirm-payment`. Per the same
  day's design addendum that route now REFUSES a non-succeeded board-and-train
  confirm outright rather than returning a 201, so it has no non-succeeded
  success body to carry the field; the reason rides the `payment_failed` error
  envelope's `details.charge_blocker` using the same union, so clients keep one
  taxonomy across both channels.
- No new DB column. The blocker is transient advice about a synchronous
  response, not accounting state: R32 keeps non-succeeded charges out of the
  owner ledger, so no read path wants it later, and support lookups ride
  `stripe_payment_intent_id` into the Stripe dashboard, which holds the full
  truth.

## [1.7.1] — 2026-08-03

Doc-only. No shape change, no field added, removed, or retyped; no client is
forced to move. Written before the behavior it describes was implemented, so
that the contract leads the change rather than trailing it.

### Changed

- **`InvoicePayWire.client_secret`** — documented, for the first time, as **not
  a completable intent**. The 2026-08-03 adversarial review found that
  `POST /invoices/:id/pay` was the one settle path that did not cancel a
  non-succeeded PaymentIntent — `invoiceAutoCharge.ts:268`,
  `enrollments.ts:765` and `memberships.ts:259` all do, and the worker's comment
  says why: so it "can't later auto-succeed and double-charge against the next
  retry's fresh PI". `POST /credit-packages/:key/purchase` shares the gap.
  The design (`<umbrella>/designs/invoice-pay-card-selection.md` § Gap 3) makes
  the cancel a rule for the class, which means the returned `client_secret` on
  the non-succeeded arm now names a *cancelled* intent. The field was previously
  undocumented, which is the trap: a client author would reasonably assume a
  client secret is there to be completed. It is returned for logging and support
  lookup only. A future 3DS-completion design must revisit the rule and
  re-document the field in the same change.

## [1.7.0] — 2026-07-31

Additive (Allison 2026-07-31: "fix the contract properly"). The pay endpoint
enters the versioned contract and gains an optional request body. No field is
removed or retyped, and a bodyless call behaves exactly as it did in 1.6.1.

### Added

- **`InvoicePayRequest`** — `POST /invoices/:id/pay` body, `{ payment_method_id?:
  string }`. The card the owner picked at settle time. Before this the endpoint
  took no body and always charged the invoice's BOUND card, so the mobile pay
  sheet's card picker was decorative: an owner could select "Mastercard ••8203"
  and be charged their Visa. The server now verifies the card is a live card of
  the calling owner (404 otherwise, tenancy-miss-collapses-to-404 per §G) and
  repoints `invoices.payment_method_id` at it inside the settle tx, so
  `LedgerEntryWire.settled_card` cannot name a card that was never charged.
- **`InvoicePayWire`** — the response, **relocated** here from
  `src/routes/invoices.ts`. Shape unchanged. It had never been in the contract,
  which meant the money endpoint had nothing for either client's
  `check:contracts` to guard — the condition that let the picker drift.
- **`ChargeStatus`** — `'requires_payment' | 'succeeded' | 'failed' | 'refunded'`,
  moved from `chargesRepository` (which now re-exports it) because
  `InvoicePayWire.charge_status` reports it. Pinned against the `charge_status`
  pgEnum in `conformance.ts` like every other shared enum.

### Note for client authors

`payment_method_id` is optional on purpose. Canonical-JSON request hashing drops
`undefined` keys, so an omitted card hashes byte-identically to the pre-1.7.0
`{ id }` body and no in-flight `Idempotency-Key` breaks. Two calls naming
DIFFERENT cards now hash differently — under the old `hashRequestBody({ id })`
they collided, so the second call replayed the first's stored response and the
owner was told a card had been charged that never was.

## [1.6.1] — 2026-07-31

Doc-only (still regenerates both clients). The `payment-due` arm's comment said
the cash/check reminder fires "~1h before the linked booking's drop-off". Allison
raised the lead to **24h** on 2026-07-31 so it arrives the day before rather than
the morning of; `PAYMENT_DUE_LEAD_MS` changed with it. No shape or enum member moved.

## [1.6.0] — 2026-07-30

Additive (waitlist, Allison 2026-07-30). One new deep-link kind; no field or
enum member is removed or retyped.

### Added

- `NotificationDeepLinkKind` arm `'waitlist'` → `/waitlist/:waitlistEntryId`,
  the destination for `waitlist-spot-open`. Deliberately NOT a booking link:
  when a seat opens nothing is booked yet — the notification is an OFFER the
  owner accepts or declines, and payment happens on accept. A booking deep link
  would point at a row that does not exist.

## [1.5.0] — 2026-07-29

Additive (Allison's notification sweep, 2026-07-29). Three new `NotificationType`
arms, one new deep-link kind, and one changed emission for an existing kind. No
field or enum member is removed or retyped; both clients resync and nothing
breaks. Historical `credits` rows persisted the query-less `/dog-profile/:dogId`
and still parse (backward-compat rule) — only NEW emissions carry `?highlight`.

### Added

- `NotificationType` arms `'invoice-overdue'`, `'card-expiring'`,
  `'waitlist-spot-open'` (pgEnum `notification_type` ALTERed on both DBs; the
  `conformance.ts` `Equal<>` pin holds). `invoice-overdue` is the settle-failure
  safety net (an invoice still open 3 days past due; fires once).
  `card-expiring` warns a week before the card on file lapses. `waitlist-spot-open`
  fires when a seat opens for a waitlisted entry — an OFFER the owner accepts or
  declines, with payment on accept; nothing is booked or charged when it fires
  (Allison 2026-07-29). No producer yet; the waitlist feature is not built.
- `NotificationDeepLinkKind` arm `'payment-method'` →
  `/payment-methods?highlight=<paymentMethodId>`, so a card warning points at
  the card rather than at the wallet page.

### Changed

- `deepLinkToPath` `credits` arm now emits `/dog-profile/:dogId?highlight=credits`
  (was the bare `/dog-profile/:dogId`). `highlight=credits` is a SENTINEL, not an
  id — the credits card is a singular surface on that page — and it makes the
  card one-shot flash so a credit-expiry alert lands on the thing it is about.

## [1.4.0] — 2026-07-28

Additive (Notifications Phase 4d, Allison's third sim-QA round 2026-07-28). No
existing field or enum member moves; both clients resync but nothing breaks. Old
persisted membership paths without `?highlight` still parse (backward-compat).

### Added

- `LedgerEntryWire.settled_method` (`'card' | 'cash' | 'check'`),
  `LedgerEntryWire.settled_card` (`{ brand; last4 }`), `LedgerEntryWire.settled_at`
  (`string`) — settle detail for a PAID ledger entry (R1). `settled_method` is
  `'card'` for every settled charge today (`'cash'`/`'check'` reserved for a future
  staff mark-paid flow, never emitted yet); `settled_card` is the settling card,
  present only when the paid charge back-references an invoice with a live
  payment_method (direct package/membership charges carry none); `settled_at` is
  the precise settle timestamp (`invoices.paid_at` when invoice-linked, else the
  charge's `created_at`). All omitted on open/refunded entries.

### Changed

- `deepLinkToPath` `membership` arm — the `params.dogId`-present branch now emits
  `/dog-subscriptions/:dogId?highlight=:membershipId` (was the query-less
  `/dog-subscriptions/:dogId`), so the app one-shot flashes the SPECIFIC ended
  subscription card (Allison 2026-07-28, R4). `link.id` is the membership id
  (`membershipRoll` already passes it — no producer change). Absent `dogId` still
  routes to `/account/memberships`. Historical rows persist the highlight-less path;
  the clients' parser keeps accepting them.

## [1.3.0] — 2026-07-27

Additive (Notifications Phase 4c, Allison's second sim-QA round 2026-07-27). No
existing field or enum member moves; both clients resync but nothing breaks.

### Added

- `NotificationType` enum — new arm `'payment-due'` (14 arms total). The
  cash/check invoice reminder: `POST /invoices/:id/pay-in-person` schedules it to
  fire ~1h before the linked booking's drop-off, or ~1h before the invoice's due
  time when no booking is linked. Mirrors the `notification_type` pgEnum;
  `conformance.ts` pins the two in lockstep (R3).
- `BookingWire.cancelled_by` (`'owner' | 'staff'`) + `BookingWire.cancel_reason`
  (`string`) — WHO cancelled a booking and the optional staff-supplied reason,
  surfaced in the owner app's cancelled-booking banner. Emitted only on a
  cancelled booking, omitted when null (same convention as `cancelled_at`) (R5).

## [1.2.0] — 2026-07-27

Additive: entity-specific deep-link destinations (Notifications Phase 4b, per
Allison's sim-QA rulings 2026-07-27). Grammar change only — no interface or enum
shape moves. Old persisted paths remain valid; the clients' `parseNotificationDeepLink`
allowlist keeps accepting them, so only NEW emissions carry the new grammar.

### Changed

- `deepLinkToPath` `invoice` arm — now embeds the invoice id:
  `/account/invoices?invoiceId=:id` (was the fixed `/account/invoices`). Powers
  the pop-up-modal, per-invoice view (Allison decision 1). Producers already pass
  `link.id` (since Phase 2), so no producer changes.
- `deepLinkToPath` `membership` arm — now params-driven (Allison decision 4,
  send-time routing): `params.dogId` present ⇒ `/dog-subscriptions/:dogId` (a lone
  membership ending routes to that dog's subscriptions page); absent ⇒ the fixed
  `/account/memberships` overview (the simultaneous-endings case — the same owner
  has multiple memberships completing in one worker tick). `membershipRoll` decides
  which at emit time.

## [1.1.0] — 2026-07-25

Additive: the notifications surface enters the contract (it was hand-mirrored
per-repo before — see the amended "Known gaps" under 1.0.0). Notifications
Phase 3.

### Added

- Enum unions: `NotificationType` (13 arms, mirrors the `notification_type`
  pgEnum — pinned in `conformance.ts`), `NotificationDeepLinkKind` (9 arms);
  value tuple `NOTIFICATION_DEEP_LINK_KINDS`.
- Wire interfaces: `NotificationWire` (moved here from `lib/notificationWire.ts`,
  which now re-exports it), `NotificationListResponse` + `UnreadCountResponse`
  (moved here from `routes/notifications.ts`), `NotificationPushData` (pins the
  snake_case push `data` keys so they can't drift from the wire — closes the D2
  push/wire mismatch), `NotificationDeepLink`.
- Helper: `deepLinkToPath(NotificationDeepLink)` — the single deep-link path
  grammar every producer derives `deep_link_path` from (decision 8).

### Changed

- 1.0.0 "Known gaps" → **Owner surfaces**: dropped `notifications` from the
  hand-mirrored list (now contracted here).

## [1.0.0] — 2026-07-20 (baseline)

First versioned cut. Documents what the contract covers today and what is
knowingly outside it (tracked in the orchestrator's STATUS.md drift ledger).

### Covered

- Enum unions + value tuples: `ServiceCategory`, `BookingStatus`,
  `RequestStatus`, `ThreadCategory`, `ReportProgram`, `LocationKey`, `RateUnit`,
  `StaffRole`, `AttendanceStatus`, `MediaPurpose`, `MediaKind`, `LessonSetting`;
  tuples `SERVICE_CATEGORIES`, `LOCATIONS`, `RATE_UNITS`, `REPORT_PROGRAMS`,
  `SESSION_PROGRAMS`; helper `isSessionProgram`.
- Wire interfaces: `BookingWire`, `AttendanceWire`, `PendingRequestNotesWire`,
  `PendingRequestFocusWire`, `PendingRequestWire`, `DivertedBookingWire`,
  `BookingDivertPreviewDogWire`, `BookingDivertPreviewWire`,
  `ThreadParticipantWire`, `ThreadWire`, `MessageAttachmentWire`, `MessageWire`,
  `SkillResult`, `PracticeItem`, `ReportWire`, `MediaWire`, `StaffDogWire`,
  `StaffRateWire`, `StaffRateHistoryWire`.

### Known gaps (contract surface that exists on the wire but not in this file)

- **Error envelope** — `ApiErrorCode` (~24 stable codes), the
  `{ error: { code, message, details? } }` shape, and the discriminated gate
  `details` live in `src/lib/errors.ts` + `src/lib/bookingErrors.ts` +
  `src/auth/plugin.ts`, not here. Both clients hand-mirror the envelope.
- **Owner surfaces** — dogs (`lib/dogWire.ts`), credits/ledger, enrollments,
  group classes/cohorts, memberships, invoices, user/me, events, payment
  methods, availability, announcements, vet. The mobile app hand-mirrors these
  per-repository. (Notifications graduated to the contract in 1.1.0.)
- **Request bodies** — this file covers responses only; POST/PATCH body shapes
  are uncontracted.
