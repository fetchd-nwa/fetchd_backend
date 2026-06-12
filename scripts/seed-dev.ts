/**
 * Dev-pg seed (`npm run db:dev:seed`). Populates the LOCAL dev database
 * (docker `fetchd-db` on :5432) with a realistic NWA dataset so real-mode and
 * the staff portal render meaningful data instead of empty states. NOT a
 * production seed and NOT the contract-test fixture (that lives in
 * `test/contracts/_fixture.ts` and seeds the :5433 test DB).
 *
 * Scope: exactly what the four staff-portal verbs need to demo —
 *   - staff (Shanthi + 3 trainers; Shanthi's id matches portal `.env.example`)
 *   - two owners + dogs (the real cohort: Waffles, Lola, Brodie, Ollie)
 *   - upcoming bookings (confirm / cancel / attendance queue)
 *   - submitted requests (approve / deny queue)
 *   - threads + messages (conversation + reply)
 *
 * Booking guards satisfied minimally: every owner gets a payment method (the
 * `bookings_payment_guarantee` trigger), and dogs are `evaluation_status =
 * 'passed'` (the eval gate). The vaccine + agreement guards pass *vacuously*
 * because we deliberately seed no `required_vaccines` / `agreement_documents`
 * rows — the portal reads neither, so a dev seed needn't carry them.
 *
 * Safety: refuses to run unless DATABASE_URL points at localhost and NODE_ENV
 * is not production — this script wipes tables, and must never touch a remote
 * (Supabase) database.
 *
 * Re-runnable: wipes the managed tables in child→parent FK order, then inserts.
 */
import { db } from '../src/db/client.js';
import { env } from '../src/env.js';
import {
  announcements,
  bookingDogs,
  bookings,
  charges,
  classPrereqOptions,
  classResources,
  cohorts,
  creditLedger,
  dogCompletedClasses,
  dogs,
  eventRsvpDogs,
  eventRsvps,
  events,
  groupClasses,
  invoices,
  messages,
  notificationDogs,
  notifications,
  owners,
  paymentMethods,
  pendingRequestDogs,
  pendingRequestPreferredDates,
  pendingRequests,
  refunds,
  scheduledNotifications,
  staff,
  stripeCustomers,
  threadDogs,
  threads,
} from '../src/db/schema/schema.js';

function assertLocalDb(): void {
  const url = env.DATABASE_URL;
  const isLocal = url.includes('localhost') || url.includes('127.0.0.1');
  if (!isLocal || env.NODE_ENV === 'production') {
    throw new Error(
      `seed-dev refuses to run: DATABASE_URL must be local and NODE_ENV must not be production ` +
        `(got NODE_ENV=${env.NODE_ENV}, host=${safeHost(url)}). This script wipes tables.`,
    );
  }
}

function safeHost(rawUrl: string): string {
  try {
    return new URL(rawUrl).host;
  } catch {
    return '(unparseable)';
  }
}

const SEED = {
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

function daysFromNow(days: number, hour = 14): string {
  const d = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
}

// Human Chicago weekday+date label (e.g. "Friday, June 6") computed off the
// seed run so closure copy never references a stale hardcoded calendar date.
function chicagoDateLabel(daysAhead: number): string {
  const d = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);
  return d.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'America/Chicago',
  });
}

// Next occurrence of a weekday (0=Sun .. 6=Sat) at `hour` UTC — keeps seeded
// events in the near future on every re-seed. Always strictly forward (never
// "today"), so an event seeded on its own weekday lands a week out.
function nextWeekday(targetDow: number, hour: number): string {
  const d = new Date();
  const add = (targetDow - d.getUTCDay() + 7) % 7 || 7;
  d.setUTCDate(d.getUTCDate() + add);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
}

