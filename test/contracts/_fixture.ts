import { eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import {
  dogCompletedClasses,
  dogFeeding,
  dogMedications,
  dogVaccines,
  dogs,
  owners,
  vets,
} from '../../src/db/schema/schema.js';

/**
 * Fixed UUIDs let the contract snapshots be real JSON files checked into git —
 * no normalization gymnastics, the regression net catches a field rename the
 * day the diff lands. Day 4b/5/6/7 extend this fixture with the rows their
 * contract tests need (required_vaccines, agreement_documents/signatures,
 * bookings, etc.); add to FIXTURE_IDS + extend seed/teardown in the same
 * order. The shape is the only contract Days 5–7 inherit; the data is yours
 * to tune to each day's read.
 *
 * UUID layout: each entity-class gets a leading nibble — 1 = owner, 2 = vet,
 * 3 = dog, 4 = vaccine, 5 = medication, 6 = completed-class. v4 marker
 * (third group leads with 4, fourth with 8) so a future fixture-aware tool
 * sees these as real UUIDs.
 */
export const FIXTURE_IDS = {
  ownerSupabaseUid: '11111111-1111-4111-8111-111111111110',
  ownerId: '11111111-1111-4111-8111-111111111111',
  vetId: '22222222-2222-4222-8222-222222222222',
  dog1Id: '33333333-3333-4333-8333-333333333331',
  dog2Id: '33333333-3333-4333-8333-333333333332',
  vaccine1Id: '44444444-4444-4444-8444-444444444441',
  vaccine2Id: '44444444-4444-4444-8444-444444444442',
  medication1Id: '55555555-5555-4555-8555-555555555551',
  completedClass1Id: '66666666-6666-4666-8666-666666666661',
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

  // requirementKey deferred to Day 4b when the required_vaccines catalog is
  // added to the fixture (FK target). For Day 4a these are display-only rows
  // — the §B wire shape emits only `{ name, expires_at }`, so the requirement
  // link is invisible on this read anyway.
  await db.insert(dogVaccines).values([
    {
      id: FIXTURE_IDS.vaccine1Id,
      dogId: FIXTURE_IDS.dog1Id,
      name: 'Rabies',
      requirementKey: null,
      expiresAt: '2027-05-19',
    },
    {
      id: FIXTURE_IDS.vaccine2Id,
      dogId: FIXTURE_IDS.dog1Id,
      name: 'Bordetella',
      requirementKey: null,
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
}

export async function teardownFixture(): Promise<void> {
  await db.delete(dogs).where(eq(dogs.ownerId, FIXTURE_IDS.ownerId));
  await db.delete(vets).where(eq(vets.id, FIXTURE_IDS.vetId));
  await db.delete(owners).where(eq(owners.id, FIXTURE_IDS.ownerId));
}
