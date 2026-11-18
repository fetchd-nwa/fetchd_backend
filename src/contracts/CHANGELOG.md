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

## [9.0.0] — 2026-11-16

BREAKING. The fix phase Allison ordered first (build DECISIONS 396, 402); plan unit P49,
Part A of `designs/request-services-v1.md` (`ca68ec459711b786`, §2.2 A1–A13), adopted
with changes by Fable's re-read (`units/P49/review-note-fable-r2.md`; DECISIONS 416,
418, 421). Her words: "i want private and board and train to be active" (393); "default
to what shanthi says / remember, for privates and board and trains staff must approve it
for it to officially be booked / bookable and then fake stripe card, liek what ive been
doing now" (413); "correct" (414). Private lessons and Board & Train become bookable and
are booked only after staff approve: a lesson when staff confirm one of her times, a
Board & Train when staff approve dates and a trainer and the family says yes to them.
**No step moves money.** Nobody charges a card for either service; the bill at the end,
which the family taps to pay, is plan unit P51's (9.1.0, additive). Shanthi's "paid at
the end" binds (`12-shanthi-answers-10-01.md:40-41`, `:146`). Not a design section
(design_label none). Build label 9.0.0 (DECISIONS 402, 418): a breaking fix-phase step
skips 7.0.0 and 8.0.0, which are design labels, and nothing parses the version. It reads
6.2.0 (P48). S42/P31 is relabelled to build 9.2.0, provisional. Breaking because A1
removes a route and its body, and A3, A4, A5 and A14 refuse bodies and calls that used
to succeed. A14 (DECISIONS 459) rides this step: it closes BUG-11's `POST /dogs` arm. No shipped client calls anything removed (mobile never calls
`confirm-payment`, DRIFT-7; the portal has no request adapter); the route's 404 test is
the proof, not that search. Contract-first: the routes keep today's behaviour until
P49's backend lands them, and the two services stay off in the offerings seed until
M5.24, P49's last backend commit. Resync both clients (`npm run sync:contracts` in
mobile and portal). Against this copy the backend's `npx tsc --noEmit -p .` fails 4
times in 3 files, each the builder's to close: `conformance.ts:89` (the
`notification_type` Drizzle enum lacks `'request-approved'` until M5.20's mirror),
`requestConfirmPayment.ts` twice (the file A1 deletes) and `staffRequests.ts:106` (the
approve body's pin, until its schema gains the three keys). `wire.ts` alone compiles.
The clients were not run against it.

### Breaking

- **A1 (breaking, removed).** `POST /requests/:id/confirm-payment` and its body
  `PostRequestsConfirmPaymentRequest` removed. It charged $2,000.00 at confirm or wrote
  an invoice due on a date the owner chose (BUG-6, NOTE-7). The route answers 404. Its
  successor is A2.
- **A3 (breaking, tightening).** `PostStaffRequestsApproveRequest` gains
  `trainer_staff_id?`, `dropoff_at?` and `duration_minutes?`, and its rules tighten.
  Private lesson: `scheduled_at` must be one of her `preferred_dates` and in the future
  (at or before now is 422, DECISIONS 463);
  `trainer_staff_id` is required, a live staffer with a lesson price, the one she named
  unless she chose "anyone"; `duration_minutes` defaults to 60; the booking stores the
  trainer, length and quote (that trainer's price), and the confirm notice names them.
  Board & Train: the body is no longer ignored; `dropoff_at` (one of her starts, in the
  future), `pickup_at` (after it) and `trainer_staff_id` (live and eligible; the one she
  named, if any) are required, `scheduled_at`, `location`, `duration_minutes` and
  `notes` refused; the four approved fields (A6) are stored, the request still parks at
  `'approved-awaiting-payment'`, and `'request-approved'` (A11) is queued. An old row
  with `length_weeks` other than 2 is refused in words. Boarding is unchanged and
  refuses the three new keys. No arm moves money.
- **A4 (breaking, tightening).** `PostRequestsRequest` and `PatchRequestsRequest`: a
  Board & Train's `length_weeks` takes 2 only (was 1..12; Zod still bounds 1..12, so 3
  is 422 and 13 is 400), and PATCH refuses `null` for it. On a private lesson or a
  Board & Train, `focus.staff_preference` is `'any'` or the `staff_id` of a live
  staffer with a price (lesson) or Board & Train eligibility, as `GET /trainers` lists
  them; omitted or cleared means "anyone". Boarding's is unchanged.
- **A5 (breaking in behaviour; it changes no type).** The owner's
  `POST /bookings/:id/cancel` and the staff `POST /staff/bookings/:id/cancel` refuse,
  with 409 `conflict`, a private-lesson or board-and-train booking whose start
  (`dropoff_at`, else `scheduled_at`) has passed. `BookingWire.can_cancel` is now
  present on every private-lesson and board-and-train row, `false` once its start has
  passed or it is cancelled and `true` before, so the app hides Cancel. Doc only: no
  type changes.
- **A14 (breaking, tightening; no type change).** `POST /dogs` from an owner refuses a
  body carrying `evaluation_status` or `evaluation_date`, with any value (`null` and
  `'not-evaluated'` included), with 400 `bad_request` right after the parse: a body
  that answered 201 now answers 400, and nothing is written. Every dog an owner
  creates is `'not-evaluated'`. Closes BUG-11's `POST` arm (DECISIONS 459).
  `PostDogsRequest` keeps both optional keys until P09's EVAL-U02 makes the body
  `.strict()` without them; staff and seed paths are unchanged. `PATCH /dogs/:id`
  still stores both from the owner, a known gap until P09 (BUG-11's `PATCH` arm).
  The owner app sends neither (Add a dog opens at P07).

### Added

- **A2 (additive).** `POST /requests/:id/confirm` `[owner]`, body none or `{}`
  (`.strict()`), Idempotency-Key → 200 `PostRequestsConfirmResponse {request:
  PendingRequestWire, booking: BookingWire}`. The family's **Yes, book it**: Board &
  Train only, from `'approved-awaiting-payment'`, her own (else 404). The booking gates
  run (card on file, vaccines, agreements; no evaluation gate), the stay is inserted at
  the approved dates, trainer and quote at her home campus, and the request is
  `'converted'` keeping the approver's id. Moves $0. 409 `conflict` from any other state,
  once the approved drop-off has passed, and when the approved trainer is no longer live
  or Board & Train eligible (staff take it back; DECISIONS 463, 466). One winner against
  her Withdraw or a staff Take back (the same row lock).
- **A6 (additive).** `PendingRequestWire.approved_trainer? {staff_id, name}`,
  `.approved_dropoff_at?`, `.approved_pickup_at?` and `.approved_price_cents?`, on a
  Board & Train from its approval on, kept after her yes and after a cancel.
- **A7 (additive, a supertype).** `GET /staff/requests` answers
  `GetStaffRequestsResponse = StaffRequestWire[]`; `StaffRequestWire` is
  `PendingRequestWire` + `owner {id, name, location?}` + `dogs {id, name}[]` +
  `preferred_trainer? {staff_id, name}`. `owner.location` is the family's home campus,
  omitted when it has none: the portal pre-fills a lesson's campus with it, and a Board &
  Train books there at her yes. Query and order unchanged; approve and deny still answer
  `PendingRequestWire`.
- **A8 (additive).** `BookingWire.quoted_price_cents?` (private lesson and Board &
  Train: the price fixed at booking), and `.dropoff_at?` and `.pickup_at?` on a
  boarding or board-and-train row. The existing `BookingWire.trainer` is now filled for
  every lesson and Board & Train booked from 9.0.0.
- **A9 (additive).** `GET /trainers` `[any principal]` → `GetTrainersResponse =
  TrainerWire[]`, `TrainerWire {staff_id, name, private_lesson_price_cents?,
  board_and_train}`: live staff with a lesson price or Board & Train eligibility,
  ordered by name.
- **A10 (additive).** `GET /staff/service-bookings` `[staff]` →
  `GetStaffServiceBookingsResponse = StaffServiceBookingWire[]`,
  `StaffServiceBookingWire {booking_id, category, owner, dogs, scheduled_at,
  duration_minutes?, dropoff_at?, pickup_at?, trainer?, quoted_price_cents?,
  location?}`: every live, uncancelled private lesson and Board & Train, ordered by
  start, no age bound, no card field. `trainer`, `quoted_price_cents` and `location`
  are optional only for a row booked before 9.0.0 (dev only) or, for `location`, a
  Board & Train whose family has no home campus.
- **A11 (additive, unions widened).** `NotificationType` gains its 16th value,
  `'request-approved'` (appended to `NOTIFICATION_TYPES`; M5.20); push category
  `urgent-updates`. `NotificationDeepLinkKind` gains `'request'` (appended to
  `NOTIFICATION_DEEP_LINK_KINDS`; `deep_link_kind` is `text`, no DDL), which joins
  `NotificationDeepLink`'s id-bearing arm, and `deepLinkToPath` gains its case:
  `{kind: 'request', id, params: {category}}` → `/request-detail/boardtrain?id=<id>`
  for `'board-and-train'` or `/request-detail/private?id=<id>` for `'private-lesson'`;
  any other or missing category throws at emit, as the `report` arm does.
- **A13 (additive: it accepts what it refused; no type change).**
  `POST /staff/requests/:id/deny` also takes back a Board & Train in
  `'approved-awaiting-payment'` (the portal's **Take back**). The row keeps its
  approved fields; a yes after it is 409; a new Board & Train request for the dog is
  then accepted.

### Documentation

- **A12 (doc).** Board & Train leaves every evaluation-gate comment on `POST /requests`
  and `evaluation_required` (`PostRequestsErrorDetails` arm 1 is boarding only;
  `PostRequestsRequest` says so); s21. The arm, its tuple and its type are unchanged:
  boarding still sends it.
- `RequestStatus`: `'approved-awaiting-payment'` is a historical name meaning "waiting
  for the family's yes"; nothing is paid there (A6).
- `PendingRequestWire.approved_by_staff_id`: a Board & Train cancelled after approval
  keeps a staff id whoever cancelled it (the approver's after her Withdraw, the denier's
  after a Take back), so a cancelled row with `approved_dropoff_at` reads "Cancelled",
  not "Denied by the school" (Fable r2 M5). `PostStaffRequestsDenyRequest` says the same.
- `PostRequestsRequest`'s `service_not_offered`: the switch stops new requests only; the
  staff approve and the family's yes do not read it, so an approval in flight stands
  (DECISIONS 463).
- `PostBookingsRequest` names the family's yes as a Board & Train's door;
  `PostRequestsErrorDetails` says a Board & Train's gates fire at her yes.
- The payments domain's `payment_failed` emitter list drops `requestConfirmPayment`.
- `ServiceOfferingWire.offered` and `PostRequestsRequest`'s `service_not_offered` name
  M5.24 as the step that seeds private-lesson and board-and-train on; boarding stays off.
- The landing-group note names 9.0.0, P51's 9.1.0 and S42's 9.2.0.
- A14: `PostDogsRequest`'s "accepted from the OWNER … deliberately NOT tightened" note is
  rewritten (the owner's create refuses both keys; P09 removes them).
  `PatchDogsRequest` names its owner-set evaluation as a known gap until P09.
  `DogWire.evaluation_status` names the three gated categories (A12) and both arms.
- Doc only, riding 9.0.0 (orchestrator, plan.json P49 `brief_must_say` 8 and 10):
  `POST /bookings/:id/dogs/:dogId/after-school/remove`'s new-key refusal names
  `session_checked_in` beside `session_ended` (P48 Opus C-N1, build DECISIONS 474);
  `EnrollmentWire.start_date` and `first_session_at` are ISO-8601 instants
  (`pgTimestampToIso`; before 9.0.0 they were Postgres text, which Hermes cannot
  parse; build DECISIONS 489).
- Riding 9.0.0 (design `request-services-v1.md` § 14, Amendment A1; build DECISIONS 511):
  `RequestStayConflictDetails` (`kind: 'conflict'`, `reason: 'stay_overlap' | 'dog_removed'`,
  `dog_id`) joins `ApiErrorDetailWire`; `POST /requests/:id/confirm` gains its two 409s;
  `POST /staff/requests/:id/approve` refuses a removed dog on every arm, and on a Board &
  Train an overlapping stay and a same-day hand-back (422); the validator names are
  corrected (Fable b1 N3).

## [6.2.0] — 2026-11-14

ADDITIVE. The fix phase Allison ordered first (build DECISIONS 396, 402, 407,
408(c)); plan unit P48, her playground #8 ("After school training caps out at 10
people … say like X/10 for each day … or grey it out if full") and her 11-14 answer
("i want the capacity shown for each day for the user to see … i should be able to go
into each booking and unselect the after school training if i want"). Not a design
section (design_label none). Build label 6.2.0: S42 (design 7.1.0), once build 6.2.0,
now ships as build 6.5.0 (plan.json `wire_label_map`). Every field is optional and the
route is new, so a 6.0.0 client reads 6.2.0 unchanged. Contract-first: the fields and
the route do not exist until P48's backend lands them. Resync both clients.

### Added

- `DayCapacityWire.after_school_capacity?` and `.after_school_remaining?`: each date's
  after-school places at that campus (`day.after_school_capacity_count`, 0 on a date
  with no day school or at a campus not offering it) and the places still free,
  advisory; 422 `after_school_full` stays the authority.
- `POST /bookings/:id/dogs/:dogId/after-school/remove` (owner, no body, Idempotency-Key):
  takes one dog's after-school off a day-school session, 200 `BookingWire`; moves no
  credit or money; the one-dog cancel's refusals without its switch.
- `BookingWire.dog_shares[].can_remove_after_school?`: whether that route would accept
  this dog now.
- `PostBookingsDogsAfterSchoolRemoveResponse` (= `BookingWire`), naming the route's 200.

### Documentation

- `BookingWire.dog_shares[].after_school`: "No route changes it after the booking" is
  now "the owner may take it off (6.2.0); no route turns it on after the booking".

## [6.0.0] — 2026-11-14

ADDITIVE. LG5's close (plan unit P22, slice S35; ledger PAY-U24, PAY-U25, PAY-U27,
PAY-U28, CRED-U18; migration M5.11 a pointer, done at M1.21; M5.10's columns landed in
P20; design §1.1 6.0.0, `designs/fetchd-v1-technical-design.md:1094-1133`; §2.7
`:4163-4334`; §2.4 `:3112-3159`; §2.10 `:5002-5021`). 6.0.0 lands for clients when P22
is gate-green and pushed on `v1/build`. Every field is optional or new, and every code
is appended, so a client built against 6.0.0-lg5.2 reads 6.0.0 unchanged.
Contract-first: the routes do not exist until P22's backend lands them. Resync both
clients (`npm run sync:contracts` in mobile and portal). Against the resynced copy (a
scratch run at the P21 working trees, not their gates) the backend fails once, its
credit-adjustment body pin; mobile and the portal compile clean.

### Added

- The staff refund, owner and manager, any amount up to what was paid, case by case
  (the 10-12 money ruling and follow-up 2, `SIGNOFF.md:252-254`; answer 11). Four
  routes, each 403 `refund_role_required` for a role its rule refuses:
  - `GET /staff/payments/:id/refund-proposal` →
    `GetStaffPaymentsRefundProposalResponse {proposed_cents, basis,
    unbooked_unspent_credits?, expired_unspent_credits?, booked_ahead?,
    per_credit_cents?, method, recorded_by?}` (PAY-U28, CRED-U18): on a package
    charge, the purchase lot's live unbooked, unspent credits × the per-credit price;
    expired ones counted apart, removed but never proposed as money. Read by
    `capabilities.refund_money`'s rule.
  - `POST /staff/refunds` (`PostStaffRefundsRequest {payment_id, amount_cents,
    instrument, reason, credits_to_remove?, enrollment_id?}`) → 201 `RefundWire`
    (PAY-U24, PAY-U25, CRED-U18). The list (`staff.refund_role_list`), or any role up
    to `pay.refund_any_role_limit_cents` (seeded 0). The credits staff choose leave
    the purchase lot at the mint, one `adjustment` row naming the refund.
  - `POST /staff/refunds/:id/retry`, bodyless → 201 `RefundWire`: *Retry to card*,
    money only, on the failed head of a retry chain.
  - `POST /staff/refunds/:id/resolve-external`
    (`PostStaffRefundsResolveExternalRequest {note, outcome?, instrument?}`) → 200
    `RefundWire`: *Returned*, on a failed or unroutable head; `withdrawn` moves no
    money and puts the first refund's removed credits back (question 41, (a) with
    both riders; PAY-U27's closing verb).
- `RefundWire {id, charge_id, owner, item, amount_cents, instrument,
  returned_instrument?, status, reason?, issued_by?, retry_of_refund_id?,
  enrollment_id?, resolved_by?, resolved_at?, resolution_note?, resolved_outcome?,
  created_at}`, with `RefundInstrument` (`'original_card' | 'cash' | 'check'`) and
  `RefundResolvedOutcome` (`'returned' | 'withdrawn'`). No `account_credit`.
- Six thrown codes, the 50th to the 55th, appended: 403 `refund_role_required`; 422
  `over_cap`, `instrument_unavailable` and `instrument_mismatch`; 409
  `refund_superseded` and `refund_in_flight`. None carries `details`.
  `instrument_mismatch` is typed now and thrown from build 11.1.0 (design 6.1.0),
  when a charge can be paid by hand; until then `cash` and `check` answer 422
  `instrument_unavailable` (PAY-U27).
- `StaffPaymentWire.stripe_payment_intent_id?` on `GET /staff/owners/:id/payments`
  (owner and manager), for the portal's Stripe-dashboard link; never on
  `StaffInvoiceWire` (question 58).
- `StaffPaymentRefundWire.retry_of_refund_id?` on the same read: the earlier row of
  the payment that a refund retries. A row another row of the payment names is not
  its retry chain's head, so the portal draws *Retry to card* and *Returned* on the
  head alone, and an older link reads as retried rather than as money still owed.
- `PostStaffOwnersCreditAdjustmentsRequest`'s `'remove'` arm takes `refund_id?`, the
  refund a hand removal answers (a refund adopted from the Stripe dashboard).

### Changed (live, no shape change)

- `StaffInvoicePaymentWire.refundable_cents` stops counting a refund closed
  `withdrawn`, so the cap reopens by its amount. A `resolved-external` row closed
  before 6.0.0 has no outcome stored and still counts.
- `RefundStatus`'s state machine gains its one backwards edge, `succeeded → failed`,
  at most once: the cap reopens, a `'refunded'` charge is recomputed, and the
  removed credits stay removed. Every refund event reads the refund's live status
  back from Stripe. A retry is a new row; the failed row it names stays `'failed'`.

### Documentation

- `StaffCapabilitiesWire.refund_money`, `StaffSettingsWire.refund_roles` and
  `PaymentSettingValueByKey.refund_any_role_limit_cents` name the routes that read
  them. `StaffInvoicePaymentWire.payment_id` and `StaffPaymentRefundWire` name the
  routes that take their ids.
- The landing-group note names 6.0.0 as LG5's close, and its label sentence follows
  the 11-10 `wire_label_map` (design 6.1.0 is build 11.1.0, 7.0.0 is 12.0.0); it says
  that some older sentences still use the 11-02 map.

## [6.0.0-lg5.2] — 2026-11-13

BREAKING. LG5's second of three steps toward 6.0.0 (plan unit P21, slices S31 and
S33; ledger DAY-U43, CXL-U02, CXL-U04 and one field for CXL-U05's cancel sheet, with
no wire of their own DAY-U44, CXL-U01, STAFF-U45, NOTIF-U17; migrations M5.04,
M5.08; design §1.1 6.0.0, `designs/fetchd-v1-technical-design.md:1050-1061`,
`:1064-1067`, `:1076-1078`, `:1083-1085`; §2.3 `:2448-2455`, `:2558-2564`,
`:2741-2749`; §2.7 `:4115-4162`, `:4412-4414`; §3.8 `:5849-5871`). 6.0.0-lg5.2 lands
for clients when P21 is gate-green and pushed on `v1/build`. Contract-first: the
routes keep today's behaviour until P21's backend lands them. Resync both clients
(`npm run sync:contracts` in mobile and portal). Against the resynced copy (a
scratch run at the landed P20 trees, not their gates) the backend fails 13 times in
6 files, the portal 4 times in 3 files, and mobile once, in its money fake.

Breaking:

- `GET /staff/cancel-window`, `PATCH /staff/cancel-window/:category`,
  `CancelWindowSettingWire` and `PatchStaffCancelWindowRequest` removed (CXL-U02):
  M5.08 drops `cancel_window_settings`. The cancellation policy is the `cxl`
  settings domain below.

Added:

- `'cxl'`, the fifteenth `SettingsDomain`, appended to `SETTINGS_DOMAINS` (CXL-U02),
  over M5.07's two tables: `GET/PATCH /staff/settings/cxl` →
  `CancellationSettingsWire {policies: CancellationPolicyWire[], global:
  CancellationGlobalPolicyWire}`. `CancellationPolicyWire {category, window_state,
  window_hours, forfeit_fraction, no_show_forfeit_fraction, flat_fee_cents,
  unpaid_no_show_close_after_hours, no_show_declare_mode, updated_at,
  updated_by_staff_id}`, one row per `ServiceCategory`, seven;
  `CancellationGlobalPolicyWire {per_dog_cancel_enabled,
  staff_entered_client_cancel_follows_owner_rules_enabled,
  staff_initiated_cancel_full_return_enabled, class_missed_meeting_money_return_mode,
  started_run_cancel_return_mode, updated_at, updated_by_staff_id}`; `null` = NOT
  SEEDED. The stored-only editor: every key is 422 `setting_inert` but
  `per_dog_cancel_enabled`. The body is `PatchStaffSettingsCxlRequest` (a global
  column takes its value, a per-service column a category → value map), with
  `CancellationPolicyColumn`, `CancellationWindowState` and
  `CancellationNoShowDeclareMode`. A client keyed by every domain must cover `cxl`.
- `GET /staff/owners/:ownerId/bookings?from=` (`GetStaffOwnersBookingsQuery`) →
  `GetStaffOwnersBookingsResponse = BookingWire[]`, any role: the family's day
  sessions dated `from` or later and not cancelled, each a staff read, so a staff
  cancel reaches any future date (CXL-U04, s17).
- `PostBookingsRequest.after_school?: Record<dog_id, YYYY-MM-DD[]>`, the after-school
  opt-in per dog per day-school date (DAY-U43, question 47), and the tick on
  `BookingWire.dog_shares[].after_school` and `CheckinBoardWire.after_school`.
- `ApiErrorCode` gains the 49th, `'after_school_full'`, 422, appended, with
  `AfterSchoolFullDetails {date, capacity, booked}`, appended to
  `ApiErrorDetailWire` and to `PostBookingsErrorDetails`, and to
  `POST_BOOKINGS_ERROR_DETAIL_KINDS` before `'payment_failed'` (the tuple follows
  execution order). The order is refused whole.
- `BookingWire.dog_shares[].return_expires_at?`: the expiry a credit coming back
  now would carry (its lot's, a fresh lot's, or a lot dead before tomorrow), so the
  cancel sheet names it before Confirm (CXL-U05).

Changed (live, no shape change):

- No cancel forfeits (CXL-U04): a whole-session cancel of an `'upcoming'` day-school
  or day-care session, owner or any staff role, returns one credit per dog still on
  it and moves no money. `BookingWire.cancel_forfeited` is `false` on every cancel
  from this version, and no route stamps `cancel_deadline_at` (question 54).
- A staff cancel's notice to the owner, of a session or of one dog, quotes the
  staff `reason` verbatim (NOTIF-U17).
- `CreditLotDetailWire.booked_ahead` counts only live debits: a dog cancelled alone,
  turned away, sent home or marked *Didn't come* on a day still `'upcoming'` no longer
  counts as booked on the lot its credit came back to (the same rule the return writer
  and `return_expires_at` read).

### Documentation

- `BookingWire.cancel_deadline_at` and `cancel_forfeited` say what they mean now;
  `PostBookingsRequest`'s session-time sentence no longer names a cancel deadline.
- `StaffCapabilitiesWire.edit_money_policy` no longer names the removed verb.
- `CheckinBoardWire.after_school`: the courtesy-call flag still fires at
  `day.late_pickup_call_time` for an after-school dog (question 89's default).
- `SettingReadWire` says where a `cxl` key's value is read; the settings header,
  `SettingsDomain` and the §16 note count fifteen domains.
- The landing-group note names 6.0.0-lg5.2.

## [6.0.0-lg5.1] — 2026-11-11

BREAKING. LG5's first of three steps toward 6.0.0 (plan unit P20, slices S29 then
S30; ledger DAY-U29, DAY-U33, DAY-U40, CXL-U09, with no wire of their own DAY-U30,
DAY-U34, DAY-U36, DAY-U57, DOG-U40, CXL-U10, CXL-U11; migrations M5.01, M5.02, M5.03,
M5.07, M5.10, M5.12; design §1.1 6.0.0, `designs/fetchd-v1-technical-design.md:1027-1049`,
`:1064-1082`; §2.3 `:2354-2550`; §2.4 `:2953-2977`; §2.10 `:5051-5069`). 6.0.0-lg5.1
lands for clients when P20 is gate-green and pushed on `v1/build`. Contract-first: the
routes keep today's behaviour until P20's backend lands them. Resync both clients
(`npm run sync:contracts` in mobile and portal). Against the resynced copy (a scratch
run at P19's working trees, not their gates) the backend fails 5 times in 3 files,
the portal 2 times in 2 files, and mobile typechecks unchanged. Mobile is 0 because
nothing there types the attendance surface or the new cancel answers: its cancel
callers treat every refusal as a lost connection, which only a test reaches.

Breaking:

- `POST /staff/bookings/:id/attendance` and `PostStaffBookingsAttendanceRequest`
  removed. Check-in is an append-only log written by six verbs, `POST
  /staff/bookings/:id/dogs/:dogId/{check-in | check-out | undo | turn-away | send-home
  | no-show}`, each with an `Idempotency-Key`, each answering 200 `AttendanceWire`
  (DAY-U29, DAY-U33). `no-show` is the board's *Didn't come*, recordable from
  `day.pickup_close_time` on the session's date.
- `AttendanceWire` is `{status, events: CheckinEventWire[]}`; `booking_id`, `dog_id`,
  `attendance` and `checked_in_at` removed.
- `AttendanceStatus` is the folded state `'expected' | 'in' | 'out' | 'turned-away' |
  'sent-home' | 'no-show'`; `'attended'` and `'excused'` removed. No pgEnum backs it
  any more (M5.12 drops `booking_attendance`).
- `CreditLotDetailWire.reason` is `'purchase' | 'adjustment' | 'settlement-return'`;
  `'cancel-refund'` removed (M5.03). Every return writes `'settlement-return'` from
  this version, and a lot written as `'cancel-refund'` before it reads
  `'settlement-return'`.

Added:

- `CheckinEventKind` (the `checkin_event_kind` pgEnum, M5.01: six kinds, no
  `attended`, no `hand-off`) and `CheckinEventWire {id, booking_id, dog_id, kind, at,
  by_staff_id, undoes_event_id?, training_completed?, reissue_credit?, note?,
  settlement?: {returned_credits}}`.
- `PostStaffBookingsDogsCheckOutRequest {note?, reissue_credit?}` (s09, s10) and
  `PostStaffBookingsDogsSendHomeRequest {training_completed?}`, each box omitted =
  unticked.
- `GET /staff/checkin-board?location&date` (`GetStaffCheckinBoardQuery`) →
  `GetStaffCheckinBoardResponse = CheckinBoardWire[]`, one row per share: `booking_id`,
  `dog_id`, `state`, `events`, `booking_status`, `late_pickup_due`, `settled`,
  `can_cancel`, `payment_pending`, `gate_warnings` (DAY-U29, DAY-U33, DAY-U40).
  `gate_warnings` sends `'vaccine_lapsed'` from this version; `'spay_neuter_overdue'`
  is typed and sent from P09, and `'reevaluation_due'` typed and sent once S14 lands.
- One dog of several (CXL-U09, s11): `POST /bookings/:id/dogs/:dogId/cancel` (owner, no
  body) and `POST /staff/bookings/:id/dogs/:dogId/cancel`
  (`PostStaffBookingsDogsCancelRequest {reason}`, any role), each → 200 `BookingWire`.
- `BookingWire.can_cancel?` and `BookingWire.dog_shares?: {dog_id, can_cancel,
  cancelled_at?}[]` on day-school and day-care rows (CXL-U09, CXL-U10).
- `ApiErrorCode` gains eight, the 41st to the 48th, appended, each 409:
  `session_checked_in`, `session_ended`, `session_cancelled`, `payment_pending`,
  `per_dog_cancel_off`, `attendance_state_conflict`, `session_not_today`,
  `no_show_too_early`. Four carry `details`, appended to `ApiErrorDetailWire`:
  `SessionEndedDetails {date}`, `AttendanceStateConflictDetails {state}`,
  `SessionNotTodayDetails {date}`, `NoShowTooEarlyDetails {recordable_from}`.

Changed (live, no shape change):

- `POST /bookings/:id/cancel` and `POST /staff/bookings/:id/cancel` refuse an
  `'upcoming'` day-school or day-care session with 409 `session_ended` once its day
  has ended, then 409 `session_checked_in` while any dog still on it is past
  `'expected'` (CXL-U09). A pending row still cancels its whole order.
- `BookingWire.dog_id` and `additional_dog_ids` list only the dogs whose shares were
  not cancelled alone; when the lead is cancelled alone, the first remaining dog is
  `dog_id`.
- `DogWire.last_seen_on` is stamped by a board check-in and restored by its undo.

Not typed here: P21's `after_school` (on the board row and on `dog_shares`), the
`cxl` settings domain and `CancellationPolicyWire` (CXL-U02; M5.07's tables land here
with no settings route over them), `GET /staff/owners/:ownerId/bookings` (CXL-U04) and
the removal of the cancel window; P22's refunds; P26's walk-in; design 8.0.0's
`draft_report_id?`; P09's evaluation-row arms.

### Documentation

- `DayProgramGlobalSettingsWire.sent_home_before_training_return_fraction`: a PATCH
  refuses any value but 0 or 1, as on the after-training key (design §2.3:2482-2483,
  question 20 (a)). Both fractions name their readers.
- `BookingStatus`: a one-dog cancel and every board verb answer 409 `payment_pending`
  on a pending row.
- The settings block says where M5.07's two tables stand until `cxl` joins.
- The landing-group note names 6.0.0-lg5.1.

- `POST /staff/orders/:id/cancel` on a settled top-up refuses a day the desk checked in (409
  `session_checked_in`) or a day already over (409 `session_ended {kind, date}`), earliest day first, writing
  nothing: the day cancels' own rule on the third cancel path (doc only; both codes were already typed).
- Doc only: `BookingWire.date` is documented as the session's scheduled start, an ISO instant (it always
  was; the portal had read it as a calendar day). The order cancel's `session_checked_in` names every day
  the desk recorded, a turn-away and a *Didn't come* included.


## [5.0.0] — 2026-11-10

ADDITIVE. LG4's close (plan unit P19, slice S26: CRED-U32, ALUM-U11, ALUM-U13;
design §1.1 5.0.0 `:980-986`, §2.4 `:2875-2877`, `:3060-3069`, `:3189-3190`). No
migration. Every field is optional or new, and every code is appended, so a
client built against 5.0.0-lg4.2 reads 5.0.0 unchanged.

### Added

- `CreditPackageWire.withheld_reason?: CreditPackageWithheldReason`
  (`'no-evaluated-dog' | 'alumni-only'`): why this owner cannot buy the row,
  computed per owner after the catalog cache read, omitted when she can and on
  every staff read. The row stays listed, greyed with the reason's copy.
  `'alumni-only'` is sent from this version (ALUM-U11); `'no-evaluated-dog'` is
  typed and sent by no route until EVAL-U20 (P11). `GET /credit-packages`'s doc
  says an owner's read is owner-aware.
- Two thrown codes, the 39th and 40th, appended: 422 `alumni_package_ineligible`
  with `AlumniPackageIneligibleDetails {kind, reason: 'no-alumni-dog'}`
  (ALUM-U11), and 422 `pack_requires_evaluated_dog`, no `details`, typed and
  thrown from P11 (EVAL-U20). Both run before any order commits, so a refused
  purchase charges nothing. `ApiErrorDetailWire` gains the details arm.
- `OwnerCreditSettingsWire` (the owner document's `cred`) gains
  `booking_outlives_lot_expiry_enabled` and `single_day_purchase_max_count`,
  read from the same `credit_settings` row (build DECISIONS 216; P18 mobile G5,
  G6): the calendar stops greying dates while the first is true, and the shop's
  stepper stops at the second.

### Documentation

- `PostCreditPackagesPurchaseRequest`: the two refusals, and why no total rides
  the body (no v1 route writes a price or a credit count; DECISIONS 216, P18
  Opus r4 N6 ruled out).
- `CreditSettingsWire`: the owner document carries four of its keys, not two.
- The landing-group note names 5.0.0 as LG4's close.

## [5.0.0-lg4.2] — 2026-11-10

BREAKING. LG4's second of three steps toward 5.0.0 (plan unit P18, slices S23, S25,
S27, S24 in pass order; ledger CRED-U04, CRED-U30, CRED-U10, CRED-U05, CRED-U17,
CRED-U08, CRED-U12, CRED-U14, CRED-U15, ALUM-U02, DAY-U23, with no wire of their own
CRED-U07, DAY-U22, CRED-U35, CRED-U01, CRED-U06, CRED-U03, CRED-U26, CRED-U28,
CRED-U33, CRED-U38, DAY-U15, CRED-U16, CRED-U39, CRED-U42, and PAY-U09's live half;
migrations M4.05 to M4.12; design §1.1 5.0.0,
`designs/fetchd-v1-technical-design.md:953-1011`, `:1019-1022`, `:929-935`; §2.3
`:2613-2719`; §2.4 `:2856-3111`; §2.7 `:4061-4107`; §4 `:6207-6214`). 5.0.0-lg4.2
lands for clients when P18 is gate-green and pushed on `v1/build`. Contract-first:
the routes keep today's behaviour until P18's backend lands them. Resync both
clients (`npm run sync:contracts` in mobile and portal). Against the resynced copy
(a scratch run at P17's working trees, not their gates) the portal typechecks
unchanged, mobile fails 2 times in 1 file and the backend 11 times in 7 files.
Those counts are small because the surface is hand-typed: mobile's
`CreditPurchaseRequest` and `parseCreditGaps`, the portal's `CreditLot`, every
raw-SQL lot read and every cache key are outside tsc's reach, so tsc is not the
work list.

Breaking:

- `PostCreditPackagesPurchaseRequest` is `{payment_method_id, count?}`: `quantity`
  (CRED-U30), `dog_id` (CRED-U10) and `location` (CRED-U04) removed. The body is
  strict, so each is 400. `count` is accepted only on a `single_day` row.
- `POST /credit-packages/:key/purchase` rides the order engine (CRED-U10). A decline
  is 402 `payment_failed`, committed and replayed, where it was a 201, and a key
  whose order has not settled answers 409 `idempotency_inflight`.
- `CreditsWire` and `GET /dogs/:id/credits` removed; `GET /credits?location` answers
  `OwnerCreditsWire {location, pools: OwnerCreditPoolWire[]}`, each pool `{mode, tier,
  balance, lots, expiring_lots}` (CRED-U10, CRED-U33). `warning_lead_days` goes: the
  app reads `cred.expiry_warning_lead_days` from `GET /settings`.
- `CreditGap` is `{location, mode, tier, balance, required}`, one entry for the pool;
  `dog_id` removed (CRED-U10). `balance` at `required` can still be short, so
  `shortfall` is the number to read.
- `NotificationDeepLink` is a union, and its `credits` arm has no `id`.
  `deepLinkToPath({kind: 'credits'})` is `/account/credits`, where it was
  `/dog-profile/<id>?highlight=credits` (CRED-U10). A stored path keeps its old route.
- `CreditExpirySettingWire`, `PostStaffCreditExpiryRequest` and `GET/POST
  /staff/credit-expiry-settings` removed (CRED-U05, M4.07, question 35).
- `CreditLotWire.expires_at` is live on every lot: the never-expiring class is
  retired (CRED-U05, CRED-U17). No shape change; a client that treated a lot as
  permanent breaks on behaviour, so it is listed here.
- `PostStaffRatesRequest.category` is `'evaluation'`, and the route takes only the
  seed amount, 0 (DAY-U23, moved from design 4.0.0 by §1.3). `GET /rates` holds only
  the evaluation row of each campus.

Added:

- `CreditTier` and `CREDIT_TIERS` (§2), pinned in §16. No pgEnum backs them.
- `ApiErrorCode` gains six, the 33rd to the 38th, appended:
  `alumni_tier_requires_alumni_dog`, `count_not_allowed`, `lot_insufficient`,
  `expiry_not_in_future`, `pool_not_bookable` (each 422) and
  `credit_edit_role_required` (403). None carries `details`.
- `CreditPackageWire.tier`, `.single_day`, `.expiry_months`; `location` and `mode`
  stay non-null. The catalog lists ten rows (CRED-U04, CRED-U07, M4.05, M4.06).
- `GET /staff/owners/:ownerId/credits` → `StaffOwnerCreditsWire`, with
  `StaffCreditPoolWire` and `CreditLotDetailWire` (CRED-U14, CRED-U38, DAY-U15). Any
  staff role reads it.
- `POST /staff/owners/:ownerId/credit-adjustments`
  (`PostStaffOwnersCreditAdjustmentsRequest`) → the changed pool (CRED-U14), and
  `PATCH /staff/credit-lots/:id` (`PatchStaffCreditLotsRequest`) →
  `CreditLotDetailWire` (CRED-U15). Each reads `staff.credit_hand_edit_role_list`.
- `PATCH /staff/credit-packages/:key` (`PatchStaffCreditPackagesRequest`,
  `{expiry_months}`) → `CreditPackageWire` (CRED-U08 narrowed), on the same list.
- `PendingPaymentWire.package_label?`: the row bought, on a `'package'` entry (design
  §2.7:3841, read from `charges.package_id`).

Changed (live, no shape change):

- `POST /bookings`: `payment.tier` is read and `payment.top_up` is honoured (PAY-U09,
  CRED-U10). `top_up_offer` and `alternative_package_key` are sent, the latter only
  for a pack that covers the shortfall and whose own lot pays every short date. `short_dates` carries
  `'credits_expire_first'`, and `credit_expired_before_date` has its predicate
  (CRED-U12). Rows can be `'payment-pending'`, and `order.charge_status` can be
  `'succeeded'` or `'requires_payment'`. `PostBookingsErrorDetails`' arms 5 and 9 are
  reachable. `cred.single_day_purchase_max_count` does not cap `top_up.count`
  (DECISIONS 151(b), the default).
- `CreditPurchaseWire`'s JSDoc is rewritten: a 201 is `'succeeded'`, or
  `charge_status: 'requires_payment'`, `credits_granted: 0` and `charge_blocker:
  'processing'` on a live intent. It no longer describes a cancelled one.
- `DogWire.is_alumni`, `CompletedProgramsWire.is_alumni` and `CurriculumProgram`:
  stored from M4.11, never cleared by un-recording a level (ALUM-U02).
- `StaffCapabilitiesWire`'s and `StaffSettingsWire`'s credit lines name their verbs,
  and the legacy-editor lists lose `/staff/credit-expiry-settings`.
  `InvoicePayWire.client_secret` stops citing `CreditPurchaseWire`.
  `PendingPaymentWire`, the order-engine banner, `BookingStatus` and the settings
  block's two `CreditExpirySettingWire` precedents are reworded.

Not typed here: P19's `withheld_reason`, `alumni_package_ineligible` and the shop's
reads; `pack_requires_evaluated_dog`, typed at P19 and sent from P11.

### Documentation, in place before this version reached the branch

- `StaffOwnerCreditsWire.expiry_enforced`: no screen reads it (§2.10:5001).
- `LedgerEntryWire.settled_card`: a pack line now carries the card, from its paid invoice (§2.7:3875).
- `RateWire`: the `location: null` rule is pinned by `test/contracts/rates.test.ts`, since the two snapshots it cited are deleted.
- `PostBookingsRequest.payment.top_up`: a pack whose own lot would not pay every short date joins the fresh-422 list (`designs/p18-pack-reach-and-moved-dates.md`).
- `CreditSettingsWire`: the bounds a PATCH already enforces are stated on `expiry_warning_lead_days` (each lead at most 365), `manual_grant_expiry_months` (1 to 120), `returned_credit_expiry_months` (0 to 120) and `single_day_purchase_max_count` (1 to 100).

## [5.0.0-lg4.1] — 2026-11-06

BREAKING. LG4's first of three steps toward 5.0.0 (plan unit P17, slice S28;
ledger CRED-U29, PAY-U15, ALUM-U17, and ALUM-U16 for its doc lines; MSG-U35 and
ALUM-U01 have no wire of their own; migrations M4.01 to M4.04; design §1.1 5.0.0,
`designs/fetchd-v1-technical-design.md:964-972`, `:1020`; §2.4 `:2834-2855`; §4
`:6203-6206`). 5.0.0-lg4.1 lands for clients when P17 is gate-green and pushed on
`v1/build`. Contract-first: the routes and the worker keep today's behaviour until
P17's backend lands them. Resync both clients (`npm run sync:contracts` in mobile
and portal). Against the resynced copy (a scratch run at the P16 commits, not their
gates) the portal typechecks unchanged, mobile fails 23 times in 11 files
and the backend 26 times in 14 files. Closing those closes neither the lane nor
the membership screens: the portal's own `Package.subscription`, the backend's own
`ChargePurpose` in `chargesRepository.ts` and every raw-SQL literal are outside
tsc's reach, so tsc is not the work list.

Breaking:

- The `memberships` domain section is removed: `MembershipStatus`,
  `MembershipWire`, `MembershipCreateWire`, `StaffMembershipWire`,
  `PostMembershipsRequest`. Routes `POST /memberships`, `GET /memberships`,
  `DELETE /memberships/:id`, `POST /staff/memberships/:id/pause` and `/resume` are
  removed (CRED-U29, M4.01).
- `NotificationType` and `NOTIFICATION_TYPES` lose `'membership-ended'` (CRED-U29)
  and `'alumni-attendance'` (ALUM-U17): 15 kinds where the comment said 17, the
  survivors in their order. Pinned to the pgEnum, so M4.02 lands in the same
  commit. `'evaluation-result'` is not in the rebuild: M2.15 appends it in LG2b (P10).
- `NotificationDeepLinkKind`, `NOTIFICATION_DEEP_LINK_KINDS` and `deepLinkToPath`
  lose `'membership'` (CRED-U29). `deepLinkToPath` throws on that kind.
- `ChargePurpose` is `'package' | 'board-train' | 'group-class'`: `'membership'`
  (CRED-U29) and `'payg'` (DECISIONS 151(h)) leave with M4.02's `charge_purpose`
  rebuild, in the order of the pgEnum that survives it.
- `LedgerEntryWire.kind` is `'session' | 'credit-pack'`: `'membership'` and
  `'payg'` removed. Inline, so no tuple or pin holds it.
- `ParkedInvoiceWire` and `GET /staff/invoices?parked` removed (PAY-U15). `GET
  /staff/invoices/:id` stays. No route answers `GET /staff/invoices` until the list
  design 6.1.0 builds there (7.1.0 here).
- `InvoiceDeepLinkReason` and `INVOICE_DEEP_LINK_REASONS` lose
  `'payment-unconfirmed'`, whose only producer was the auto-charge worker (PAY-U15).
  `deepLinkToPath` throws on it. A path already stored with it parses with the
  reason dropped.
- `DogWire.alumni_attendance_flagged_at`,
  `CompletedProgramsWire.alumni_attendance_flagged_at` and `POST
  /staff/dogs/:dogId/clear-alumni-flag` removed (ALUM-U17, M4.03).

Changed (doc only, no shape change):

- `EnrollmentPaymentStatus` and `PostEnrollmentsRequest.pay_later`: nothing bills
  a pay-later invoice automatically from this version. The owner pays it through
  `POST /invoices/:id/pay`, and the arm stays until 8.0.0 removes it (PAY-U10).
- `NotificationType`'s `'invoice-overdue'` comment: nothing enqueues it from this
  version (M4.04, question 87). The label stays, on rows already written.
  `'card-expiring'` no longer speaks of auto-charges.
- `CreditLotWire` stops listing alumni grants as never-expiring, and
  `CompletedProgramsWire` stops saying the fifth program clears lot expiries
  (ALUM-U16). The 1-credit and import clauses stay for P18.
- `InvoiceStatus` and `ChargePurpose` name `StaffInvoiceWire` as how they reach
  the wire, and `ChargePurpose` drops its note on declaration order.
- `InvoicePayWire.charge_refunded` says another settle of the same invoice, not
  the worker.
- `PaymentFailedDetails`: "all five emit sites" was stale, and memberships' go
  here; it says every emit site.
- `RefundStatus`, `GetStaffReportsResponse` and `GetStaffReportsQuery` stop naming
  a removed shape or route. `GetStaffInvoicesResponse`'s no-alias comment now
  names the 6.1.0 list.

Not typed here: everything else of 5.0.0, which is P18's (S23, S24, S25, S27:
`OwnerCreditsWire`, `CreditGap`'s re-key, the catalog fields, hand edits, the
purchase body, `CreditExpirySettingWire`'s removal) and P19's (S26: the shop's
refusals and `withheld_reason`).

## [4.0.0] — 2026-11-05

BREAKING. LG3's third and last step: this sets 4.0.0, the group's target, and
closes LG3 (plan unit P16, slices S21, S22; ledger PAY-U06, PAY-U09, DAY-U17,
DAY-U19, and PAY-U41 for one doc line; PAY-U45 and TAX-U01 have no wire of their
own; no migration; design §1.1 4.0.0,
`designs/fetchd-v1-technical-design.md:864-874`, `:900-913`, `:917-920`; §2.3
`:2613-2659`; §2.7 `:4051-4092`). 4.0.0 lands for clients when P16 is gate-green
and pushed on `v1/build`. Contract-first: the routes keep today's behaviour until
P16's backend lands them. Resync both clients (`npm run sync:contracts` in mobile
and portal). Against the resynced copy (a scratch run at their HEADs, not their
gates) the portal typechecks unchanged and mobile fails at
`repositories/bookingRepository.ts:594`, `:602` and `:603`. The backend fails at
`lib/bookingErrors.ts:115`, `routes/bookings.ts:143` and
`routes/enrollments.ts:1654`. Closing those six closes tsc and leaves the
pay-as-you-go lane compiling in both repos, so tsc is not the work list.

