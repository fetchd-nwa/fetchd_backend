/**
 * Dev-pg seed (`npm run db:dev:seed`). Populates the LOCAL dev database
 * (docker `fetchd-db` on :5432) with a realistic NWA dataset so real-mode and
 * the staff portal render meaningful data instead of empty states. NOT a
 * production seed and NOT the contract-test fixture (that lives in
 * `test/contracts/_fixture.ts` and seeds the :5433 test DB).
 *
 * Scope: exactly what the four staff-portal verbs need to demo —
 *   - staff: Shanthi (owner, both campuses), Amber (manager, Bentonville),
 *     Rachel and Donavan (trainers, Fayetteville), Fed (trainer, Bentonville)
 *     — the roster of design §2.1:1950-1955 (STAFF-U02, STAFF-U03), with fake
 *     uids; Shanthi's id matches portal `.env.example`
 *   - two owners + dogs (the real cohort: Waffles, Lola, Brodie, Ollie)
 *   - upcoming bookings (confirm / cancel / the check-in board)
 *   - submitted requests (approve / deny queue)
 *   - threads + messages (conversation + reply)
 *
 * Booking guards satisfied minimally: every owner gets a payment method (the
 * `bookings_payment_guarantee` trigger), and dogs are `evaluation_status =
 * 'passed'` (the eval gate). The vaccine + agreement guards pass *vacuously*
 * because we deliberately seed no `required_vaccines` / `agreement_documents`
 * rows — the portal reads neither, so a dev seed needn't carry them. A dev
 * database can hold both (onboarding asks for the waiver), and one live document the
 * seeded owners never signed refuses every seeded booking, so `wipe` erases every
 * `required_vaccines`, `agreement_signatures` and `agreement_documents` row, any a
 * person made in dev included, and the seed re-seeds neither requirement.
 *
 * Safety: refuses to run unless DATABASE_URL points at localhost and NODE_ENV
 * is not production — this script wipes tables, and must never touch a remote
 * (Supabase) database.
 *
 * Re-runnable: wipes the managed tables in child→parent FK order, then inserts.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { and, eq, inArray, isNotNull, like, ne, not, sql } from 'drizzle-orm';

import { db } from '../src/db/client.js';
import { env } from '../src/env.js';
import {
  agreementDocuments,
  agreementSignatures,
  announcements,
  bookingDogs,
  bookings,
  charges,
  checkinEvents,
  classPrereqOptions,
  classResources,
  cohorts,
  creditLedger,
  creditLotExpiryEdits,
  creditPackages,
  dogCompletedClasses,
  dogCompletedPrograms,
  dogs,
  eventRsvpDogs,
  eventRsvps,
  events,
  groupClasses,
  idempotencyKeys,
  invoices,
  messages,
  notificationDogs,
  notifications,
  orders,
  owners,
  paymentMethods,
  pendingRequestDogs,
  pendingRequestPreferredDates,
  pendingRequests,
  refunds,
  requiredVaccines,
  scheduledNotifications,
  serviceRates,
  staff,
  stripeCustomers,
  threadDogs,
  threads,
} from '../src/db/schema/schema.js';
import { CURRICULUM_PROGRAMS } from '../src/lib/alumni.js';
import { computeDayProgramScheduledAt } from '../src/lib/bookingSchedule.js';
import { bucketToChicagoDate } from '../src/lib/chicagoDate.js';
import { addChicagoMonths } from '../src/lib/creditExpiry.js';

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

import { SEED } from './seed-ids.js';

const CATALOG_SEED_STEP = fileURLToPath(
  new URL('../migrations/lg4/M4.06_seed_ten_credit_packages.sql', import.meta.url),
);

function daysFromNow(days: number, hour = 14): string {
  const d = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
}

// §3.4's `day.dropoff_open_time` at both campuses, which is where a seeded day
// starts: the day starts when the campus opens and no arrival time is asked.
const SEEDED_DROPOFF_OPEN = '07:30';

// Day school and day care run Mon–Fri as seeded, so their seeded rows must never
// land on a weekend. Takes the raw offset then nudges forward off any Sat/Sun.
function dayProgramStartFromNow(days: number): string {
  const d = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
    d.setUTCDate(d.getUTCDate() + 1);
  }
  const date = d.toISOString().slice(0, 10);
  return computeDayProgramScheduledAt(date, SEEDED_DROPOFF_OPEN).toISOString();
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
  // scheduled_notifications.emitted_notification_id → notifications.id, so the
  // child (scheduled) must be deleted before the parent (notifications).
  await db.delete(scheduledNotifications);
  await db.delete(notifications);
  await db.delete(messages);
  await db.delete(threadDogs);
  await db.delete(threads);
  await db.delete(pendingRequestPreferredDates);
  await db.delete(pendingRequestDogs);
  await db.delete(pendingRequests);
  // `orders` is a cycle (M3.02): orders.invoice_id → invoices, and charges, invoices,
  // bookings and idempotency_keys each carry order_id → orders, while orders.owner_id
  // holds the owner. One invoice paid in the app leaves all of it, so break the cycle
  // from the far side and drop the orders before any of those tables goes.
  await db.update(charges).set({ orderId: null }).where(isNotNull(charges.orderId));
  await db.update(invoices).set({ orderId: null }).where(isNotNull(invoices.orderId));
  await db.update(bookings).set({ orderId: null }).where(isNotNull(bookings.orderId));
  await db.update(idempotencyKeys).set({ orderId: null }).where(isNotNull(idempotencyKeys.orderId));
  await db.delete(orders);
  // refunds → invoices → creditLedger all reference charges; delete them before
  // charges, and charges before bookings (charges.booking_id) + paymentMethods
  // (invoices.payment_method_id).
  await db.delete(refunds);
  await db.delete(invoices);
  await db.delete(creditLotExpiryEdits);
  await db.delete(creditLedger);
  await db.delete(charges);
  await db.delete(creditPackages);
  // Only the evaluation is a rate now: a day is a credit, and an older seed's rows are not.
  await db.delete(serviceRates).where(ne(serviceRates.category, 'evaluation'));
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
  await db.delete(dogCompletedPrograms);
  await db.delete(dogs);
  // `dog_vaccines` went with the dogs. Any owner who finished onboarding signed something,
  // and a signature RESTRICTs both its owner and its document.
  await db.delete(requiredVaccines);
  await db.delete(agreementSignatures);
  await db.delete(agreementDocuments);
  await db.delete(owners);
  await db.delete(staff);
}

// Real Stripe rows survive a re-seed (Δ 2026-07-16). The wipe has to clear
// stripe_customers + payment_methods (FK order), but those tables can hold
// LIVE test-mode objects: the lazily-provisioned customer and any card added
// through the app. Wiping them cost Allison her real test card on every
// re-seed. Only rows for the seeded owners can be carried across — the wipe
// drops every other owner id. Lingering `cus_seed_%` / `pm_seed_%` fakes from
// pre-2026-07-14 seeds are deliberately NOT preserved.
const SEEDED_OWNER_IDS = [SEED.ownerAllisonId, SEED.ownerJordanId];

type RealStripeRows = {
  customers: (typeof stripeCustomers.$inferSelect)[];
  cards: (typeof paymentMethods.$inferSelect)[];
};

async function captureRealStripeRows(): Promise<RealStripeRows> {
  const customers = await db
    .select()
    .from(stripeCustomers)
    .where(
      and(
        inArray(stripeCustomers.ownerId, SEEDED_OWNER_IDS),
        not(like(stripeCustomers.stripeCustomerId, 'cus_seed_%')),
      ),
    );
  const cards = await db
    .select()
    .from(paymentMethods)
    .where(
      and(
        inArray(paymentMethods.ownerId, SEEDED_OWNER_IDS),
        not(like(paymentMethods.stripePaymentMethodId, 'pm_seed_%')),
      ),
    );
  return { customers, cards };
}

async function restoreRealStripeRows({ customers, cards }: RealStripeRows): Promise<void> {
  if (customers.length > 0) {
    await db.insert(stripeCustomers).values(customers);
  }
  if (cards.length === 0) return;
  // A restored real card keeps its default flag — it's the card the owner
  // actually pays with. The `payment_methods_one_default` partial index
  // allows one live default per owner, so demote that owner's seeded
  // placeholder before inserting.
  const ownersWithRealDefault = [
    ...new Set(cards.filter((c) => c.isDefault && c.expiredAt === null).map((c) => c.ownerId)),
  ];
  if (ownersWithRealDefault.length > 0) {
    await db
      .update(paymentMethods)
      .set({ isDefault: false })
      .where(
        and(
          inArray(paymentMethods.ownerId, ownersWithRealDefault),
          like(paymentMethods.stripePaymentMethodId, 'pm_seed_%'),
        ),
      );
  }
  await db.insert(paymentMethods).values(cards);
}

/** One pack bought on the engine: the order, its charge, the paid invoice and the lot. */
async function seedBoughtPack(args: {
  key: string;
  ownerId: string;
  paymentMethodId: string;
  orderId: string;
  chargeId: string;
  invoiceId: string;
  lotId: string;
  boughtAt: string;
}) {
  const { key, ownerId, paymentMethodId, orderId, chargeId, invoiceId, lotId, boughtAt } = args;
  const [pack] = await db.select().from(creditPackages).where(eq(creditPackages.key, key));
  if (pack === undefined) throw new Error(`the catalog holds no ${key}`);

  await db.insert(orders).values({ id: orderId, ownerId, createdAt: boughtAt });
  await db.insert(charges).values({
    id: chargeId,
    ownerId,
    orderId,
    amountCents: pack.priceCents,
    status: 'succeeded',
    purpose: 'package',
    packageId: pack.id,
    creditsCount: pack.credits,
    paymentMethodId,
    stripePaymentIntentId: `pi_seed_${key}`,
    createdAt: boughtAt,
  });
  await db.insert(invoices).values({
    id: invoiceId,
    ownerId,
    orderId,
    amountCents: pack.priceCents,
    status: 'paid',
    purpose: 'package',
    packageId: pack.id,
    location: pack.location,
    paymentMethodId,
    paidChargeId: chargeId,
    paidAt: boughtAt,
    issuedAt: boughtAt,
    dueAt: boughtAt,
  });
  await db.insert(creditLedger).values({
    id: lotId,
    ownerId,
    location: pack.location,
    mode: pack.mode,
    tier: pack.tier,
    delta: pack.credits,
    reason: 'purchase',
    packageId: pack.id,
    chargeId,
    expiresAt: addChicagoMonths(new Date(boughtAt), pack.expiryMonths).toISOString(),
    createdAt: boughtAt,
  });
  return { lotId, ownerId, location: pack.location, mode: pack.mode, tier: pack.tier };
}