async function wipe(): Promise<void> {
  // Child → parent FK order. Includes the transactional tables a portal demo
  // (approve/cancel/reply) can write, so a re-seed starts clean.
  await db.delete(announcements);
  await db.delete(eventRsvpDogs);
  await db.delete(eventRsvps);
  await db.delete(events);
  await db.delete(notificationDogs);
  await db.delete(notifications);
  await db.delete(scheduledNotifications);
  await db.delete(messages);
  await db.delete(threadDogs);
  await db.delete(threads);
  await db.delete(pendingRequestPreferredDates);
  await db.delete(pendingRequestDogs);
  await db.delete(pendingRequests);
  // refunds → invoices → creditLedger all reference charges; delete them before
  // charges, and charges before bookings (charges.booking_id) + paymentMethods
  // (invoices.payment_method_id).
  await db.delete(refunds);
  await db.delete(invoices);
  await db.delete(creditLedger);
  await db.delete(charges);
  await db.delete(bookingDogs);
  await db.delete(bookings);
  // cohorts are referenced by bookings.cohort_id (deleted above); group_classes
  // are referenced by cohorts.class_key + class_prereq_options — delete the
  // children first, then the catalog.
  await db.delete(cohorts);
  await db.delete(classPrereqOptions);
  await db.delete(groupClasses);
  await db.delete(paymentMethods);
  await db.delete(stripeCustomers);
  await db.delete(dogCompletedClasses);
  await db.delete(dogs);
  await db.delete(owners);
  await db.delete(staff);
}

