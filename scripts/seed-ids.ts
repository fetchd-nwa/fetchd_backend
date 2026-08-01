/**
 * The id manifest `seed-dev.ts` writes, in its own module.
 *
 * Separate from `seed-dev.ts` ON PURPOSE: that file calls `main()` at import
 * time, so anything importing it would RUN THE SEED as a side effect — a
 * checker that wipes the database it was asked to inspect. This module has no
 * side effects, so `check-dev-db.ts` can read the manifest safely.
 */
export const SEED = {
  // Staff. Shanthi's id is the portal `.env.example` default principal.
  staffShanthiId: '00000000-0000-4000-8000-0000000000a1',
  staffRachelId: '00000000-0000-4000-8000-0000000000a2',
  staffDonavanId: '00000000-0000-4000-8000-0000000000a3',
  staffFedId: '00000000-0000-4000-8000-0000000000a4',

  // Owners (clients).
  ownerAllisonId: '0caa0000-0000-4000-8000-000000000001',
  ownerJordanId: '0caa0000-0000-4000-8000-000000000002',

  // Dogs — the real cohort.
  dogWafflesId: 'd0900000-0000-4000-8000-000000000001',
  dogLolaId: 'd0900000-0000-4000-8000-000000000002',
  dogBrodieId: 'd0900000-0000-4000-8000-000000000003',
  dogOllieId: 'd0900000-0000-4000-8000-000000000004',

  // Bookings (all upcoming + unconfirmed so the portal can confirm them).
  bookingWafflesSchoolId: 'b0070000-0000-4000-8000-000000000001',
  bookingLolaLessonId: 'b0070000-0000-4000-8000-000000000002',
  bookingBrodieBoardingId: 'b0070000-0000-4000-8000-000000000003',
  bookingGroupWalkId: 'b0070000-0000-4000-8000-000000000004',
  // Past ATTENDED day programs — one per dog, ~2 weeks back. These are what
  // keep the seeded dogs "fresh" under the 3-month re-evaluation staleness
  // rule (Shanthi 2026-07-14): without a recent attended day-school/day-care
  // session, every demo booking would divert into the staff-approval queue.
  bookingWafflesPastSchoolId: 'b0070000-0000-4000-8000-000000000005',
  bookingLolaPastSchoolId: 'b0070000-0000-4000-8000-000000000006',
  bookingBrodiePastCareId: 'b0070000-0000-4000-8000-000000000007',
  bookingOlliePastCareId: 'b0070000-0000-4000-8000-000000000008',

  // Submitted requests (approve / deny queue).
  requestWafflesLessonId: '9e510000-0000-4000-8000-000000000001',
  requestBrodieBoardingId: '9e510000-0000-4000-8000-000000000002',
  requestLolaBoardTrainId: '9e510000-0000-4000-8000-000000000003',

  // Threads + messages.
  threadAllisonId: '7a700000-0000-4000-8000-000000000001',
  threadJordanId: '7a700000-0000-4000-8000-000000000002',
  msg1Id: '0e550000-0000-4000-8000-000000000001',
  msg2Id: '0e550000-0000-4000-8000-000000000002',
  msg3Id: '0e550000-0000-4000-8000-000000000003',
  msg4Id: '0e550000-0000-4000-8000-000000000004',

  // Payment methods (explicit ids — invoices FK them).
  paymentMethodAllisonId: 'b00a0000-0000-4000-8000-000000000001',
  paymentMethodJordanId: 'b00a0000-0000-4000-8000-000000000002',

  // Billing ledger for Allison (the full-history owner the owner-app dev
  // principal should point at) — one row per FE ledger kind/status.
  chargePackageId: 'c0a50000-0000-4000-8000-000000000001',
  chargePaygId: 'c0a50000-0000-4000-8000-000000000002',
  chargeMembershipId: 'c0a50000-0000-4000-8000-000000000003',
  chargeRefundedId: 'c0a50000-0000-4000-8000-000000000004',
  invoiceOpenId: '12005000-0000-4000-8000-000000000001',

  // Group-class cohorts (all 3 class types, both locations, varied fills +
  // one full cohort to demo the cohort-full state).
  cohortPuppyFayId: 'c0407000-0000-4000-8000-000000000001',
  cohortPuppyBenId: 'c0407000-0000-4000-8000-000000000002',
  cohortManners1FayId: 'c0407000-0000-4000-8000-000000000003',
  cohortManners1BenId: 'c0407000-0000-4000-8000-000000000004',
  cohortManners2FayId: 'c0407000-0000-4000-8000-000000000005',
  cohortManners2FullId: 'c0407000-0000-4000-8000-000000000006',
  cohortPublicPupsFayId: 'c0407000-0000-4000-8000-000000000007',
  // Recent-Updates announcements (Fayetteville-targeted home-screen catalog).
  annClosureId: 'a11c0000-0000-4000-8000-000000000001',
  annYappyHourId: 'a11c0000-0000-4000-8000-000000000002',
  annPuppyClassId: 'a11c0000-0000-4000-8000-000000000003',
  annMeetTeamId: 'a11c0000-0000-4000-8000-000000000004',
  annSummerPackagesId: 'a11c0000-0000-4000-8000-000000000005',
  annClassMovedId: 'a11c0000-0000-4000-8000-000000000006',
  // Events + an RSVP (so the spots bar isn't empty). Yappy Hour is the only
  // event — Public Pups is a group class (see groupClasses), not an event.
  eventYappyHourId: 'e0e70000-0000-4000-8000-000000000001',
  rsvpJordanYappyId: 'e0e70000-0000-4000-8000-0000000000a1',
} as const;
