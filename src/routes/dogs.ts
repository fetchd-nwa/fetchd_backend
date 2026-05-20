import type { FastifyInstance } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  dogs,
  vets,
  dogVaccines,
  dogMedications,
  dogFeeding,
  dogCompletedClasses,
  type evaluationStatus,
  type groupClassKey,
} from '../db/schema/schema.js';
import { requirePrincipal, resolveAuthHook, type AuthRouteOptions } from '../auth/plugin.js';
import { live } from '../db/softExpire.js';
import { ageInMonths } from '../lib/ageMonths.js';

/**
 * `GET /dogs` `[auth]` — every live dog the authenticated owner owns,
 * denormalized into the DATA-CONTRACT §B wire shape: `vet?` resolved from
 * `dogs.primary_vet_id`, `age_months` computed in America/Chicago,
 * `vaccines` / `medications` / `feeding` / `completed_class_keys` assembled
 * from per-dog joins. Staff principals get an empty list (owner app only
 * surfaces owner-owned dogs, R3).
 *
 * Query plan: one `dogs LEFT JOIN vets` read, then four parallel
 * `WHERE dog_id IN (…)` reads for the child tables — five queries regardless
 * of dog count. A single json_agg query would be one round-trip but less
 * readable; Day-8 Redis will cache the assembled response either way. Per-
 * table `live(...)` predicates exclude soft-expired rows at the read seam.
 *
 * Wire-shape nullability conventions (locked Day 4a, applied through 4b+):
 *   • Required keys with no `?` in §B: always emit; null DB text → ''.
 *   • Optional keys with `?` in §B: omit when null/empty (evaluation_date,
 *     completed_class_keys, vet, and the vet-internal phone/email/...).
 *   • Documented exceptions per the FE RawX type: feeding.notes is
 *     `string | null`, always present.
 */

type EvaluationStatus = (typeof evaluationStatus.enumValues)[number];
type GroupClassKey = (typeof groupClassKey.enumValues)[number];

interface VetWire {
  id: string;
  name: string;
  phone?: string;
  email?: string;
  address?: string;
  notes?: string;
}

interface VaccineWire {
  name: string;
  expires_at: string;
}

interface MedicationWire {
  id: string;
  name: string;
  dose: string;
  frequency: string;
}

interface FeedingWire {
  brand: string;
  amount: string;
  frequency: string;
  notes: string | null;
}

interface DogWire {
  id: string;
  name: string;
  breed: string;
  age_months: number;
  profile_image_path: string;
  vaccines: VaccineWire[];
  medications: MedicationWire[];
  feeding: FeedingWire;
  special_notes: string;
  evaluation_status: EvaluationStatus;
  evaluation_date?: string;
  completed_class_keys?: GroupClassKey[];
  vet?: VetWire;
}

export interface DogsRouteOptions extends AuthRouteOptions {
  /**
   * Injectable clock so contract tests get a deterministic `age_months`. A
   * factory (not a `Date`) is the right shape: a captured `Date` at registration
   * time would freeze production's clock. Default factory = `() => new Date()`.
   */
  now?: () => Date;
}