Breaking:

- `PostBookingsRequest.payment` is required, and is `{kind: 'credits', tier?:
  'regular' | 'alumni', top_up?: {count, payment_method_id, package_key?,
  expected_total_cents}}` where it was `'credits' | 'payg'` (PAY-U09, DAY-U17,
  CRED-U10). Credits are the only tender: no pay-as-you-go arm, no card arm, no
  `lines[]`. A missing `payment` or a string `payment` is 400 `bad_request`.
- `PostBookingsRequest.payment_method_id` removed. It is an unknown key to
  `.strict()`, so 400 `bad_request`, on a credits body too, where it used to be
  accepted and ignored.

Added:

- `payment.top_up`, typed here and live at P18. Until then `top_up_offer` is
  always `null`, and a body carrying `top_up` answers as tx1 answers an offer
  that no longer holds: 422 `insufficient_credits` with the current `shortfall`
  and `top_up_offer: null`, nothing written, no order, the card not read, no
  Stripe call. With credits enough for the dates that is `shortfall: 0`, and the
  client re-sends without `top_up`. `tier` is accepted and not read until P18.
- `InsufficientCreditsDetails` gains `shortfall`, `short_dates: {date, reason:
  'no_credit' | 'credits_expire_first', expires_at?}[]`, `top_up_offer: {count,
  unit_price_cents, total_cents, package_key} | null` and
  `alternative_package_key?` (PAY-U09, DAY-U17). `gaps` stays. `short_dates` has
  one entry per missing credit, so its length is `shortfall`. Every `reason` is
  `'no_credit'` and `alternative_package_key` is omitted until P18.
