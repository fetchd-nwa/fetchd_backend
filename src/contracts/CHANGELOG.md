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
