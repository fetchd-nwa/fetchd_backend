import { eq, sql, type SQL } from 'drizzle-orm';
import { charges, cohorts, events, type LocationKey } from './schema/schema.js';
import type { Tx } from './tx.js';

/**
 * **THE ONE GLOBAL LOCK ORDER** (design §2.7:3975, written once, here):
 *
 *   request-key claim
 *     → dog, every dog ascending (`withDogLocks`)
 *       → `(campus, date)` capacity locks, every date ascending (or the run lock)
 *         → cohort, `FOR NO KEY UPDATE` (enrollment and the withdraw)
 *           → charge (the order's)
 *             → the invoice the charge settles
 *               → bookings, in id order
 *                 → dog row, `FOR NO KEY UPDATE` (the check-in's `last_seen_on` and its
 *                   undo's recompute, `checkinEventsRepository.lockDogClock`)
 *                   → pool `(owner, location, mode, tier)`, the credit-lot slot, the alumni
 *                     pool before the regular one (`lockPools`)
 *                     → refunds
 *
 * Take each family once for the whole order. A transaction that needs a later lock
 * and then finds it needs an earlier one has a deadlock waiting for it, so anything
 * reaching for two of these reads this list first. That holds inside a family too: two
 * `lockPools` calls in one transaction are two orders, so a settle takes the pool it grants
 * into with the pools its order debited, because a cancel's return follows it in the same
 * transaction, and an alumni top-up's tx1 holds alumni on its way to regular.
 *
 * The board's verbs (P20, `lib/checkinVerbs.ts`) and the one-dog cancel take claim →
 * (the order's charge, on a top-up day: the cancel only) → the booking row (`lockById`,
 * `FOR UPDATE`) → the dog row → the pool. The dog row is the one new edge: a check-in moves
 * the dog's clock after locking her booking, and an undo recomputes it there. It is safe
 * for the reason the alumni record's lock is (below): `no key update` conflicts with no
 * FK re-check's `KEY SHARE`, and no holder of a dog row lock reaches for a booking row
 * after it (`staffAlumni` takes the dog and wants nothing after). Pinned on real
 * connections by `checkin-lock-order.test.ts`.
 *
 * What P15 uses is claim → charge → bookings: a pending row cancels through
 * {@link lockCharge} before it locks any row, which is what stops two cancels of one order
 * from crossing, and the same order holds on the settle, the webhook, the sweeper and
 * *Cancel order*. P20's settled arm of *Cancel order* (§M2) takes no new edge: it locks the
 * order's rows in this order before it reads their check-in log, so a board verb holding
 * one of them (booking row, then dog row) finishes first and the cancel reads its event.
 * Pinned on real connections by `settled-share-cancels.test.ts` (F9).
 *
 * tx1 of an invoice payment locks the invoice with no charge lock held and takes no
 * existing charge's lock after it (its in-flight check is a plain read, and the charge
 * it writes is new), so it cannot cross a settle, which holds the charge and then
 * updates the invoice. Its lock is `FOR NO KEY UPDATE`, never `FOR UPDATE`: the insert
 * of `orders.invoice_id` earlier in tx1 already took `FOR KEY SHARE` on that row, so two
 * tenders each holding that share and asking `FOR UPDATE` deadlock.
 *
 * The withdraw takes its cohort, then every charge it will write, ascending, then its
 * bookings, then its invoice: those last two run against this list, which holds only
 * while a class's rows carry no order, so nothing else wants both.
 *
 * The cohort is on this list for a lock no statement asks for: the FK re-check. `FOR KEY
 * SHARE` lands on the cohort from any insert carrying `cohort_id`, tx1's charge among
 * them, and from a second `UPDATE` of one invoice in one transaction, because Postgres
 * re-checks every FK of a row version its own transaction wrote, which is a settle on
 * another card reaching `repointPaymentMethod`. Both hold the invoice by then, so each
 * asks for the cohort against this list, while the withdraw holds the cohort on its way
 * to that charge and invoice. It stays safe only because nobody waits there: `lockCohort`
 * is `FOR NO KEY UPDATE`, which `KEY SHARE` does not conflict with and which conflicts
 * with itself. `FOR UPDATE` is a 40P01, the invoice's lesson above. A statement-level
 * trace cannot see an FK check, so `order-lock-order.test.ts` pins it on real connections.
 *
 * `dogs` and `bookings` are parents the same re-check reaches. A settle asks `KEY SHARE`
 * of the dog twice, on the charge insert and on the second `UPDATE` of its invoice, and
 * the one row lock on a dog, `dogsRepository.lockForAlumniUpdate`, is `FOR NO KEY UPDATE`
 * and wants nothing after it, so there is no wait. A class invoice's charge names
 * `booking_id` too, which is safe only because the withdraw writes those rows with a
 * plain `UPDATE` and a per-booking cancel refuses class rows. A board-train invoice's
 * charge names it as well, against `lockById`'s `FOR UPDATE`, and that is a wait and not
 * a cycle: the cancel holds the booking and touches no invoice, so `/pay` queues behind
 * it. The 40P01 here was `payg`'s, whose cancel voided the invoice `/pay` held, and that
 * void left with `payg` at P17.
 *
 * A final failure's `invoiceStillOwed` takes the invoice under its charge, in this list's
 * order. The sweeper looks at one row at a time, so a tick waits behind a held invoice,
 * one look at a time, bounded by a settle: no settle holds a row across a Stripe call,
 * and one that did would make the tick wait on Stripe.
 *
 * **The dog lock stays** (DECISIONS 123(c), 174(h)). §2.4:2947 and §2.7:3983 delete "the
 * `(dog, mode, location)` slot" with M4.10, which is a slot the code no longer has. The lock
 * today is the dog alone, and it is what makes the overlap guard hold across campuses:
 * capacity locks are per campus, so with no dog lock one dog could be booked at both on
 * one day. It crosses nothing, because every holder takes it first, before capacity, and
 * the pool comes last.
 */