- `ChargeBlocker` and `CHARGE_BLOCKERS` gain `'insufficient_funds'` and
  `'expired_card'` (PAY-U06), on every route that carries a blocker.
- `'credit_expired_before_date'` appended to `ApiErrorCode` and `API_ERROR_CODES`,
  422 in `API_ERROR_STATUS` (CRED-U12). `CreditExpiredBeforeDateDetails
  {expires_at, dates}` joins `ApiErrorDetailWire` and `PostBookingsErrorDetails`,
  and the code joins `POST_BOOKINGS_ERROR_DETAIL_KINDS` before
  `'insufficient_credits'`, because a date no credit can reach is found first
  and a top-up could not complete that booking. Not reachable until its predicate
  lands (P18).

Changed (doc only, no shape change):

- `PaymentFailedDetails`: "With no `charge_blocker` no card answered" is false on
  real Stripe, which keeps no reason on a cancelled intent (test-mode run,
  DECISIONS 147(b), 149(b)). It now says no reason is recorded, and "no money
  moved" stands. A doc error on a landed version, so it rides this bump.
- `POST /bookings`' refusal arms are renumbered, and "NOT reachable yet" names
  arms 5 and 9. The pay-as-you-go sentences leave `PostBookingsRequest`,
  `PostBookingsErrorDetails` and `PostBookingsResponse`.
