import { randomUUID } from 'node:crypto';
import { eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import {
  bookingDogs,
  bookings,
  creditLedger,
  dayProgramSettings,
  dogVaccines,
  dogs,
  invoices,
  scheduledNotifications,
} from '../../src/db/schema/schema.js';
import { clearInvoiceChargeAttempts, FIXTURE_IDS, topUpCredits } from './_fixture.js';

/**
 * What P13's day-program test files share: a dog that passes every gate, a way to
 * move the settings that are now read at runtime, and a way to put both back. The
 * settings are a test's input here, so each file calls `restoreDaySeeds` after each
 * test, or one test's horizon would quietly become the next test's refusal.
 */

export type Campus = 'fayetteville' | 'bentonville';

/** A fixture-owned dog that passes every gate. Pushes her id onto `ledger`. */
export async function createBookableDog(ledger: string[]): Promise<string> {
  const dogId = randomUUID();
  ledger.push(dogId);
  await db.insert(dogs).values({
    id: dogId,
    ownerId: FIXTURE_IDS.ownerId,
    name: `Day ${dogId.slice(0, 8)}`,
    breed: 'Test Breed',
    birthdate: '2023-01-01',
    evaluationStatus: 'passed',
  });
  // Vaccines are checked by a trigger on the real clock, so the expiry is too.
  const expiresAt = new Date(Date.now() + 5 * 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  await db
    .insert(dogVaccines)
    .values(
      [FIXTURE_IDS.requiredVaccineRabiesKey, FIXTURE_IDS.requiredVaccineBordetellaKey].map(
        (requirementKey) => ({ dogId, name: requirementKey, requirementKey, expiresAt }),
      ),
    );
  return dogId;
}

/** The same dog with credits in both modes at both campuses. */
export async function createFundedDog(ledger: string[], credits = 5): Promise<string> {
  const dogId = await createBookableDog(ledger);
  for (const location of ['fayetteville', 'bentonville'] as const) {
    await topUpCredits(dogId, 'school', credits, location);
    await topUpCredits(dogId, 'daycare', credits, location);
  }
  return dogId;
}

/** Everything these dogs left behind, in FK order. */
export async function removeDogs(dogIds: string[]): Promise<void> {
  if (dogIds.length === 0) return;
  const bookingIds = (
    await db
      .select({ id: bookingDogs.bookingId })
      .from(bookingDogs)
      .where(inArray(bookingDogs.dogId, dogIds))
  ).map((r) => r.id);
  if (bookingIds.length > 0) {
    await db
      .delete(scheduledNotifications)
      .where(inArray(scheduledNotifications.bookingId, bookingIds));
    await clearInvoiceChargeAttempts();
    await db.delete(invoices).where(inArray(invoices.bookingId, bookingIds));
    await db.delete(creditLedger).where(inArray(creditLedger.bookingId, bookingIds));
  }
  await db.delete(scheduledNotifications).where(inArray(scheduledNotifications.dogId, dogIds));
  await db.delete(creditLedger).where(inArray(creditLedger.dogId, dogIds));
  if (bookingIds.length > 0) {
    await db.delete(bookings).where(inArray(bookings.id, bookingIds)); // booking_dogs CASCADE
  }
  await db.delete(dogVaccines).where(inArray(dogVaccines.dogId, dogIds));
  await db.delete(dogs).where(inArray(dogs.id, dogIds));
}

/** Move one campus's day settings, as an edit would, without the PATCH route. */
export async function setCampusSettings(
  location: Campus,
  values: Partial<typeof dayProgramSettings.$inferInsert>,
): Promise<void> {
  await db.update(dayProgramSettings).set(values).where(eq(dayProgramSettings.location, location));
}

/** Move the global day settings. */
export async function setGlobalSettings(
  values: Partial<typeof dayProgramSettings.$inferInsert>,
): Promise<void> {
  await db.update(dayProgramSettings).set(values).where(isNull(dayProgramSettings.location));
}

/** The §3.4 seeds these files move, written back. */
export async function restoreDaySeeds(): Promise<void> {
  await db
    .update(dayProgramSettings)
    .set({ bookingHorizonMonths: 3, maxDogsPerBookingCount: 5 })
    .where(isNull(dayProgramSettings.location));
  await db
    .update(dayProgramSettings)
    .set({
      openWeekdaysList: [1, 2, 3, 4, 5],
      dailyCapacityDogs: 15,
      dropoffOpenTime: '07:30',
      pickupCloseTime: '17:30',
      sameDayCutoffTime: '07:30',
    })
    .where(isNotNull(dayProgramSettings.location));
}
