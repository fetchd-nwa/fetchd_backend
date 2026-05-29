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
  bookingDogs,
  bookings,
  creditLedger,
  dogs,
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
} as const;

function daysFromNow(days: number, hour = 14): string {
  const d = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
}

async function wipe(): Promise<void> {
  // Child → parent FK order. Includes the transactional tables a portal demo
  // (approve/cancel/reply) can write, so a re-seed starts clean.
  await db.delete(notificationDogs);
  await db.delete(notifications);
  await db.delete(scheduledNotifications);
  await db.delete(messages);
  await db.delete(threadDogs);
  await db.delete(threads);
  await db.delete(pendingRequestPreferredDates);
  await db.delete(pendingRequestDogs);
  await db.delete(pendingRequests);
  await db.delete(refunds);
  await db.delete(creditLedger);
  await db.delete(bookingDogs);
  await db.delete(bookings);
  await db.delete(paymentMethods);
  await db.delete(stripeCustomers);
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
      location: 'Fayetteville, AR',
      active: true,
    },
    {
      id: SEED.staffRachelId,
      supabaseUid: '00000000-0000-4000-8000-0000000000b2',
      name: 'Rachel',
      role: 'trainer',
      location: 'Fayetteville, AR',
      active: true,
    },
    {
      id: SEED.staffDonavanId,
      supabaseUid: '00000000-0000-4000-8000-0000000000b3',
      name: 'Donavan',
      role: 'trainer',
      location: 'Fayetteville, AR',
      active: true,
    },
    {
      id: SEED.staffFedId,
      supabaseUid: '00000000-0000-4000-8000-0000000000b4',
      name: 'Fed Acosta',
      role: 'trainer',
      location: 'Bentonville, AR',
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
      location: 'Fayetteville, AR',
    },
    {
      id: SEED.ownerJordanId,
      supabaseUid: '0caa0000-0000-4000-8000-0000000000f2',
      name: 'Jordan Blake',
      email: 'jordan@example.com',
      phone: '479-555-0102',
      location: 'Bentonville, AR',
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
}

async function main(): Promise<void> {
  assertLocalDb();
  await wipe();
  await seed();
  console.log(
    `Seeded dev DB (${safeHost(env.DATABASE_URL)}): 4 staff, 2 owners, 4 dogs, 4 bookings, 3 requests, 2 threads. ` +
      `Portal principal: staff:${SEED.staffShanthiId}:owner-shanthi`,
  );
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error('seed-dev failed:', err);
  process.exit(1);
});
