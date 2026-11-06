import { eq, sql, type SQL } from 'drizzle-orm';
import { bookingMode, charges, cohorts, events, type LocationKey } from './schema/schema.js';
import type { Tx } from './tx.js';

type BookingMode = (typeof bookingMode.enumValues)[number];

/**
 * **THE ONE GLOBAL LOCK ORDER** (design §2.7:3975, written once, here):
 *
 *   request-key claim
 *     → `(campus, date)` capacity locks, every date ascending (or the run lock)
 *       → cohort, `FOR NO KEY UPDATE` (enrollment and the withdraw)
 *         → charge (the order's)
 *           → the invoice the charge settles
 *             → bookings, in id order
 *               → pool `(owner, location, mode, tier)`, the credit-lot slot
 *                 → refunds
 *
 * Take each family once for the whole order. A transaction that needs a later lock
 * and then finds it needs an earlier one has a deadlock waiting for it, so anything
 * reaching for two of these reads this list first. What P15 uses is claim → charge →
 * bookings: a pending row cancels through {@link lockCharge} before it locks any row,
 * which is what stops two cancels of one order from crossing, and the same order holds
 * on the settle, the webhook, the sweeper and *Cancel order*.
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
 * A final failure's `invoiceStillOwed` takes the invoice under its charge, in this list's
 * order. The sweeper looks at one row at a time, so a tick waits behind a held invoice,
 * one look at a time, bounded by a settle: no settle holds a row across a Stripe call,
 * and one that did would make the tick wait on Stripe.
 *
 * Not on this list yet, because no path takes it alongside a charge: `withDogLocks`,
 * which the booking core takes before capacity. M4.10 deletes the `(dog, mode,
 * location)` slot and puts the pool where this list says.
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
 * Per-(dog, mode) transaction-scoped advisory lock — the membership-create
 * serializer (`POST /memberships`, uniqueness ruling 2026-07-16: one ACTIVE
 * membership per (dog, mode)). The route pre-checks before the Stripe charge
 * (friendly 409, no money moves), but that read races the seconds-wide Stripe
 * round-trip of a concurrent subscribe: both calls can pass the pre-check,
 * both charge, and both insert. This lock + an in-tx re-check serialize the
 * insert decision so the loser detects the winner's row and refunds its
 * duplicate charge instead of double-subscribing. The partial unique index
 * (`memberships_one_active_per_dog_mode`) is the constraint floor beneath
 * both.
 *
 * Key: `hashtext('membership:<dogId>:<mode>')`. The prefix keeps this
 * namespace disjoint from the booking (`dog:<dogId>`) and
 * `service-rate:` locks; int4 hash collisions only cause spurious
 * serialization, never incorrect behavior. The key is a string, so `dogId` must
 * be the lowercased id: `POST /memberships` normalises it at its parse boundary.
 */
export async function withMembershipCreateLock<T>(
  tx: Tx,
  dogId: string,
  mode: BookingMode,
  fn: () => Promise<T>,
): Promise<T> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`membership:${dogId}:${mode}`}))`);
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
 * acquisition order. It serializes the credit balance check, the FIFO lot
 * choice and the overlap guard, so the `credit_ledger` debit can't race any of
 * them. Held until the outer transaction commits OR rolls back.
 *
 * The key is the dog alone, `hashtext('dog:<dogId>')`, and `<dogId>` is the
 * lowercased id. The key is a string and Postgres reads a uuid in either case, so
 * this function trusts its caller to have normalised: `POST /bookings` does it at
 * the parse boundary (`postBookingBodySchema`). The prefix keeps the key disjoint
 * from the file's other namespaces. A dog is in one place on a day, so
 * the overlap guard reads her bookings across every mode and campus, and any two
 * bookings for her must be able to see each other. A key carrying the campus or
 * the mode lets two concurrent requests both pass the guard, and each spends a
 * credit or opens an invoice for one day. Credits stay per-(dog, mode, location);
 * only the queue is per dog.
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
