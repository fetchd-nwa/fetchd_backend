import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import { hashRequestBody, requireIdempotencyKey, withMutation } from '../db/mutation.js';
import { lockCohort } from '../db/locks.js';
import { bookingsRepository } from '../db/repositories/bookingsRepository.js';
import { chargesRepository, type ChargeStatus } from '../db/repositories/chargesRepository.js';
import { cohortsRepository } from '../db/repositories/cohortsRepository.js';
import { dogCompletedClassesRepository } from '../db/repositories/dogCompletedClassesRepository.js';
import { dogsRepository } from '../db/repositories/dogsRepository.js';
import {
  enrollmentsRepository,
  type EnrollmentPaymentStatus,
} from '../db/repositories/enrollmentsRepository.js';
import { groupClassesRepository } from '../db/repositories/groupClassesRepository.js';
import { invoicesRepository } from '../db/repositories/invoicesRepository.js';
import { refundsRepository } from '../db/repositories/refundsRepository.js';
import {
  alreadyEnrolledError,
  cohortFullError,
  eligibilityMissingError,
  type EligibilityGap,
} from '../lib/bookingErrors.js';
import { checkBookingGates } from '../lib/bookingGatePreCheck.js';
import { enqueueBookingReminders } from '../lib/enqueueBookingReminders.js';
import { insertBookingWithGateMapping } from '../lib/insertBookingWithGateMapping.js';
import { computeCohortSessionDates } from '../lib/cohortSchedule.js';
import { toBookingWire, type BookingWire } from '../lib/bookingWire.js';
import { cancelWindowSettingsRepository } from '../db/repositories/cancelWindowSettingsRepository.js';
import { computeCancelDeadlineFromHours } from '../lib/cancelWindow.js';
import { ApiError } from '../lib/errors.js';
import { loadStripePaymentContext } from '../lib/loadStripePaymentContext.js';
import { pgTimestampToDate } from '../lib/pgTimestamp.js';
import { requireOwner } from '../lib/principalNarrows.js';
import {
  defaultStripeClient,
  stripeIntentStatusToChargeStatus,
  type StripeClient,
} from '../lib/stripe.js';
import { parseOrThrow } from '../lib/zodIssues.js';

/**
 * `POST /enrollments` `[auth]` — Day 11 cohort enrollment.
 *
 * Group-class enrollment is structurally distinct from day-program
 * booking (POST /bookings) and lives in its own route file per §C.1
 * Model 2 ("Never POST /bookings" for group-class). One transaction
 * materializes `len(dog_ids) × cohort.weeks` booking rows under a
 * cohort row lock + bumps `cohorts.filled` atomically.
 *
 * The transaction protocol (matches schema.sql ~line 1298):
 *   1. Ownership gate per dog (`dogsRepository.findOwnedExists`).
 *   2. `lockCohort(tx, cohort_id)` — `SELECT ... FOR UPDATE` on the
 *      cohort row. All concurrent enrollments to this cohort
 *      serialize here.
 *   3. Liveness check — `expiredAt !== null` → 404 (soft-expired
 *      cohort = "no such cohort" for enrollment purposes).
 *   4. Capacity assertion — `filled + |dog_ids| > capacity` → 422
 *      `cohort_full` with structured details.
 *   5. R7 eligibility — per dog, check OR-prereq options (Day-6a's
 *      `class_prereq_options`). Any dog missing a satisfier → 422
 *      `eligibility_missing` with per-dog gap detail.
 *   6. Gate pre-check above the trigger floor — payment (owner once)
 *      → vaccine (per dog, since each dog will be a lead in its own
 *      bookings) → agreement (owner once, against `group-class`).
 *      Same priority order as Day-10 (rule-of-two; extract at
 *      rule-of-three on Day 12).
 *   7. Materialize per-week scheduled_at via `computeCohortSessionDates`
 *      (DST-preserving Chicago wall-time cadence). For each dog × week,
 *      INSERT a single-dog booking + booking_dogs. Trigger fallback maps
 *      race-induced gate violations via `gateTriggerErrorToApiError`.
 *   8. `cohortsRepository.bumpFilled(tx, cohort_id, +|dog_ids|)` under
 *      the held row lock.
 *   9. Payment (Δ 2026-06-09), per dog — group-class is money-paid, not
 *      credit-paid. Pay-now: a Stripe PaymentIntent per dog is confirmed
 *      BEFORE this tx (a declined card blocks enrollment); this step writes
 *      the succeeded `charges` rows (cohort_id + dog_id stamped). Pay-later:
 *      a card-backed open `invoices` row per dog due 24h before the first
 *      session — the auto-charge worker bills it then. Withdrawing before the
 *      first session refunds the charge / voids the open invoice.
 *  10. Post-commit: no cache invalidation today (the cohort catalog
 *      cache is keyed by class_key, not cohort id, and a `filled`
 *      bump doesn't change the catalog wire shape). Day-19 staff
 *      cohort edits will add `cohorts:*` patterns.
 *
 * Body: `{ cohort_id: uuid, dog_ids: uuid[], payment_method_id: uuid,
 *   pay_later?: boolean }`. Returns 201 + `BookingWire[]` length =
 *   `|dog_ids| × cohort.weeks`, ASC by scheduled_at then dog_id.
 *
 * Owner-only. Staff principals get 403 — the Day-19 staff portal will
 * surface cohort enrollments via the cohort detail screen but never
 * via this endpoint.
 *
 * Duplicate-enrollment guard (Day-19d, step 3b): a `(cohort_id,
 * lead_dog_id)` live-bookings check runs under the cohort lock — a dog
 * already enrolled (non-cancelled bookings in this cohort) is rejected
 * with `already_enrolled` 422. Cancelled bookings are excluded, so
 * "re-enroll after cancel" works. Idempotency still replays the exact
 * retry; the guard catches two distinct enroll attempts.
 */

