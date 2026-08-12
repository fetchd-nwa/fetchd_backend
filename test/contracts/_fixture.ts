import { eq, inArray } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import {
  agreementDocuments,
  agreementSignatures,
  announcements,
  bookingDogs,
  bookings,
  cancelWindowSettings,
  classPrereqOptions,
  cohorts,
  creditLedger,
  creditPackages,
  dayCapacity,
  dogCompletedClasses,
  dogFeeding,
  dogMedications,
  dogVaccines,
  dogs,
  eventRsvpDogs,
  eventRsvps,
  eventSeries,
  events,
  groupClasses,
  invoiceChargeAttempts,
  messages,
  deviceTokens,
  notificationDogs,
  notifications,
  owners,
  paymentMethods,
  scheduledNotifications,
  stripeCustomers,
  pendingRequestDogs,
  pendingRequestPreferredDates,
  pendingRequests,
  reports,
  requiredVaccines,
  serviceRates,
  staff,
  threadDogs,
  threads,
  vets,
} from '../../src/db/schema/schema.js';

/**
 * Fixed UUIDs let the contract snapshots be real JSON files checked into git —
 * no normalization gymnastics, the regression net catches a field rename the
 * day the diff lands. Day 5/6/7 extend this fixture with the rows their
 * contract tests need (bookings, reports, threads, etc.); add to FIXTURE_IDS
 * and extend seed/teardown in FK order. The shape is the only contract Days
 * 5–7 inherit; the data is yours to tune to each day's read.
 *
 * UUID layout: each entity-class gets a leading nibble — 1 = owner, 2 = vet,
 * 3 = dog, 4 = vaccine, 5 = medication, 6 = completed-class, 7 = booking,
 * 9 = agreement signature, a = staff, b = payment-method. v4 marker (third
 * group leads with 4, fourth with 8) so a future fixture-aware tool sees
 * these as real UUIDs.
 *
 * Catalog keys (`required_vaccines.key`, `agreement_documents.key`) are
 * `text` PKs, not UUIDs. They use a `test-` prefix so a future production
 * seed of the same catalog (`rabies`, `liability-waiver`) doesn't collide
 * with the fixture — test rows stay clearly fixture-scoped.
 */
export const FIXTURE_IDS = {
  ownerSupabaseUid: '11111111-1111-4111-8111-111111111110',
  ownerId: '11111111-1111-4111-8111-111111111111',
  vetId: '22222222-2222-4222-8222-222222222222',
  dog1Id: '33333333-3333-4333-8333-333333333331',
  dog2Id: '33333333-3333-4333-8333-333333333332',
  vaccine1Id: '44444444-4444-4444-8444-444444444441',
  vaccine2Id: '44444444-4444-4444-8444-444444444442',
  vaccine3Id: '44444444-4444-4444-8444-444444444443',
  vaccine4Id: '44444444-4444-4444-8444-444444444444',
  medication1Id: '55555555-5555-4555-8555-555555555551',
  completedClass1Id: '66666666-6666-4666-8666-666666666661',
  requiredVaccineRabiesKey: 'test-rabies',
  requiredVaccineBordetellaKey: 'test-bordetella',
  agreementGeneralKey: 'test-general-waiver',
  agreementBoardingKey: 'test-boarding-policy',
  agreementMarketingKey: 'test-marketing-consent',
  signatureGeneralId: '99999999-9999-4999-8999-999999999991',
  signatureBoardingId: '99999999-9999-4999-8999-999999999992',
  staffDonavanSupabaseUid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa0',
  staffDonavanId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  staffRachelSupabaseUid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
  staffRachelId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
  paymentMethod1Id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
  // Day-14: Stripe customer mapping for the fixture owner. Required by the
  // POST /credit-packages/:key/purchase route's `loadPurchaseContext` step
  // — a payment_methods row without a matching stripe_customers row is a
  // 422 (broken API contract). Routes accept any text for the stripe id;
  // tests assert against the stub-returned id, not this string.
  stripeCustomerId: 'cus_fixture_test_visa',
  // Day-5 bookings (numbered for stability across snapshots).
  // 1-5 = upcoming, 6-8 = past, 9 = cancelled, 10 = far-future DST CST coverage.
  booking1Id: '77777777-7777-4777-8777-777777777771',
  booking2Id: '77777777-7777-4777-8777-777777777772',
  booking3Id: '77777777-7777-4777-8777-777777777773',
  booking4Id: '77777777-7777-4777-8777-777777777774',
  booking5Id: '77777777-7777-4777-8777-777777777775',
  booking6Id: '77777777-7777-4777-8777-777777777776',
  booking7Id: '77777777-7777-4777-8777-777777777777',
  booking8Id: '77777777-7777-4777-8777-777777777778',
  booking9Id: '77777777-7777-4777-8777-777777777779',
  bookingDstId: '77777777-7777-4777-8777-77777777777a',
  // Δ 2026-07-14 staleness anchors: booking6 (dog1 past day-school) is marked
  // ATTENDED on its roster row, and this past day-care gives dog2 the same —
  // without a recent attended day program every POST /bookings in this suite
  // would divert into the approval queue (Shanthi's 3-month re-eval rule).
  bookingDog2PastCareId: '77777777-7777-4777-8777-77777777777b',
  // Day-5b: credit_packages catalog keys + credit_ledger ids + service_rates
  // ids. Packages use `test-*` text prefixes for the same reason as the
  // catalog rows above (no collision with a future production seed).
  creditPackageSchool5Key: 'test-school-5',
  creditPackageSchool10Key: 'test-school-10',
  creditPackageDaycare8Key: 'test-daycare-8',
  creditPackageRetiredKey: 'test-retired-pack',
  // The surrogate id of the CURRENT-window test-school-5 @ fayetteville row
  // (Δ 2026-06-08 effective-dating) — the exact priced version the fixture
  // purchase ledger row + the webhook test point at.
  creditPackageSchool5Id: 'cccccccc-cccc-4ccc-8ccc-ccccccccca51',
  creditLedgerPurchaseId: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
  creditLedgerDebitId: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2',
  creditLedgerBentonvilleId: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3',
  serviceRateSchoolFayId: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1',
  serviceRateSchoolNullLocId: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2',
  serviceRateDaycareCurrentId: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd3',
  serviceRateDaycareFutureId: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd4',
  // Day-5b edge-case rows: soft-expired day_capacity override (live() must
  // skip it), closed-window day-care @ bentonville (effective-date filter
  // must skip it so the null-location row wins), boarding rate with empty-
  // string note (optional-omit must drop it from the wire).
  serviceRateDaycareBentonClosedId: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd5',
  serviceRateBoardingEmptyNoteId: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd6',
  // Day-6a: requests + group classes + cohorts + prereq option.
  // group_class keys are NOT prefixed with `test-` because they ARE the
  // canonical `group_class_key` enum values; production seed coexists via
  // ON CONFLICT. UUIDs follow the existing entity-nibble layout —
  // 8 = pending_request, 0 = class_prereq_option, f = cohort.
  pendingRequest1Id: '88888888-8888-4888-8888-888888888881',
  pendingRequest2Id: '88888888-8888-4888-8888-888888888882',
  classPrereqMannersOptionId: '00000000-0000-4000-8000-000000000001',
  cohortPuppyId: 'ffffffff-ffff-4fff-8fff-fffffffffff1',
  cohortMannersId: 'ffffffff-ffff-4fff-8fff-fffffffffff2',
  // Day-6b: reports. `e` nibble is the report id-space.
  //   foundation = Waffles' curriculum-day report (full envelope, all 4
  //     curriculum keys), Donavan as trainer.
  //   privateLesson = Waffles' private-lesson with `private_lesson_content`
  //     variant doc + sparse curriculum envelope (only practice_at_home),
  //     Rachel as trainer.
  //   boarding = Lola's `boarding_session_content` variant doc, NO
  //     trainer (day-care/boarding default), NO curriculum envelope,
  //     NO visit_count, NO verdict_headline (the all-omit branch).
  reportFoundationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1',
  reportPrivateLessonId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2',
  reportBoardingId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3',
  // Day-6b score-push (2026-05-20): add coverage for the remaining 2
  // variant programs so the R2 variant-key emission is runtime-tested
  // (not just compile-time exhaustive via the helper switch).
  reportBoardTrainId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee4',
  reportGroupClassId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5',
  // Day-7a: messaging fixture. Threads use the `1` nibble for the id-space
  // (one nibble shared with owners; thread ids are PK-fresh UUIDs so no
  // collision, just a memorable convention) and messages use `2`.
  //   thread1 = `sessions` category, with Donavan (Fayetteville trainer),
  //     thread_dogs links Waffles + Lola, 5 messages (mixed sender,
  //     2 unread from staff).
  //   thread2 = `billing` category, with Rachel (Fayetteville trainer),
  //     no thread_dogs, 2 messages (all read).
  thread1Id: '11111111-1111-4111-8111-aaaaaaaaaaa1',
  thread2Id: '11111111-1111-4111-8111-aaaaaaaaaaa2',
  message1Id: '22222222-2222-4222-8222-aaaaaaaaaaa1',
  message2Id: '22222222-2222-4222-8222-aaaaaaaaaaa2',
  message3Id: '22222222-2222-4222-8222-aaaaaaaaaaa3',
  message4Id: '22222222-2222-4222-8222-aaaaaaaaaaa4',
  message5Id: '22222222-2222-4222-8222-aaaaaaaaaaa5',
  message6Id: '22222222-2222-4222-8222-aaaaaaaaaaa6',
  message7Id: '22222222-2222-4222-8222-aaaaaaaaaaa7',
  // Day-7a: events fixture. `event_series` carries the recurring "Public
  // Pups" definition; `events` carries one row per dated occurrence.
  //   eventPublicPups = future occurrence (series_id set, is_recurring,
  //     no capacity, description set) — exercises the series + recurring
  //     branch.
  //   eventYappyHour  = one-off future event (series_id null, capacity
  //     20) — exercises the soft-cap + non-recurring branch. NOT emitted
  //     in this Day-7a wire shape (capacity/series_id deferred until FE
  //     consumes) but the row exists.
  //   eventPast = a past event so the snapshot covers "API returns past
  //     events too; FE filters" (FE listEvents returns all).
  // `4` and `5` nibbles for event/series ids; `6` for rsvp ids.
  eventSeriesPublicPupsId: '44444444-4444-4444-8444-aaaaaaaaaaa1',
  eventPublicPupsId: '55555555-5555-4555-8555-aaaaaaaaaaa1',
  eventYappyHourId: '55555555-5555-4555-8555-aaaaaaaaaaa2',
  eventPastId: '55555555-5555-4555-8555-aaaaaaaaaaa3',
  eventCappedId: '55555555-5555-4555-8555-aaaaaaaaaaa4', // capacity 1 — exercises event_full
  eventRsvp1Id: '66666666-6666-4666-8666-aaaaaaaaaaa1',
  // Day-7b: notifications + announcements fixture. Following Day-7a's
  // "reuse first-octet + unique last-octet" idiom — first-octet `7` (booking
  // id-space, weakly associated since most notifications are booking-
  // triggered), last-octet `b`-pattern for notifications and `c`-pattern for
  // announcements. PK-fresh against bookings (`7...n`), payment-method
  // (`b...` with first-octet b), and credit-ledger (`c...` with first-
  // octet c).
  //
  // Five notifications cover (DESC by received_at = order returned):
  //   notif5 (newest) — message-received, UNREAD, sender_staff_id=Donavan,
  //     deep_link_path, dog_ids=[Waffles]. Exercises sender + read-state.
  //   notif4 — report-published, READ, deep_link_path, dog_ids=[Waffles].
  //   notif3 — booking-confirmed, READ, deep_link_path, dog_ids=[Waffles,
  //     Lola]. Multi-dog denorm branch.
  //   notif2 — announcement, UNREAD, NO deep_link_path, NO dog_ids, NO
  //     sender. The all-optional-omitted branch.
  //   notif1 (oldest) — booking-cancelled, READ, deep_link_path, NO dog_ids.
  //
  // Unread count = 2 (notif5, notif2). With limit=3 + cursor pagination
  // the first page emits notif5/4/3 + next_cursor pointing past notif3,
  // and the second page emits notif2/1 with no next_cursor.
  notification1Id: '77777777-7777-4777-8777-bbbbbbbbbbb1',
  notification2Id: '77777777-7777-4777-8777-bbbbbbbbbbb2',
  notification3Id: '77777777-7777-4777-8777-bbbbbbbbbbb3',
  notification4Id: '77777777-7777-4777-8777-bbbbbbbbbbb4',
  notification5Id: '77777777-7777-4777-8777-bbbbbbbbbbb5',
  // Three live announcements + one soft-expired. Exercise: pinned-first
  // ordering, NULL target_location = all-locations match, specific
  // target_location filter, live() filter on expired row.
  //   ann1 — pinned, target=NULL (all), category=team, body + deep_link.
  //   ann2 — not pinned, target='bentonville', category=event, NO
  //     body, NO deep_link.
  //   ann3 — not pinned, target='fayetteville', category=class, body
  //     + deep_link.
  //   annExpired — pinned, target=NULL, expired_at set. Must NOT appear
  //     in any response.
  announcement1Id: '77777777-7777-4777-8777-ccccccccccc1',
  announcement2Id: '77777777-7777-4777-8777-ccccccccccc2',
  announcement3Id: '77777777-7777-4777-8777-ccccccccccc3',
  announcementExpiredId: '77777777-7777-4777-8777-ccccccccccc4',
} as const;

