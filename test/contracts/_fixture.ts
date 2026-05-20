import { eq, inArray } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import {
  agreementDocuments,
  agreementSignatures,
  bookingDogs,
  bookings,
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
  groupClasses,
  owners,
  paymentMethods,
  pendingRequestDogs,
  pendingRequestPreferredDates,
  pendingRequests,
  requiredVaccines,
  serviceRates,
  staff,
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
  // Day-5b: credit_packages catalog keys + credit_ledger ids + service_rates
  // ids. Packages use `test-*` text prefixes for the same reason as the
  // catalog rows above (no collision with a future production seed).
  creditPackageSchool5Key: 'test-school-5',
  creditPackageSchool10Key: 'test-school-10',
  creditPackageDaycare8Key: 'test-daycare-8',
  creditPackageRetiredKey: 'test-retired-pack',
  creditLedgerPurchaseId: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
  creditLedgerDebitId: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2',
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
    location: 'Fayetteville, AR',
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
      evaluationStatus: 'not-evaluated',
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
      location: 'Fayetteville, AR',
      imagePath: null,
      active: true,
    },
    {
      id: FIXTURE_IDS.staffRachelId,
      supabaseUid: FIXTURE_IDS.staffRachelSupabaseUid,
      name: 'Rachel',
      role: 'trainer',
      location: 'Fayetteville, AR',
      imagePath: null,
    },
  ]);

  // Live payment method — required by the bookings_payment_guarantee
  // BEFORE-INSERT trigger (any owner booking without one is rejected with
  // ERRCODE check_violation). Test-mode Stripe id only; nothing here ever
  // hits real Stripe in a contract test.
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
  ]);

  // Day-5b catalog: credit_packages. Two active school packs (5/10), one
  // active daycare pack (8), one retired (active=false — verifies the
  // server-side active=true filter). Snapshot covers Postgres enum order
  // (booking_mode declared 'school','daycare' → school packs emit first).
  await db.insert(creditPackages).values([
    {
      key: FIXTURE_IDS.creditPackageSchool5Key,
      mode: 'school',
      credits: 5,
      priceCents: 25_000,
      label: '5 School Credits (fixture)',
      isPopular: false,
      active: true,
    },
    {
      key: FIXTURE_IDS.creditPackageSchool10Key,
      mode: 'school',
      credits: 10,
      priceCents: 45_000,
      label: '10 School Credits (fixture)',
      isPopular: true,
      active: true,
    },
    {
      key: FIXTURE_IDS.creditPackageDaycare8Key,
      mode: 'daycare',
      credits: 8,
      priceCents: 30_000,
      label: '8 Daycare Credits (fixture)',
      isPopular: false,
      active: true,
    },
    {
      key: FIXTURE_IDS.creditPackageRetiredKey,
      mode: 'school',
      credits: 3,
      priceCents: 15_000,
      label: 'Retired Test Pack',
      isPopular: false,
      active: false,
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
    { bookingId: FIXTURE_IDS.booking6Id, dogId: FIXTURE_IDS.dog1Id, isLead: true },
    { bookingId: FIXTURE_IDS.booking7Id, dogId: FIXTURE_IDS.dog2Id, isLead: true },
    { bookingId: FIXTURE_IDS.booking8Id, dogId: FIXTURE_IDS.dog1Id, isLead: true },
    { bookingId: FIXTURE_IDS.booking9Id, dogId: FIXTURE_IDS.dog1Id, isLead: true },
    { bookingId: FIXTURE_IDS.bookingDstId, dogId: FIXTURE_IDS.dog1Id, isLead: true },
  ]);

  // Day-5b: credit_ledger entries for Waffles only (Lola has zero ledger
  // rows → exercises the zero-sentinel branch of GET /dogs/:id/credits via
  // the LEFT JOIN through dogs in creditsRepository).
  //   +5 school purchase (references credit_packages.test-school-5)
  //   -1 school debit  (references booking1 — Waffles' upcoming day-school)
  // Resulting balance: { school: 4, daycare: 0 }
  await db.insert(creditLedger).values([
    {
      id: FIXTURE_IDS.creditLedgerPurchaseId,
      dogId: FIXTURE_IDS.dog1Id,
      mode: 'school',
      delta: 5,
      reason: 'purchase',
      packageKey: FIXTURE_IDS.creditPackageSchool5Key,
      note: 'Fixture purchase of 5-pack',
    },
    {
      id: FIXTURE_IDS.creditLedgerDebitId,
      dogId: FIXTURE_IDS.dog1Id,
      mode: 'school',
      delta: -1,
      reason: 'booking-debit',
      bookingId: FIXTURE_IDS.booking1Id,
      note: 'Fixture debit for booking1',
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

  // Two pending requests:
  //   - request1: submitted private-lesson, MULTI-DOG (Waffles lead +
  //     Lola), full notes (per_dog + joint), full focus (staff_preference
  //     + comfort_level), 3 preferred dates → exercises every required +
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
      comfortLevel: 'high',
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
}

export async function teardownFixture(): Promise<void> {
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
  await db.delete(pendingRequests).where(eq(pendingRequests.ownerId, FIXTURE_IDS.ownerId));
  await db
    .delete(cohorts)
    .where(inArray(cohorts.id, [FIXTURE_IDS.cohortPuppyId, FIXTURE_IDS.cohortMannersId]));
  await db
    .delete(classPrereqOptions)
    .where(eq(classPrereqOptions.id, FIXTURE_IDS.classPrereqMannersOptionId));
  await db
    .delete(groupClasses)
    .where(inArray(groupClasses.key, ['puppy', 'manners-1', 'manners-2']));
  await db
    .delete(creditLedger)
    .where(inArray(creditLedger.dogId, [FIXTURE_IDS.dog1Id, FIXTURE_IDS.dog2Id]));
  await db.delete(bookings).where(eq(bookings.ownerId, FIXTURE_IDS.ownerId));
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
  await db
    .delete(serviceRates)
    .where(
      inArray(serviceRates.id, [
        FIXTURE_IDS.serviceRateSchoolFayId,
        FIXTURE_IDS.serviceRateSchoolNullLocId,
        FIXTURE_IDS.serviceRateDaycareCurrentId,
        FIXTURE_IDS.serviceRateDaycareFutureId,
        FIXTURE_IDS.serviceRateDaycareBentonClosedId,
        FIXTURE_IDS.serviceRateBoardingEmptyNoteId,
      ]),
    );
  await db.delete(dayCapacity).where(eq(dayCapacity.location, 'fayetteville'));
  await db.delete(paymentMethods).where(eq(paymentMethods.ownerId, FIXTURE_IDS.ownerId));
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