- `ChargePurpose` and `LedgerEntryWire.kind` say `'payg'` stays, pinned to the
  pgEnum with no migration here, that nothing writes it from 4.0.0, and that it
  survives on rows already written until P17 deletes the auto-charge lane.
- `RateWire` and `PostStaffRatesRequest` lose their pay-as-you-go reasons. Three
  rate docs that said "design 4.0.0" now say P18: DAY-U23 moved to S23 (design
  §1.3).
- `StaffRateWire`: voiding a past-dated row that has a predecessor is 409
  `conflict` (PAY-U41).
- `ApiErrorCode`'s `insufficient_credits` comment covers a `top_up` that no longer
  fits.

Not typed here: `PostStaffRatesRequest`'s narrowing and `GET /rates` (DAY-U23,
P18); `CreditPurchaseWire`'s processing arm (P18); the `CreditGap` re-key (P18);
409 `payment_pending` (P20); `EnrollmentWire.order_id` and
`PostEnrollmentsResponse` (P29).

## [4.0.0-lg3.2] — 2026-11-05

BREAKING. LG3's second step, step 2 of 3 toward 4.0.0 (plan unit P15, slice S20,
ledger PAY-U04, PAY-U05, PAY-U07, and PAY-U01, which keeps code and has no wire
of its own; migrations M3.02, M3.03; design §1.1 4.0.0,
`designs/fetchd-v1-technical-design.md:857-899`, `:925-928`; §2.7 `:3799-4030`).
Contract-first: the routes keep today's behaviour until P15's backend lands them
and the two migrations. Resync both clients (`npm run sync:contracts` in mobile
and portal). Against the resynced copy (a scratch run at their HEADs, not their
gates) both clients typecheck unchanged. That does not mean mobile is safe: its
`POST /bookings` call is a cast, so it compiles and then throws on every booking
until P15's mobile builder lands. The backend fails at one site,
`contracts/conformance.ts:79`, until M3.03's value reaches `schema.ts`.

Breaking:

- `POST /bookings` returns 201 `PostBookingsResponse {order: OrderWire, sessions:
  BookingWire[]}` instead of `BookingWire[]` (PAY-U04, DAY-U16). One Confirm is
  one order, credits-only included. `sessions` holds one row per date, ascending.
  `order.charge_status` is `'none'` unless a top-up was charged, so it is always
  `'none'` until the top-up is live (typed at 4.0.0, P16; answered from P18).
- `POST /invoices/:id/pay` rides the order engine (PAY-U05, PAY-U07). A final
  decline answers 402 `payment_failed`, where it answered 201 with
  `charge_blocker`. The invoice stays open with the failed charge recorded. The
  402 is stored: a replay returns it and the card is not tried again, so the next
  try takes a fresh key, with the same card or another. `charge_blocker` on the
  201 is now only ever `'processing'`, and that intent is live: the 1.7.1 cancel
  rule no longer applies to this route.

Added:

- `OrderWire {id, owner_id, created_at, charge_status: 'none' | 'succeeded' |
  'requires_payment' | 'failed', client_action?: ChargeBlocker}`. `orders` stores
  no status: both charge fields are read from the order's one charge. A confirm
  answers `none`, `succeeded` or `requires_payment`; `failed` is read-side.
- `BookingWire.order_id?`, `LedgerEntryWire.order_id?` (M3.02), each omitted when
  the row has no order.