/**
 * Body cap on dogs per enrollment request. Matches Day-10's same-named
 * limit on POST /bookings — a hostile body bounded BEFORE we touch the
 * DB. Five is the realistic ceiling (NWA's three-dog households
 * dominate; 5 covers every plausible household).
 */
const MAX_DOGS_PER_REQUEST = 5;

/**
 * Pay-later auto-charge lead time (Δ 2026-06-09): a card-backed open invoice
 * is created with `due_at = cohort_start − 24h`, and the existing invoice
 * auto-charge worker charges it then. Unenrolling before that voids the
 * invoice, so a pay-later that's withdrawn early is never charged.
 */
const GROUP_CLASS_AUTOCHARGE_LEAD_MS = 24 * 60 * 60 * 1000;

const postEnrollmentBodySchema = z
  .object({
    cohort_id: z.string().uuid(),
    dog_ids: z.array(z.string().uuid()).min(1).max(MAX_DOGS_PER_REQUEST),
    payment_method_id: z.string().uuid('payment_method_id must be a UUID'),
    // pay-now (the default) charges each dog's card immediately; pay-later
    // defers to the auto-charge worker 24h before the first session.
    pay_later: z.boolean().optional(),
  })
  .strict();

type PostEnrollmentBody = z.infer<typeof postEnrollmentBodySchema>;

export interface EnrollmentsRouteOptions extends AuthRouteOptions {
  /** Stripe seam (Δ 2026-06-09 pay-now / withdraw refund). Tests inject a stub. */
  stripe?: StripeClient;
  /**
   * Injectable clock for the withdraw "class hasn't started yet" guard, so a
   * contract test gets a deterministic now vs the fixture cohort start dates.
   * Default = `new Date()`.
   */
  now?: () => Date;
}

const cohortIdParamSchema = z.object({ cohortId: z.string().uuid('cohortId must be a UUID') });
const withdrawBodySchema = z.object({ dog_id: z.string().uuid('dog_id must be a UUID') }).strict();