/**
 * A fixed instant the route under test uses as "today" via its `now` option.
 * Dog 1's birthdate is pinned exactly 36 months before this date in Chicago,
 * so `age_months` is deterministic. Pick a date well inside DST so the
 * Chicago bucket is unambiguous (CDT in May = UTC-5).
 */
export const FIXTURE_TODAY = new Date('2026-05-19T17:00:00Z');
export const FIXTURE_NOW = (): Date => FIXTURE_TODAY;

/**
 * Re-seed the fixture. Idempotent across runs: hard-deletes any prior rows
 * first (test scaffolding may use raw DELETE — the never-DELETE invariant is
 * the API's contract with the FE, not a constraint on test seam code).
 *
 * Delete order: dogs first (cascades to vaccines/meds/feeding/completed_
 * classes), then vets, then the owner. Day-4b additions (signatures,
 * required_vaccines, agreement_documents) extend this — signatures must drop
 * before the owner (ON DELETE RESTRICT). Future booking days extend further.
 */
export async function seedFixture(): Promise<void> {
  await teardownFixture();

  // Day-13 leak guard: the test container's DB is persistent across `npm test`
  // runs (schema seed runs once at container create, not per-run), so any
  // test that PATCHes `cancel_window_settings` leaves the policy tuned for
  // subsequent runs. Restore the seeded 48h-flat baseline here so every file
  // starts from the same policy — booking tests asserting the seeded delta
  // are deterministic regardless of run order or prior leaks.
  await db.update(cancelWindowSettings).set({ hoursBefore: 48, updatedByStaffId: null });

  await db.insert(vets).values({
    id: FIXTURE_IDS.vetId,
    name: 'Banfield — Fayetteville',
    phone: '479-555-0100',
    email: 'fay@banfield.example',
    address: '500 Vet Way, Fayetteville, AR',
    notes: 'Ask for Dr. Patel; open weekends.',
    source: 'seed',
    externalRef: 'fixture-vet-banfield-fayetteville',
  });

  await db.insert(requiredVaccines).values([
    {
      key: FIXTURE_IDS.requiredVaccineRabiesKey,
      label: 'Rabies (fixture)',
      gatesCategories: ['day-care', 'day-school', 'boarding', 'board-and-train'],
    },
    {
      key: FIXTURE_IDS.requiredVaccineBordetellaKey,
      label: 'Bordetella (fixture)',
      gatesCategories: ['day-care', 'day-school', 'boarding'],
    },
  ]);

  await db.insert(agreementDocuments).values([
    {
      key: FIXTURE_IDS.agreementGeneralKey,
      label: 'General Liability Waiver (fixture)',
      currentVersion: 1,
      required: true,
      // Empty applies_to → applies to ALL service categories (DATA-CONTRACT §H).
      appliesTo: [],
    },
    {
      key: FIXTURE_IDS.agreementBoardingKey,
      label: 'Boarding Policy (fixture)',
      currentVersion: 2,
      required: true,
      appliesTo: ['boarding', 'board-and-train'],
    },
    // Day-5a addition: non-required, unsigned. Preserves the unsigned-branch
    // coverage of the agreements snapshot now that boarding-policy must be
    // signed (else the bookings_agreement_guard trigger rejects boarding
    // bookings in this fixture). required=false means the guard ignores it,
    // so unsigned is safe; the wire-shape signed_version: null still emits.
    {
      key: FIXTURE_IDS.agreementMarketingKey,
      label: 'Marketing Consent (fixture)',
      currentVersion: 1,
      required: false,
      appliesTo: [],
    },
  ]);

  await db.insert(owners).values({
    id: FIXTURE_IDS.ownerId,
    supabaseUid: FIXTURE_IDS.ownerSupabaseUid,
    name: 'Allison Fixture',
    email: 'fixture@example.com',
    phone: '555-0001',
    location: 'fayetteville',
    avatarImagePath: '',
    emergencyName: 'Sam Fixture',
    emergencyRelationship: 'spouse',
    emergencyPhone: '555-0002',
    pushNotificationsEnabled: true,
    pushNotificationCategories: { booking: true, message: true },
    emailNotificationsEnabled: true,
    emailNotificationCategories: { booking: true, message: true },
  });

  await db.insert(dogs).values([
    {
      id: FIXTURE_IDS.dog1Id,
      ownerId: FIXTURE_IDS.ownerId,
      name: 'Waffles',
      breed: 'Labradoodle',
      // Exactly 36 months before FIXTURE_TODAY in America/Chicago.
      birthdate: '2023-05-19',
      specialNotes: 'Eager learner; loves water.',
      evaluationStatus: 'passed',
      evaluationDate: '2024-03-01T15:00:00Z',
      primaryVetId: FIXTURE_IDS.vetId,
      profileImagePath: 'dogs/waffles/waffles-pfp.jpg',
    },
    {
      id: FIXTURE_IDS.dog2Id,
      ownerId: FIXTURE_IDS.ownerId,
      name: 'Lola',
      breed: 'Golden Retriever',
      // Exercises the ageMonthsOverride branch (birthdate unknown at import).
      birthdate: null,
      ageMonthsOverride: 84,
      specialNotes: '',
      // Day-12b: bumped from 'not-evaluated' → 'passed' so the fixture's
      // booking2 (Lola lead, day-care) + booking5 (Lola lead, boarding)
      // still seed cleanly under the new evaluation gate trigger, and so
      // multi-dog day-care/boarding tests with Lola as a booking_dog pass.
      // The evaluation-gate.test.ts suite flips Lola back to non-passed
      // values per test (with finally-restore), same shape as the
      // vaccine-gate test soft-expires + restores her Rabies record.
      evaluationStatus: 'passed',
      evaluationDate: '2024-06-01T15:00:00Z',
      // Lola boards in this fixture (booking5) → exercises the boarding_enabled
      // = true wire path; Waffles stays default false for the false path.
      boardingEnabled: true,
      profileImagePath: null,
    },
  ]);

  await db.insert(dogVaccines).values([
    {
      id: FIXTURE_IDS.vaccine1Id,
      dogId: FIXTURE_IDS.dog1Id,
      name: 'Rabies',
      requirementKey: FIXTURE_IDS.requiredVaccineRabiesKey,
      expiresAt: '2027-05-19',
    },
    {
      id: FIXTURE_IDS.vaccine2Id,
      dogId: FIXTURE_IDS.dog1Id,
      name: 'Bordetella',
      requirementKey: FIXTURE_IDS.requiredVaccineBordetellaKey,
      expiresAt: '2026-08-15',
    },
    // Lola gets the same gating vaccines so she can be lead on day-care /
    // day-school / boarding bookings (vaccine gate checks the lead dog).
    {
      id: FIXTURE_IDS.vaccine3Id,
      dogId: FIXTURE_IDS.dog2Id,
      name: 'Rabies',
      requirementKey: FIXTURE_IDS.requiredVaccineRabiesKey,
      expiresAt: '2027-05-19',
    },
    {
      id: FIXTURE_IDS.vaccine4Id,
      dogId: FIXTURE_IDS.dog2Id,
      name: 'Bordetella',
      requirementKey: FIXTURE_IDS.requiredVaccineBordetellaKey,
      expiresAt: '2026-08-15',
    },
  ]);

  await db.insert(dogMedications).values({
    id: FIXTURE_IDS.medication1Id,
    dogId: FIXTURE_IDS.dog1Id,
    name: 'Apoquel',
    dose: '5.4 mg',
    frequency: 'once daily',
  });

  await db.insert(dogFeeding).values({
    dogId: FIXTURE_IDS.dog1Id,
    brand: 'Purina Pro Plan',
    amount: '1 cup',
    frequency: 'twice daily',
    notes: 'Add warm water to soften.',
  });

  await db.insert(dogCompletedClasses).values({
    id: FIXTURE_IDS.completedClass1Id,
    dogId: FIXTURE_IDS.dog1Id,
    classKey: 'manners-1',
    completedAt: '2025-09-01T17:00:00Z',
  });

  // Owner has signed BOTH agreements at their current versions. The Day-4b
  // agreements contract test covers the unsigned branch via a separate
  // assertion (it ignores the boarding-policy signature row when validating
  // that an unsigned doc returns signed_version: null). Day 5 needs both
  // signatures so boarding bookings pass the agreement gate trigger.
  await db.insert(agreementSignatures).values([
    {
      id: FIXTURE_IDS.signatureGeneralId,
      ownerId: FIXTURE_IDS.ownerId,
      documentKey: FIXTURE_IDS.agreementGeneralKey,
      version: 1,
      signedAt: '2026-04-01T15:00:00Z',
    },
    {
      id: FIXTURE_IDS.signatureBoardingId,
      ownerId: FIXTURE_IDS.ownerId,
      documentKey: FIXTURE_IDS.agreementBoardingKey,
      version: 2,
      signedAt: '2026-04-01T15:00:00Z',
    },
  ]);

  // Staff trainers — used by bookings' trainer_staff_id resolution. Two
  // staff so the contract tests exercise the inArray(staff.id, [...]) join
  // with >1 ids; one per real NWA role pattern (Donavan = day school,
  // Rachel = private lessons).
  await db.insert(staff).values([
    {
      id: FIXTURE_IDS.staffDonavanId,
      supabaseUid: FIXTURE_IDS.staffDonavanSupabaseUid,
      name: 'Donavan',
      role: 'trainer',
      location: 'fayetteville',
      imagePath: null,
      active: true,
    },
    {
      id: FIXTURE_IDS.staffRachelId,
      supabaseUid: FIXTURE_IDS.staffRachelSupabaseUid,
      name: 'Rachel',
      role: 'trainer',
      location: 'fayetteville',
      imagePath: null,
    },
  ]);

  // Live payment method — required by the bookings_payment_guarantee
  // BEFORE-INSERT trigger (any owner booking without one is rejected with
  // ERRCODE check_violation). Test-mode Stripe id only; nothing here ever
  // hits real Stripe in a contract test.
  // Day-14: stripe_customers must exist BEFORE the payment_methods INSERT
  // for the credit-purchase route's validation chain. FK is owner → stripe
  // customer one-to-one; insert is independent of payment_methods schema-
  // wise but ordering here matches the prod flow.
  await db.insert(stripeCustomers).values({
    ownerId: FIXTURE_IDS.ownerId,
    stripeCustomerId: FIXTURE_IDS.stripeCustomerId,
  });

  await db.insert(paymentMethods).values({
    id: FIXTURE_IDS.paymentMethod1Id,
    ownerId: FIXTURE_IDS.ownerId,
    stripePaymentMethodId: 'pm_fixture_test_visa',
    brand: 'visa',
    last4: '4242',
    expMonth: 12,
    expYear: 2030,
    cardholderName: 'Allison Fixture',
    isDefault: true,
  });

  // Bookings (10 rows) covering every branch the Day-5a contract tests
  // exercise:
  //   1: upcoming day-school, single dog, trainer set, location fayetteville
  //   2: upcoming day-care, single dog (Lola lead), NO trainer, location bentonville
  //   3: upcoming private-lesson, MULTI-DOG (Waffles lead + Lola), with notes,
  //      location NULL (legacy-import simulation)
  //   4: upcoming boarding with pickup_at set (definite end)
  //   5: upcoming boarding with pickup_at NULL (indefinite — exercises the
  //      "no resolved end yet" branch of the bucket helper)
  //   6: past day-school
  //   7: past private-lesson
  //   8: past boarding (pickup_at in the past)
  //   9: cancelled day-school (exercises cancelled_at + cancel_forfeited
  //      always-emitted-as-boolean-when-cancelled; excluded from upcoming/past)
  //   10: far-future day-school on 2026-11-04 — Wednesday AFTER fall-back DST,
  //       so the helper computes 17:30 Chicago in CST (UTC-6). Exercises the
  //       same code path differently from the CDT (UTC-5) summer bookings.
  await db.insert(bookings).values([
    {
      id: FIXTURE_IDS.booking1Id,
      ownerId: FIXTURE_IDS.ownerId,
      leadDogId: FIXTURE_IDS.dog1Id,
      category: 'day-school',
      status: 'upcoming',
      scheduledAt: '2026-05-20T13:00:00Z',
      durationMinutes: 540,
      trainerStaffId: FIXTURE_IDS.staffDonavanId,
      notes: null,
      location: 'fayetteville',
    },
    {
      id: FIXTURE_IDS.booking2Id,
      ownerId: FIXTURE_IDS.ownerId,
      leadDogId: FIXTURE_IDS.dog2Id,
      category: 'day-care',
      status: 'upcoming',
      scheduledAt: '2026-05-21T13:00:00Z',
      durationMinutes: 540,
      trainerStaffId: null,
      notes: null,
      location: 'bentonville',
    },
    {
      id: FIXTURE_IDS.booking3Id,
      ownerId: FIXTURE_IDS.ownerId,
      leadDogId: FIXTURE_IDS.dog1Id,
      category: 'private-lesson',
      status: 'upcoming',
      scheduledAt: '2026-05-26T15:00:00Z',
      durationMinutes: 60,
      trainerStaffId: FIXTURE_IDS.staffRachelId,
      notes: 'Joint household session — leash skills with both dogs',
      location: null,
    },
    {
      id: FIXTURE_IDS.booking4Id,
      ownerId: FIXTURE_IDS.ownerId,
      leadDogId: FIXTURE_IDS.dog1Id,
      category: 'boarding',
      status: 'upcoming',
      scheduledAt: '2026-06-15T15:00:00Z',
      durationMinutes: null,
      trainerStaffId: FIXTURE_IDS.staffDonavanId,
      dropoffAt: '2026-06-15T15:00:00Z',
      pickupAt: '2026-06-20T17:00:00Z',
      notes: '5-night stay; includes a few day-school refreshers',
      location: 'fayetteville',
    },
    {
      id: FIXTURE_IDS.booking5Id,
      ownerId: FIXTURE_IDS.ownerId,
      leadDogId: FIXTURE_IDS.dog2Id,
      category: 'boarding',
      status: 'upcoming',
      scheduledAt: '2026-07-01T13:00:00Z',
      durationMinutes: null,
      trainerStaffId: null,
      dropoffAt: '2026-07-01T13:00:00Z',
      pickupAt: null,
      notes: null,
      location: 'fayetteville',
    },
    {
      id: FIXTURE_IDS.booking6Id,
      ownerId: FIXTURE_IDS.ownerId,
      leadDogId: FIXTURE_IDS.dog1Id,
      category: 'day-school',
      status: 'past',
      scheduledAt: '2026-05-12T13:00:00Z',
      durationMinutes: 540,
      trainerStaffId: FIXTURE_IDS.staffDonavanId,
      notes: null,
      location: 'fayetteville',
    },
    {
      id: FIXTURE_IDS.booking7Id,
      ownerId: FIXTURE_IDS.ownerId,
      leadDogId: FIXTURE_IDS.dog2Id,
      category: 'private-lesson',
      status: 'past',
      scheduledAt: '2026-05-05T15:00:00Z',
      durationMinutes: 60,
      trainerStaffId: FIXTURE_IDS.staffRachelId,
      notes: null,
      location: 'fayetteville',
    },
    {
      id: FIXTURE_IDS.booking8Id,
      ownerId: FIXTURE_IDS.ownerId,
      leadDogId: FIXTURE_IDS.dog1Id,
      category: 'boarding',
      status: 'past',
      scheduledAt: '2026-04-25T15:00:00Z',
      durationMinutes: null,
      trainerStaffId: FIXTURE_IDS.staffDonavanId,
      dropoffAt: '2026-04-25T15:00:00Z',
      pickupAt: '2026-04-30T17:00:00Z',
      notes: null,
      location: 'fayetteville',
    },
    {
      id: FIXTURE_IDS.booking9Id,
      ownerId: FIXTURE_IDS.ownerId,
      leadDogId: FIXTURE_IDS.dog1Id,
      category: 'day-school',
      status: 'cancelled',
      scheduledAt: '2026-05-22T13:00:00Z',
      durationMinutes: 540,
      trainerStaffId: FIXTURE_IDS.staffDonavanId,
      notes: 'Owner cancelled — family emergency',
      location: 'fayetteville',
      cancelledAt: '2026-05-18T20:00:00Z',
      cancellationReason: 'family-emergency',
      cancelDeadlineAt: '2026-05-21T13:00:00Z',
      cancelForfeited: false,
    },
    {
      id: FIXTURE_IDS.bookingDstId,
      ownerId: FIXTURE_IDS.ownerId,
      leadDogId: FIXTURE_IDS.dog1Id,
      category: 'day-school',
      status: 'upcoming',
      // Wednesday after fall-back (Nov 1 2026). 13:00 UTC = 7:00 CST.
      scheduledAt: '2026-11-04T14:00:00Z',
      durationMinutes: 540,
      trainerStaffId: FIXTURE_IDS.staffDonavanId,
      notes: null,
      location: 'fayetteville',
    },
    {
      // Δ 2026-07-14: dog2's staleness anchor — a recently-ATTENDED day-care
      // (roster row below carries attendance='attended'). Keeps dog2 "fresh"
      // under the 3-month re-eval divert so pre-existing POST /bookings tests
      // book instantly; the divert suite builds its own stale dogs.
      id: FIXTURE_IDS.bookingDog2PastCareId,
      ownerId: FIXTURE_IDS.ownerId,
      leadDogId: FIXTURE_IDS.dog2Id,
      category: 'day-care',
      status: 'past',
      scheduledAt: '2026-05-11T13:00:00Z',
      durationMinutes: 540,
      trainerStaffId: null,
      notes: null,
      location: 'bentonville',
    },
  ]);

  // Day-5b catalog, effective-dated since Δ 2026-06-08 (parity with
  // service_rates). At FIXTURE_TODAY (2026-05-19) the live catalog is exactly
  // the three current-window fayetteville packs + the one bentonville pack, so
  // the snapshot is byte-identical to the pre-effective-dating shape. The extra
  // windows exercise the filter:
  //   - test-school-5 @ fayetteville carries THREE windows of one key — a
  //     superseded past price, the CURRENT price (the row the purchase ledger +
  //     snapshot point at), and a FUTURE scheduled reprice — proving "pick the
  //     window that contains today" (past + future both excluded).
  //   - the retired pack's only window is already closed at FIXTURE_TODAY → it
  //     is absent from the catalog (this is the retire mechanism now, replacing
  //     the old active=false switch).
  // Enum order: booking_mode declared 'school','daycare' → school emits first.
  await db.insert(creditPackages).values([
    // test-school-5 @ fayetteville — superseded prior price (window closed).
    {
      key: FIXTURE_IDS.creditPackageSchool5Key,
      location: 'fayetteville',
      mode: 'school',
      credits: 5,
      priceCents: 22_000,
      label: '5 School Credits (old price)',
      isPopular: false,
      effectiveFrom: '2025-06-01',
      effectiveTo: '2026-01-01',
    },
    // test-school-5 @ fayetteville — CURRENT price (live window at FIXTURE_TODAY).
    // The fixture purchase ledger row's package_id points at this exact row.
    {
      id: FIXTURE_IDS.creditPackageSchool5Id,
      key: FIXTURE_IDS.creditPackageSchool5Key,
      location: 'fayetteville',
      mode: 'school',
      credits: 5,
      priceCents: 25_000,
      label: '5 School Credits (fixture)',
      isPopular: false,
      effectiveFrom: '2026-01-01',
      effectiveTo: '2027-01-01',
    },
    // test-school-5 @ fayetteville — FUTURE scheduled reprice (window opens
    // after FIXTURE_TODAY → excluded from today's catalog).
    {
      key: FIXTURE_IDS.creditPackageSchool5Key,
      location: 'fayetteville',
      mode: 'school',
      credits: 5,
      priceCents: 28_000,
      label: '5 School Credits (2027 price)',
      isPopular: false,
      effectiveFrom: '2027-01-01',
      effectiveTo: null,
    },
    {
      key: FIXTURE_IDS.creditPackageSchool10Key,
      location: 'fayetteville',
      mode: 'school',
      credits: 10,
      priceCents: 45_000,
      label: '10 School Credits (fixture)',
      isPopular: true,
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
    },
    {
      key: FIXTURE_IDS.creditPackageDaycare8Key,
      location: 'fayetteville',
      mode: 'daycare',
      credits: 8,
      priceCents: 30_000,
      label: '8 Daycare Credits (fixture)',
      isPopular: false,
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
    },
    // Δ 2026-06-04: same pack key at Bentonville with a DIFFERENT price —
    // exercises per-location pricing.
    {
      key: FIXTURE_IDS.creditPackageSchool5Key,
      location: 'bentonville',
      mode: 'school',
      credits: 5,
      priceCents: 27_500,
      label: '5 School Credits (Bentonville fixture)',
      isPopular: false,
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
    },
    // Fully retired: window already closed at FIXTURE_TODAY, no replacement →
    // absent from the catalog (replaces the old active=false retire switch).
    {
      key: FIXTURE_IDS.creditPackageRetiredKey,
      location: 'fayetteville',
      mode: 'school',
      credits: 3,
      priceCents: 15_000,
      label: 'Retired Test Pack',
      isPopular: false,
      effectiveFrom: '2025-06-01',
      effectiveTo: '2026-04-01',
    },
  ]);

  // Day-5b: per-location day_capacity overrides. Default rule (weekend
  // closed, weekday 3/3) lives in `lib/availability.ts` — these two rows
  // exercise the two override branches:
  //   - 2026-05-17 (Sun) OPEN as a special-event day (school 2 + daycare 1)
  //   - 2026-05-19 (Tue) CLOSED for a staff offsite (0/0)
  // Bentonville has no overrides so its snapshot exercises pure defaults.
  await db.insert(dayCapacity).values([
    {
      location: 'fayetteville',
      date: '2026-05-17',
      schoolOpenings: 2,
      daycareOpenings: 1,
    },
    {
      location: 'fayetteville',
      date: '2026-05-19',
      schoolOpenings: 0,
      daycareOpenings: 0,
    },
    // Soft-expired override: a "closed-Fri" override that was withdrawn.
    // `live(dayCapacity)` filters it out → /availability for 2026-05-22
    // emits the default (3/3 weekday) instead of the expired override (0/0).
    {
      location: 'fayetteville',
      date: '2026-05-22',
      schoolOpenings: 0,
      daycareOpenings: 0,
      expiredAt: '2026-05-01T12:00:00Z',
    },
  ]);

  // Day-5b: service_rates. Two key behaviors:
  //   - location-specific row beats null-location row at the same category
  //     (day-school @ fayetteville $75 vs day-school @ null-location $70 →
  //     fayetteville query returns $75; bentonville query returns $70 via
  //     the null-location fallback)
  //   - effective-dated lookup: day-care @ null-location $45 (active
  //     [2025-12-01, 2026-06-01)) covers FIXTURE_TODAY=2026-05-19; the
  //     $50 row opens 2026-06-01 and must NOT be returned today
  await db.insert(serviceRates).values([
    {
      id: FIXTURE_IDS.serviceRateSchoolFayId,
      category: 'day-school',
      location: 'fayetteville',
      amountCents: 7500,
      unit: 'per-day',
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
      note: 'Standard day-school rate, Fayetteville (fixture)',
    },
    {
      id: FIXTURE_IDS.serviceRateSchoolNullLocId,
      category: 'day-school',
      location: null,
      amountCents: 7000,
      unit: 'per-day',
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
      note: null,
    },
    {
      id: FIXTURE_IDS.serviceRateDaycareCurrentId,
      category: 'day-care',
      location: null,
      amountCents: 4500,
      unit: 'per-day',
      effectiveFrom: '2025-12-01',
      effectiveTo: '2026-06-01',
      note: null,
    },
    {
      id: FIXTURE_IDS.serviceRateDaycareFutureId,
      category: 'day-care',
      location: null,
      amountCents: 5000,
      unit: 'per-day',
      effectiveFrom: '2026-06-01',
      effectiveTo: null,
      note: 'Mid-year increase (fixture)',
    },
    // Day-care @ bentonville $40 — CLOSED window [2025-12-01, 2026-04-01).
    // FIXTURE_TODAY=2026-05-19 is past effective_to → the effective-date
    // filter drops this row, and the null-location $45 wins. Exercises
    // "closed-specific-window falls back to null-location."
    {
      id: FIXTURE_IDS.serviceRateDaycareBentonClosedId,
      category: 'day-care',
      location: 'bentonville',
      amountCents: 4000,
      unit: 'per-day',
      effectiveFrom: '2025-12-01',
      effectiveTo: '2026-04-01',
      note: 'Bentonville intro pricing (expired)',
    },
    // Boarding @ fayetteville with explicit empty-string note. The wire
    // emit logic omits `note` when null OR empty — this row exercises
    // the empty-string branch (the other rows test null + populated).
    {
      id: FIXTURE_IDS.serviceRateBoardingEmptyNoteId,
      category: 'boarding',
      location: 'fayetteville',
      amountCents: 8500,
      unit: 'per-night',
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
      note: '',
    },
  ]);

  // One booking_dogs row per booking_dog pair. Lead is always present;
  // booking 3 is the only multi-dog row (Waffles lead + Lola additional).
  await db.insert(bookingDogs).values([
    { bookingId: FIXTURE_IDS.booking1Id, dogId: FIXTURE_IDS.dog1Id, isLead: true },
    { bookingId: FIXTURE_IDS.booking2Id, dogId: FIXTURE_IDS.dog2Id, isLead: true },
    { bookingId: FIXTURE_IDS.booking3Id, dogId: FIXTURE_IDS.dog1Id, isLead: true },
    { bookingId: FIXTURE_IDS.booking3Id, dogId: FIXTURE_IDS.dog2Id, isLead: false },
    { bookingId: FIXTURE_IDS.booking4Id, dogId: FIXTURE_IDS.dog1Id, isLead: true },
    { bookingId: FIXTURE_IDS.booking5Id, dogId: FIXTURE_IDS.dog2Id, isLead: true },
    // Δ 2026-07-14: the two staleness anchors — dog1's past day-school and
    // dog2's past day-care are ATTENDED so the fixture dogs book instantly
    // under the 3-month re-eval divert rule.
    {
      bookingId: FIXTURE_IDS.booking6Id,
      dogId: FIXTURE_IDS.dog1Id,
      isLead: true,
      attendance: 'attended' as const,
      checkedInAt: '2026-05-12T13:05:00Z',
      checkedInByStaffId: FIXTURE_IDS.staffDonavanId,
    },
    { bookingId: FIXTURE_IDS.booking7Id, dogId: FIXTURE_IDS.dog2Id, isLead: true },
    { bookingId: FIXTURE_IDS.booking8Id, dogId: FIXTURE_IDS.dog1Id, isLead: true },
    { bookingId: FIXTURE_IDS.booking9Id, dogId: FIXTURE_IDS.dog1Id, isLead: true },
    { bookingId: FIXTURE_IDS.bookingDstId, dogId: FIXTURE_IDS.dog1Id, isLead: true },
    {
      bookingId: FIXTURE_IDS.bookingDog2PastCareId,
      dogId: FIXTURE_IDS.dog2Id,
      isLead: true,
      attendance: 'attended' as const,
      checkedInAt: '2026-05-11T13:05:00Z',
      checkedInByStaffId: FIXTURE_IDS.staffDonavanId,
    },
  ]);

  // Day-5b: credit_ledger entries for Waffles only (Lola has zero ledger
  // rows → exercises the zero-sentinel branch of GET /dogs/:id/credits via
  // the LEFT JOIN through dogs in creditsRepository).
  //   +5 school purchase (references the current test-school-5 @ fay row by id)
  //   -1 school debit  (references booking1 — Waffles' upcoming day-school)
  // Resulting balance: { school: 4, daycare: 0 }
  await db.insert(creditLedger).values([
    {
      id: FIXTURE_IDS.creditLedgerPurchaseId,
      dogId: FIXTURE_IDS.dog1Id,
      mode: 'school',
      location: 'fayetteville',
      delta: 5,
      reason: 'purchase',
      packageId: FIXTURE_IDS.creditPackageSchool5Id,
      note: 'Fixture purchase of 5-pack',
    },
    {
      id: FIXTURE_IDS.creditLedgerDebitId,
      dogId: FIXTURE_IDS.dog1Id,
      mode: 'school',
      location: 'fayetteville',
      delta: -1,
      reason: 'booking-debit',
      bookingId: FIXTURE_IDS.booking1Id,
      note: 'Fixture debit for booking1',
    },
    // Δ 2026-06-04: a Bentonville grant so Waffles' balance differs by
    // location — Fayetteville {school:4, daycare:0}, Bentonville {school:0,
    // daycare:2}. Proves GET /dogs/:id/credits is location-scoped.
    {
      id: FIXTURE_IDS.creditLedgerBentonvilleId,
      dogId: FIXTURE_IDS.dog1Id,
      mode: 'daycare',
      location: 'bentonville',
      delta: 2,
      reason: 'adjustment',
      note: 'Fixture Bentonville daycare grant',
    },
  ]);

  // Day-6a catalog: group_classes (3 keys covering both enrollment types) +
  // class_prereq_options (the single existing prereq: manners-2 needs
  // manners-1). Inserted as canonical enum values, not test-prefixed —
  // production catalog seed coexists via ON CONFLICT (key) DO UPDATE. The
  // catalog is the read source for GET /group-classes; the eligibility
  // endpoint reads class_prereq_options against the dog's
  // dog_completed_classes rows.
  await db.insert(groupClasses).values([
    {
      key: 'puppy',
      name: 'Puppy Class (fixture)',
      weeks: 4,
      pricePerDogCents: 12_000,
      capacity: 6,
      ageRange: '8-16 weeks',
      description: 'Foundation skills for puppies under 4 months.',
      enrollmentType: 'open',
    },
    {
      key: 'manners-1',
      name: 'Group Manners 1 (fixture)',
      weeks: 4,
      pricePerDogCents: 18_000,
      capacity: 8,
      ageRange: null,
      description: '4-week beginner manners cohort.',
      enrollmentType: 'cohort',
    },
    {
      key: 'manners-2',
      name: 'Group Manners 2 (fixture)',
      weeks: 4,
      pricePerDogCents: 20_000,
      capacity: 8,
      ageRange: null,
      description: 'Builds on Group Manners 1; manners-1 prereq required.',
      enrollmentType: 'cohort',
    },
  ]);

  // OR-prereq join: one row today (manners-2 → manners-1). The model
  // supports multiple rows per class_key as OR alternatives — the planned
  // public-manners class will have two rows (manners-1, manners-2), and
  // the eligibility endpoint passes the dog if she's completed ANY ONE.
  // Day-6a fixture exercises the singleton-OR case + the no-prereq case
  // (puppy, manners-1).
  await db.insert(classPrereqOptions).values({
    id: FIXTURE_IDS.classPrereqMannersOptionId,
    classKey: 'manners-2',
    prereqClassKey: 'manners-1',
  });

  // Two cohorts:
  //   - puppy @ fayetteville (open enrollment, no end_date)
  //   - manners-2 @ bentonville (cohort enrollment, end_date set,
  //     partially filled — 2/8)
  // Combined they exercise list-by-class + by-id + the location enum
  // breadth + nullable end_date branch.
  await db.insert(cohorts).values([
    {
      id: FIXTURE_IDS.cohortPuppyId,
      classKey: 'puppy',
      location: 'fayetteville',
      startDate: '2026-05-26T15:00:00Z',
      endDate: null,
      weeklyTime: '10:00 AM',
      weeks: 4,
      capacity: 6,
      filled: 1,
    },
    {
      id: FIXTURE_IDS.cohortMannersId,
      classKey: 'manners-2',
      location: 'bentonville',
      startDate: '2026-06-01T23:00:00Z',
      endDate: '2026-06-22T23:00:00Z',
      weeklyTime: '6:00 PM',
      weeks: 4,
      capacity: 8,
      filled: 2,
    },
  ]);

  // Day-6b: reports. Three rows covering R2 rehydration:
  //   foundation — Waffles, curriculum program, `results` envelope holds
  //     all FOUR sibling curriculum keys (skills grid `results` + practice
  //     + friends + additional_skills_completed). `content` NULL per the
  //     CHECK constraint (curriculum programs carry no variant doc).
  //   private-lesson — Waffles, variant program. `content` holds the
  //     `private_lesson_content` doc; `results` envelope holds only
  //     `practice_at_home` (variant rows often carry sparse curriculum).
  //     Exercises the optional-omit branch on individual envelope keys.
  //   boarding-session — Lola, variant program. `content` holds the
  //     `boarding_session_content` doc; `results` NULL (no curriculum
  //     data at all). NULL trainer (day-care/boarding default — no
  //     trainer name on the wire). visit_count + verdict_headline NULL
  //     (exercises the both-omit branch).
  await db.insert(reports).values([
    {
      id: FIXTURE_IDS.reportFoundationId,
      dogId: FIXTURE_IDS.dog1Id,
      // 2026-05-08 13:00 UTC = 08:00 CDT (mid-May, DST active).
      date: '2026-05-08T13:00:00Z',
      trainerStaffId: FIXTURE_IDS.staffDonavanId,
      category: 'day-school',
      program: 'foundation',
      excerpt: 'Waffles had a great session — really locked in her sit-stay today up to 15 feet.',
      fullText:
        'Waffles came in with a ton of energy today but channeled it really well once we got into structured work. We focused on duration and distance with her sit-stay.',
      visitCount: 8,
      verdictHeadline: 'Great Start!',
      results: {
        results: {
          'sit.l1': { status: 'pass' },
          'sit.l2': { status: 'pass', score: '4/5' },
          'down.l1': { status: 'learning', score: '3/5' },
        },
        practice_at_home: [
          { text: 'Build *Down duration* — start with 3 seconds, work up to 15.' },
          { text: 'Practice *Place* on her cot in the kitchen during dinner prep.' },
        ],
        friends_today: [FIXTURE_IDS.dog2Id],
        additional_skills_completed: ['name-recognition'],
      },
      content: null,
    },
    {
      id: FIXTURE_IDS.reportPrivateLessonId,
      dogId: FIXTURE_IDS.dog1Id,
      date: '2026-04-25T20:00:00Z',
      trainerStaffId: FIXTURE_IDS.staffRachelId,
      category: 'private-lesson',
      program: 'private-lesson',
      excerpt: 'Worked through leash protocols, transitions, and managing distractions.',
      fullText:
        'Great session today — Waffles is showing real progress on leash, but transitions and unexpected dogs are still her biggest moments.',
      visitCount: 3,
      verdictHeadline: 'On the right track',
      results: {
        practice_at_home: [
          { text: 'Run the leash protocol *indoors first*, every day, before you head out.' },
          { text: "Drill *up-down* anywhere — even when she's calm." },
        ],
      },
      content: {
        session_focus: 'Leash skills + transitions + managing distractions',
        topics: [
          {
            id: 'leash',
            title: 'Leash',
            sections: [
              {
                kind: 'steps',
                items: [
                  'Start her inside before the walk — pay for standing beside you.',
                  'Once outside, claim the space in front of the house.',
                ],
              },
              {
                kind: 'note',
                text: 'Transitions are tough for her — going around corners and into new areas.',
              },
            ],
          },
        ],
      },
    },
    {
      id: FIXTURE_IDS.reportBoardingId,
      dogId: FIXTURE_IDS.dog2Id,
      date: '2026-04-12T20:00:00Z',
      trainerStaffId: null,
      category: 'boarding',
      program: 'boarding-session',
      excerpt: '3-night stay — settled fast, slept through by night 2.',
      fullText:
        'Lola had a wonderful three nights with us. She settled in faster than most dogs do — sleeping through the night by the second day.',
      visitCount: null,
      verdictHeadline: null,
      results: null,
      content: {
        check_in_date: '2026-04-12T16:00:00.000Z',
        check_out_date: '2026-04-15T11:00:00.000Z',
        nights: 3,
        summary: 'Settled in quickly. Slept through by night 2.',
        days: [
          {
            date: '2026-04-12T16:00:00.000Z',
            label: 'Day 1 · Arrival',
            activities: ['Check-in at 4 PM', 'Yard time with Brodie'],
            sleep_note: 'Slept through after dinner.',
          },
        ],
      },
    },
    {
      // board-train-session variant — exercises board_train_session_content
      // wire key. Reuses the boarding-day-journal content shape (same as
      // boarding) per the FE's `to*Content` translators.
      id: FIXTURE_IDS.reportBoardTrainId,
      dogId: FIXTURE_IDS.dog1Id,
      date: '2026-03-15T20:00:00Z',
      trainerStaffId: FIXTURE_IDS.staffDonavanId,
      category: 'board-and-train',
      program: 'board-train-session',
      excerpt: '2-week foundations residential — solid cue set + leash skills.',
      fullText:
        'Two-week board & train. We built engagement, then the core cues (sit, down, place, stay), then leash skills. Reliable cue set by handoff; daily reps from you keep it cemented.',
      visitCount: 1,
      verdictHeadline: 'Two solid weeks',
      results: null,
      content: {
        check_in_date: '2026-03-01T16:00:00.000Z',
        check_out_date: '2026-03-15T11:00:00.000Z',
        nights: 14,
        summary: 'Engagement → cues → leash → distractions. Foundation built.',
        days: [
          {
            date: '2026-03-01T16:00:00.000Z',
            label: 'Day 1 · Arrival',
            activities: ['Intake walk', 'Crate intro', 'Quiet evening'],
            sleep_note: 'Settled by 10 PM.',
            trainer_note: 'Easy intake. Reads routine quickly.',
          },
        ],
      },
    },
    {
      // group-class-session variant — exercises group_class_session_content
      // wire key. Distinct content shape (class_name + cohort_label +
      // week_count + weeks[]); each week has its own topics array of
      // {label, description?, isLinked?} entries.
      id: FIXTURE_IDS.reportGroupClassId,
      dogId: FIXTURE_IDS.dog1Id,
      date: '2026-03-01T20:00:00Z',
      trainerStaffId: FIXTURE_IDS.staffRachelId,
      category: 'group-class',
      program: 'group-class-session',
      excerpt: '4-week Group Manners 1 cohort — solid recall + place + leash review.',
      fullText:
        'Group Manners 1 ran over four Saturdays. Below is the recap from each week with handouts, practice items, and the concepts we covered.',
      visitCount: 1,
      verdictHeadline: 'Cohort complete',
      results: null,
      content: {
        class_name: 'Group Manners 1',
        cohort_label: "Spring '26 cohort",
        week_count: 4,
        weeks: [
          {
            week_number: 1,
            date: '2026-02-08T20:00:00.000Z',
            title: 'Foundations: engagement + name recognition',
            location: 'In house',
            intro: 'Welcome to Group Manners 1.',
            topics: [
              { label: 'Engagement', isLinked: true },
              { label: 'Name recognition', description: 'Build the muscle of looking at you.' },
            ],
            practice_items: ['Daily engagement drills', 'Name game at meals'],
            closing_note: 'Great first week.',
          },
        ],
      },
    },
  ]);

  // Two pending requests:
  //   - request1: submitted private-lesson, MULTI-DOG (Waffles lead +
  //     Lola), full notes (per_dog + joint), full focus (staff_preference
  //     + descriptor_keys), 3 preferred dates → exercises every required +
  //     optional key on the PendingRequest wire shape.
  //   - request2: converted board-and-train, single dog (Waffles),
  //     length_weeks=2, approved_at + approved_by_staff_id +
  //     converted_booking_id set, NO notes, NO focus inner keys →
  //     exercises optional-omit on the wire (notes omitted entirely,
  //     focus emits `{}`). `converted_booking_id` points at booking1 to
  //     satisfy the FK; the category mismatch (B&T request → day-school
  //     booking) is fixture coincidence, not on the wire.
  await db.insert(pendingRequests).values([
    {
      id: FIXTURE_IDS.pendingRequest1Id,
      ownerId: FIXTURE_IDS.ownerId,
      leadDogId: FIXTURE_IDS.dog1Id,
      category: 'private-lesson',
      status: 'submitted',
      submittedAt: '2026-05-15T19:00:00Z',
      notesPerDog: 'Waffles needs leash polish; Lola is reactive to bikes.',
      notesJoint: 'They walk best on a coupler — keep them together if possible.',
      staffPreference: 'rachel',
      descriptorKeys: ['nervous', 'reactive-on-leash'],
    },
    {
      id: FIXTURE_IDS.pendingRequest2Id,
      ownerId: FIXTURE_IDS.ownerId,
      leadDogId: FIXTURE_IDS.dog1Id,
      category: 'board-and-train',
      status: 'converted',
      submittedAt: '2026-04-10T16:00:00Z',
      lengthWeeks: 2,
      approvedAt: '2026-04-12T17:00:00Z',
      approvedByStaffId: FIXTURE_IDS.staffRachelId,
      convertedBookingId: FIXTURE_IDS.booking1Id,
    },
  ]);

  await db.insert(pendingRequestDogs).values([
    { requestId: FIXTURE_IDS.pendingRequest1Id, dogId: FIXTURE_IDS.dog1Id, isLead: true },
    { requestId: FIXTURE_IDS.pendingRequest1Id, dogId: FIXTURE_IDS.dog2Id, isLead: false },
    { requestId: FIXTURE_IDS.pendingRequest2Id, dogId: FIXTURE_IDS.dog1Id, isLead: true },
  ]);

  await db.insert(pendingRequestPreferredDates).values([
    { requestId: FIXTURE_IDS.pendingRequest1Id, ordinal: 1, preferredAt: '2026-06-05T15:00:00Z' },
    { requestId: FIXTURE_IDS.pendingRequest1Id, ordinal: 2, preferredAt: '2026-06-12T15:00:00Z' },
    { requestId: FIXTURE_IDS.pendingRequest1Id, ordinal: 3, preferredAt: '2026-06-19T15:00:00Z' },
    { requestId: FIXTURE_IDS.pendingRequest2Id, ordinal: 1, preferredAt: '2026-05-01T13:00:00Z' },
    { requestId: FIXTURE_IDS.pendingRequest2Id, ordinal: 2, preferredAt: '2026-05-08T13:00:00Z' },
  ]);

  // Day-7a: messaging fixture. Two threads, seven messages.
  //   thread1 (`sessions`, with Donavan): related to Waffles + Lola via
  //     thread_dogs. Five messages alternating owner/staff sender, the
  //     last two from staff are UNREAD (read_at NULL). → unread_count = 2.
  //   thread2 (`billing`, with Rachel): no thread_dogs (related_dog_ids
  //     emits as `[]`). Two messages — owner Q, Rachel A, both READ.
  //     → unread_count = 0.
  await db.insert(threads).values([
    {
      id: FIXTURE_IDS.thread1Id,
      ownerId: FIXTURE_IDS.ownerId,
      participantStaffId: FIXTURE_IDS.staffDonavanId,
      category: 'sessions',
      title: 'Waffles + Lola — leash work',
      subText: 'with Donavan',
      lastMessage: 'Sounds good — Friday at 9am.',
      lastMessageAt: '2026-05-19T14:30:00Z',
    },
    {
      id: FIXTURE_IDS.thread2Id,
      ownerId: FIXTURE_IDS.ownerId,
      participantStaffId: FIXTURE_IDS.staffRachelId,
      category: 'billing',
      title: 'Group Manners 1 invoice',
      subText: 'with Rachel',
      lastMessage: 'Got it, thanks!',
      lastMessageAt: '2026-05-10T17:00:00Z',
    },
  ]);

  await db.insert(threadDogs).values([
    { threadId: FIXTURE_IDS.thread1Id, dogId: FIXTURE_IDS.dog1Id },
    { threadId: FIXTURE_IDS.thread1Id, dogId: FIXTURE_IDS.dog2Id },
  ]);

  await db.insert(messages).values([
    // thread1 timeline — owner asks, staff replies, owner follows up,
    // staff replies twice (both unread → unread_count = 2).
    {
      id: FIXTURE_IDS.message1Id,
      threadId: FIXTURE_IDS.thread1Id,
      senderKind: 'owner',
      senderOwnerId: FIXTURE_IDS.ownerId,
      senderStaffId: null,
      text: 'Hey — wanted to follow up on Waffles & Lola from Tuesday. Is Friday morning open?',
      sentAt: '2026-05-19T13:00:00Z',
      readAt: '2026-05-19T13:05:00Z',
    },
    {
      id: FIXTURE_IDS.message2Id,
      threadId: FIXTURE_IDS.thread1Id,
      senderKind: 'staff',
      senderOwnerId: null,
      senderStaffId: FIXTURE_IDS.staffDonavanId,
      text: 'Friday at 9am works. Bringing both?',
      sentAt: '2026-05-19T13:10:00Z',
      readAt: '2026-05-19T13:15:00Z',
    },
    {
      id: FIXTURE_IDS.message3Id,
      threadId: FIXTURE_IDS.thread1Id,
      senderKind: 'owner',
      senderOwnerId: FIXTURE_IDS.ownerId,
      senderStaffId: null,
      text: 'Yes — both. Lola is the bigger leash-reactivity question right now.',
      sentAt: '2026-05-19T13:20:00Z',
      readAt: '2026-05-19T13:21:00Z',
    },
    {
      id: FIXTURE_IDS.message4Id,
      threadId: FIXTURE_IDS.thread1Id,
      senderKind: 'staff',
      senderOwnerId: null,
      senderStaffId: FIXTURE_IDS.staffDonavanId,
      text: 'Perfect — I have a couple of new tools for that. Bring her flat collar.',
      sentAt: '2026-05-19T14:25:00Z',
      readAt: null,
    },
    {
      id: FIXTURE_IDS.message5Id,
      threadId: FIXTURE_IDS.thread1Id,
      senderKind: 'staff',
      senderOwnerId: null,
      senderStaffId: FIXTURE_IDS.staffDonavanId,
      text: 'Sounds good — Friday at 9am.',
      sentAt: '2026-05-19T14:30:00Z',
      readAt: null,
    },
    // thread2 — invoice Q + A, both read.
    {
      id: FIXTURE_IDS.message6Id,
      threadId: FIXTURE_IDS.thread2Id,
      senderKind: 'owner',
      senderOwnerId: FIXTURE_IDS.ownerId,
      senderStaffId: null,
      text: 'Hi — was the Group Manners 1 charge for both dogs or just Waffles?',
      sentAt: '2026-05-10T16:30:00Z',
      readAt: '2026-05-10T16:45:00Z',
    },
    {
      id: FIXTURE_IDS.message7Id,
      threadId: FIXTURE_IDS.thread2Id,
      senderKind: 'staff',
      senderOwnerId: null,
      senderStaffId: FIXTURE_IDS.staffRachelId,
      text: 'Just Waffles — Lola never enrolled in this one. Got it, thanks!',
      sentAt: '2026-05-10T17:00:00Z',
      readAt: '2026-05-10T17:15:00Z',
    },
  ]);

  // Day-7a: events fixture. One series (Public Pups), three event rows
  // (one series-recurring, one one-off w/ capacity, one past), one RSVP
  // from the fixture owner attached to the recurring event with both
  // dogs in event_rsvp_dogs.
  await db.insert(eventSeries).values({
    id: FIXTURE_IDS.eventSeriesPublicPupsId,
    name: 'Public Pups',
    cadence: 'weekly-saturday',
    defaultDurationMinutes: 60,
    description: 'Weekly social hour for vaccinated, well-socialized dogs.',
    isActive: true,
  });

  await db.insert(events).values([
    {
      id: FIXTURE_IDS.eventPublicPupsId,
      name: 'Public Pups',
      startsAt: '2026-05-23T19:00:00Z', // Saturday 2pm CDT
      durationMinutes: 60,
      locLabel: 'Fayetteville yard',
      locAddress: '123 Main St, Fayetteville, AR',
      locLatitude: 36.0822,
      locLongitude: -94.1719,
      description: 'Bring your favorite ball.',
      isRecurring: true,
      seriesId: FIXTURE_IDS.eventSeriesPublicPupsId,
      capacity: null,
    },
    {
      id: FIXTURE_IDS.eventYappyHourId,
      name: 'Yappy Hour',
      startsAt: '2026-06-15T22:00:00Z', // Monday 5pm CDT
      durationMinutes: 90,
      locLabel: 'Bentonville patio',
      locAddress: '456 Beer St, Bentonville, AR',
      locLatitude: 36.3729,
      locLongitude: -94.2088,
      description: null, // exercises optional-omit on description
      isRecurring: false,
      seriesId: null,
      capacity: 20,
    },
    {
      id: FIXTURE_IDS.eventPastId,
      name: 'Public Pups (last week)',
      startsAt: '2026-05-16T19:00:00Z',
      durationMinutes: 60,
      locLabel: 'Fayetteville yard',
      locAddress: '123 Main St, Fayetteville, AR',
      locLatitude: 36.0822,
      locLongitude: -94.1719,
      description: 'Past event — included in /events response per FE contract.',
      isRecurring: true,
      seriesId: FIXTURE_IDS.eventSeriesPublicPupsId,
      capacity: null,
    },
    {
      id: FIXTURE_IDS.eventCappedId,
      name: 'Tiny Meetup',
      startsAt: '2026-06-20T19:00:00Z',
      durationMinutes: 60,
      locLabel: 'Fayetteville yard',
      locAddress: '123 Main St, Fayetteville, AR',
      locLatitude: 36.0822,
      locLongitude: -94.1719,
      description: 'Capacity 1 — exercises the event_full soft cap.',
      isRecurring: false,
      seriesId: null,
      capacity: 1,
    },
  ]);

  await db.insert(eventRsvps).values({
    id: FIXTURE_IDS.eventRsvp1Id,
    eventId: FIXTURE_IDS.eventPublicPupsId,
    ownerId: FIXTURE_IDS.ownerId,
    rsvpdAt: '2026-05-18T16:00:00Z',
  });

  await db.insert(eventRsvpDogs).values([
    { rsvpId: FIXTURE_IDS.eventRsvp1Id, dogId: FIXTURE_IDS.dog1Id },
    { rsvpId: FIXTURE_IDS.eventRsvp1Id, dogId: FIXTURE_IDS.dog2Id },
  ]);

  // Day-7b: notifications + notification_dogs. Append-only feed (no
  // expired_at). Pin received_at timestamps so the snapshot is stable and
  // the cursor-pagination keyset has deterministic ordering. notif5 is
  // newest, notif1 is oldest; see FIXTURE_IDS docblock for branch coverage.
  await db.insert(notifications).values([
    {
      id: FIXTURE_IDS.notification5Id,
      ownerId: FIXTURE_IDS.ownerId,
      type: 'message-received',
      title: 'New message from Donavan',
      body: 'Perfect — I have a couple of new tools for that. Bring her flat collar.',
      receivedAt: '2026-05-19T16:00:00Z',
      readAt: null,
      deepLinkPath: '/messages/' + FIXTURE_IDS.thread1Id,
      senderStaffId: FIXTURE_IDS.staffDonavanId,
    },
    {
      id: FIXTURE_IDS.notification4Id,
      ownerId: FIXTURE_IDS.ownerId,
      type: 'report-published',
      title: "Waffles' new report card is ready",
      body: 'Great session today — really locked in her sit-stay.',
      receivedAt: '2026-05-19T12:00:00Z',
      readAt: '2026-05-19T12:30:00Z',
      deepLinkPath: '/reports/' + FIXTURE_IDS.reportFoundationId,
      senderStaffId: null,
    },
    {
      id: FIXTURE_IDS.notification3Id,
      ownerId: FIXTURE_IDS.ownerId,
      type: 'booking-confirmed',
      title: 'Private lesson confirmed',
      body: 'Joint household session with Waffles + Lola — May 26 at 10am.',
      receivedAt: '2026-05-18T15:00:00Z',
      readAt: '2026-05-18T15:10:00Z',
      deepLinkPath: '/bookings/' + FIXTURE_IDS.booking3Id,
      senderStaffId: null,
    },
    {
      id: FIXTURE_IDS.notification2Id,
      ownerId: FIXTURE_IDS.ownerId,
      type: 'announcement',
      title: 'School closed Memorial Day',
      body: 'NWA will be closed Monday May 25 for Memorial Day. Normal hours resume Tuesday.',
      receivedAt: '2026-05-17T10:00:00Z',
      readAt: null,
      deepLinkPath: null,
      senderStaffId: null,
    },
    {
      id: FIXTURE_IDS.notification1Id,
      ownerId: FIXTURE_IDS.ownerId,
      type: 'booking-cancelled',
      title: 'Day school cancelled',
      body: 'Your May 22 day school booking was cancelled.',
      receivedAt: '2026-05-16T09:00:00Z',
      readAt: '2026-05-16T09:05:00Z',
      deepLinkPath: '/bookings/' + FIXTURE_IDS.booking9Id,
      senderStaffId: null,
    },
  ]);

  // notification_dogs M:N (no expired_at). notif3 multi-dog, notif4/5
  // single-dog (Waffles), notif1/2 none.
  await db.insert(notificationDogs).values([
    { notificationId: FIXTURE_IDS.notification5Id, dogId: FIXTURE_IDS.dog1Id },
    { notificationId: FIXTURE_IDS.notification4Id, dogId: FIXTURE_IDS.dog1Id },
    { notificationId: FIXTURE_IDS.notification3Id, dogId: FIXTURE_IDS.dog1Id },
    { notificationId: FIXTURE_IDS.notification3Id, dogId: FIXTURE_IDS.dog2Id },
  ]);

  // Day-7b: announcements. Three live + one soft-expired. Pinned-first
  // ordering means ann1 (pinned, oldest published) emits before ann2/ann3
  // even though ann2 is newer.
  await db.insert(announcements).values([
    {
      id: FIXTURE_IDS.announcement1Id,
      category: 'team',
      title: 'Meet our new trainer Fed',
      body: 'Fed joins us at Bentonville starting June 1 — sport dog + reactive specialist.',
      publishedAt: '2026-05-15T15:00:00Z',
      deepLinkPath: '/team/fed',
      targetLocation: null, // all locations
      isPinned: true,
    },
    {
      id: FIXTURE_IDS.announcement2Id,
      category: 'event',
      title: 'Yappy Hour @ Bentonville',
      body: null, // optional-omit branch
      publishedAt: '2026-05-18T17:00:00Z',
      deepLinkPath: null, // optional-omit branch
      targetLocation: 'bentonville',
      isPinned: false,
    },
    {
      id: FIXTURE_IDS.announcement3Id,
      category: 'class',
      title: 'Group Manners 1 starting in June',
      body: 'Saturdays at 10am, 4 weeks. Fayetteville only.',
      publishedAt: '2026-05-10T18:00:00Z',
      deepLinkPath: '/classes/manners-1',
      // Day-19e: exercises the cta wire (the all-present branch) — an enroll CTA
      // emits as a nested `cta` object alongside the legacy deep_link_path.
      ctaLabel: 'See available dates',
      ctaKind: 'enroll',
      ctaTarget: 'manners-1',
      targetLocation: 'fayetteville',
      isPinned: false,
    },
    {
      id: FIXTURE_IDS.announcementExpiredId,
      category: 'urgent',
      title: 'EXPIRED — should not appear',
      body: 'This announcement was withdrawn; live() filter must skip it.',
      publishedAt: '2026-05-05T12:00:00Z',
      deepLinkPath: null,
      targetLocation: null,
      isPinned: true,
      expiredAt: '2026-05-12T12:00:00Z',
    },
  ]);
}