- `ChargeAttemptOutcomeWire {attempts, outcome: 'succeeded' | 'pending' |
  'failed', blocker?}` (PAY-U05). No response carries it at this step;
  `POST /staff/invoices/:id/charge`, at 7.1.0, is the first.
- `PaymentFailedDetails` gains `order_id?`, `attempts?`, and `outcome?: 'failed' |
  'abandoned'` (no confirm was sent; `attempts: 0`). A route on the engine sends
  all three, and a route not on it yet omits them.
- `'payment_failed'` joins `POST_BOOKINGS_ERROR_DETAIL_KINDS` and
  `PostBookingsErrorDetails`, as a 402 (PAY-U05, DAY-U18). Not reachable until
  the top-up is live (P18).
- `BookingStatus` gains `'payment-pending'` (M3.03; PAY-U07), carried only by the
  rows of a Confirm whose top-up charge is still processing. The row is the seat
  hold. A cancel of any one pending row cancels the whole order.
- `GET /staff/payments/pending` (any role) → `GetStaffPaymentsPendingResponse`,
  `PendingPaymentWire[] {order_id, owner: {id, name}, kind: 'booking' |
  'package' | 'class', amount_cents, created_at, minutes_pending, sessions?}`:
  every order still pending past `pay.processing_hold_max_minutes`. Empty until
  P18.
- `POST /staff/orders/:id/cancel` (any role, `Idempotency-Key`, no body) →
  `PostStaffOrdersCancelResponse {order_id, outcome: 'cancelled' | 'settled' |
  'settled_then_cancelled'}`. 404 for no such order; 409 `conflict` for an order
  with nothing pending, or for one that changed under the cancel (an intent id
  landing after its read). Either way nothing is written.
- `'invoice_payment_in_flight'` appended to `ApiErrorCode` and `API_ERROR_CODES`,
  409 in `API_ERROR_STATUS`, no `details` (PAY-U05). `POST /invoices/:id/pay`
  answers it while another order on the invoice holds a `requires_payment` charge
  inside its lease.

Changed (doc only, no shape change):

- §0's idempotency list: the engine's 402 is the one stored error, and a claim
  stays open while its charge is processing, so the same key answers 409
  `idempotency_inflight` even after the pending 201.
- `payment_failed`'s two docs no longer say a card was always charged or that
  nothing was written: `outcome: 'abandoned'` asked no card, and a decline leaves
  its failed charge recorded.
- `POST /bookings`'s two detail docs say "refuse", since one arm is a 402.
- `InvoicePayRequest` lists the route's five answers. `InvoicePayWire`'s
  `client_secret` and `charge_blocker` docs, and the § payments-invoices note on
  this route's failures, stop describing the 1.7.1 cancel rule here.

Rows `pay.card_attempts_max_count`, `pay.seat_hold_max_minutes` and
`pay.processing_hold_max_minutes` need no change: `PaymentSettingWire` has
carried them since 2.0.0-lg1.1 (M1.13), and P15 gives them their first reader.

Not typed here: `ChargeBlocker`'s two new members, the `insufficient_credits`
additions, the `payment` object and `credit_expired_before_date` (P16);
`PostStaffRatesRequest` and `CreditPurchaseWire`'s processing arm (P18); 409
`payment_pending` (P20); `EnrollmentWire.order_id` and `PostEnrollmentsResponse`
(P29, with M7.08); `BookingStatus`'s class-row doc and `'payment-refunded'` (P28).

*P14, no bump (DECISIONS 135(d), Fable L3).* Route ids are lowercased at the parse, and the idempotency hash runs on the parsed body, so a key first used on a capitalised body before this release replays as 422 `idempotency_mismatch`. No shipped client capitalises an id, and production starts clean.

## [4.0.0-lg3.1] — 2026-11-04

BREAKING. LG3's first step, step 1 of 3 toward 4.0.0 (plan unit P13, slice S18,
ledger DAY-U05, DAY-U04, DAY-U10, DAY-U11, DAY-U07; migration M3.01; design §1.1
4.0.0, `designs/fetchd-v1-technical-design.md:849-960`; §2.3 `:2305-2353`; §2.6
`:3714-3731`). Contract-first: the routes keep today's behaviour until P13's
backend lands them and M3.01. Resync both clients (`npm run sync:contracts` in
mobile and portal). Against the resynced copy (a scratch run at their HEADs, not
their gates) the portal typechecks unchanged. The mobile app fails in
`availabilityRepository.ts` (`:46`, `:47`, `:51`, `:52`) and
`bookingRepository.ts:693` until P13's mobile builder lands.

Breaking:

- `DayCapacityWire`: `school_openings`, `daycare_openings`, `school_remaining`
  and `daycare_remaining` become `capacity_dogs` and `remaining_dogs`: one cap
  per (location, date), combined across day school and daycare (DAY-U05). The
  rule replaces the 3/3 weekday and closed-weekend default: open weekday in
  `day.open_weekdays_list` → `day.daily_capacity_dogs`; else 0; a `day_capacity`
  row overrides either. Remaining is the cap minus every live client booking dog
  on that date at that campus. Evaluations are not in the count yet (P10, P11).
- `CapacityGap`, and so `InsufficientCapacityDetails`, lose `mode`: keyed
  (location, date). `openings_remaining` keeps its name.
- `GetAvailabilityQuery.mode` is removed. The route's query schema is not
  `.strict()`, so a stale client still sending `mode=` is not refused.
- `PostBookingsRequest.dropoff_time` is removed, and with it the drop-off window
  refusal (DAY-U11). Each session's `scheduled_at` is the campus's
  `day.dropoff_open_time` on its date, so the cancel deadline and the reminders
  move with it (DAY-71). The body is `.strict()`, so a client still sending the
  key gets 400 `bad_request`.

Added:

- `'program_not_offered'` (DAY-U04), `'same_day_cutoff_passed'`,
  `'beyond_booking_horizon'` (DAY-U10), `'capacity_below_booked'` (DAY-U07) and
  `'service_not_offered'` (design-added, design §1.1:936, §2.6:3727; question 2)
  appended to `ApiErrorCode` and `API_ERROR_CODES`, each 422 in
  `API_ERROR_STATUS`. Only `capacity_below_booked` carries `details`.
- `CapacityBelowBookedDetails {kind: 'capacity_below_booked'; dates: string[]}`,
  in `ApiErrorDetailWire` and `PatchStaffSettingsErrorDetails`.
- `PUT /staff/day-capacity/:location/:date` (`PutStaffDayCapacityRequest
  {capacity_dogs}`, an upsert that re-opens a withdrawn date) and `DELETE` to
  withdraw (DAY-U07). Both answer 200 with the date's resulting
  `DayCapacityWire`, take an `Idempotency-Key`, are open to any staff role at
  either campus, and can answer 422 `capacity_below_booked`. A `DELETE` that
  finds no live override changes nothing and is still 200.
- `SettingValueSpecWire`'s `record` arm gains `fixed?: Record<string, string>`,
  so the manifest serves what the PATCH already enforces. A key named there is
  shown read-only at that value, and a PATCH naming another is 422
  `invalid_payload`. It closes the editor drawing `asked` for the sign-up map's
  `email` (P05 review, Fable N4).

Changed (a route answers something new, no shape change):

- `POST /bookings` answers `program_not_offered`, `same_day_cutoff_passed` and
  `beyond_booking_horizon`, none with `details`. A date past the horizon was
  `invalid_payload`.
- `POST /requests` answers `service_not_offered` and `beyond_booking_horizon`,
  and `PATCH /requests/:id` `beyond_booking_horizon`, none with `details`. A
  request names no campus, so `service_not_offered` reads the family's home
  campus; a family with none is refused only when no campus offers the service.
- `POST /enrollments` answers `beyond_booking_horizon`, no `details`, on the
  cohort's first session, with or without `allow_partial`.
- `PATCH /staff/settings/day/:location` answers `capacity_below_booked` when it
  lowers `daily_capacity_dogs` or unticks a weekday from `open_weekdays_list`
  under a booked date (refusal step 5).

Changed (doc only; no shape change):

- `PostBookingsRequest`: the 92-day lookahead and the 5-dog bound leave the doc;
  both are read at runtime from `day.booking_horizon_months` and
  `day.max_dogs_per_booking_count` (DAY-U10). The 1..30 dates bound stays
  `MAX_DATES_PER_REQUEST`, a constant. The horizon is calendar months, not 92
  days, and the doc defines the reckoning once.
- `PostBookingsRequest`: a Zod failure, an unknown key included, is 400
  `bad_request`. The doc said 422.
- `GetAvailabilityQuery`: the date cap follows `day.booking_horizon_months`, so
  a window from today through the horizon's last date always fits. No fixed
  number is stated.
- `PostRequestsRequest`: the 92-day lookahead leaves the doc.
- `BookingMode`, `CohortFullDetails`, `PostBookingsErrorDetails`,
  `PostRequestsErrorDetails` and the `insufficient_capacity` comment no longer
  name a mode on capacity or leave out the new refusals.
- Every `.ts:NNN` cite in § bookings (36 lines) and its three `schema.sql:NNN`
  cites now name symbols. The build keeps moving those files (build DECISIONS
  120, 121(f)).
- `API_ERROR_STATUS` no longer counts its codes; `GetStaffBookingsQuery` says a
  route body's cross-field rules use `invalid_payload`, since a Zod failure there
  is 400; two `bookingErrors.ts` and three `routes/enrollments.ts` cites stop
  naming lines that moved.
- `WIRE_CONTRACT_VERSION` `'3.0.0'` → `'4.0.0-lg3.1'`. Its doc gains LG3's steps,
  and no longer says every design label above 3.0.0 reads one major up: that
  starts at 6.1.0 (build DECISIONS 6, plan.json `wire_label_map`).

Not typed here: `OrderWire`, `PostBookingsResponse`, `order_id`, the `payment`
object and every other design 4.0.0 item of S19–S22 (P15, P16). Evaluations in
the seat count (P10, P11).

## [3.0.0] — 2026-11-03

BREAKING. LG2's close, and the end of M1's part of design 3.0.0 (plan unit P12,
slice S17, ledger DOG-U08, PAY-U19; migrations M2.16, M2.17, M3.05; design §1.1 3.0.0,
`designs/fetchd-v1-technical-design.md:749-755`, `:806-809`; §2.2 `:2132-2137`;
§2.6 `:3714-3730`). It types the two design 3.0.0 items M1 carries for S17
(plan.json `wire_3_0_0_split`: B-divert-lane-removed, A-last-seen-on). With
3.0.0-lg2.1's two items, that is all of design 3.0.0 in M1. Every other design
3.0.0 item ships after M1 as 7.0.0 (LG2b; build DECISIONS 6, 32) and is not
typed here. Contract-first: the routes keep today's behaviour until P12's
backend lands the deletion, M2.16 and M2.17. Resync both clients (`npm run
sync:contracts` in mobile and portal). Against the resynced copy (a scratch run
at their HEADs, not their gates) the portal typechecks unchanged. The mobile
app fails in `bookingRepository.ts` (`:28`, `:30`, `:34`, `:164`, then `:266`
and `:777` behind them) until P12's mobile builder deletes the divert flow.

Breaking (B-divert-lane-removed; DOG-U08, PAY-U19):

- `POST /bookings` loses its 202 arm: `DivertedBookingWire` is removed. 201
  `BookingWire[]` is its one success. Nothing replaces the lane in M1: the
  spay/neuter refusal lands in S11 (LG2b; plan.json `m1_known_gaps`), and the
  re-evaluation clock in S14, dated (design.md:806-809).
- `POST /bookings/preview` is removed, with `PostBookingsPreviewRequest`,
  `BookingDivertPreviewWire` and `BookingDivertPreviewDogWire`.
- `PendingRequestWire.location`, `.payment` and `.divert_reasons` are removed.
  M2.17 drops their columns and `payment_method_id`, which was never on the
  wire.
- `'already_requested'` leaves `POST_BOOKINGS_ERROR_DETAIL_KINDS`, and
  `AlreadyRequestedDetails` leaves `PostBookingsErrorDetails`: the divert branch
  was `POST /bookings`' only emit site. Both stay on `POST /requests`, and the
  code and its details arm stay in `ApiErrorCode` and `ApiErrorDetailWire`.
  Arms 1-7 of the `POST /bookings` list keep their numbers.

Added (A-last-seen-on; EVAL-U12, EVAL-U04):

- `DogWire.last_seen_on?: string` (`YYYY-MM-DD`), sent from `dogs.last_seen_on`
  (M2.16) and omitted while the column is null. Nothing stamps the column until
  the check-in unit lands (P20), and no gate, clock or client acts on it in v1
  yet: its reader is S14's, dated.

Changed (doc only; no shape change):

- `PostStaffRequestsApproveRequest`: the day-school / day-care bullet is gone.
  Such a request cannot be created any more; approving one that survives is 409
  `conflict`, books and charges nothing, and leaves the row `submitted`; deny
  still works. The private-lesson, boarding and
  board-and-train bullets are unchanged (design §2.6). The doc now cites
  `staffRequests.ts` by symbol, because this unit moves its lines.
- `OwnerEvaluationCampusSettingsWire.price_cents`: M3.05 seeds both campuses,
  so `null` now takes a closed or voided row.
- `DogWire.spayed_neutered`: the owner's answer is stored, and no booking path
  reads it until the spay/neuter refusal lands (S11, LG2b).