export function registerEnrollmentsRoute(
  app: FastifyInstance,
  opts: EnrollmentsRouteOptions = {},
): void {
  const authHook = resolveAuthHook(opts);
  const stripe = opts.stripe ?? defaultStripeClient;
  const nowFactory = opts.now ?? ((): Date => new Date());

  app.post(
    '/enrollments',
    { preHandler: [authHook] },
    async (request, reply): Promise<BookingWire[]> => {
      const principal = requirePrincipal(request);
      requireOwner(principal, 'enroll dogs in a cohort');
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
      const body = parseOrThrow(postEnrollmentBodySchema, request.body, 'body');
      const parsed = validateEnrollmentBody(body);
      // Deterministic dog order: pre-tx Stripe charges + in-tx booking rows
      // iterate the same sorted list (stable ids + matching charge↔booking pairs).
      const sortedDogIds = [...parsed.dogIds].sort();

      // ── Pre-tx: per-dog price + (pay-now) Stripe charges OUTSIDE the tx ──
      // The amount is server-authoritative (the class's per-dog price), never
      // client-passed. Pay-now confirms each dog's PaymentIntent BEFORE the
      // enroll tx so a declined card blocks enrollment; the tx writes the
      // charge rows referencing these intents. Pay-later skips Stripe entirely
      // (the auto-charge worker bills the open invoice at due_at).
      const amountPerDogCents = await resolvePerDogPriceCents(parsed.cohortId);
      // Pay-now confirms each dog's card BEFORE the enroll tx (a long Stripe
      // call can't pin a tx open; a declined card must block enrollment). To
      // keep that safe, EVERY failure between the charge and a COMMITTED
      // enrollment unwinds the captured money — chargeEachDogNow self-unwinds a
      // partial multi-dog charge, and the try below covers the not-succeeded
      // guard + the enroll tx rolling back (cohort filled in the race, a gate
      // flipped, a trigger fired). Before this (2026-07-18) a rolled-back tx
      // stranded the pre-charged money with no charge row and no refund.
      const paidIntents = parsed.payLater
        ? []
        : await chargeEachDogNow({
            stripe,
            ownerId: principal.ownerId,
            paymentMethodId: parsed.paymentMethodId,
            cohortId: parsed.cohortId,
            dogIds: sortedDogIds,
            amountPerDogCents,
            idempotencyKey,
            log: request.log,
          });

      try {
        // A pay-now intent that confirmed but did NOT reach 'succeeded'
        // (off-session 3DS / processing) must not enroll — unwind + fail rather
        // than write a non-succeeded charge row and enroll the dog anyway.
        if (paidIntents.some((intent) => intent.status !== 'succeeded')) {
          throw new ApiError(
            'payment_required',
            'the card charge did not complete — no dogs were enrolled',
          );
        }

        const outcome = await withMutation<BookingWire[]>(
          {
            principal,
            idempotencyKey,
            endpoint: 'POST /enrollments',
            requestHash: hashRequestBody(body),
            // Day-11 mutations don't touch any cache key in §3 today.
            // Day-19 staff-portal cohort edits will be the first writers
            // to `cohorts:*` patterns; this declaration is the
            // cache-invalidation-lint convention seam (Day-10 polish).
            keysToInvalidate: () => [],
          },
          async (tx) => {
            // 1. Ownership gate — every requested dog must belong to the
            //    principal. Same response for "not owned" vs "doesn't
            //    exist" so dog ids can't enumerate across owners.
            for (const dogId of parsed.dogIds) {
              const exists = await dogsRepository.findOwnedExists(dogId, principal.ownerId, tx);
              if (!exists) {
                throw new ApiError('not_found', `dog ${dogId} not found`);
              }
            }

            // 2. Cohort row lock — all concurrent enrollments to this
            //    cohort serialize here. Lock held until commit/rollback.
            const cohortRow = await lockCohort(tx, parsed.cohortId);

            // 3. Liveness — undefined = id doesn't exist; `expiredAt !==
            //    null` = soft-expired. Both surface as 404 (the cohort
            //    doesn't exist for enrollment purposes).
            if (cohortRow === undefined || cohortRow.expiredAt !== null) {
              throw new ApiError('not_found', `cohort ${parsed.cohortId} not found`);
            }

            // 3b. Duplicate guard (Day-19d) — a dog already enrolled in this
            //     cohort (live, non-cancelled bookings) can't re-enroll.
            //     Checked under the cohort lock so a concurrent enroll can't
            //     slip a duplicate past it (closes the Day-11 caveat).
            const alreadyEnrolled = await bookingsRepository.findEnrolledDogsInCohort(
              tx,
              parsed.cohortId,
              parsed.dogIds,
            );
            if (alreadyEnrolled.length > 0) {
              throw alreadyEnrolledError({ cohort_id: parsed.cohortId, dog_ids: alreadyEnrolled });
            }

            // 4. Capacity assertion against the LOCKED snapshot. Schema
            //    CHECK `filled <= capacity` is the unbypassable floor;
            //    this is the friendly route-layer surface with structured
            //    details for FE deep-linking.
            const requested = parsed.dogIds.length;
            if (cohortRow.filled + requested > cohortRow.capacity) {
              throw cohortFullError({
                cohort_id: cohortRow.id,
                capacity: cohortRow.capacity,
                filled: cohortRow.filled,
                requested,
              });
            }

            // 5. R7 eligibility — server-derived prereqs. Empty options
            //    array = no prereqs, everyone passes. Otherwise each dog
            //    must have a live `dog_completed_classes` row matching
            //    at least one of the OR alternatives.
            const prereqOptions = await groupClassesRepository.findPrereqOptionsForClass(
              cohortRow.classKey,
            );
            if (prereqOptions.length > 0) {
              const eligibilityGaps: EligibilityGap[] = [];
              for (const dogId of parsed.dogIds) {
                const completed = await dogCompletedClassesRepository.findCompletedKeysForDogInTx(
                  tx,
                  dogId,
                );
                const completedSet = new Set(completed);
                const hasAny = prereqOptions.some((opt) => completedSet.has(opt));
                if (!hasAny) {
                  eligibilityGaps.push({
                    dog_id: dogId,
                    missing_alternatives: prereqOptions,
                  });
                }
              }
              if (eligibilityGaps.length > 0) throw eligibilityMissingError(eligibilityGaps);
            }

            // 6. Gate pre-check above the trigger floor. Same priority
            //    order as Day-10 (payment → vaccine → agreement). Vaccine
            //    gate is per-dog because each dog will be a lead dog in
            //    its own bookings, and the BEFORE-INSERT trigger checks
            //    NEW.lead_dog_id's vaccines.
            await checkBookingGates(tx, {
              ownerId: principal.ownerId,
              dogIds: parsed.dogIds,
              category: 'group-class',
              // Threads the cohort's class into the vaccine gate so class-key-
              // exempt requirements are skipped (puppy classes: no rabies yet).
              groupClassKey: cohortRow.classKey,
            });

            // 7. Materialize per-week scheduled_at (DST-preserving Chicago
            //    wall-time cadence). For each (dog × week) pair, INSERT
            //    a single-dog booking. Trigger fallback wraps the INSERT
            //    so a concurrent gate state-change between pre-check and
            //    insert surfaces as a typed ApiError.
            const startInstant = pgTimestampToDate(cohortRow.startDate);
            const sessionDates = computeCohortSessionDates(startInstant, cohortRow.weeks);
            // `sortedDogIds` (handler scope) gives deterministic id sequences
            // across runs (matches the Day-10 dog-sort convention) and pairs each
            // pay-now charge with its dog.

            // Resolve free-cancel hours ONCE for the whole enrollment — all
            // group-class sessions share the same category, so the policy
            // is invariant across the loop. Stamping the same resolved
            // deadline per session keeps the per-week semantics honest
            // (each weekly session has its own deadline, but computed off
            // the same per-category policy snapshot).
            const groupClassHours = await cancelWindowSettingsRepository.resolveHoursFor(
              'group-class',
              tx,
            );
            const insertedWires: BookingWire[] = [];
            for (const scheduledAt of sessionDates) {
              const cancelDeadlineAt = computeCancelDeadlineFromHours(scheduledAt, groupClassHours);
              for (const dogId of sortedDogIds) {
                const inserted = await insertBookingWithGateMapping(tx, {
                  ownerId: principal.ownerId,
                  leadDogId: dogId,
                  category: 'group-class',
                  scheduledAt,
                  location: cohortRow.location,
                  notes: null,
                  cancelDeadlineAt,
                  additionalDogIds: [],
                  cohortId: cohortRow.id,
                  // Day-11: session_report_id is NULL at enrollment time. Day-19
                  // staff portal "author report" verb creates the report row
                  // and links it back to every weekly booking for the (cohort,
                  // dog) via `bookings.session_report_id`.
                  sessionReportId: null,
                });
                // Day-16: enqueue the per-session reminder. Per-dog × per-
                // session × per-cohort means N×W rows for an enrollment;
                // each gets its own UNIQUE dedupe_key (booking_id-scoped).
                await enqueueBookingReminders(tx, {
                  bookingId: inserted.id,
                  ownerId: principal.ownerId,
                  leadDogId: dogId,
                  category: 'group-class',
                  scheduledAt,
                });
                insertedWires.push(
                  toBookingWire(
                    inserted,
                    { lead: dogId, additional: [] },
                    null /* group-class bookings carry no trainer */,
                  ),
                );
              }
            }

            // 8. `filled` counter bump — atomic under the row lock.
            //    Day-11 is owner-only so every dog_id counts (capacity-
            //    exempt staff dogs deferred until staff enrollment is a
            //    real use case).
            await cohortsRepository.bumpFilled(tx, cohortRow.id, requested);

            // 9. Payment rows, per dog (Δ 2026-06-09 — group-class is paid
            //    per-(cohort, dog) so a single dog can be withdrawn + refunded).
            //    Pay-now: a succeeded `charges` row per pre-confirmed intent (shows
            //    in the billing ledger immediately). Pay-later: a card-backed open
            //    `invoices` row due 24h before the first session — the auto-charge
            //    worker bills it then; withdrawing earlier voids it (never charged).
            if (parsed.payLater) {
              const dueAt = new Date(
                pgTimestampToDate(cohortRow.startDate).getTime() - GROUP_CLASS_AUTOCHARGE_LEAD_MS,
              ).toISOString();
              for (const dogId of sortedDogIds) {
                await invoicesRepository.createOpen(tx, {
                  ownerId: principal.ownerId,
                  amountCents: amountPerDogCents,
                  purpose: 'group-class',
                  paymentMethodId: parsed.paymentMethodId,
                  dueAt,
                  cohortId: cohortRow.id,
                  dogId,
                });
              }
            } else {
              for (const intent of paidIntents) {
                await chargesRepository.create(tx, {
                  ownerId: principal.ownerId,
                  amountCents: intent.amountCents,
                  status: intent.status,
                  purpose: 'group-class',
                  stripePaymentIntentId: intent.intentId,
                  cohortId: cohortRow.id,
                  dogId: intent.dogId,
                });
              }
            }

            return { status: 201, body: insertedWires };
          },
        );

        reply.code(outcome.status);
        return outcome.body;
      } catch (err) {
        // Money was captured but the enrollment did not commit — refund/cancel
        // it all so nothing is stranded, then re-raise the original error so the
        // owner still gets the right 4xx (cohort_full, eligibility_missing, …).
        await unwindCapturedIntents(stripe, paidIntents, idempotencyKey, request.log);
        throw err;
      }
    },
  );

  // --- GET /enrollments -------------------------------------------------
  //
  // The owner's current group-class enrollments — one row per live (cohort,
  // dog) pairing, for the mobile "Currently enrolled" section. `can_withdraw`
  // mirrors the withdraw verb's guard (self-serve withdraw is allowed until the
  // first session starts); the verb re-checks it authoritatively under the lock.
  app.get(
    '/enrollments',
    { preHandler: [authHook] },
    async (request): Promise<EnrollmentWire[]> => {
      const principal = requirePrincipal(request);
      requireOwner(principal, 'list enrollments');
      const rows = await enrollmentsRepository.listForOwner(principal.ownerId);
      const nowMs = nowFactory().getTime();
      return rows.map((row) => toEnrollmentWire(row, nowMs));
    },
  );

  // --- POST /enrollments/:cohortId/withdraw -----------------------------
  //
  // Per-dog unenroll (Δ 2026-06-09). Under the cohort lock: guard the class
  // hasn't started, soft-cancel that dog's weekly bookings, decrement
  // `cohorts.filled`, then settle the money — an unpaid pay-later open invoice
  // is VOIDED (never charged); a succeeded charge (pay-now, or a pay-later that
  // already auto-charged) is REFUNDED (refunds row at 'pending' + post-commit
  // Stripe refund, mirroring the booking-cancel money-back branch).
  app.post(
    '/enrollments/:cohortId/withdraw',
    { preHandler: [authHook] },
    async (request, reply): Promise<{ withdrawn: true; refunded_cents: number }> => {
      const principal = requirePrincipal(request);
      requireOwner(principal, 'withdraw from a cohort');
      const { cohortId } = parseOrThrow(cohortIdParamSchema, request.params, 'path');
      const { dog_id: dogId } = parseOrThrow(withdrawBodySchema, request.body, 'body');
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);

      // Closure handle for the post-commit Stripe refund (money-back branch);
      // undefined for the void / free paths (postCommit no-ops).
      let pendingStripeRefund:
        | { refundId: string; paymentIntentId: string; amountCents: number }
        | undefined;

      const outcome = await withMutation<{ withdrawn: true; refunded_cents: number }>(
        {
          principal,
          idempotencyKey,
          endpoint: 'POST /enrollments/:cohortId/withdraw',
          requestHash: hashRequestBody({ cohortId, dogId }),
          keysToInvalidate: () => [],
          postCommit: async () => {
            if (pendingStripeRefund === undefined) return;
            const result = await stripe.createRefund(
              {
                paymentIntentId: pendingStripeRefund.paymentIntentId,
                amountCents: pendingStripeRefund.amountCents,
                reason: 'requested_by_customer',
              },
              `${idempotencyKey}:refund`,
            );
            await refundsRepository.markStripeId({
              id: pendingStripeRefund.refundId,
              stripeRefundId: result.id,
            });
          },
        },
        async (tx) => {
          // 1. Lock the cohort — serialize against concurrent enroll/withdraw
          //    so the `filled` decrement is race-free. 404 collapses gone +
          //    soft-expired.
          const cohortRow = await lockCohort(tx, cohortId);
          if (cohortRow === undefined || cohortRow.expiredAt !== null) {
            throw new ApiError('not_found', `cohort ${cohortId} not found`);
          }

          // 2. Ownership — the dog must belong to the principal (same 404 for
          //    "not owned" vs "doesn't exist").
          const owned = await dogsRepository.findOwnedExists(dogId, principal.ownerId, tx);
          if (!owned) {
            throw new ApiError('not_found', `dog ${dogId} not found`);
          }

          // 3. The dog's live weekly bookings in this cohort. None → not enrolled.
          const enrolledBookings = await bookingsRepository.findLiveBookingsForCohortDog(
            tx,
            cohortId,
            dogId,
          );
          if (enrolledBookings.length === 0) {
            throw new ApiError('conflict', `dog ${dogId} is not enrolled in cohort ${cohortId}`);
          }

          // 4. Pre-start guard — self-serve withdraw closes once the first
          //    session has started (staff can still cancel via the portal).
          const firstSessionMs = new Date(enrolledBookings[0]!.scheduledAt).getTime();
          if (nowFactory().getTime() >= firstSessionMs) {
            throw new ApiError(
              'conflict',
              'this class has already started — contact us to withdraw',
            );
          }

          // 5. Soft-cancel every weekly booking + release the cohort seat.
          for (const booking of enrolledBookings) {
            await bookingsRepository.markCancelled(tx, booking.id);
          }
          await cohortsRepository.bumpFilled(tx, cohortId, -1);

          // 6. Settle the money. Void an unpaid pay-later invoice (never
          //    charged); refund a succeeded charge (pay-now / already-charged
          //    pay-later). Exactly one of the two matches an enrollment.
          let refundedCents = 0;
          const openInvoice = await invoicesRepository.findOpenForCohortDog(tx, {
            cohortId,
            dogId,
          });
          // markVoid only touches rows still 'open' and returns the count. If
          // the auto-charge worker settled the invoice between findOpen and
          // here (0 voided), fall through to the refund path — otherwise a
          // now-CHARGED invoice would be left un-refunded (the #2 race bug).
          const voidedCount =
            openInvoice !== undefined
              ? await invoicesRepository.markVoid(tx, { id: openInvoice.id })
              : 0;
          if (voidedCount === 0) {
            const charge = await chargesRepository.findSucceededForCohortDog(tx, {
              cohortId,
              dogId,
            });
            if (charge !== undefined && charge.stripePaymentIntentId !== null) {
              const alreadyRefunded = await refundsRepository.sumNonFailedForCharge(tx, charge.id);
              const maxRefund = charge.amountCents - alreadyRefunded;
              if (maxRefund > 0) {
                const refund = await refundsRepository.createPending(tx, {
                  ownerId: principal.ownerId,
                  chargeId: charge.id,
                  bookingId: null,
                  amountCents: maxRefund,
                  reason: 'cancel',
                });
                pendingStripeRefund = {
                  refundId: refund.id,
                  paymentIntentId: charge.stripePaymentIntentId,
                  amountCents: maxRefund,
                };
                refundedCents = maxRefund;
              }
            }
          }

          return { status: 200, body: { withdrawn: true, refunded_cents: refundedCents } };
        },
      );

      reply.code(outcome.status);
      return outcome.body;
    },
  );
}

