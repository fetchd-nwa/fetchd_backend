import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../client.js';

/**
 * Read seam for the owner's CURRENT group-class enrollments (Δ 2026-06-09) —
 * one row per live (cohort, dog) pairing, with the class/cohort detail the
 * mobile "Currently enrolled" section renders plus the per-enrollment payment
 * state and the first-session instant (drives the "can still withdraw" guard,
 * which the withdraw verb re-checks authoritatively under the cohort lock).
 *
 * Payment state is derived per ENROLLMENT: a succeeded `charges` row
 * **belonging to this enrollment** → `paid` (pay-now, or a pay-later that
 * already auto-charged); else an open `invoices` row → `pay-later`
 * (card-backed, auto-charges at due_at); else `pending` (an async/3DS charge
 * not yet settled — rare). The enrollment itself is the live, non-cancelled
 * group-class bookings.
 *
 * **"Belonging to this enrollment" is the correction of 2026-08-22**
 * (ADDENDUM 3 §A3.17). It used to mean ANY succeeded charge for the (cohort,
 * dog) — not even remainder-checked — and a (cohort, dog) is not an
 * enrollment: withdraw + re-enroll mints a second one under the same key, so a
 * re-enrolled dog resting on an uncaptured hold showed `paid` off the previous
 * enrollment's money. The enum values and the wire shape are unchanged; what
 * changed is that the documented meaning became true. (Remainder-awareness —
 * `paid` for a live enrollment refunded out of band — stays OUT of scope:
 * portal surface, Adjudication 8.)
 */

export type EnrollmentPaymentStatus = 'paid' | 'pay-later' | 'pending';

export interface EnrollmentRow {
  cohortId: string;
  dogId: string;
  classKey: string;
  className: string;
  location: string;
  startDate: string;
  weeklyTime: string | null;
  weeks: number;
  firstSessionAt: string;
  paymentStatus: EnrollmentPaymentStatus;
}

const ENROLLMENT_ROW_SCHEMA = z.object({
  cohort_id: z.string().uuid(),
  dog_id: z.string().uuid(),
  class_key: z.string(),
  class_name: z.string(),
  location: z.string(),
  start_date: z.string(),
  weekly_time: z.string().nullable(),
  weeks: z.number(),
  first_session_at: z.string(),
  payment_status: z.enum(['paid', 'pay-later', 'pending']),
});

export const enrollmentsRepository = {
  async listForOwner(ownerId: string): Promise<EnrollmentRow[]> {
    const result = await db.execute(sql`
      SELECT DISTINCT ON (b.cohort_id, b.lead_dog_id)
        b.cohort_id,
        b.lead_dog_id AS dog_id,
        c.class_key,
        gc.name        AS class_name,
        c.location,
        c.start_date,
        c.weekly_time,
        c.weeks,
        (
          SELECT min(b2.scheduled_at)
          FROM bookings b2
          WHERE b2.cohort_id = b.cohort_id
            AND b2.lead_dog_id = b.lead_dog_id
            AND b2.status <> 'cancelled'
            AND b2.expired_at IS NULL
        ) AS first_session_at,
        CASE
          WHEN EXISTS (
            SELECT 1 FROM charges ch
            WHERE ch.cohort_id = b.cohort_id AND ch.dog_id = b.lead_dog_id
              AND ch.status = 'succeeded'
              -- The enrollment-membership rule (ADDENDUM 3 §A3.17), in SQL:
              -- the charge's ANCHOR is one of THIS enrollment's live rows, or
              -- (legacy, NULL anchor) it was minted at or after this
              -- enrollment's birth. Without it, a re-enrolled dog whose money
              -- is an uncaptured hold read 'paid' off the PREVIOUS
              -- enrollment's charge — and mobile branches its withdraw
              -- confirm-dialog money sentence on this field.
              AND (
                EXISTS (
                  SELECT 1 FROM bookings anchor
                  WHERE anchor.id = ch.booking_id
                    AND anchor.cohort_id = b.cohort_id
                    AND anchor.lead_dog_id = b.lead_dog_id
                    AND anchor.status <> 'cancelled'
                    AND anchor.expired_at IS NULL
                )
                OR (
                  ch.booking_id IS NULL
                  AND ch.created_at >= (
                    SELECT min(born.created_at) FROM bookings born
                    WHERE born.cohort_id = b.cohort_id
                      AND born.lead_dog_id = b.lead_dog_id
                      AND born.status <> 'cancelled'
                      AND born.expired_at IS NULL
                  )
                )
              )
          ) THEN 'paid'
          WHEN EXISTS (
            SELECT 1 FROM invoices iv
            WHERE iv.cohort_id = b.cohort_id AND iv.dog_id = b.lead_dog_id
              AND iv.status = 'open'
          ) THEN 'pay-later'
          ELSE 'pending'
        END AS payment_status
      FROM bookings b
      JOIN cohorts c        ON c.id = b.cohort_id
      JOIN group_classes gc ON gc.key = c.class_key
      WHERE b.owner_id = ${ownerId}
        AND b.category = 'group-class'
        AND b.status <> 'cancelled'
        AND b.expired_at IS NULL
      ORDER BY b.cohort_id, b.lead_dog_id, c.start_date
    `);

    return ENROLLMENT_ROW_SCHEMA.array()
      .parse(result.rows)
      .map((r) => ({
        cohortId: r.cohort_id,
        dogId: r.dog_id,
        classKey: r.class_key,
        className: r.class_name,
        location: r.location,
        startDate: r.start_date,
        weeklyTime: r.weekly_time,
        weeks: r.weeks,
        firstSessionAt: r.first_session_at,
        paymentStatus: r.payment_status,
      }));
  },
};