- `PostBookingsRequest`: states the 201 `BookingWire[]` response, which only the
  deleted 202 doc stated before.
- `PendingRequestWire.approved_by_staff_id`: its stamp sites are cited by symbol;
  one of the old line cites was the arm this unit deletes.
- `MeWire.name` and `.phone`: a stored value with no visible character reads as
  `null`, now said on the field itself (P05 review, Fable r2 N1).
- `PatchMeRequest`: `emergency_contact` and `address` require every sub-key;
  omitting one is a 400, not a blank, as the old doc said. `MeWire.location` no
  longer claims to be the one wire surface that translates.
- Every `routes/me.ts:NNN` cite (19 lines, 18 distinct cites) now names a symbol.
  P05 rewrote that file and all of them had gone stale.
- `WIRE_CONTRACT_VERSION` `'3.0.0-lg2.1'` → `'3.0.0'`. Its doc already named
  this step.
- This changelog: the 3.0.0-lg2.1 `StaffOwnerWire` bullet no longer says the
  fields "mirror" their columns (build DECISIONS 115(b), 116).

Not typed here: every other design 3.0.0 item (plan.json P12
`wire_items_not_in_m1`, LG2b's 7.0.0); `reeval_due` and `reevaluation_due`
(S14, dated); 4.0.0's `PostBookingsResponse`.

## [3.0.0-lg2.1] — 2026-11-03

BREAKING. LG2 step 1 of 2 toward 3.0.0, M1's part of design 3.0.0 (plan unit
P05, slice S05, ledger ACCT-U04; migration M2.01; design §1.1 3.0.0,
`designs/fetchd-v1-technical-design.md:738`, `:758-763`, `:822-827`; §2.2
`:2244`). It types the two design 3.0.0 items M1 carries for S05 (plan.json
`wire_3_0_0_split`: B-me-nullable, A-profile-incomplete-me): the owner's
`name`, `phone` and home campus become nullable, and `PATCH /me` follows the
sign-up map. P12 sets 3.0.0 itself (the divert lane's removal and
`DogWire.last_seen_on`). Every other design 3.0.0 item ships after M1 as
7.0.0 (LG2b; build DECISIONS 6, 32) and is not typed here. Contract-first: no
route emits the new shapes until P05's backend lands M2.01 and the route
changes. Resync both clients (`npm run sync:contracts` in mobile and portal).
Against the resynced copy (a scratch run at their HEADs, not their gates) the
portal typechecks unchanged; the mobile app fails at
`userRepository.ts:71` and `:73` until P05's mobile builder adapts `toUser`.

Breaking:

- `MeWire.name` and `.phone` `string` → `string | null`; `MeWire.location`
  `LocationDisplay` → `LocationDisplay | null` (ACCT-U04; M2.01). Each is
  `null` when the family has none, never `''` and never omitted. A reader that
  prints a name falls back to `email` (design §2.2:2244). The nested
  `emergency_contact` and `address` keep their `''`-never-`null` rule.
- `StaffOwnerWire.name` and `.phone` → `string | null`; `.location`
  `LocationKey` → `LocationKey | null`. M2.01 makes the three `owners` columns
  nullable, and each field is `null` when the family has none. A stored `name`
  or `phone` with no visible character reads, and sorts, as `null`: "filled"
  means a visible character. `id`, `email` and `source` are never `null`. The
  list is now ordered by `lower(coalesce(name, email))`, then `id`: what a
  reader prints.

Added:

- `MeWire.missing_mandatory_fields: SignupField[]`: the fields the sign-up map
  (`acct.signup_field_requirement_map`) marks `mandatory` that are empty on the
  account, in `SIGNUP_FIELDS` order, `[]` when none. It is read from Postgres
  on every `GET /me` and `PATCH /me`, with no cache, and never lists `email`.
- `'profile_incomplete'` appended to `ApiErrorCode` and `API_ERROR_CODES`
  (after `'setting_inert'`, never inserted), with status 422 in
  `API_ERROR_STATUS`.
- `ProfileIncompleteDetails {kind: 'profile_incomplete'; field_keys:
  SignupField[]}`, appended to `ApiErrorDetailWire`. `PATCH /me` emits it when
  the body would leave a `mandatory` field empty. It lists every such field the
  body blanks, never empty, in `SIGNUP_FIELDS` order. A field already empty
  that the body does not name is not a reason to refuse.
- `SIGNUP_FIELDS`, the `SignupField` value tuple in its one order (the map is
  jsonb, which keeps no key order). §16 pins it to `SignupField`. A mutant that
  drops `'address'` proved the pin red first: TS2344 at the pin, and nowhere
  else.
- `PatchMeRequest.name` and `.phone` → `string | null`, and `.location` →
  `LocationDisplay | null`. `null` clears; a `name` or `phone` with no
  visible character (spaces, NBSP and zero-width characters do not count) is
  the same as `null`. A request type that only widens,
  so every 2.0.0 client's body is still accepted.

Changed (doc, plus server behaviour; no shape change):

- `PatchMeRequest`: the map is read on every call. A blanked `mandatory` field
  is 422 `profile_incomplete`; a body that names an `off` field is 400
  `bad_request` whatever its value; every 400 comes before the 422.
  `POST /me/signup` is documented as reserved: not built in v1 and not typed
  (question 29).
- `AccountSettingsWire.signup_fields`: `email` is fixed at `mandatory` (design
  §2.2:2244). A staff PATCH that sets it to anything else is 422
  `invalid_payload`.
- `StaffDogWire.owner_name` is the family's name, or its `email` when the name
  is empty. It is never `null` and never `''`.
- `ApiErrorCode`'s `not_provisioned` note: the owner app answers it on
  `GET /me` with its one "No account yet" screen and Log Out (ACCT-U14).
- `SignupField`'s doc names its two new uses. The design calls the type
  `SignupFieldKey` (§1.1:761-762); the existing name is kept.
- `WIRE_CONTRACT_VERSION` `'2.0.0'` → `'3.0.0-lg2.1'`. Its doc gains LG2's
  line, the M1 part and the LG2b offset.

Not typed here: `POST /me/signup` and its `invite_pending` kind (never built in
3.0.0); `profile_incomplete` on `POST /bookings`, `POST /enrollments` and
`POST /evaluations` (ACCT-U11 and the evaluation route, LG2b); mobile's
`parseBookingGate` codes; and every other design 3.0.0 item (LG2b's 7.0.0, or
P12's 3.0.0).

## [2.0.0] — 2026-11-02

Additive. LG1 step 3 of 3 and LG1's close: 2.0.0 itself, the group's target
(plan unit P03, slice S03, ledger STAFF-U13 and the contract half of
STAFF-U46; build DECISIONS 85; design §1.1 2.0.0,
`designs/fetchd-v1-technical-design.md:710-719`, §2.10 `:4682-4697`,
`:4943-4958`). It types the last of 2.0.0: the staff billing reads
(STAFF-U13), the owner list, and the settings manifest that the portal's
settings editor is drawn from (DECISIONS 85, J27, closing DECISIONS 58's gap).
It also caps an offering's name and description. With 2.0.0-lg1.1 and
2.0.0-lg1.2 before it, every line of §1.1 2.0.0 is now typed. No existing
field, type or tuple changes shape, so every 2.0.0-lg1.2 client compiles
unchanged. Contract-first: no route serves the new shapes until P03's backend
phase B. Resync both clients (`npm run sync:contracts` in mobile and portal).
Both typecheck unchanged against the resynced copy (a scratch run at their
HEADs, not their gates).

Added (§ auth-media):

- `RecordSource` = `'app' | 'gingr' | 'seed'`, a mirror of the `record_source`
  pgEnum (`schema.sql:194`). `conformance.ts` pins it in the same backend
  commit. No value tuple.
- `StaffOwnerWire` `{id, name, email, phone, location: LocationKey, source:
  RecordSource}` and `GetStaffOwnersResponse` for `GET /staff/owners` (any
  staff role; §1.1:718-719). It lists live owners, ordered by name, with no
  money field. `location` is `owners.location` as the slug: the design's
  "campus".

Added (§ payments-invoices, STAFF-U13; §1.1:710-717, §2.10:4682-4697):

- `StaffInvoiceWire` for `GET /staff/owners/:id/invoices`
  (`GetStaffOwnersInvoicesResponse`) and `GET /staff/invoices/:id`, any staff
  role: `id`, `owner_id`, `status`, `purpose`, `amount_cents`, `paid_cents`,
  `dog_id?`, `issued_at`, `due_at`, `paid_at?`, `payments?`. It is today's
  invoice shape (the severance from PAY-U20, design.md:4493-4494), so it has no
  `number` and no `lines`: v1 invoices are one line (design.md:6944).
  `payments` is a non-omit exception decided by the caller. It is present,
  `[]` included, exactly for a caller holding `capabilities.refund_money`
  (04- item 128), and absent for the seeded trainer.
- `StaffInvoicePaymentWire` `{payment_id, paid_cents, refundable_cents}`.
  `refundable_cents` uses the design's one cap definition. On today's schema
  it is paid minus every refund not `failed`, floored at 0. No `withdrawn`
  outcome exists until M5.10 (design 6.0.0), and the field's meaning holds
  across that change.
- `StaffPaymentWire` and `StaffPaymentRefundWire` for `GET
  /staff/owners/:id/payments` (`GetStaffOwnersPaymentsResponse`), owner and
  manager only. `StaffPaymentWire` extends `StaffInvoicePaymentWire` with
  `status: 'succeeded' | 'refunded'`, `purpose`, `created_at`, `dog_id?`,
  `invoice_id?` and `refunds: StaffPaymentRefundWire[]`. A refund row is
  `{id, amount_cents, status: RefundStatus, reason?, created_at}`. There is
  no brand or last4, and the trainer gets 403 `forbidden`.
- `GetStaffOwnersPaymentMethodsResponse` = `PaymentMethodWire[]` for `GET
  /staff/owners/:id/payment-methods`, owner and manager only. It reuses the
  owner's own card row unchanged. The trainer gets 403 `forbidden`.

Added (§ settings, DECISIONS 85):

- (a) `SettingClass` (`'ops' | 'money' | 'price' | 'roles'`, the registry's
  four) and `SettingCatalog` (the six catalog tables a *read-only here* key
  lives in).
- (b) `GET /staff/settings/manifest` → `GetStaffSettingsManifestResponse` =
  `StaffSettingsManifestWire` `{entries: SettingsManifestEntryWire[]}`, any
  staff role, one document. The registry serves one entry per key: `key`,
  `domain`, `class` (`| null`), `read` (`SettingReadWire` `{tier, field,
  path?}` `| null`), `editor` (`SettingEditorWire`: `here` | `via` |
  `elsewhere`), `inert` (`SettingInertWire`: `false` | `{kind, note?}`),
  `editable` and `value` (`SettingValueSpecWire`). `editable` is computed for
  the caller's role, and is `false` for every price key and every inert key.
  `value` has fourteen arms, the registry's value types, with bounds
  resolved, enum values listed, the three staff roles on `role-list` and the
  offerings caps. Un-inerting a key changes the manifest's data, never its
  shape.
- §16: `Expect<Equal<Extract<SettingsDomain, 'manifest'>, never>>`. The static
  segment `manifest` wins over `:domain` in the router, so it may never be a
  domain. A mutant that appends `'manifest'` as a full domain (tuple, union
  and both maps) proved the pin red first: TS2344 at the pin, and nowhere else.

Changed (doc, plus server validation; no shape change):

- `ServiceOfferingWire.name` and `.description` hold at most 60 and 280
  characters (Unicode code points). They are never blank (send `null` to
  clear) and stay one line (DECISIONS 71). Anything else is 422
  `invalid_payload`, enforced in the route; there is no DDL (P01 r3 Opus L3).

Changed (doc only):

- `WIRE_CONTRACT_VERSION` `'2.0.0-lg1.2'` → `'2.0.0'`. Its doc now states the
  landing-group prerelease scheme.
- `ParkedInvoiceWire` names the two new invoice routes. It notes that
  `/staff/invoices/:id` does not collide with `/staff/invoices?parked`, and
  that design 6.1.0's general invoice list is not built here.
- `PaymentMethodWire` names the staff route. `RefundStatus` names its first
  field.
- Settings section header: it names 2.0.0's additions. Its class-and-inert
  rule now says the manifest serves both as data, and its route list gains
  the manifest and the static-segment note.

Not typed here: a `STAFF_ROLES` tuple (nothing iterates the roles; the
manifest serves them on each `role-list` entry); design 6.1.0's general
`GET /staff/invoices` list; and nothing from design 3.0.0 or later.

## [2.0.0-lg1.2] — 2026-11-02

BREAKING. LG1 step 2 of 3 toward 2.0.0 (plan unit P02, slice S02, ledger
STAFF-U02, STAFF-U03, STAFF-U07, ACCT-U05; migrations M1.19–M1.21; design §1.1
2.0.0, `designs/fetchd-v1-technical-design.md:598-605`, `:685-709`, `:720-721`).
It types 2.0.0's whole breaking half: the rebuilt staff roles, the staff
`/me` shape, and the `staff` settings domain that P01 left out (build
DECISIONS 47). It also documents the trainer's 403 on the four legacy money
editors and the expired staffer's 403. Contract-first: no route emits the new
shapes until P02's backend lands M1.19–M1.21 and STAFF-U07. A 2.0.0-lg1.1
client that reads `StaffMeWire.location` or `.active`, or matches on
`'owner-shanthi'` / `'office'`, breaks. Resync both clients (`npm run
sync:contracts` in mobile and portal). Both typecheck unchanged against the
resynced copy (a scratch run, not their gates): the mobile role mapper takes
`role: string`, and the portal imports nothing from `contracts.ts`.

Breaking:

- `StaffRole` `'owner-shanthi' | 'trainer' | 'office'` → `'owner' | 'manager' |
  'trainer'`, in the rebuilt `staff_role` pgEnum's order (M1.19; STAFF-U02).
  It types `StaffMeWire.role`, `ThreadParticipantWire.role` and the five lists
  of `StaffSettingsWire`. `conformance.ts:83` stays red until the Drizzle
  `pgEnum` is rebuilt in the same backend commit. No value tuple exists and
  none is added.
- `StaffMeWire.location: LocationDisplay | null` → `home_locations:
  LocationDisplay[]`, display labels, never empty, held by M1.20's
  `CHECK (cardinality(home_locations) > 0)` (STAFF-U03, E67). Descriptive
  only: no route refuses a staffer outside her home campuses (STAFF-71).

Added:

- `StaffMeWire.capabilities: StaffCapabilitiesWire`, nine booleans computed
  server-side on each `GET /me`: `edit_prices` (false for every role in v1,
  q27 → (a)), `edit_money_policy`, `open_money_reports`,
  `open_payment_history` (owner and manager), `refund_money`, `edit_credits`,
  `custom_invoice`, `desk_sale`, `cash_day_totals` (owner, or a role on the
  matching `staff_settings` list; `refund_money` also for every role while
  `pay.refund_any_role_limit_cents` > 0). Each flag's rule is on its doc
  comment. No `refund_over_limit` (never built, §1.1:729-731) (STAFF-U07).
- `StaffSettingsWire` (M1.21): `refund_roles`, `credit_hand_edit_roles`,
  `desk_sale_roles`, `custom_invoice_roles`, `cash_day_totals_roles:
  StaffRole[]` and `portal_idle_signout_minutes: number` (1..60), plus the
  audit pair. Seeds `{owner, manager}`, `{owner, manager}`, `{owner, manager,
  trainer}`, `{owner, manager}`, `{owner, manager, trainer}`, 30. Served on
  `GET/PATCH /staff/settings/staff`. Every key is `roles` class (owner only).
  The PATCH body is `Partial<Omit<StaffSettingsWire, SettingsAuditKey>>`.
  A role list that is empty is 422 `invalid_payload`; one holding an unknown
  or a repeated role is 400 `bad_request` (build DECISIONS 59).
- `'staff'` APPENDED to `SettingsDomain` and `SETTINGS_DOMAINS` (after `'vax'`,
  never inserted) and to `SettingsWireByDomain` and `SettingsPatchByDomain`.
  That makes fourteen domains, §1.1's count. The §16 key-set pins hold: a
  mutant with `'staff'` in the tuple but missing from one map fails `tsc`
  (TS2344 at the pin, both maps tried).

Changed (doc only):

- `ApiErrorCode`: 403 `not_provisioned` is documented for every staff route
  when the bearer's `staff.expired_at` is set (existing behavior,
  `auth/plugin.ts:115-121`, `auth/mirror.ts:33`; §1.1:720-721). The portal
  signs out on it.
- `POST /staff/rates` (`PostStaffRatesRequest`), `POST /staff/rates/:id/void`
  (`StaffRateWire`), `PATCH /staff/cancel-window/:category`
  (`PatchStaffCancelWindowRequest`, `CancelWindowSettingWire`) and `POST
  /staff/credit-expiry-settings` (`PostStaffCreditExpiryRequest`) now
  document 403 `forbidden` for the trainer. Each route is
  `requireStaffRole('owner', 'manager')` whole (§1.1:706-709; §2.1:2080-2094).
- `StaffMeWire`'s NOTE-35 freeze note and DRIFT-43 note are rewritten. The
  "no per-`StaffRole` authorization gating" note is replaced by
  `StaffCapabilitiesWire`'s doc.
- Settings section header, the `SettingsDomain` doc and the §16 comment now
  say fourteen domains.
- `PaymentSettingValueByKey.refund_any_role_limit_cents`: editable by the owner
  and the manager again (`money` class, design §3.7), reverting 2.0.0-lg1.1's
  owner-only note. Allison's 11-02 answer, "Shanthi or Amber" (build
  DECISIONS 73).