/**
 * Top up a fixture dog with `amount` extra credits of `mode`. Promoted
 * to the shared fixture at Day 13 (rule-of-three: booking-create +
 * evaluation-gate + bookings-cancel all need it for the credit-paid
 * paths). The reason field is `'purchase'`, mirroring how Day-14
 * package-purchase will write rows; `note` carries a unique tag so
 * accumulating top-ups across tests are visible in audit_log if
 * something goes sideways.
 */
export async function topUpCredits(
  dogId: string,
  mode: 'school' | 'daycare',
  amount: number,
  location: 'fayetteville' | 'bentonville' = 'fayetteville',
): Promise<void> {
  const { creditLedger } = await import('../../src/db/schema/schema.js');
  const { randomUUID } = await import('node:crypto');
  await db.insert(creditLedger).values({
    dogId,
    mode,
    location,
    delta: amount,
    reason: 'purchase',
    note: `Test top-up ${randomUUID()}`,
  });
}

/**
 * Hard-delete every fixture row this file knows about, in FK-safe order.
 *
 * **FK ordering invariant (READ BEFORE EDITING):** any new table that
 * references an existing fixture table must drop BEFORE the table it
 * references. Foreign keys with `ON DELETE RESTRICT` block parent deletes;
 * a missed precedence leaves teardown failing partway, the next file's
 * seed inheriting orphan rows, and tests cascading. Earned 2026-05-26
 * (Day-14): `credit_ledger.charge_id → charges.id` was added but the
 * teardown still deleted `charges` first, FK-blocking the entire chain.
 *
 * Per-table precedence in this file's deletes:
 *   refunds          → before bookings + charges
 *   credit_ledger    → before charges + dogs + bookings (charges FK Day-14)
 *   charges          → before owners + bookings
 *   booking_dogs     → ON DELETE CASCADE on bookings (implicit)
 *   bookings         → before dogs + owners
 *   payment_methods  → before owners (RESTRICT)
 *   stripe_customers → before owners (RESTRICT; Day-14)
 *   dogs             → before owners + vets (RESTRICT on owners)
 *   agreement_*      → before owners + agreement_documents
 *   required_vaccines → before requirement-key-referencing dog_vaccines
 *   vets             → before owners-dependent FKs are dropped
 *   owners           → after all children
 *   staff            → after bookings (RESTRICT via trainer_staff_id)
 *
 * Adding a new table? Update the precedence list above + the delete
 * sequence below, AND verify with `node --test test/contracts/<file>.test.ts`
 * — both isolation (the file alone) AND multi-file (the full suite),
 * because race-on-shared-DB is the test container's failure mode.
 */