// ---- helpers ---------------------------------------------------------

/**
 * The "Currently enrolled" wire row. `payment_status` is `paid` (charged) /
 * `pay-later` (card-backed open invoice, auto-charges before the first session)
 * / `pending` (async charge not yet settled). `can_withdraw` is the self-serve
 * window — true until the first session's instant.
 */
export interface EnrollmentWire {
  cohort_id: string;
  dog_id: string;
  class_key: string;
  class_name: string;
  location: string;
  start_date: string;
  weekly_time: string | null;
  weeks: number;
  first_session_at: string;
  payment_status: EnrollmentPaymentStatus;
  can_withdraw: boolean;
}

function toEnrollmentWire(
  row: Awaited<ReturnType<typeof enrollmentsRepository.listForOwner>>[number],
  nowMs: number,
): EnrollmentWire {
  return {
    cohort_id: row.cohortId,
    dog_id: row.dogId,
    class_key: row.classKey,
    class_name: row.className,
    location: row.location,
    start_date: row.startDate,
    weekly_time: row.weeklyTime,
    weeks: row.weeks,
    first_session_at: row.firstSessionAt,
    payment_status: row.paymentStatus,
    can_withdraw: new Date(row.firstSessionAt).getTime() > nowMs,
  };
}

/**
 * Cross-field invariants Zod doesn't express cleanly: dog_ids must be
 * distinct (the same dog enrolling twice in one body is the same
 * defect from the user's POV as a duplicate in the array). UUID
 * formatting + per-element validation is already handled by the Zod
 * schema; this layer is only the structural assertions.
 */