async function seed(): Promise<void> {
  // M1.19/M1.20: owner | manager | trainer, and a non-empty set of home
  // campuses. Shanthi is home to BOTH (M1.20's backfill alone gives one).
  await db.insert(staff).values([
    {
      id: SEED.staffShanthiId,
      supabaseUid: '00000000-0000-4000-8000-0000000000b1',
      name: 'Shanthi',
      role: 'owner',
      // Sorted, as staff:provision writes a set: a roster run then compares equal.
      homeLocations: ['bentonville', 'fayetteville'],
    },
    {
      id: SEED.staffRachelId,
      supabaseUid: '00000000-0000-4000-8000-0000000000b2',
      name: 'Rachel',
      role: 'trainer',
      homeLocations: ['fayetteville'],
    },
    {
      id: SEED.staffDonavanId,
      supabaseUid: '00000000-0000-4000-8000-0000000000b3',
      name: 'Donavan',
      role: 'trainer',
      homeLocations: ['fayetteville'],
    },
    {
      id: SEED.staffFedId,
      supabaseUid: '00000000-0000-4000-8000-0000000000b4',
      name: 'Fed Acosta',
      role: 'trainer',
      homeLocations: ['bentonville'],
    },
    {
      id: SEED.staffAmberId,
      supabaseUid: '00000000-0000-4000-8000-0000000000b5',
      name: 'Amber',
      role: 'manager',
      homeLocations: ['bentonville'],
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
      addressLine1: '123 W Dickson St',
      addressLine2: 'Apt 4',
      addressCity: 'Fayetteville',
      addressState: 'AR',
      addressZip: '72701',
    },
    {
      id: SEED.ownerJordanId,
      supabaseUid: '0caa0000-0000-4000-8000-0000000000f2',
      name: 'Jordan Blake',
      email: 'jordan@example.com',
      phone: '479-555-0102',
      location: 'bentonville',
      addressLine1: '456 SE 8th St',
      addressLine2: '',
      addressCity: 'Bentonville',
      addressState: 'AR',
      addressZip: '72712',
    },
  ]);

  // Payment method per owner — the payment-guarantee trigger rejects any
  // owner booking without a live payment method. Deliberately NO
  // stripe_customers rows (Δ 2026-07-14): a fake `cus_seed_*` id made
  // `POST /payment-methods/setup-intent` 500 against real Stripe ("no such
  // customer") and blocked the add-card flow. The route lazily provisions a
  // REAL test-mode customer on first add-card instead; the seeded pm rows
  // below satisfy the booking gate but are not live Stripe objects (real
  // purchases need a card added through the app).
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

  // The ten rows of the catalog, from M4.06's own statement, so this seed and a migrated
  // database hold one catalog. Each row names its campus, program and tier.
  await db.execute(sql.raw(readFileSync(CATALOG_SEED_STEP, 'utf8')));

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
      // Shanthi 2026-07-14: all seed dogs are fixed, so the spay/neuter refusal
      // (S11) will not refuse a demo family when it lands.
      spayedNeutered: true,
      // Stored since M4.11: she holds all five curriculum levels, seeded below.
      isAlumni: true,
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
      spayedNeutered: true,
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
      spayedNeutered: true,
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
      spayedNeutered: true,
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
  // §J.3 alumni demo: Waffles has all 5 day-school curriculum programs, her row says so
  // (M4.11), and the dog-profile hero shows the badge. Her credits expire like anyone's
  // (ALUM-U16).
  await db.insert(dogCompletedPrograms).values(
    CURRICULUM_PROGRAMS.map((program) => ({
      dogId: SEED.dogWafflesId,
      program,
      completedByStaffId: SEED.staffShanthiId,
    })),
  );

  await db.insert(bookings).values([
    {
      id: SEED.bookingWafflesSchoolId,
      ownerId: SEED.ownerAllisonId,
      leadDogId: SEED.dogWafflesId,
      category: 'day-school',
      status: 'upcoming',
      scheduledAt: dayProgramStartFromNow(2),
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
      lessonSetting: 'home',
    },
    {
      id: SEED.bookingBrodieBoardingId,
      ownerId: SEED.ownerJordanId,
      leadDogId: SEED.dogBrodieId,
      category: 'boarding',
      status: 'upcoming',
      scheduledAt: daysFromNow(5, 15),
      // Spans dropoff (day 5, 15:00) → pickup (day 9, 17:00) = 4d2h. The wire
      // only emits `duration_minutes` (never pickup_at), so the owner app's
      // residential booking-conflict block reads the stay length from here —
      // leaving it null would gray a single day instead of the whole stay.
      durationMinutes: 5880,
      trainerStaffId: SEED.staffFedId,
      dropoffAt: daysFromNow(5, 15),
      pickupAt: daysFromNow(9, 17),
      notes: '4-night stay.',
      location: 'bentonville',
    },
    {
      // Multi-dog day-care so the board has a roster to check in.
      id: SEED.bookingGroupWalkId,
      ownerId: SEED.ownerJordanId,
      leadDogId: SEED.dogBrodieId,
      category: 'day-care',
      status: 'upcoming',
      scheduledAt: dayProgramStartFromNow(1),
      durationMinutes: 480,
      trainerStaffId: null,
      location: 'bentonville',
    },
    // Past ATTENDED day programs: each dog's most recent day, ~2 weeks back,
    // so a demo dog has a history to show, checked in and out on the board's log
    // below. No booking path reads attendance.
    {
      id: SEED.bookingWafflesPastSchoolId,
      ownerId: SEED.ownerAllisonId,
      leadDogId: SEED.dogWafflesId,
      category: 'day-school',
      status: 'past',
      scheduledAt: dayProgramStartFromNow(-14),
      durationMinutes: 540,
      trainerStaffId: SEED.staffDonavanId,
      confirmedAt: daysFromNow(-15, 15),
      location: 'fayetteville',
    },
    {
      id: SEED.bookingLolaPastSchoolId,
      ownerId: SEED.ownerAllisonId,
      leadDogId: SEED.dogLolaId,
      category: 'day-school',
      status: 'past',
      scheduledAt: dayProgramStartFromNow(-10),
      durationMinutes: 540,
      trainerStaffId: SEED.staffRachelId,
      confirmedAt: daysFromNow(-11, 15),
      location: 'fayetteville',
    },
    {
      id: SEED.bookingBrodiePastCareId,
      ownerId: SEED.ownerJordanId,
      leadDogId: SEED.dogBrodieId,
      category: 'day-care',
      status: 'past',
      scheduledAt: dayProgramStartFromNow(-12),
      durationMinutes: 480,
      trainerStaffId: null,
      confirmedAt: daysFromNow(-13, 15),
      location: 'bentonville',
    },
    {
      id: SEED.bookingOlliePastCareId,
      ownerId: SEED.ownerJordanId,
      leadDogId: SEED.dogOllieId,
      category: 'day-care',
      status: 'past',
      scheduledAt: dayProgramStartFromNow(-8),
      durationMinutes: 480,
      trainerStaffId: null,
      confirmedAt: daysFromNow(-9, 15),
      location: 'bentonville',
    },
  ]);

  await db.insert(bookingDogs).values([
    { bookingId: SEED.bookingWafflesSchoolId, dogId: SEED.dogWafflesId, isLead: true },
    { bookingId: SEED.bookingLolaLessonId, dogId: SEED.dogLolaId, isLead: true },
    { bookingId: SEED.bookingBrodieBoardingId, dogId: SEED.dogBrodieId, isLead: true },
    { bookingId: SEED.bookingGroupWalkId, dogId: SEED.dogBrodieId, isLead: true },
    { bookingId: SEED.bookingGroupWalkId, dogId: SEED.dogOllieId, isLead: false },
    { bookingId: SEED.bookingWafflesPastSchoolId, dogId: SEED.dogWafflesId, isLead: true },
    { bookingId: SEED.bookingLolaPastSchoolId, dogId: SEED.dogLolaId, isLead: true },
    { bookingId: SEED.bookingBrodiePastCareId, dogId: SEED.dogBrodieId, isLead: true },
    { bookingId: SEED.bookingOlliePastCareId, dogId: SEED.dogOllieId, isLead: true },
  ]);

  // The past days above, attended (M5.12; design §2.3:2369-2372): each a check-in at
  // drop-off and a check-out eight hours later on the board's append-only log, by the
  // staffer who took her, and the dog's `last_seen_on` moved to that day, as a real
  // check-in moves it. No booking path reads attendance.
  const attended = [
    {
      bookingId: SEED.bookingWafflesPastSchoolId,
      dogId: SEED.dogWafflesId,
      days: -14,
      staffId: SEED.staffDonavanId,
    },
    {
      bookingId: SEED.bookingLolaPastSchoolId,
      dogId: SEED.dogLolaId,
      days: -10,
      staffId: SEED.staffRachelId,
    },
    {
      bookingId: SEED.bookingBrodiePastCareId,
      dogId: SEED.dogBrodieId,
      days: -12,
      staffId: SEED.staffShanthiId,
    },
    {
      bookingId: SEED.bookingOlliePastCareId,
      dogId: SEED.dogOllieId,
      days: -8,
      staffId: SEED.staffShanthiId,
    },
  ];
  for (const day of attended) {
    const inAt = dayProgramStartFromNow(day.days);
    const outAt = new Date(new Date(inAt).getTime() + 8 * 60 * 60 * 1000).toISOString();
    const lastSeenOn = bucketToChicagoDate(inAt);
    await db.insert(checkinEvents).values([
      {
        bookingId: day.bookingId,
        dogId: day.dogId,
        kind: 'check-in',
        at: inAt,
        byStaffId: day.staffId,
        lastSeenMoved: true,
        lastSeenPrior: null,
      },
      {
        bookingId: day.bookingId,
        dogId: day.dogId,
        kind: 'check-out',
        at: outAt,
        byStaffId: day.staffId,
        reissueCredit: false,
      },
    ]);
    await db.update(dogs).set({ lastSeenOn }).where(eq(dogs.id, day.dogId));
  }

  // Billing ledger for Allison — populates the owner app's Invoices tab in
  // real mode with one row per FE kind/status. (`GET /invoices`, Day-19d.)
  await db.insert(charges).values([
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

  // Each family's credits, bought on the engine 20 days ago, so a day already gone was paid
  // by a lot that was live then, and each lot holds a month from that purchase.
  const allisonLot = await seedBoughtPack({
    key: 'school-2x-weekly-fayetteville',
    ownerId: SEED.ownerAllisonId,
    paymentMethodId: SEED.paymentMethodAllisonId,
    orderId: SEED.orderAllisonPackId,
    chargeId: SEED.chargePackageId,
    invoiceId: SEED.invoiceAllisonPackId,
    lotId: SEED.lotAllisonSchoolId,
    boughtAt: daysFromNow(-20, 15),
  });
  const jordanLot = await seedBoughtPack({
    key: 'daycare-10-bentonville',
    ownerId: SEED.ownerJordanId,
    paymentMethodId: SEED.paymentMethodJordanId,
    orderId: SEED.orderJordanPackId,
    chargeId: SEED.chargeJordanPackId,
    invoiceId: SEED.invoiceJordanPackId,
    lotId: SEED.lotJordanDaycareId,
    boughtAt: daysFromNow(-20, 16),
  });

  // Every seeded credit-paid day spends a credit: one debit a dog, each naming its lot.
  await db.insert(creditLedger).values(
    (
      [
        [allisonLot, SEED.bookingWafflesPastSchoolId, SEED.dogWafflesId],
        [allisonLot, SEED.bookingLolaPastSchoolId, SEED.dogLolaId],
        [allisonLot, SEED.bookingWafflesSchoolId, SEED.dogWafflesId],
        [jordanLot, SEED.bookingBrodiePastCareId, SEED.dogBrodieId],
        [jordanLot, SEED.bookingOlliePastCareId, SEED.dogOllieId],
        [jordanLot, SEED.bookingGroupWalkId, SEED.dogBrodieId],
        [jordanLot, SEED.bookingGroupWalkId, SEED.dogOllieId],
      ] as const
    ).map(([lot, bookingId, dogId]) => ({
      ownerId: lot.ownerId,
      location: lot.location,
      mode: lot.mode,
      tier: lot.tier,
      delta: -1,
      reason: 'booking-debit' as const,
      lotId: lot.lotId,
      bookingId,
      dogId,
    })),
  );

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
      lessonSetting: 'public',
      descriptorKeys: ['high-energy', 'food-motivated'],
    },
    {
      id: SEED.requestBrodieBoardingId,
      ownerId: SEED.ownerJordanId,
      leadDogId: SEED.dogBrodieId,
      category: 'boarding',
      status: 'submitted',
      submittedAt: daysFromNow(-2, 11),
      notesJoint: 'Travel for work — flexible on dates.',
      descriptorKeys: ['easy-going'],
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
      descriptorKeys: ['reactive-on-leash', 'nervous'],
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
        `Get to know the team behind your dog's progress. Rachel and Donavan each ` +
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
        `Buy an 8- or 12-day Day School package this summer and save compared to paying per ` +
        `day. Credits can be split across all of your dogs, so they're easy to share between ` +
        `siblings.`,
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
  const preserved = await captureRealStripeRows();
  await wipe();
  await seed();
  await restoreRealStripeRows(preserved);
  console.log(
    `Seeded dev DB (${safeHost(env.DATABASE_URL)}): 5 staff, 2 owners, 4 dogs, 4 bookings, 3 requests, ` +
      `2 threads, 10 credit packages, 4 group classes + 7 cohorts, billing ledger, 6 announcements, ` +
      `1 event. ` +
      `Preserved real Stripe rows: ${preserved.customers.length} customer(s), ${preserved.cards.length} card(s). ` +
      `Portal principal: staff:${SEED.staffShanthiId}:owner`,
  );
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error('seed-dev failed:', err);
  process.exit(1);
});