- `WIRE_CONTRACT_VERSION` `'2.0.0-lg1.1'` → `'2.0.0-lg1.2'`.

Removed:

- `StaffMeWire.active` (with `staff.active`, M1.20; question 34). Sign-in reads
  `expired_at` only, so an expired staffer gets 403 `not_provisioned` and
  never this shape.
- `StaffMeWire.location` (replaced by `home_locations`, above).
- `StaffRole` members `'owner-shanthi'` and `'office'`.

Not typed here: invoices, payments, payment-methods and `GET /staff/owners`
(P03, LG1 step 3), and nothing from design 3.0.0 or later.

## [2.0.0-lg1.1] — 2026-11-02

Additive. LG1 step 1 of 3 toward 2.0.0 (plan unit P01, slice S01, ledger
SET-U01; design §1.1 2.0.0, `designs/fetchd-v1-technical-design.md:608-684`).
The settings domain section and its two error arms, for THIRTEEN domains:
`acct`, `alum`, `cash`, `cred`, `day`, `dog`, `eval`, `mig`, `msg`, `notif`,
`pay`, `rpt`, `vax`. The fourteenth, `staff` (`StaffSettingsWire`, M1.21),
joins at 2.0.0-lg1.2 with P02, which owns the rebuilt `staff_role` enum it
needs (build DECISIONS 47). Nothing of 2.0.0's breaking half is here:
`StaffRole`, `StaffMeWire` and `capabilities` are untouched. Contract-first:
no route serves the new shapes until P01's phase B. Every 1.13.0 client
compiles unchanged. Resync both clients (`npm run sync:contracts` in mobile and
portal).

Changed:

- `WIRE_CONTRACT_VERSION` `'1.13.0'` → `'2.0.0-lg1.1'`.
- `ApiErrorCode`, `API_ERROR_CODES` and `API_ERROR_STATUS` gain
  `'setting_inert'` (422). It is APPENDED after `'internal'`, so no existing
  tuple position moves (§1.1:590-591, :641-644).
- `ApiErrorDetailWire` gains two arms, appended: `RefusedKeysDetails`
  `{kind: 'refused_keys'; refused_keys: string[]}`, which rides 403
  `forbidden` (kind ≠ code, truth 3 of §1b), and `SettingInertDetails`
  `{kind: 'setting_inert'; inert_keys: string[]}`, which rides 422
  `setting_inert`.
- File header layout: `settings` is listed as the last fenced domain
  section, after `reports` and before §16. §16 keeps its label (§1.1:591-593).
- §16 `WireTupleConformance` gains `SETTINGS_DOMAINS` ↔ `SettingsDomain` and
  three key-set pins. `keyof SettingsWireByDomain` and
  `keyof SettingsPatchByDomain` must each equal `SettingsDomain`, and
  `keyof PatchStaffSettingsPayRequest` must equal `PaymentSettingKey`. So
  P02's `'staff'` append fails `tsc` until both maps carry it. Proven red
  first by five mutants (tuple missing a member; `'staff'` appended without
  its maps; a pay body key dropped; `'setting_inert'` missing from the tuple;
  and from the status table).

Added (new fenced section `// >>> domain:settings`):

- (a) `SettingsDomain` + `SETTINGS_DOMAINS` (13). Value unions:
  `AccountLockedViewMode`, `SignupField`, `SignupFieldMode`,
  `CashDueService`, `CashDueEvent` (no `'package'` / `'purchase'`,
  §1.1:672, :729-730), `CashPackPartialPaymentDestination`,
  `ReplySignatureMode`, `NotificationChannelMode`, `ReminderProgram`,
  `QuietHoursClass`, `BroadcastAudienceKind`, `PaymentChargeTimingMode`.
- (b) Staff row wires, each carrying `SettingsAuditWire` (`updated_at`,
  `updated_by_staff_id: string | null`), with fields equal to the columns of
  §4 M1.01–M1.16:
  - `AccountSettingsWire`, `AlumniSettingsWire`, `CashSettingsWire`,
    `CreditSettingsWire` (§1.1's ten keys), `DogGateSettingsWire` (four E01
    gates plus `card_required_for_evaluation_booking_enabled`),
    `MigrationSettingsWire`, `NotificationSettingsWire` (born with
    `email_sender_display_name`, `reminder_channel_by_program`,
    `expiry_notice_channel` and `email_inflight_alarm_minutes`),
    `ReportsSettingsWire`, `VaccineSettingsWire`.
  - `MessagingSettingsWire`, with `reply_signature_mode` and the two
    server-resolved responder first names.
  - Two tiers: `DayProgramSettingsWire` = `DayProgramGlobalSettingsWire`
    (`location: null`) | `DayProgramCampusSettingsWire` (with
    `ServiceOfferingWire` offerings, E03). `EvaluationSettingsWire` =
    `EvaluationGlobalSettingsWire` | `EvaluationCampusSettingsWire` likewise.
  - `PaymentSettingWire`, a `(key, scope, value)` row union discriminated on
    `key`, with `PaymentSettingValueByKey` and `PaymentSettingKey`.
    `scope: string`, `'global'` for org-wide rows.
  - `SettingsWireByDomain` and the response aliases
    `GetStaffSettingsResponse<D>` and `PatchStaffSettingsResponse<D>` for
    `GET`/`PATCH /staff/settings/:domain[/:location]`. `day` and `eval`
    address their global row on the bare path and a campus row on
    `/:location`; `pay` returns every row.
  - The owner document `OwnerSettingsWire`, `GET /settings` →
    `GetSettingsResponse`, read from Postgres on every call on the ordinary
    `authenticate` guard. Its sections are `offerings`, `day`, `gates`,
    `eval` (per-campus evaluation `price_cents`, `null` until its
    `service_rates` row exists), `cred`, `cls`, `msg`
    (`OwnerMessagingSettingsWire`), `notif`, `rpt`, `vax` and `pay`. There is
    no `cxl` section, no `mig` section and no day-school price. The section
    types are `OwnerDaySettingsWire`, `OwnerDayCampusSettingsWire`,
    `OwnerGateSettingsWire`, `OwnerEvaluationSettingsWire`,
    `OwnerEvaluationCampusSettingsWire`, `OwnerCreditSettingsWire`,
    `OwnerClassSettingsWire`, `OwnerMessagingSettingsWire`,
    `OwnerNotificationSettingsWire`, `OwnerReportsSettingsWire`,
    `OwnerVaccineSettingsWire` and `OwnerPaymentSettingsWire`.
- (c) `PatchStaffSettingsRequest<D>` over `SettingsPatchByDomain`. Each body
  is partial: every column optional, and every key sent is an edit. `day` and
  `eval` take their tier's columns. The pay body is
  `PatchStaffSettingsPayRequest`, and `SettingsAuditKey` names the two audit
  fields. `Idempotency-Key` is required, and `requestHash` covers
  `{domain, location, ...body}`. Refusal order: 400 → 403 `refused_keys` →
  422 `setting_inert` → 422 `invalid_payload`.
- (d) `PatchStaffSettingsErrorDetails` = `RefusedKeysDetails |
  SettingInertDetails`.

Not changed: `CancelWindowSettingWire`, `CreditExpirySettingWire` and their
verbs stay until design 6.0.0 / 5.0.0 remove them (§1.1:682-684). Settings-key
classes (`ops`/`money`/`price`/`roles`) and inertness live in the server
registry, not on the wire.

Not typed (build DECISIONS 53–58, the drafter's D1–D10): no `day_school_offered_flag` /
`daycare_offered_flag` — `offerings[service].offered` is the one store (D2); no
`capacity_override_dogs` column (D3, per-date `day_capacity`); no DOG-U02 nullable
`card_required_for_evaluation_booking` (D4); no `vax.service_min_age_weeks` or
`rpt.event_price_per_dog_cents` (D7/D8). `setting_inert` also covers the 11-02 re-cut's keys
whose readers wait for P06, P07 and P09.


Review fixes folded in before the first commit (no separate version; build DECISIONS 60–62, 69):
`EvaluationGlobalSettingsWire.reeval_after_months_unseen` is `number | null` (null switches the
clock off, EVAL-53). Documented: `expiry_warning_lead_days` non-empty and distinct;
`refund_any_role_limit_cents` editable by the owner only; `CreditBalanceWire
.warning_lead_days` doc no longer claims the retired `credits-expiring` scan runs.

## [1.13.0] — 2026-08-25

Additive. The whole-truth bump (`designs/wire-contract-completion.md`, the
rulebook): every owner-facing JSON shape and request body enters the
versioned contract, wire.ts reorganizes into 13 alphabetical fenced domain
sections, and THE error contract is promoted from runtime truth.

Skeleton (orchestrator-typed, branch `wire-1.13.0-contract-completion`):

- One-time reorganization (§2): fixed section order — §1 error contract, §2
  shared enums + tuples, §3–§15 fenced domain sections (alphabetical, also
  the lane-merge order), §16 tuple conformance. Every 1.12.0 exported
  declaration relocated BYTE-IDENTICAL, doc comments included, with exactly
  the named exceptions below.
- New: `ApiErrorCode` — the 23 thrown codes (`lib/errors.ts`, verbatim) +
  `'internal'`, the serializer's fallback (api-conventions.md:151's
  documented trap, closed); `API_ERROR_CODES`; `API_ERROR_STATUS` (statuses
  are now CONTRACTUAL); `ApiErrorWire`; `ApiErrorEnvelope`; the closed
  13-arm `ApiErrorDetailWire` union with its item shapes promoted under
  their existing exported names from `lib/bookingErrors.ts` (`VaccineGap`,
  `AgreementGap`, `CreditGap`, `CapacityGap`, `CohortFullDetails` + the
  `CohortFullDetails_` flat arm, `EligibilityGap`,
  `UnpassedEvaluationStatus`, `EvaluationGap`, `AlreadyBookedConflict`,
  `AlreadyEnrolledDetails`, `AlreadyRequestedDetails`,
  `PaymentFailedDetails`, `MediaUploadMissingDetails`). The two coexisting
  detail grammars (nested vs flat-spread), the kebab-case
  `media-upload-missing` kind, and kind≠code non-invariance are PINNED as
  documented truths, not fixed.