interface ValidatedEnrollmentBody {
  cohortId: string;
  dogIds: string[];
  paymentMethodId: string;
  payLater: boolean;
}

function validateEnrollmentBody(body: PostEnrollmentBody): ValidatedEnrollmentBody {
  const dogIdSet = new Set(body.dog_ids);
  if (dogIdSet.size !== body.dog_ids.length) {
    throw new ApiError('invalid_payload', 'dog_ids must contain distinct values');
  }
  return {
    cohortId: body.cohort_id,
    dogIds: body.dog_ids,
    paymentMethodId: body.payment_method_id,
    payLater: body.pay_later ?? false,
  };
}

/**
 * Server-authoritative per-dog price for a cohort's class (anti-scam: the FE
 * never passes the amount). Reads the cohort → its class's `price_per_dog_cents`.
 * 404 if the cohort is gone/soft-expired (the enroll tx re-checks under lock).
 */
async function resolvePerDogPriceCents(cohortId: string): Promise<number> {
  // Best-effort pre-tx read for the price; the enroll tx re-locks + re-checks
  // cohort liveness authoritatively (this only needs the per-dog amount).
  const cohort = await cohortsRepository.findById(cohortId);
  if (cohort === undefined) {
    throw new ApiError('not_found', `cohort ${cohortId} not found`);
  }
  const groupClass = await groupClassesRepository.findByKey(cohort.classKey);
  if (groupClass === undefined) {
    throw new ApiError('invalid_payload', `cohort ${cohortId} references an unknown class`);
  }
  return groupClass.pricePerDogCents;
}