/**
 * The instant a lease is judged or written at: Postgres's `now()`, so every replica
 * reads one clock (design §2.7:3860), unless a test injected one. `now()` in a
 * transaction is that transaction's start, so a lease begun after a lock wait is short
 * by that wait, which is the safe direction.
 */
export function leaseInstant(at: Date | undefined): SQL {
  return at === undefined ? sql`now()` : sql`${at.toISOString()}::timestamptz`;
}

/**
 * Row-lock an engine charge for the duration of the transaction: the settle's
 * serialisation point, and the first row lock any order-wide write takes. Returns the
 * whole row, because everything that takes this lock acts on what it reads under it.
 * `undefined` if the id doesn't exist; the caller decides what that means.
 */
export async function lockCharge(
  tx: Tx,
  chargeId: string,
): Promise<typeof charges.$inferSelect | undefined> {
  const [row] = await tx.select().from(charges).where(eq(charges.id, chargeId)).for('update');
  return row;
}

/** One pool's advisory-lock key: the unit a spend or a grant serialises on. */
function poolLockKey(pool: {
  ownerId: string;
  location: string;
  mode: string;
  tier: string;
}): string {
  return `pool:${pool.ownerId}:${pool.location}:${pool.mode}:${pool.tier}`;
}

/**
 * Lock these pools until the transaction ends: the credit-lot slot of the order above,
 * after the charge and after any booking row the path locks. What a holder reads of a pool
 * stays true until its writes commit, which is why a pool cannot be overspent. `alumni`
 * sorts before `regular`, so an alumni top-up takes the alumni pool first, as §2.7 asks.
 */
export async function lockPools(
  tx: Tx,
  pools: readonly { ownerId: string; location: string; mode: string; tier: string }[],
): Promise<void> {
  for (const key of [...new Set(pools.map(poolLockKey))].sort()) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
  }
}

/**
 * Per-key transaction-scoped advisory lock on one catalog row's versions: the
 * serializer of `PATCH /staff/credit-packages/:key`. The edit's statement reads the
 * row live today and closes or corrects it, so two edits of one key must not both read
 * the same row: the second would wait on it, then open the same successor and die on
 * `UNIQUE (key, effective_from)`, a 500. Under the lock the second reads what the first
 * committed and corrects it. Takes no other lock, and no path holds a booking lock
 * across it.
 */
