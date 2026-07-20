# Wire contract changelog

Per-version ledger for `src/contracts/wire.ts` (`WIRE_CONTRACT_VERSION`). Every
edit to wire.ts bumps the version and gets an entry here; the prose _decision
register_ stays `.claude/backend/DATA-CONTRACT.md` (cross-reference its dated
`Δ`/`§` entries). After any bump, resync both generated clients — staff portal
and mobile app — each via its own `npm run sync:contracts`, in their own repos'
commits, and update the orchestrator's `STATUS.md`
(`fetchd_client_mobile_app/.claude/STATUS.md`).

Entry format: `## [x.y.z] — YYYY-MM-DD` + Added/Changed/Removed bullets naming
`Interface.field` or the enum, with a `(Δ date, DATA-CONTRACT §…)` cross-ref
where one exists.

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
  methods, availability, notifications, announcements, vet. The mobile app
  hand-mirrors these per-repository.
- **Request bodies** — this file covers responses only; POST/PATCH body shapes
  are uncontracted.