async function seed(): Promise<void> {
  await db.insert(staff).values([
    {
      id: SEED.staffShanthiId,
      supabaseUid: '00000000-0000-4000-8000-0000000000b1',
      name: 'Shanthi',
      role: 'owner-shanthi',
      location: 'fayetteville',
      active: true,
    },
    {
      id: SEED.staffRachelId,
      supabaseUid: '00000000-0000-4000-8000-0000000000b2',
      name: 'Rachel',
      role: 'trainer',
      location: 'fayetteville',
      active: true,
    },
    {
      id: SEED.staffDonavanId,
      supabaseUid: '00000000-0000-4000-8000-0000000000b3',
      name: 'Donavan',
      role: 'trainer',
      location: 'fayetteville',
      active: true,
    },
    {
      id: SEED.staffFedId,
      supabaseUid: '00000000-0000-4000-8000-0000000000b4',
      name: 'Fed Acosta',
      role: 'trainer',
      location: 'bentonville',
      active: true,
    },
  ]);

  await db.insert(owners).values([
    {
      id: SEED.ownerAllisonId,
      supabaseUid: '0caa0000-0000-4000-8000-0000000000f1',
      name: 'Allison Frye',
      email: 'allison@example.com',
      phone: '479-555-0101',
      location: 'fayetteville',
    },
    {
      id: SEED.ownerJordanId,
      supabaseUid: '0caa0000-0000-4000-8000-0000000000f2',
      name: 'Jordan Blake',
      email: 'jordan@example.com',
      phone: '479-555-0102',
      location: 'bentonville',
    },
  ]);

  // Stripe customer + payment method per owner — the payment-guarantee
  // trigger rejects any owner booking without a live payment method.
  await db.insert(stripeCustomers).values([
    { ownerId: SEED.ownerAllisonId, stripeCustomerId: 'cus_seed_allison' },
    { ownerId: SEED.ownerJordanId, stripeCustomerId: 'cus_seed_jordan' },
  ]);
  await db.insert(paymentMethods).values([
    {
      id: SEED.paymentMethodAllisonId,
      ownerId: SEED.ownerAllisonId,
      stripePaymentMethodId: 'pm_seed_allison',
      brand: 'visa',
      last4: '4242',
      expMonth: 12,
      expYear: 2030,
      cardholderName: 'Allison Frye',
      isDefault: true,
    },
    {
      id: SEED.paymentMethodJordanId,
      ownerId: SEED.ownerJordanId,
      stripePaymentMethodId: 'pm_seed_jordan',
      brand: 'mastercard',
      last4: '5555',
      expMonth: 9,
      expYear: 2029,
      cardholderName: 'Jordan Blake',
      isDefault: true,
    },
  ]);

  await db.insert(dogs).values([
    {
      id: SEED.dogWafflesId,
      ownerId: SEED.ownerAllisonId,
      name: 'Waffles',
      breed: 'Labradoodle',
      birthdate: '2023-01-15',
      specialNotes: 'Eager learner; loves water.',
      evaluationStatus: 'passed',
      evaluationDate: '2024-03-01T15:00:00Z',
      // Boarding is staff-granted per dog (default false). Waffles is the one
      // boarding client here — demonstrates the gate (her boarding tile + flow
      // show; the other seed dogs' don't).
      boardingEnabled: true,
      profileImagePath: 'dogs/waffles/waffles-pfp.jpg',
    },
    {
      id: SEED.dogLolaId,
      ownerId: SEED.ownerAllisonId,
      name: 'Lola',
      breed: 'Golden Retriever',
      birthdate: '2021-06-10',
      specialNotes: 'Reactive to bikes; works best on a flat collar.',
      evaluationStatus: 'passed',
      evaluationDate: '2024-06-01T15:00:00Z',
      profileImagePath: 'dogs/lola/lola-pfp.jpg',
    },
    {
      id: SEED.dogBrodieId,
      ownerId: SEED.ownerJordanId,
      name: 'Brodie',
      breed: 'Border Collie',
      birthdate: '2022-09-20',
      specialNotes: 'High drive; completed Manners 1.',
      evaluationStatus: 'passed',
      evaluationDate: '2024-02-15T15:00:00Z',
      profileImagePath: 'dogs/brodie/brodie-pfp.jpg',
    },
    {
      id: SEED.dogOllieId,
      ownerId: SEED.ownerJordanId,
      name: 'Ollie',
      breed: 'Cavalier King Charles Spaniel',
      birthdate: '2023-04-05',
      specialNotes: 'Friendly; still building leash focus.',
      evaluationStatus: 'passed',
      evaluationDate: '2024-05-01T15:00:00Z',
      profileImagePath: 'dogs/ollie/ollie-pfp.jpeg',
    },
  ]);

  // Group-class catalog — all three class types (price in cents on the wire;
  // the FE renders whole dollars). Mirrors mobile/src/mock/group-classes.json.
  await db.insert(groupClasses).values([
    {
      key: 'puppy',
      name: 'Puppy Class',
      weeks: 4,
      pricePerDogCents: 15_000,
      capacity: 15,
      ageRange: 'Ages 7–13 weeks',
      description:
        'Open enrollment any Saturday. Socialization, confidence-building, and the very first basics.',
      enrollmentType: 'open',
    },
    {
      key: 'manners-1',
      name: 'Manners 1',
      weeks: 6,
      pricePerDogCents: 25_000,
      capacity: 15,
      ageRange: null,
      description: 'Foundation course. Sit, down, come, stay, place, leave it, and leash manners.',
      enrollmentType: 'cohort',
    },
    {
      key: 'manners-2',
      name: 'Manners 2',
      weeks: 6,
      pricePerDogCents: 25_000,
      capacity: 15,
      ageRange: null,
      description:
        'Builds on Manners 1. Reliability with distance, distractions, and harder environments.',
      enrollmentType: 'cohort',
    },
    {
      // Public Pups — a 6-week real-world public-manners course (a group class,
      // NOT an event). Each week meets at a different public location around
      // town; that rotation lives in the description because a cohort carries a
      // single `location` (per-week locations aren't modeled — see cohort note).
      key: 'public-pups',
      name: 'Public Pups',
      weeks: 6,
      pricePerDogCents: 25_000,
      capacity: 12,
      ageRange: null,
      description:
        'A six-week course in real-world public manners. Each week meets at a different ' +
        'public spot around town, so your dog practices staying calm and focused wherever ' +
        "you go — not just in the training room. You'll also learn to read your dog's early " +
        'stress signals and step in before a situation tips over, keeping outings positive ' +
        'for both of you.',
      enrollmentType: 'cohort',
    },
  ]);
  // OR-prereq: Manners 2 requires Manners 1 (R7 eligibility source of truth).
  await db
    .insert(classPrereqOptions)
    .values([{ classKey: 'manners-2', prereqClassKey: 'manners-1' }]);
  // Per-class resources — link cards surfaced on the dog-profile Group page,
  // gated by completion (shown only once a dog has a live dog_completed_classes
  // row for the class). Lola completed Manners 1 below, so her Manners 1 resource
  // demonstrates the UNLOCKED state; the Puppy resources stay hidden for every
  // seed dog (none completed Puppy) — the LOCKED state. Content is placeholder
  // pending Shanthi; deep_link_path must resolve to a real /info route.
  await db.insert(classResources).values([
    {
      classKey: 'puppy',
      title: 'Puppy Class Recap',
      subtitle: 'What we covered and how to keep practicing at home',
      deepLinkPath: '/info/puppy-class',
      position: 0,
    },
    {
      classKey: 'puppy',
      title: 'Yappy Hour',
      subtitle: 'Bi-weekly evening social for clients and their dogs',
      deepLinkPath: '/info/yappy-hour',
      position: 1,
    },
    {
      classKey: 'manners-1',
      title: 'Yappy Hour',
      subtitle: 'Practice your new manners at a real-world social',
      deepLinkPath: '/info/yappy-hour',
      position: 0,
    },
  ]);
  // Cohorts — both locations, varied fills, future starts (relative to now so
  // they stay bookable), plus one FULL cohort to demo the cohort-full state.
  // capacity snapshots the class cap (15); end_date = start + (weeks-1) weeks.
  await db.insert(cohorts).values([
    {
      id: SEED.cohortPuppyFayId,
      classKey: 'puppy',
      location: 'fayetteville',
      startDate: daysFromNow(7, 15),
      endDate: daysFromNow(7 + 3 * 7, 15),
      weeklyTime: '10:00 am',
      weeks: 4,
      capacity: 15,
      filled: 6,
    },
    {
      id: SEED.cohortPuppyBenId,
      classKey: 'puppy',
      location: 'bentonville',
      startDate: daysFromNow(10, 15),
      endDate: daysFromNow(10 + 3 * 7, 15),
      weeklyTime: '10:00 am',
      weeks: 4,
      capacity: 15,
      filled: 4,
    },
    {
      id: SEED.cohortManners1FayId,
      classKey: 'manners-1',
      location: 'fayetteville',
      startDate: daysFromNow(14, 16),
      endDate: daysFromNow(14 + 5 * 7, 16),
      weeklyTime: '11:00 am',
      weeks: 6,
      capacity: 15,
      filled: 8,
    },
    {
      id: SEED.cohortManners1BenId,
      classKey: 'manners-1',
      location: 'bentonville',
      startDate: daysFromNow(21, 23),
      endDate: daysFromNow(21 + 5 * 7, 23),
      weeklyTime: '6:30 pm',
      weeks: 6,
      capacity: 15,
      filled: 12,
    },
    {
      id: SEED.cohortManners2FayId,
      classKey: 'manners-2',
      location: 'fayetteville',
      startDate: daysFromNow(20, 17),
      endDate: daysFromNow(20 + 5 * 7, 17),
      weeklyTime: '12:00 pm',
      weeks: 6,
      capacity: 15,
      filled: 4,
    },
    {
      // Full cohort — exercises the cohort-full gate in the enroll flow.
      id: SEED.cohortManners2FullId,
      classKey: 'manners-2',
      location: 'fayetteville',
      startDate: daysFromNow(45, 17),
      endDate: daysFromNow(45 + 5 * 7, 17),
      weeklyTime: '12:00 pm',
      weeks: 6,
      capacity: 15,
      filled: 15,
    },
    {
      // Public Pups — a 6-week course cohort. `location` is the home/first-week
      // base; the weekly rotation to different public spots isn't modeled (the
      // schema has one location per cohort), so it lives in the class description.
      id: SEED.cohortPublicPupsFayId,
      classKey: 'public-pups',
      location: 'fayetteville',
      startDate: daysFromNow(7, 15),
      endDate: daysFromNow(7 + 5 * 7, 15),
      weeklyTime: '9:00 am',
      weeks: 6,
      capacity: 12,
      filled: 5,
    },
  ]);
  // Lola has completed Manners 1 → she's eligible for Manners 2; Waffles
  // hasn't → enrolling Waffles in Manners 2 fires the prereq gate. Demos both
  // sides of the R7 eligibility check for Allison.
  await db.insert(dogCompletedClasses).values([{ dogId: SEED.dogLolaId, classKey: 'manners-1' }]);

  await db.insert(bookings).values([
    {
      id: SEED.bookingWafflesSchoolId,
      ownerId: SEED.ownerAllisonId,
      leadDogId: SEED.dogWafflesId,
      category: 'day-school',
      status: 'upcoming',
      scheduledAt: daysFromNow(2, 13),
      durationMinutes: 540,
      trainerStaffId: SEED.staffDonavanId,
      location: 'fayetteville',
    },
    {
      id: SEED.bookingLolaLessonId,
      ownerId: SEED.ownerAllisonId,
      leadDogId: SEED.dogLolaId,
      category: 'private-lesson',
      status: 'upcoming',
      scheduledAt: daysFromNow(3, 15),
      durationMinutes: 60,
      trainerStaffId: SEED.staffRachelId,
      notes: 'Leash reactivity — bikes.',
      location: 'fayetteville',
    },
    {
      id: SEED.bookingBrodieBoardingId,
      ownerId: SEED.ownerJordanId,
      leadDogId: SEED.dogBrodieId,
      category: 'boarding',
      status: 'upcoming',
      scheduledAt: daysFromNow(5, 15),
      durationMinutes: null,
      trainerStaffId: SEED.staffFedId,
      dropoffAt: daysFromNow(5, 15),
      pickupAt: daysFromNow(9, 17),
      notes: '4-night stay.',
      location: 'bentonville',
    },
    {
      // Multi-dog day-care so the attendance verb has a roster to check in.
      id: SEED.bookingGroupWalkId,
      ownerId: SEED.ownerJordanId,
      leadDogId: SEED.dogBrodieId,
      category: 'day-care',
      status: 'upcoming',
      scheduledAt: daysFromNow(1, 14),
      durationMinutes: 480,
      trainerStaffId: null,
      location: 'bentonville',
    },
  ]);

  await db.insert(bookingDogs).values([
    { bookingId: SEED.bookingWafflesSchoolId, dogId: SEED.dogWafflesId, isLead: true },
    { bookingId: SEED.bookingLolaLessonId, dogId: SEED.dogLolaId, isLead: true },
    { bookingId: SEED.bookingBrodieBoardingId, dogId: SEED.dogBrodieId, isLead: true },
    { bookingId: SEED.bookingGroupWalkId, dogId: SEED.dogBrodieId, isLead: true },
    { bookingId: SEED.bookingGroupWalkId, dogId: SEED.dogOllieId, isLead: false },
  ]);

  // Billing ledger for Allison — populates the owner app's Invoices tab in
  // real mode with one row per FE kind/status. (`GET /invoices`, Day-19d.)
  await db.insert(charges).values([
    {
      id: SEED.chargePackageId,
      ownerId: SEED.ownerAllisonId,
      amountCents: 40500,
      status: 'succeeded',
      purpose: 'package',
      createdAt: daysFromNow(-30, 15),
    },
    {
      id: SEED.chargePaygId,
      ownerId: SEED.ownerAllisonId,
      amountCents: 9000,
      status: 'succeeded',
      purpose: 'payg',
      bookingId: SEED.bookingLolaLessonId,
      createdAt: daysFromNow(-20, 15),
    },
    {
      id: SEED.chargeMembershipId,
      ownerId: SEED.ownerAllisonId,
      amountCents: 7900,
      status: 'succeeded',
      purpose: 'membership',
      createdAt: daysFromNow(-15, 15),
    },
    {
      // Refunded group-class charge — exercises the 'refunded' status + the
      // purpose-derived category for a charge with no booking link.
      id: SEED.chargeRefundedId,
      ownerId: SEED.ownerAllisonId,
      amountCents: 20000,
      status: 'refunded',
      purpose: 'group-class',
      createdAt: daysFromNow(-25, 15),
    },
  ]);
  // The credit-pack grant that the package charge funded — gives the ledger
  // row its dog + mode.
  await db.insert(creditLedger).values([
    {
      dogId: SEED.dogWafflesId,
      mode: 'school',
      location: 'fayetteville',
      delta: 10,
      reason: 'purchase',
      chargeId: SEED.chargePackageId,
      createdAt: daysFromNow(-30, 15),
    },
  ]);
  // One open (pay-later) invoice — the only tappable, payable ledger row.
  await db.insert(invoices).values([
    {
      id: SEED.invoiceOpenId,
      ownerId: SEED.ownerAllisonId,
      amountCents: 18000,
      status: 'open',
      purpose: 'board-train',
      paymentMethodId: SEED.paymentMethodAllisonId,
      issuedAt: daysFromNow(-3, 15),
      dueAt: daysFromNow(7, 15),
    },
  ]);

  await db.insert(pendingRequests).values([
    {
      id: SEED.requestWafflesLessonId,
      ownerId: SEED.ownerAllisonId,
      leadDogId: SEED.dogWafflesId,
      category: 'private-lesson',
      status: 'submitted',
      submittedAt: daysFromNow(-1, 16),
      notesPerDog: 'Waffles needs leash polish.',
      staffPreference: 'rachel',
      comfortLevel: 'high',
    },
    {
      id: SEED.requestBrodieBoardingId,
      ownerId: SEED.ownerJordanId,
      leadDogId: SEED.dogBrodieId,
      category: 'boarding',
      status: 'submitted',
      submittedAt: daysFromNow(-2, 11),
      notesJoint: 'Travel for work — flexible on dates.',
      comfortLevel: 'medium',
    },
    {
      id: SEED.requestLolaBoardTrainId,
      ownerId: SEED.ownerAllisonId,
      leadDogId: SEED.dogLolaId,
      category: 'board-and-train',
      status: 'submitted',
      submittedAt: daysFromNow(-1, 9),
      lengthWeeks: 2,
      notesPerDog: 'Two-week reactivity intensive.',
      comfortLevel: 'high',
    },
  ]);

  await db.insert(pendingRequestDogs).values([
    { requestId: SEED.requestWafflesLessonId, dogId: SEED.dogWafflesId, isLead: true },
    { requestId: SEED.requestBrodieBoardingId, dogId: SEED.dogBrodieId, isLead: true },
    { requestId: SEED.requestLolaBoardTrainId, dogId: SEED.dogLolaId, isLead: true },
  ]);

  await db.insert(pendingRequestPreferredDates).values([
    { requestId: SEED.requestWafflesLessonId, ordinal: 1, preferredAt: daysFromNow(7, 15) },
    { requestId: SEED.requestWafflesLessonId, ordinal: 2, preferredAt: daysFromNow(9, 15) },
    { requestId: SEED.requestBrodieBoardingId, ordinal: 1, preferredAt: daysFromNow(14, 15) },
    { requestId: SEED.requestLolaBoardTrainId, ordinal: 1, preferredAt: daysFromNow(21, 15) },
  ]);

  await db.insert(threads).values([
    {
      id: SEED.threadAllisonId,
      ownerId: SEED.ownerAllisonId,
      participantStaffId: SEED.staffDonavanId,
      category: 'sessions',
      title: 'Waffles + Lola — leash work',
      subText: 'with Donavan',
      lastMessage: 'Perfect — bring her flat collar.',
      lastMessageAt: daysFromNow(-1, 14),
    },
    {
      id: SEED.threadJordanId,
      ownerId: SEED.ownerJordanId,
      participantStaffId: SEED.staffFedId,
      category: 'enrollment',
      title: "Brodie's boarding dates",
      subText: 'with Fed',
      lastMessage: 'Sounds good, thanks!',
      lastMessageAt: daysFromNow(-2, 16),
    },
  ]);

  await db.insert(threadDogs).values([
    { threadId: SEED.threadAllisonId, dogId: SEED.dogWafflesId },
    { threadId: SEED.threadAllisonId, dogId: SEED.dogLolaId },
    { threadId: SEED.threadJordanId, dogId: SEED.dogBrodieId },
  ]);

  await db.insert(messages).values([
    {
      id: SEED.msg1Id,
      threadId: SEED.threadAllisonId,
      senderKind: 'owner',
      senderOwnerId: SEED.ownerAllisonId,
      text: 'Is Friday morning open for Waffles and Lola?',
      sentAt: daysFromNow(-1, 13),
      readAt: daysFromNow(-1, 13),
    },
    {
      id: SEED.msg2Id,
      threadId: SEED.threadAllisonId,
      senderKind: 'staff',
      senderStaffId: SEED.staffDonavanId,
      text: 'Perfect — bring her flat collar.',
      sentAt: daysFromNow(-1, 14),
      readAt: null,
    },
    {
      id: SEED.msg3Id,
      threadId: SEED.threadJordanId,
      senderKind: 'owner',
      senderOwnerId: SEED.ownerJordanId,
      text: 'Can Brodie board the second week of the month?',
      sentAt: daysFromNow(-2, 15),
      readAt: daysFromNow(-2, 15),
    },
    {
      id: SEED.msg4Id,
      threadId: SEED.threadJordanId,
      senderKind: 'staff',
      senderStaffId: SEED.staffFedId,
      text: 'Yes — we have space. Sounds good, thanks!',
      sentAt: daysFromNow(-2, 16),
      readAt: null,
    },
  ]);

  // Recent-Updates announcements for the Fayetteville home screen. Tapping a
  // card opens the generic /announcement/[id] detail screen (hero + explanation
  // + optional CTA), EXCEPT: `urgent` → the closure modal, and any row with a
  // `deepLinkPath` → that screen directly (a destination that IS the full
  // experience and already explains + signs up: `report` → its report card, the
  // Yappy Hour event → its sign-up screen, the Puppy Class → its info screen).
  // The detail-screen CTA is a typed union: `route` (allowlisted in-app path,
  // used by Meet-the-team), plus `enroll` (group_class_key) + `external` (https
  // URL) — both supported by the model but unused by the current seed.
  // `daysFromNow` keeps them recent on re-seed; published newest-first.
  await db.insert(announcements).values([
    {
      id: SEED.annClosureId,
      category: 'urgent',
      title: `Fayetteville closed ${chicagoDateLabel(5)}`,
      body:
        `Our Fayetteville location will be closed ${chicagoDateLabel(5)} while the whole ` +
        `team is at a continuing-education workshop. Day School and Day Care are cancelled ` +
        `that day — your trainer will reach out to adjust standing schedules. Boarding and ` +
        `pickups are unaffected.`,
      publishedAt: daysFromNow(-1, 15),
      targetLocation: 'fayetteville',
    },
    {
      id: SEED.annYappyHourId,
      category: 'event',
      title: 'Yappy Hour is back this Saturday',
      publishedAt: daysFromNow(-2, 16),
      // Deep-links to the data-driven event screen, which explains the event AND
      // has the dog-picker RSVP. `/event/[id]` renders ANY event row — a new
      // event is a seed row + an announcement pointing at its id, no new screen.
      deepLinkPath: `/event/${SEED.eventYappyHourId}`,
      targetLocation: 'fayetteville',
    },
    {
      id: SEED.annPuppyClassId,
      category: 'class',
      title: 'Summer puppy class signups are open',
      publishedAt: daysFromNow(-3, 15),
      // The Puppy Class info screen explains the course AND has the "See
      // available dates" enroll button, so the card links straight there
      // (no generic detail in between), like the Yappy Hour event.
      deepLinkPath: '/info/puppy-class',
      targetLocation: 'fayetteville',
    },
    {
      id: SEED.annMeetTeamId,
      category: 'team',
      title: 'Meet your Fayetteville trainers',
      body:
        `Get to know the team behind your dog's progress. Rachel, Donavan, and Angie each ` +
        `bring a different specialty — from puppy foundations to reactivity and ` +
        `board-and-train — and they're who you'll see at drop-off and in your report cards.` +
        `\n\nTap through to read a little about each of them and what they focus on.`,
      publishedAt: daysFromNow(-5, 14),
      // route CTA — allowlisted in-app screen (the team directory).
      ctaLabel: 'Meet the team',
      ctaKind: 'route',
      ctaTarget: '/info/staff',
      targetLocation: 'fayetteville',
    },
    {
      id: SEED.annClassMovedId,
      category: 'class',
      title: 'Manners classes have moved',
      body:
        `Heads up — our group Manners classes have moved to a new, larger training room at ` +
        `our Fayetteville location. Same trainers, same weekly schedule — just a roomier ` +
        `space with better footing for the dogs.\n\nIf you're already enrolled, your cohort's ` +
        `day and time are unchanged; just check in at the front desk and they'll point you ` +
        `to the new room.`,
      publishedAt: daysFromNow(-6, 14),
      // informational — no CTA (demonstrates the no-button detail screen).
      targetLocation: 'fayetteville',
    },
    {
      id: SEED.annSummerPackagesId,
      category: 'promo',
      title: 'Summer Day School packages now available',
      body:
        `Buy a 10- or 20-day Day School package this summer and save compared to paying per ` +
        `day. Packages never expire and can be split across all of your dogs, so they're ` +
        `easy to share between siblings.`,
      publishedAt: daysFromNow(-7, 14),
      targetLocation: 'fayetteville',
    },
  ]);

  // Yappy Hour — the one event, for the data-driven /event/[id] screen. (Public
  // Pups is a group class, not an event — see groupClasses above.) Carries a soft
  // `capacity` so the spots bar has a denominator.
  // NOTE: Yappy Hour's loc_address/coords are a Fayetteville-area placeholder —
  // swap in NWA's real school address when known (drives the map "directions").
  await db.insert(events).values([
    {
      id: SEED.eventYappyHourId,
      name: 'Yappy Hour',
      startsAt: nextWeekday(6, 22), // next Saturday ~5pm Chicago (22:00 UTC)
      durationMinutes: 120,
      locLabel: 'NWA School for Dogs · Fayetteville',
      locAddress: 'Fayetteville, AR',
      locLatitude: 36.0822,
      locLongitude: -94.1719,
      description:
        `A relaxed off-the-clock social for graduates of any NWA program — or pups who'd ` +
        `like to be one someday. Open play in the big yard, kiddie pools out, and a treat ` +
        `bar under the awning. Bring your dog (or two, or three), some water, and a ` +
        `willingness to chat. We'll have trainers on the floor to keep things calm and ` +
        `answer questions. Humans get coffee, dogs get puppuccinos.`,
      isRecurring: false,
      capacity: 25,
    },
  ]);

  // One existing RSVP (Jordan's two dogs → Yappy Hour) so spots_filled = 2/25
  // out of the gate — Allison can then sign up Waffles/Lola against a live bar.
  await db.insert(eventRsvps).values({
    id: SEED.rsvpJordanYappyId,
    ownerId: SEED.ownerJordanId,
    eventId: SEED.eventYappyHourId,
  });
  await db.insert(eventRsvpDogs).values([
    { rsvpId: SEED.rsvpJordanYappyId, dogId: SEED.dogBrodieId },
    { rsvpId: SEED.rsvpJordanYappyId, dogId: SEED.dogOllieId },
  ]);
}

async function main(): Promise<void> {
  assertLocalDb();
  await wipe();
  await seed();
  console.log(
    `Seeded dev DB (${safeHost(env.DATABASE_URL)}): 4 staff, 2 owners, 4 dogs, 4 bookings, 3 requests, ` +
      `2 threads, 4 group classes + 7 cohorts, billing ledger, 6 announcements, 1 event. ` +
      `Portal principal: staff:${SEED.staffShanthiId}:owner-shanthi`,
  );
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error('seed-dev failed:', err);
  process.exit(1);
});
