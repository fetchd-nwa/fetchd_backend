/**
 * **Which enrollment does this charge belong to?** — ADDENDUM 3 §A3.17
 * (`designs/partial-success-enrollment.md`), 2026-08-22, amended by §A3.18 D3
 * the same day.
 *
 * A `(cohort, dog)` is NOT an enrollment. A withdraw + re-enroll mints a SECOND
 * enrollment under the same key, and every money read that keyed on the pair
 * answered for whichever enrollment's charge it happened to reach first —
 * measured end-to-end as a live authorization CANCELLED for an enrolled dog
 * because a previous enrollment's charge still carried a remainder (R4-3).
 *
 * **An enrollment IS its booking rows.** They are minted in one
 * tx/savepoint and soft-cancelled as a unit by the withdraw
 * (`bookingsRepository.markCancelled`); per-booking cancellation of a
 * group-class row is forbidden in both routes (R23,
 * `BUSINESS-LOGIC/group-classes-enrollments.md:58`, enforced at
 * `cancelBookingService.ts:122-125`), so a member row's liveness IS the
 * enrollment's liveness. That is the identity this module expresses, and it is
 * the ONE definition of membership in this codebase — the reads
 * (`chargesRepository`), the reconciler's row-scoped arms, and the withdraw
 * settle all consume it, so they cannot drift into three answers again.
 *
 * **Two rules, and the second one retires itself.**
 *
 *   1. **Stamped** — the charge carries an *anchor*: the earliest-scheduled
 *      booking row minted with it. It belongs to this enrollment iff that
 *      anchor is one of the enrollment's live rows.
 *   2. **Legacy (NULL anchor)** — minted before the stamp existed. It belongs
 *      to this enrollment iff it was minted at or after the enrollment's BIRTH.
 *
 * **How narrow rule 2 actually is (§A3.17 → §A3.18 D5 → §A3.19 F2).** §A3.17
 * called it legacy-only and was wrong: the invoice lane resolved its anchor at
 * SETTLE time and wrote NULL when it found no live booking. §A3.18 D1 moved
 * that to MINT time — a group-class invoice carries its own enrollment's
 * anchor and every invoice-lane charge copies it — and then claimed no
 * post-deploy path could mint a NULL anchor. **That was wrong too, through two
 * doors** (both executed): invoices minted BEFORE the stamp existed, a
 * population draining over weeks; and `invoices.booking_id`'s
 * `ON DELETE SET NULL`, which silently orphans an invoice when an ops script
 * hard-deletes an anchor row.
 *
 * §A3.19 F2 closes both at the mint with an exact same-transaction witness
 * (`resolveInvoiceAnchorBookingId`). So the honest statement is: **a
 * post-deploy NULL anchor now occurs only through that fallback's FAILURE arm,
 * which WARNs naming the invoice** — and rule 2 is the net behind it. Rule 2
 * still shrinks toward nothing; it is no longer claimed to be already there.
 *
 * **`>=`, inclusive, and that is load-bearing.** Postgres `now()` is
 * transaction-start-stable, so a legacy enroll transaction's bookings and its
 * charge carry EQUAL `created_at`; `>` would orphan every legacy enrollment
 * from its own money.
 *
 * **One precision: the database's (§A3.18 D3).** Every instant here is the
 * DB's own MICROSECONDS, carried as `created_at_us` by the projections that
 * feed this module, and `new Date()` never touches the membership path.
 * Before this rule, `Date` truncated Postgres's microseconds to milliseconds on
 * both sides of the comparison, and a charge at `…10.1875+00` against a birth
 * of `…10.1879+00` was a member in JS while Postgres said it PREDATED the
 * enrollment — two layers, two answers about the same two rows, and a live
 * hold released for a dog with four live sessions (OP-11). µs epoch ≈ 1.8e15,
 * comfortably inside `Number.MAX_SAFE_INTEGER` (9.0e15), so integer comparison
 * is exact. Rejected en route: comparing the driver's timestamp STRINGS
 * lexicographically — Postgres trims trailing fractional zeros, so `.19` sorts
 * before `.1875` and string order is not time order.
 */

/**
 * The live booking-row shape every caller already has in hand.
 *
 * `createdAtUs` is `(EXTRACT(EPOCH FROM created_at) * 1e6)::bigint` — rendered
 * as text by the projections, because node-postgres hands `int8` back as a
 * string to avoid silently lossy parsing. Both spellings are accepted and
 * normalized once, here.
 */
export interface EnrollmentBookingRow {
  id: string;
  createdAtUs: string | number;
}

/**
 * One enrollment's identity: its live booking ids (the anchor set) and the
 * microsecond instant it was born (`min(created_at)` over those rows).
 */
export interface EnrollmentIdentity {
  readonly bookingIds: readonly string[];
  readonly bornAtUs: number;
}

/**
 * Build the identity from a dog's live bookings in one cohort — the set
 * `bookingsRepository.findLiveBookingsForCohortDog` returns.
 *
 * **`undefined` when the set is EMPTY, and that is the whole answer for a
 * withdrawn dog**: there is no current enrollment, so no charge belongs to one.
 * Expressed as an absent identity rather than an empty one so a caller cannot
 * accidentally read "matches nothing" as "matches everything".
 */
export function enrollmentIdentityOf(
  liveBookings: readonly EnrollmentBookingRow[],
): EnrollmentIdentity | undefined {
  if (liveBookings.length === 0) return undefined;
  const bookingIds: string[] = [];
  let bornAtUs = Number.POSITIVE_INFINITY;
  for (const row of liveBookings) {
    bookingIds.push(row.id);
    const us = microsFromDb(row.createdAtUs, `booking ${row.id}`);
    if (us < bornAtUs) bornAtUs = us;
  }
  return { bookingIds, bornAtUs };
}

/**
 * Does this charge belong to that enrollment? The membership rule above, in
 * one place.
 *
 * A charge is never a member of a non-existent enrollment (`undefined`), which
 * is what makes "is THIS row's own enrollment still live?" the same question
 * asked with the CURRENT live set.
 */
export function chargeBelongsToEnrollment(
  charge: { bookingId: string | null; createdAtUs: string | number },
  enrollment: EnrollmentIdentity | undefined,
): boolean {
  if (enrollment === undefined) return false;
  if (charge.bookingId !== null) return enrollment.bookingIds.includes(charge.bookingId);
  return microsFromDb(charge.createdAtUs, 'charge') >= enrollment.bornAtUs;
}

/**
 * Parse a DB microsecond stamp, LOUDLY.
 *
 * An unparseable instant would silently become `NaN`, every comparison against
 * it would be false, and the charge would drop out of its own enrollment —
 * which on the reconciler's capture gate reads as "this enrollment is unpaid"
 * and TAKES money. `created_at` is `NOT NULL DEFAULT now()` on both tables, so
 * this cannot fire; it throws rather than defaulting because the failure
 * direction of a quiet default here is a charge, not a missed charge.
 *
 * The safe-integer check is not ceremony: past 2^53 microseconds (year 2255)
 * integer comparison would start rounding, and a money rule must not begin
 * lying quietly on a birthday.
 */
function microsFromDb(value: string | number, what: string): number {
  const us = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(us) || !Number.isSafeInteger(us)) {
    throw new Error(`enrollmentIdentity: ${what} has an unusable created_at_us (${String(value)})`);
  }
  return us;
}
