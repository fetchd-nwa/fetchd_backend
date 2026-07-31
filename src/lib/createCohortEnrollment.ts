import type { FastifyBaseLogger } from 'fastify';
import { lockCohort } from '../db/locks.js';
import { bookingsRepository } from '../db/repositories/bookingsRepository.js';
import { cancelWindowSettingsRepository } from '../db/repositories/cancelWindowSettingsRepository.js';
import { chargesRepository, type ChargeStatus } from '../db/repositories/chargesRepository.js';
import { cohortsRepository } from '../db/repositories/cohortsRepository.js';
import { dogCompletedClassesRepository } from '../db/repositories/dogCompletedClassesRepository.js';
import { groupClassesRepository } from '../db/repositories/groupClassesRepository.js';
import { invoicesRepository } from '../db/repositories/invoicesRepository.js';
import {
  alreadyEnrolledError,
  cohortFullError,
  eligibilityMissingError,
  type EligibilityGap,
} from './bookingErrors.js';
import { checkBookingGates } from './bookingGatePreCheck.js';
import { toBookingWire, type BookingWire } from './bookingWire.js';
import { computeCancelDeadlineFromHours } from './cancelWindow.js';
import { computeCohortSessionDates } from './cohortSchedule.js';
import { enqueueBookingReminders } from './enqueueBookingReminders.js';
import { insertBookingWithGateMapping } from './insertBookingWithGateMapping.js';
import { loadStripePaymentContext } from './loadStripePaymentContext.js';
import { ApiError } from './errors.js';
import { pgTimestampToDate } from './pgTimestamp.js';
import { stripeIntentStatusToChargeStatus, type StripeClient } from './stripe.js';
import type { Tx } from '../db/tx.js';

/**
 * The group-class enrollment core — cohort row lock → liveness → duplicate
 * guard → capacity → R7 prereqs → gates → per-week booking rows → `filled`
 * bump → payment rows.
 *
 * Extracted from `POST /enrollments` (Day-11..Δ 2026-06-09) when the waitlist
 * gave it a second caller: `POST /waitlist/:id/accept` turns a cohort offer
 * into exactly this enrollment. Before the extraction that route threw
 * `conflict` unconditionally, because the sequence was inlined in the route and
 * the only alternative was a second copy that would drift on the next
 * enrollment rule — the same reason `lib/createDayProgramBookings.ts` was
 * extracted for the day programs.
 *
 * Callers own: body parsing/validation, ownership gates, idempotency
 * (`withMutation`), and the pre-tx Stripe money — a long network call must not
 * pin a transaction open, and a declined card must block the enrollment before
 * it starts. `chargeEachDogNow` / `unwindCapturedIntents` below are that
 * pre-tx half, shared by both callers so neither can get the unwind wrong.
 *
 * NOT extracted, deliberately: the cohort's start-time guard. `POST
 * /enrollments` has never refused to enroll into a cohort whose first session
 * has passed (only `withdraw` looks at the clock), so adding one here would be
 * a behaviour change to an endpoint this refactor is supposed to leave alone.
 */

/** A pay-now PaymentIntent confirmed before the enroll transaction. */
export interface PaidEnrollmentIntent {
  dogId: string;
  intentId: string;
  status: ChargeStatus;
  amountCents: number;
}

/**
 * How the enrollment is paid. Group-class is money-paid, never credit-paid
 * (Δ 2026-06-09), and it is paid per-(cohort, dog) so a single dog can be
 * withdrawn and refunded on its own.
 *
 *   - `pay-now`  — the intents the caller already confirmed; this writes the
 *     succeeded `charges` rows.
 *   - `pay-later` — a card-backed open `invoices` row per dog, due 24h before
 *     the first session; the auto-charge worker bills it then.
 */
export type CohortEnrollmentPayment =
  | { kind: 'pay-now'; intents: readonly PaidEnrollmentIntent[] }
  | { kind: 'pay-later'; paymentMethodId: string; amountPerDogCents: number };

export interface CreateCohortEnrollmentArgs {
  ownerId: string;
  cohortId: string;
  /** Every dog to enroll, lead-less (each dog leads its own weekly bookings). */
  dogIds: readonly string[];
  payment: CohortEnrollmentPayment;
}

/**
 * Pay-later auto-charge lead time (Δ 2026-06-09): a card-backed open invoice is
 * created with `due_at = cohort_start − 24h`, and the existing invoice
 * auto-charge worker charges it then. Unenrolling before that voids the
 * invoice, so a pay-later that's withdrawn early is never charged.
 */
const GROUP_CLASS_AUTOCHARGE_LEAD_MS = 24 * 60 * 60 * 1000;