export function registerDogsRoute(app: FastifyInstance, opts: DogsRouteOptions = {}): void {
  const authHook = resolveAuthHook(opts);
  const now = opts.now ?? (() => new Date());

  app.get('/dogs', { preHandler: [authHook] }, async (request) => {
    const principal = requirePrincipal(request);
    if (principal.kind !== 'owner') {
      return [];
    }

    const dogRows = await db
      .select({ dog: dogs, vet: vets })
      .from(dogs)
      .leftJoin(vets, and(eq(vets.id, dogs.primaryVetId), live(vets)))
      .where(and(eq(dogs.ownerId, principal.ownerId), live(dogs)))
      .orderBy(dogs.createdAt, dogs.id);

    if (dogRows.length === 0) return [];

    const dogIds = dogRows.map((r) => r.dog.id);

    const [vaccineRows, medicationRows, feedingRows, completedRows] = await Promise.all([
      db
        .select()
        .from(dogVaccines)
        .where(and(inArray(dogVaccines.dogId, dogIds), live(dogVaccines)))
        .orderBy(dogVaccines.expiresAt, dogVaccines.id),
      db
        .select()
        .from(dogMedications)
        .where(and(inArray(dogMedications.dogId, dogIds), live(dogMedications)))
        .orderBy(dogMedications.id),
      db
        .select()
        .from(dogFeeding)
        .where(and(inArray(dogFeeding.dogId, dogIds), live(dogFeeding))),
      db
        .select()
        .from(dogCompletedClasses)
        .where(and(inArray(dogCompletedClasses.dogId, dogIds), live(dogCompletedClasses)))
        .orderBy(dogCompletedClasses.completedAt, dogCompletedClasses.id),
    ]);

    const vaccinesByDog = bucketBy(vaccineRows, (v) => v.dogId);
    const medicationsByDog = bucketBy(medicationRows, (m) => m.dogId);
    const feedingByDog = new Map(feedingRows.map((f) => [f.dogId, f] as const));
    const completedByDog = bucketBy(completedRows, (c) => c.dogId);

    const today = now();
    return dogRows.map(({ dog, vet }): DogWire => {
      const wire: DogWire = {
        id: dog.id,
        name: dog.name,
        breed: dog.breed,
        age_months: ageInMonths({
          birthdate: dog.birthdate,
          ageMonthsOverride: dog.ageMonthsOverride,
          today,
        }),
        profile_image_path: dog.profileImagePath ?? '',
        vaccines: (vaccinesByDog.get(dog.id) ?? []).map((v) => ({
          name: v.name,
          expires_at: v.expiresAt,
        })),
        medications: (medicationsByDog.get(dog.id) ?? []).map((m) => ({
          id: m.id,
          name: m.name,
          dose: m.dose,
          frequency: m.frequency,
        })),
        feeding: feedingWireFor(feedingByDog.get(dog.id)),
        special_notes: dog.specialNotes,
        evaluation_status: dog.evaluationStatus,
      };
      if (dog.evaluationDate !== null) wire.evaluation_date = pgTimestampToIso(dog.evaluationDate);
      const keys = (completedByDog.get(dog.id) ?? []).map((c) => c.classKey);
      if (keys.length > 0) wire.completed_class_keys = keys;
      if (vet !== null) wire.vet = vetWireFor(vet);
      return wire;
    });
  });
}

function vetWireFor(row: typeof vets.$inferSelect): VetWire {
  const wire: VetWire = { id: row.id, name: row.name };
  if (row.phone !== null) wire.phone = row.phone;
  if (row.email !== null) wire.email = row.email;
  if (row.address !== null) wire.address = row.address;
  if (row.notes !== null) wire.notes = row.notes;
  return wire;
}

function feedingWireFor(row: typeof dogFeeding.$inferSelect | undefined): FeedingWire {
  // No feeding row → empty-string defaults so the wire stays stable. /POST
  // /dogs (Day 9) decides whether feeding is required on create; the read
  // path can't refuse to serve a dog that lacks one.
  if (row === undefined) {
    return { brand: '', amount: '', frequency: '', notes: null };
  }
  return {
    brand: row.brand,
    amount: row.amount,
    frequency: row.frequency,
    notes: row.notes,
  };
}

function pgTimestampToIso(pgString: string): string {
  // Drizzle pg with `mode: 'string'` returns timestamptz in PG's default ISO
  // DateStyle: `'YYYY-MM-DD HH:MM:SS[.uuu]+TZ'` — space-separated date/time
  // and a single-pair `+TZ` (no colon, e.g. `+00`). V8's `Date` parser rejects
  // both. Rewrite the space → 'T' and pad the offset to `+HH:MM` so we can
  // round-trip through `Date.toISOString()` for the on-wire ISO-8601 emit
  // (per DATA-CONTRACT R5). Already-`Z` or `+HH:MM` strings pass untouched.
  const withT = pgString.replace(' ', 'T');
  const withTz = withT.replace(/([+-]\d{2})$/, '$1:00');
  return new Date(withTz).toISOString();
}

function bucketBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const result = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const bucket = result.get(k);
    if (bucket) bucket.push(item);
    else result.set(k, [item]);
  }
  return result;
}