export async function withCreditPackageLock<T>(
  tx: Tx,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`credit-package:${key}`}))`);
  return fn();
}

/**
 * Per-(category, location) transaction-scoped advisory lock — the
 * service-rate supersede serializer (`POST /staff/rates`). The effective-dated
 * write reads the current open rate row, then closes it + inserts a new one;
 * two concurrent edits to the SAME (category, location) track must serialize so
 * they can't both observe "no later row" and leave two open (`effective_to IS
 * NULL`) rows — which would break the non-overlap invariant the rate lookup
 * (`findActiveRate`) and the next supersede both rely on. Held until the outer
 * transaction commits OR rolls back.
 *
 * Key: `hashtext('service-rate:<category>:<location>')`. The prefix keeps this
 * namespace disjoint from the booking/`capacity:` advisory locks; the colon
 * separators make "no two different (category, location) tracks collide"
 * structurally obvious. int4 hash collisions are birthday-paradox-bounded and
 * only cause spurious serialization, never incorrect behavior.
 */
export async function withServiceRateLock<T>(
  tx: Tx,
  category: string,
  location: string,
  fn: () => Promise<T>,
): Promise<T> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`service-rate:${category}:${location}`}))`,
  );
  return fn();
}

/**
 * Row-lock a cohort for the duration of the transaction — the
 * `enrollInGroupClass` capacity-ceiling primitive (`schema.sql` Transaction
 * contract notes, `enrollInGroupClass` ~line 1276). Concurrent enrollment
 * attempts on the same cohort serialize on this row so the
 * `filled + len(non-staff dogs) <= capacity` assertion is race-free.
 *
 * `FOR NO KEY UPDATE`, never `FOR UPDATE` (the FK re-check, at the top of this file). It
 * conflicts with itself and with `bumpFilled`'s `UPDATE`, so two enrollments still read
 * each other's `filled`, and a second withdraw of one dog waits here and then finds her
 * rows gone. All it lets past is the `KEY SHARE` of a child row naming this cohort, and
 * that reads no seat count.
 *
 * Returns the locked row to the caller (who does the capacity arithmetic
 * and the `UPDATE cohorts SET filled = filled + ...`). `undefined` if the
 * cohort id doesn't exist — the caller decides the error semantic.
 *
 * Soft-expire is INTENTIONALLY not filtered here. The row lock acquires on
 * existence-by-id; capacity policy that an expired cohort can't be enrolled
 * into is the caller's call (the enrollment txn itself filters by
 * `live(cohorts)` before this — by the time we lock, the live check has
 * passed, and we lock the same id we just read).
 */
export async function lockCohort(
  tx: Tx,
  cohortId: string,
): Promise<typeof cohorts.$inferSelect | undefined> {
  const [row] = await tx
    .select()
    .from(cohorts)
    .where(eq(cohorts.id, cohortId))
    .for('no key update');
  return row;
}

/**
 * Row-lock an event for the duration of the transaction — the
 * `POST /events/:id/rsvp` soft-cap primitive (Day-19e). Concurrent RSVPs to
 * the same event serialize on this row so the
 * `live_dogs - owner_current + |dog_ids| <= capacity` assertion is race-free.
 * Returns the locked row (the caller reads `capacity` + does the arithmetic),
 * or `undefined` when the id doesn't exist. Soft-expire is intentionally NOT
 * filtered — same rationale as `lockCohort`: the route's `live` check runs
 * before the lock, and we lock the same id we just read.
 */
export async function lockEvent(
  tx: Tx,
  eventId: string,
): Promise<typeof events.$inferSelect | undefined> {
  const [row] = await tx.select().from(events).where(eq(events.id, eventId)).for('update');
  return row;
}