/**
 * Materialize one enrollment inside the caller's transaction. Returns the
 * created weekly bookings, ASC by scheduled_at then dog_id (`|dogIds| ×
 * cohort.weeks` of them).
 */
export async function createCohortEnrollment(
  tx: Tx,
  args: CreateCohortEnrollmentArgs,
): Promise<BookingWire[]> {
  // Deterministic dog order: booking rows come out in a stable sequence across
  // runs (the Day-10 dog-sort convention). Pay-now charges pair with their dog
  // by the `dogId` on each intent, not by position, so this sort is free to
  // differ from the order the caller charged in.
  const dogIds = [...args.dogIds].sort();

  // 1. Cohort row lock — all concurrent enrollments to this cohort serialize
  //    here. Lock held until commit/rollback.
  const cohortRow = await lockCohort(tx, args.cohortId);

  // 2. Liveness — undefined = id doesn't exist; `expiredAt !== null` =
  //    soft-expired. Both surface as 404 (the cohort doesn't exist for
  //    enrollment purposes).
  if (cohortRow === undefined || cohortRow.expiredAt !== null) {
    throw new ApiError('not_found', `cohort ${args.cohortId} not found`);
  }

  // 3. Duplicate guard (Day-19d) — a dog already enrolled in this cohort (live,
  //    non-cancelled bookings) can't re-enroll. Checked under the cohort lock so
  //    a concurrent enroll can't slip a duplicate past it.
  const alreadyEnrolled = await bookingsRepository.findEnrolledDogsInCohort(
    tx,
    args.cohortId,
    dogIds,
  );
  if (alreadyEnrolled.length > 0) {
    throw alreadyEnrolledError({ cohort_id: args.cohortId, dog_ids: alreadyEnrolled });
  }

  // 4. Capacity assertion against the LOCKED snapshot. Schema CHECK `filled <=
  //    capacity` is the unbypassable floor; this is the friendly route-layer
  //    surface with structured details for FE deep-linking.
  //
  //    There is deliberately no `allowOverCapacity` escape here, unlike
  //    `createDayProgramBookings`: the cohort ceiling is that DB CHECK, not an
  //    API rule, so skipping this assertion would only move the failure to the
  //    `filled` bump below and turn a typed 422 into a constraint violation.
  //    A staff cap override on a group class means raising `cohorts.capacity`.
  const requested = dogIds.length;
  if (cohortRow.filled + requested > cohortRow.capacity) {
    throw cohortFullError({
      cohort_id: cohortRow.id,
      capacity: cohortRow.capacity,
      filled: cohortRow.filled,
      requested,
    });
  }

  // 5. R7 eligibility — server-derived prereqs. Empty options array = no
  //    prereqs, everyone passes. Otherwise each dog must have a live
  //    `dog_completed_classes` row matching at least one of the OR alternatives.
  const prereqOptions = await groupClassesRepository.findPrereqOptionsForClass(cohortRow.classKey);
  if (prereqOptions.length > 0) {
    const eligibilityGaps: EligibilityGap[] = [];
    for (const dogId of dogIds) {
      const completed = await dogCompletedClassesRepository.findCompletedKeysForDogInTx(tx, dogId);
      const completedSet = new Set(completed);
      const hasAny = prereqOptions.some((opt) => completedSet.has(opt));
      if (!hasAny) {
        eligibilityGaps.push({ dog_id: dogId, missing_alternatives: prereqOptions });
      }
    }
    if (eligibilityGaps.length > 0) throw eligibilityMissingError(eligibilityGaps);
  }

  // 6. Gate pre-check above the trigger floor. Same priority order as Day-10
  //    (payment → vaccine → agreement). Vaccine gate is per-dog because each dog
  //    will be a lead dog in its own bookings, and the BEFORE-INSERT trigger
  //    checks NEW.lead_dog_id's vaccines.
  await checkBookingGates(tx, {
    ownerId: args.ownerId,
    dogIds,
    category: 'group-class',
    // Threads the cohort's class into the vaccine gate so class-key-exempt
    // requirements are skipped (puppy classes: no rabies yet).
    groupClassKey: cohortRow.classKey,
  });

  // 7. Materialize per-week scheduled_at (DST-preserving Chicago wall-time
  //    cadence). For each (dog × week) pair, INSERT a single-dog booking.
  //    Trigger fallback wraps the INSERT so a concurrent gate state-change
  //    between pre-check and insert surfaces as a typed ApiError.
  const startInstant = pgTimestampToDate(cohortRow.startDate);
  const sessionDates = computeCohortSessionDates(startInstant, cohortRow.weeks);

  // Resolve free-cancel hours ONCE for the whole enrollment — all group-class
  // sessions share the same category, so the policy is invariant across the
  // loop. Stamping the same resolved deadline per session keeps the per-week
  // semantics honest (each weekly session has its own deadline, but computed
  // off the same per-category policy snapshot).
  const groupClassHours = await cancelWindowSettingsRepository.resolveHoursFor('group-class', tx);
  const insertedWires: BookingWire[] = [];
  for (const scheduledAt of sessionDates) {
    const cancelDeadlineAt = computeCancelDeadlineFromHours(scheduledAt, groupClassHours);
    for (const dogId of dogIds) {
      const inserted = await insertBookingWithGateMapping(tx, {
        ownerId: args.ownerId,
        leadDogId: dogId,
        category: 'group-class',
        scheduledAt,
        location: cohortRow.location,
        notes: null,
        cancelDeadlineAt,
        additionalDogIds: [],
        cohortId: cohortRow.id,
        // session_report_id is NULL at enrollment time. The staff portal's
        // "author report" verb creates the report row and links it back to
        // every weekly booking for the (cohort, dog).
        sessionReportId: null,
      });
      // Day-16: enqueue the per-session reminder. Per-dog × per-session ×
      // per-cohort means N×W rows for an enrollment; each gets its own UNIQUE
      // dedupe_key (booking_id-scoped).
      await enqueueBookingReminders(tx, {
        bookingId: inserted.id,
        ownerId: args.ownerId,
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

  // 8. `filled` counter bump — atomic under the row lock. Owner-only today, so
  //    every dog_id counts (capacity-exempt staff dogs deferred until staff
  //    enrollment is a real use case).
  await cohortsRepository.bumpFilled(tx, cohortRow.id, requested);

  // 9. Payment rows, per dog (Δ 2026-06-09). Pay-now: a succeeded `charges` row
  //    per pre-confirmed intent (shows in the billing ledger immediately).
  //    Pay-later: a card-backed open `invoices` row due 24h before the first
  //    session — the auto-charge worker bills it then; withdrawing earlier
  //    voids it (never charged).
  if (args.payment.kind === 'pay-later') {
    const dueAt = new Date(startInstant.getTime() - GROUP_CLASS_AUTOCHARGE_LEAD_MS).toISOString();
    for (const dogId of dogIds) {
      await invoicesRepository.createOpen(tx, {
        ownerId: args.ownerId,
        amountCents: args.payment.amountPerDogCents,
        purpose: 'group-class',
        paymentMethodId: args.payment.paymentMethodId,
        dueAt,
        cohortId: cohortRow.id,
        dogId,
      });
    }
  } else {
    for (const intent of args.payment.intents) {
      await chargesRepository.create(tx, {
        ownerId: args.ownerId,
        amountCents: intent.amountCents,
        status: intent.status,
        purpose: 'group-class',
        stripePaymentIntentId: intent.intentId,
        cohortId: cohortRow.id,
        dogId: intent.dogId,
      });
    }
  }

  return insertedWires;
}

/**
 * Server-authoritative per-dog price for a cohort's class (anti-scam: the FE
 * never passes the amount). Reads the cohort → its class's
 * `price_per_dog_cents`. 404 if the cohort is gone/soft-expired (the enroll tx
 * re-locks + re-checks cohort liveness authoritatively; this only needs the
 * per-dog amount).
 */
export async function resolvePerDogPriceCents(cohortId: string): Promise<number> {
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

/**
 * Pay-now: confirm one PaymentIntent per dog OUTSIDE the enroll tx (a long
 * network call can't pin a tx open; a declined card must throw here and block
 * enrollment). One intent per dog — not a single combined charge — so each
 * dog's enrollment can be refunded independently on withdraw. The per-dog
 * idempotency-key suffix keeps retries Stripe-deduped.
 */
export async function chargeEachDogNow(args: {
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
 * now-refunded Stripe PI and could enroll on refunded money. Rare and NWA-side;
 * the complete fix is manual-capture (authorize pre-tx, capture in postCommit,
 * cancel on rollback) — deferred as a larger change.
 */
export async function unwindCapturedIntents(
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

/**
 * The pay-now guard both callers run between charging and enrolling: an intent
 * that confirmed but did NOT reach 'succeeded' (off-session 3DS / processing)
 * must not enroll. The caller's catch unwinds the captured money.
 */
export function assertAllIntentsSucceeded(intents: readonly PaidEnrollmentIntent[]): void {
  if (intents.some((intent) => intent.status !== 'succeeded')) {
    throw new ApiError(
      'payment_required',
      'the card charge did not complete — no dogs were enrolled',
    );
  }
}