- Fold-in (server-side, §3.3): `lib/errors.ts` now imports the code union,
  status table, and details union FROM the wire — a route inventing a
  details literal outside the contract is a `tsc` error at the construction
  site (proven: mutant kind fails TS2820). `lib/bookingErrors.ts` re-exports
  the promoted shapes; constructors unchanged in behavior.
- New shared enums (§5.3): `BookingMode`, `EvaluationStatus`,
  `GroupClassKey` — promoted from `lib/bookingMode.ts:28` and
  `lib/dogWire.ts:27-28` module-privates that were already leaking
  structurally; each pinned to its pgEnum in `conformance.ts` (proven:
  member removal fails the pin).
- New value tuples: `API_ERROR_CODES`, `BOOKING_MODES`, `GROUP_CLASS_KEYS`,
  `NOTIFICATION_TYPES`, `MEDIA_PURPOSES`, `CHARGE_BLOCKERS`,
  `WITHDRAW_MONEY_OUTCOMES`. New `WireTupleConformance` (§16): tuple ↔
  union SET equality pinned in-file with local `Expect`/`Equal`,
  self-contained, so the guard travels with every generated client copy.
- NAMED EXCEPTION 1 (instrument fix, design amendment WC-A1, proven
  red-first): the six pre-1.13.0 value tuples change declaration FORM from
  `: readonly [X, ...X[]] = […]` to `= […] as const satisfies readonly
  [X, ...X[]]` — member values byte-identical, runtime value identical,
  element type narrows compile-time-only. Required because under the old
  annotation every §16 pin is TAUTOLOGICAL — `(typeof TUPLE)[number]`
  widens to the union, so a tuple missing a member passed `tsc` (executed
  in the skeleton session; the same mutant now fails TS2344). This also
  retro-closes the pre-existing hole on the six old tuples
  (`SESSION_PROGRAMS` already used the working form).
- NAMED EXCEPTION 2 (doc-only, on record since money-residue §1.2): doc:
  `owed_cents` remainder is recorded as a terminal `unroutable` refunds row
  at withdraw time (money-residue 1.2); semantics of the sentence unchanged.
- NAMED EXCEPTION 3 (additive field on a 1.12.0 declaration, bookings lane):
  `PendingRequestWire` gains optional `approved_by_staff_id?: string`
  (digest bookings/S; closes DRIFT-8 @ DISCREPANCIES.md:291). Additive at
  the type level — every 1.12.0 client compiles unchanged — and
  omit-on-null on the wire, so no emission changes for a request no staffer
  has touched. The §13 #2 verbatim-block audit reads this declaration
  against THIS exception.
- New (server-side, not wire): `contracts/typeAsserts.ts` — `Expect`/`Equal`
  for the route-side Zod ↔ wire request-body pins (§5.1.3; `z.input`, never
  `z.infer`); `test/contracts/error-envelope.test.ts` — pins the three
  serializer branches (details present / details OMITTED-not-null /
  `'internal'` fallback) through the live `registerAuth` mapper, proven
  red-first (the details-null variant failed before the true pin landed).

Lanes (13 read-only patch builders → `designs/wire-1.13.0-patches/`, merged
alphabetically 2026-08-25 per the §8 protocol; every digest contract item
dispositioned — the 2.6 adversary audits 39/39):

- Entity/response wires promoted under their existing names, per §6's sweep:
  `MeWire` + `StaffMeWire` (the NOTE-35 freeze, ratified) +
  `MeEmergencyContactWire`/`MeAddressWire`/`GetMeResponse`;
  `UploadsSignRequest`/`UploadsSignResponse`; the dog family (`DogWire`,
  `VaccineWire`, `MedicationWire`, `FeedingWire`, `VetWire`),
  `AgreementWire`, `RequiredVaccineWire` — plus its `exempt_class_keys`
  additive EMISSION (the phase's one runtime-byte change, red-first
  tested); `CompletedProgramsWire` + `CurriculumProgram`;
  `WelcomeDogWire`; `EventWire`/`EventLocationWire`/`EventRsvpWire` +
  `DeleteEventsRsvpResponse`; `MembershipWire`/`MembershipCreateWire`/
  `StaffMembershipWire`/`MembershipStatus` (no DB pin possible —
  CHECK-less text, documented; phase 3 adds both);
  `AnnouncementWire`/`AnnouncementCtaWire`/`AnnouncementCtaKind`
  (CHECK-backed, no pin possible, documented)/`AnnouncementCategory`
  (pgEnum pin landed); `DeviceTokenWire`/`DevicePlatform`;
  `LedgerEntryWire` + its unions (incl. `group_class_name`),
  `ParkedInvoiceWire`, `PaymentMethodWire`,
  `PostPaymentMethodsSetupIntentResponse`, `InvoiceStatus` +
  `ChargePurpose` (pgEnum pins landed); `RateWire` (its
  `location: LocationKey | null` non-omit exception documented),
  `DayCapacityWire` (promoted as configured-only; superseded in the fix
  round below, which adds the `*_remaining` pair),
  `CancelWindowSettingWire`; `CreditsWire`/`CreditLotWire`/
  `CreditPackageWire`/`CreditExpirySettingWire`; `GroupClassWire`/
  `CohortWire`/`GroupEligibilityWire`/`EnrollmentWire` +
  `GroupClassEnrollmentType`/`EnrollmentPaymentStatus`; `RefundStatus`
  (pgEnum pin landed; promoted on explicit instruction — no wire field
  consumes it yet, stated on the declaration); the four `ReportWire`
  content types (`PrivateLessonContentWire`, `BoardingSessionContentWire`,
  `BoardTrainSessionContentWire` — a deliberate alias of boarding —
  `GroupClassSessionContentWire`) + `GetStaffReportsResponse` +
  the DELETE envelope shapes for 2.3b.
- Request bodies + query shapes across all 13 domains (~35 declarations),
  each with an exported `z.input` §5.1.3 pin beside its schema — including
  the pin that makes the pre-existing `InvoicePayRequest` live for the
  first time, and `PostEnrollmentsRequest` finally typing `allow_partial` +
  `retry_of` (previously CHANGELOG prose only). Per-endpoint 422 aliases:
  `PostBookingsErrorDetails` (8 arms — runtime truth over the design's
  7-arm sketch, §14.1), `PostRequestsErrorDetails`,
  `PostEnrollmentsErrorDetails`, `PostEventsRsvpErrorDetails` (= `never`;
  `event_full` carries no details, pinned as such) + their arm-kind tuples
  and §16 pins. `GetStaffReportsQuery` with `dog_id` REQUIRED (Allison
  ruling, WC-A5 — the staff-invoices precedent).
- §14.2 sanctioned narrowings, each with runtime + compile proofs:
  `ReportWire` content ×4 (Class A — the only edits to 1.12.0
  declarations beyond the named exceptions);
  `EnrollmentWire.location`/`class_key`, `GroupClassWire.enrollment_type`,
  `CompletedProgramsWire.program` (Class B; the fourth is design
  amendment WC-A2).
- §5.4 equality-proven z.enum swaps, the only Zod bytes moved anywhere:
  `MediaPurpose` ×3 sites (auth-media, member diffs quoted) and
  `pgEnumTuple(bookingMode)` → `BOOKING_MODES` (availability.ts:42).
- §0 conventions gained the Idempotency-Key contract (206-char bound,
  DERIVED: 255 − 49, enforcement-cited to `db/mutation.ts`).
- Named phase-3 contract debt (WC-A3/WC-A5, deliberate): `GetBookingsQuery`,
  `GetRequestsQuery`, `GetStaffRequestsQuery`, `GetStaffInvoicesQuery`,
  `GetAnnouncementsQuery`; `?search=` on staff bookings; an
  `IDEMPOTENCY_KEY_MAX_LEN` wire export; the messaging owner/staff
  400-vs-422 discrepancy (new ledger item); the fifth `MediaPurpose`
  declaration behind the repository seam; the `LocationDisplay` dedupe.

Fix round 1 (2.6 adversary, both lanes; 2026-08-25):

- New: `DayCapacityWire.school_remaining` + `.daycare_remaining` — Allison's
  APPROVED §6-batch #3 option C, which the lanes had mistakenly carried as
  still-deferred (Fable-lane HIGH, requirement drift; WC-A7). Advisory
  (computed outside the booking lock); the authoritative arithmetic stays in
  the booking transaction. Mobile's calendar `classifyStatus` repoints to
  them.
- Contract-truth corrections (all doc-only, Opus-lane findings):
  `API_ERROR_STATUS.internal` documented as a DEFAULT, not a guarantee — the
  serializer fallback passes Fastify-originated statuses through (400/413/
  415 reachable with `code: 'internal'`), now runtime-pinned; the table
  itself becomes `as const satisfies` (immutable + exhaustive);
  `GetStaffBookingsQuery`'s pre-2.3b "every key is inert" prose retired
  (filters are live, malformed values 400, `from > to` returns `[]`); the
  §0 Idempotency-Key block's "FIRST value wins" corrected to Node's real
  comma-join behavior with a SEND-EXACTLY-ONCE warning (duplicated
  differing values defeat replay — server-side rejection is a phase-3
  hardening candidate); two stale §6-batch citations repaired (deny-reason
  "batch #7"; push-categories "#4 rules the vocabulary").
- `DELETE /staff/reports/:id` now also DISMISSES the report's
  `report-published` notification rows (`dismissed_at`, the feed's
  established soft-hide — `notifications` is append-only and has no
  `expired_at`) in the same transaction — the orphaned push whose deep link
  silently resolved to a DIFFERENT report (Opus-lane MEDIUM) dies with its
  subject.
- NAMED EXCEPTION 4 (cosmetic, undeclared until the adversary's symbol
  audit caught it): `WithdrawMoneyOutcome`'s attached comments were
  prettier-reflowed during the fence merge (member values, order, and
  comment TEXT unchanged); the fix round additionally re-attached the
  orphaned `refund_manual` continuation line so the money vocabulary reads
  correctly. The §13 #2 audit reads this block against THIS exception.

Fix round 2 + final pass (2.6 adversary re-verify; 2026-08-25 afternoon):

- Round 2 (backend `2a0e99c`): the notification dismissal's DEAD-DOG arm
  closed — `findOwnerIdAnyInTx` (lifecycle-blind owner lookup; a dead dog
  still names its owner) replaces the live-filtered lookup on the
  report-delete retraction path, red-first against the adversary's exact
  reproduction, the false "rides its own dog's disappearance" comment
  deleted, and the two sibling live-filter callers audited as correct
  (creation gates, loud 404s). `findBookedCountsInRange`'s date window
  rewritten SARGABLE (Postgres-side timestamptz bounds — single tz
  authority with the GROUP BY bucket; EXPLAIN: window moved from Filter
  into Index Cond, bound params included; DST equivalence proven by a
  20-year Chicago-midnight sweep + a 5,094-instant transition sweep, 0
  mismatches; new fall-back-night guard test proven by zone mutation).
  Straggler citations repaired. Gate GREEN 1372/1372.
- Final pass (both lanes, own probes): every round-2 finding re-killed
  independently (isolated-tree red-first re-run; parameterized EXPLAIN on
  a purpose-built 120k-row table; all three repos' wire bodies
  sha-identical at 1.13.0). Verdict CLEAN TO CLOSE — remaining items were
  doc-accuracy only, fixed at close: the dead-dog safety comment's false
  NOT NULL claim corrected (owner_id is NULLABLE in DDL — staff-owned
  dogs; the write-path immutability argument stands), the DST guard
  comment's mis-stated failure modes replaced with the executed one, the
  "no Filter at all" EXPLAIN overstatement scoped to the date window, the
  bidirectional coupling note restored on `assertCapacityWithinLock`, the
  notifications mutation inventory updated, and two schema.sql citations
  re-anchored (+45 drift). The umbrella + backend instruction files'
  "portal has no contract sync" claims retired (2.5 built it).

NOTE ON NUMBERING: the completion plan (2026-08-20) reserved "1.12.0" for
this bump; 1.12.0 shipped 2026-08-21 with the withdraw settlement envelope.
Read every plan citation of "wire 1.12.0" in its Phase 2/§8 as 1.13.0, and
its §2.6 "verified against 1.11.0" as against 1.12.0 (adjudicated,
`designs/wire-contract-completion.md` §1).

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