/**
 * Day 10 capacity serializer — advisory lock on `(location, date)` for the
 * day-program booking path. Held for the lifetime of the transaction;
 * concurrent `bookSession` calls touching the same calendar bucket serialize
 * cleanly without forcing the sparse `day_capacity` table to materialize
 * default-rule rows.
 *
 * Why advisory over row-lock for THIS path:
 * - `day_capacity` is SPARSE (only overrides). Locking via FOR UPDATE
 *   requires the row to exist; materializing a default-value row on every
 *   booked date breaks the "rows = overrides" invariant the read side
 *   relies on (a `day_capacity` row stops being an unambiguous override
 *   signal once we start writing default-value rows alongside).
 * - The advisory lock doesn't care whether a row exists. The capacity
 *   computation reads the override row OR falls back to the campus's rule
 *   under the same lock, through the one `dayCapacityFor` the read side uses.
 * - The cap edits (`lib/capLowering.ts`) take this same lock, so a booking
 *   and a staff write serialise on it: `withCapacityLocks`, below.
 *
 * Lock key: `hashtext('capacity:<location>:<date>')`. The colon separator
 * makes "no two different (location, date) pairs collide" structurally
 * obvious; the prefix keeps this key namespace disjoint from the
 * `dog:<dogId>` advisory locks elsewhere in the file. int4 hash
 * collisions are birthday-paradox-bounded and only cause spurious
 * serialization (never incorrect behavior).
 *
 * Day-10 lock ordering protocol (deadlock avoidance): when a single
 * transaction acquires multiple capacity locks (a multi-date booking, a cap
 * edit that lowers many dates), it MUST acquire them in ASC date order.
 * Combined with `withDogLocks`'s ASC dogId ordering, two concurrent
 * multi-key writers can never deadlock — both observe the same total
 * acquisition order. An advisory transaction lock cannot be released before
 * COMMIT, so a multi-date holder holds every date it has taken.
 */
export async function withCapacityLock<T>(
  tx: Tx,
  location: LocationKey,
  date: string,
  fn: () => Promise<T>,
): Promise<T> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`capacity:${location}:${date}`}))`);
  return fn();
}

/**
 * Batch helper for every multi-date holder: the `bookSession` path and the
 * cap-lowering check. Acquires `withCapacityLock` for every `(location, date)`
 * pair in canonical ASC date order so two concurrent N-date writers on
 * overlapping date sets can never deadlock against each other — both observe
 * the same total acquisition order. Single-date is a no-overhead degenerate of
 * this helper (one lock acquired).
 */
export async function withCapacityLocks<T>(
  tx: Tx,
  location: LocationKey,
  dates: readonly string[],
  fn: () => Promise<T>,
): Promise<T> {
  const sortedDates = [...dates].sort();
  for (const date of sortedDates) {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`capacity:${location}:${date}`}))`,
    );
  }
  return fn();
}

/**
 * The booking core's dog lock: one transaction-scoped advisory lock per dog,
 * acquired in canonical ASC dogId order so two concurrent N-dog bookings on
 * overlapping dog sets can never deadlock — both observe the same total
 * acquisition order. It serializes the overlap guard, across campuses: a dog
 * can be in one place on a day, so two pools never make two bookings safe
 * (DECISIONS 174(h)). The lot choice is `lockPools`'s to serialize. Held until
 * the outer transaction commits OR rolls back.
 *
 * The key is the dog alone, `hashtext('dog:<dogId>')`, and `<dogId>` is the
 * lowercased id. The key is a string and Postgres reads a uuid in either case, so
 * this function trusts its caller to have normalised: `POST /bookings` does it at
 * the parse boundary (`postBookingBodySchema`). The prefix keeps the key disjoint
 * from the file's other namespaces. A dog is in one place on a day, so
 * the overlap guard reads her bookings across every mode and campus, and any two
 * bookings for her must be able to see each other. A key carrying the campus or
 * the mode lets two concurrent requests both pass the guard, and each spends a
 * credit or opens an invoice for one day. Credits are the owner's, so the pool lock
 * ({@link lockPools}) is what serialises spending them; this queue is per dog.
 *
 * Acquisition is sequential — postgres holds advisory locks until the
 * transaction commits, and the lock-acquire round-trips are cheap
 * (one statement each). Parallelizing would risk deadlock against a
 * concurrent transaction acquiring the same dogs in a different order.
 */
export async function withDogLocks<T>(
  tx: Tx,
  dogIds: readonly string[],
  fn: () => Promise<T>,
): Promise<T> {
  const sortedIds = [...dogIds].sort();
  for (const dogId of sortedIds) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`dog:${dogId}`}))`);
  }
  return fn();
}