interface PaidEnrollmentIntent {
  dogId: string;
  intentId: string;
  status: ChargeStatus;
  amountCents: number;
}

/**
 * Pay-now: confirm one PaymentIntent per dog OUTSIDE the enroll tx (a long
 * network call can't pin a tx open; a declined card throws here and blocks
 * enrollment). One intent per dog — not a single combined charge — so each
 * dog's enrollment can be refunded independently on withdraw. The per-dog
 * idempotency-key suffix keeps retries Stripe-deduped.
 */
async function chargeEachDogNow(args: {
  stripe: StripeClient;
  ownerId: string;
  paymentMethodId: string;
  cohortId: string;
  dogIds: readonly string[];
  amountPerDogCents: number;
  idempotencyKey: string;
  log: FastifyBaseLogger;
}): Promise<PaidEnrollmentIntent[]> {
  const ctx = await loadStripePaymentContext({
    ownerId: args.ownerId,
    paymentMethodId: args.paymentMethodId,
  });
  const intents: PaidEnrollmentIntent[] = [];
  try {
    for (const dogId of args.dogIds) {
      const intent = await args.stripe.createAndConfirmPaymentIntent(
        {
          customerId: ctx.stripeCustomerId,
          paymentMethodId: ctx.stripePaymentMethodId,
          amountCents: args.amountPerDogCents,
          currency: 'usd',
          metadata: {
            owner_id: args.ownerId,
            dog_id: dogId,
            cohort_id: args.cohortId,
            purpose: 'group-class',
          },
        },
        `${args.idempotencyKey}:dog:${dogId}`,
      );
      intents.push({
        dogId,
        intentId: intent.id,
        status: stripeIntentStatusToChargeStatus(intent.status),
        amountCents: intent.amountCents,
      });
    }
  } catch (err) {
    // A later dog's card threw mid-loop — unwind the EARLIER dogs' captured
    // charges so a partial multi-dog charge isn't stranded, then rethrow.
    await unwindCapturedIntents(args.stripe, intents, args.idempotencyKey, args.log);
    throw err;
  }
  return intents;
}