/**
 * Drop every `invoice_charge_attempts` row (2026-08-12).
 *
 * The auto-charge attempt ledger FK-restricts `invoices` — deliberately, since
 * an invoice is a retained financial record and its attempt history is the
 * operator's answer to "what happened to this money?". That means EVERY test
 * teardown that hard-deletes invoices must clear attempts first, or the delete
 * FK-blocks and takes the whole file's `after` hook down with it.
 *
 * Unscoped on purpose: the test container is exclusively ours, the suite runs
 * `--test-concurrency=1`, and these rows are worker telemetry, not fixture
 * identity. Scoping each caller's subquery would buy nothing and would be one
 * more thing to get wrong in fifteen files.
 */
export async function clearInvoiceChargeAttempts(): Promise<void> {
  await db.delete(invoiceChargeAttempts);
}

export async function teardownFixture(): Promise<void> {
  // Day-16: scheduled_notifications must drop BEFORE notifications —
  // the FK `emitted_notification_id → notifications.id` has no ON DELETE
  // (default NO ACTION), so an already-emitted scheduled row would block
  // its corresponding notifications delete otherwise. Also drops
  // device_tokens (owner-cascade safe but explicit-cleanup keeps the
  // teardown deterministic). idempotency_keys are owner-cascade by FK
  // but the Day-16 TTL sweep test seeds rows with no owner_id, so an
  // explicit DELETE by created_at window would over-broaden; instead
  // each test scopes its own cleanup. Day-9+ mutation tests' keys are
  // owner-scoped so owner-cascade handles them.
  await db
    .delete(scheduledNotifications)
    .where(eq(scheduledNotifications.ownerId, FIXTURE_IDS.ownerId));
  await db.delete(deviceTokens).where(eq(deviceTokens.ownerId, FIXTURE_IDS.ownerId));
  // Day-7b: notifications + announcements. notification_dogs cascades on
  // notifications delete (ON DELETE CASCADE FK). notifications cascades on
  // owners delete (also CASCADE) but we drop by owner_id explicitly so the
  // teardown is order-independent of when owners is deleted below.
  // Announcements are NOT owner-scoped — delete by id list.
  await db.delete(notifications).where(eq(notifications.ownerId, FIXTURE_IDS.ownerId));
  await db
    .delete(announcements)
    .where(
      inArray(announcements.id, [
        FIXTURE_IDS.announcement1Id,
        FIXTURE_IDS.announcement2Id,
        FIXTURE_IDS.announcement3Id,
        FIXTURE_IDS.announcementExpiredId,
      ]),
    );
  // FK order matters: bookings reference dogs/owner/staff (RESTRICT on owner),
  // booking_dogs cascades on booking delete; payment_methods restricts owner
  // delete; signatures restrict owner + agreement_documents. dogs is first
  // because it cascades children (vaccines/meds/feeding/completed). Bookings
  // delete drops the booking_dogs rows via ON DELETE CASCADE. Day-5b adds
  // credit_ledger (RESTRICT on dogs.id, references bookings.id) → drop
  // before bookings + dogs; credit_packages (RESTRICTed by credit_ledger);
  // service_rates + day_capacity (independent). Day-6a adds pending_requests
  // (RESTRICT on owners, RESTRICT on bookings via converted_booking_id) →
  // drop FIRST so the bookings delete below isn't blocked; pending_request_*
  // children cascade. Group-classes catalog (group_classes + cohorts +
  // class_prereq_options) is independent of owner/dog state — drop after
  // pending_requests but before nothing in particular.
  // Day-7a: threads + messages. messages cascades on thread delete; we
  // delete threads by owner_id (cascade pulls down thread_dogs + messages
  // implicitly), but doing it explicitly here keeps the teardown
  // independent of the ON DELETE CASCADE FKs in case those move later.
  await db.delete(threads).where(eq(threads.ownerId, FIXTURE_IDS.ownerId));
  // Day-7a: event_rsvps + events. event_rsvp_dogs cascades on rsvp delete;
  // events cascade rsvps; event_series is independent and shared across
  // events so drop AFTER events. Order: rsvps (owner-keyed) → events (id-
  // keyed) → series.
  await db.delete(eventRsvps).where(eq(eventRsvps.ownerId, FIXTURE_IDS.ownerId));
  await db
    .delete(events)
    .where(
      inArray(events.id, [
        FIXTURE_IDS.eventPublicPupsId,
        FIXTURE_IDS.eventYappyHourId,
        FIXTURE_IDS.eventPastId,
        FIXTURE_IDS.eventCappedId,
      ]),
    );
  await db.delete(eventSeries).where(eq(eventSeries.id, FIXTURE_IDS.eventSeriesPublicPupsId));
  await db.delete(pendingRequests).where(eq(pendingRequests.ownerId, FIXTURE_IDS.ownerId));
  // Day-11 reordered the cohort/booking chain. The bookings→cohorts FK
  // (`bookings.cohort_id REFERENCES cohorts(id)`, default NO ACTION) means a
  // booking with cohort_id set blocks deletion of its cohort. Day-10 and
  // earlier had zero bookings referencing cohorts so the order didn't matter;
  // Day-11 enrollment writes bookings.cohort_id, which forces a precise FK
  // teardown chain: credit_ledger → bookings → cohorts → classPrereqOptions
  // → groupClasses. (credit_ledger.booking_id references bookings; bookings.
  // cohort_id references cohorts; classPrereqOptions.class_key and
  // cohorts.class_key both reference groupClasses.)
  // Day-13: refunds + charges both reference bookings via FK. Tests
  // (money-back cancel branch) seed `charges` rows attached to the
  // fixture owner's bookings, and the cancel txn appends `refunds`
  // rows. Both must be deleted before bookings or the bookings delete
  // FK-violates and the after-hook hangs the process via stuck Redis
  // connections (earned 2026-05-26).
  const { refunds, charges, invoices, stripeEvents } =
    await import('../../src/db/schema/schema.js');
  const { like } = await import('drizzle-orm');
  // Day-15: stripe_events is a webhook dedupe ledger; tests insert events
  // with the `evt_test_` prefix so this pattern-delete keeps the table
  // clean across runs. Independent of the FK chain — no foreign keys
  // reference stripe_events.
  await db.delete(stripeEvents).where(like(stripeEvents.eventId, 'evt_test_%'));
  await clearInvoiceChargeAttempts();
  // Day-15: invoices restricts on owner_id + payment_method_id; drop
  // before payment_methods + owners. invoices.paid_charge_id is FK to
  // charges (no on-delete), so drop invoices BEFORE charges as well —
  // charge delete would FK-block otherwise once a paid invoice exists.
  await db.delete(invoices).where(eq(invoices.ownerId, FIXTURE_IDS.ownerId));
  await db.delete(refunds).where(eq(refunds.ownerId, FIXTURE_IDS.ownerId));
  // FK order: credit_ledger.charge_id → charges.id (Day-14 purchase path
  // attaches the ledger row to a charge), so ledger must drop BEFORE
  // charges. Filtering by dog_id alone misses charge-attached rows for
  // OTHER dogs; widen to "any charge from this owner" before purging.
  await db
    .delete(creditLedger)
    .where(inArray(creditLedger.dogId, [FIXTURE_IDS.dog1Id, FIXTURE_IDS.dog2Id]));
  await db.delete(charges).where(eq(charges.ownerId, FIXTURE_IDS.ownerId));
  await db.delete(bookings).where(eq(bookings.ownerId, FIXTURE_IDS.ownerId));
  // Catch BOTH the fixture-id cohorts AND any per-test cohorts attached to
  // the test group_classes (Day-11+ enrollment tests insert per-test cohorts
  // with random UUIDs for isolation; an id-targeted delete here would leave
  // them dangling and the `groupClasses` delete below would FK-violate).
  await db.delete(cohorts).where(inArray(cohorts.classKey, ['puppy', 'manners-1', 'manners-2']));
  await db
    .delete(classPrereqOptions)
    .where(eq(classPrereqOptions.id, FIXTURE_IDS.classPrereqMannersOptionId));
  await db
    .delete(groupClasses)
    .where(inArray(groupClasses.key, ['puppy', 'manners-1', 'manners-2']));
  await db
    .delete(creditPackages)
    .where(
      inArray(creditPackages.key, [
        FIXTURE_IDS.creditPackageSchool5Key,
        FIXTURE_IDS.creditPackageSchool10Key,
        FIXTURE_IDS.creditPackageDaycare8Key,
        FIXTURE_IDS.creditPackageRetiredKey,
      ]),
    );
  // Clear the WHOLE table, not just the seeded fixture ids: the staff
  // rate-editor write path (`POST /staff/rates`) inserts rows with random
  // UUIDs, so an id-scoped delete would leak them across files and pollute
  // every later rate lookup. `service_rates` is fixture-owned in tests (schema
  // .sql seeds none), so a full delete is safe + keeps the table reset per file.
  await db.delete(serviceRates);
  await db.delete(dayCapacity).where(eq(dayCapacity.location, 'fayetteville'));
  await db.delete(paymentMethods).where(eq(paymentMethods.ownerId, FIXTURE_IDS.ownerId));
  // Day-14: stripe_customers FK→owners is ON DELETE RESTRICT, so it must
  // drop before the owners delete below. Order vs payment_methods doesn't
  // matter (no FK between them) but pairing them here keeps the Stripe-
  // side rows clustered for future readers.
  await db.delete(stripeCustomers).where(eq(stripeCustomers.ownerId, FIXTURE_IDS.ownerId));
  await db.delete(dogs).where(eq(dogs.ownerId, FIXTURE_IDS.ownerId));
  await db.delete(agreementSignatures).where(eq(agreementSignatures.ownerId, FIXTURE_IDS.ownerId));
  await db
    .delete(agreementDocuments)
    .where(eq(agreementDocuments.key, FIXTURE_IDS.agreementGeneralKey));
  await db
    .delete(agreementDocuments)
    .where(eq(agreementDocuments.key, FIXTURE_IDS.agreementBoardingKey));
  await db
    .delete(agreementDocuments)
    .where(eq(agreementDocuments.key, FIXTURE_IDS.agreementMarketingKey));
  await db
    .delete(requiredVaccines)
    .where(eq(requiredVaccines.key, FIXTURE_IDS.requiredVaccineRabiesKey));
  await db
    .delete(requiredVaccines)
    .where(eq(requiredVaccines.key, FIXTURE_IDS.requiredVaccineBordetellaKey));
  await db.delete(vets).where(eq(vets.id, FIXTURE_IDS.vetId));
  await db.delete(owners).where(eq(owners.id, FIXTURE_IDS.ownerId));
  // Staff are referenced by bookings.trainer_staff_id (RESTRICT) — drop them
  // last, after bookings are gone. Test rows are id-targeted so the order is
  // robust to re-seeding mid-run.
  await db.delete(staff).where(eq(staff.id, FIXTURE_IDS.staffDonavanId));
  await db.delete(staff).where(eq(staff.id, FIXTURE_IDS.staffRachelId));
}

/**
 * YYYY-MM-DD for the `nth` weekday strictly after FIXTURE_TODAY (n=0 is the
 * next weekday). Booking-surface tests want weekdays because the default
 * `day_capacity` for weekends is {school:0, daycare:0} (closed) — a weekend
 * date 422s on insufficient_capacity before the behavior under test runs.
 * Extracted 2026-07-15 (the 6th per-file copy tripped the duplication bar);
 * booking-payg keeps its local dual-anchor variant (it also derives weekdays
 * from REAL now for the PAYG due-at math).
 */
export function futureWeekday(nth: number): string {
  const ONE_DAY = 86_400_000;
  let count = 0;
  let offset = 1;
  for (;;) {
    const d = new Date(FIXTURE_TODAY.getTime() + offset * ONE_DAY);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      if (count === nth) {
        return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
      }
      count += 1;
    }
    offset += 1;
  }
}