/**
 * Undo pay-now group-class charges when the enrollment doesn't commit (a
 * mid-loop card throw, a not-succeeded intent, or the enroll tx rolling back).
 * Succeeded intents are REFUNDED; not-yet-settled intents are CANCELLED so they
 * can't later auto-succeed and strand money. Best-effort per intent: a failed
 * unwind is logged loudly (captured money needing manual reconciliation) and
 * never masks the original enroll error.
 *
 * Residual (2026-07-18): a client that RETRIES with the same idempotency key
 * after a *transient* (non-business) tx failure re-confirms the same
 * now-refunded Stripe PI and could enroll on refunded money. Rare and
 * NWA-side; the complete fix is manual-capture (authorize pre-tx, capture in
 * postCommit, cancel on rollback) — deferred as a larger change.
 */
async function unwindCapturedIntents(
  stripe: StripeClient,
  intents: readonly PaidEnrollmentIntent[],
  idempotencyKey: string,
  log: FastifyBaseLogger,
): Promise<void> {
  for (const intent of intents) {
    try {
      if (intent.status === 'succeeded') {
        await stripe.createRefund(
          {
            paymentIntentId: intent.intentId,
            amountCents: intent.amountCents,
            reason: 'requested_by_customer',
          },
          `${idempotencyKey}:enroll-unwind:${intent.dogId}`,
        );
      } else {
        await stripe.cancelPaymentIntent(intent.intentId);
      }
    } catch (unwindErr) {
      log.error(
        { err: unwindErr, paymentIntentId: intent.intentId, dogId: intent.dogId },
        'group-class enroll unwind FAILED — captured money needs manual reconciliation',
      );
    }
  }
}
