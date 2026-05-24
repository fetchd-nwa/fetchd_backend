import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import { hashRequestBody, requireIdempotencyKey, withMutation } from '../db/mutation.js';
import { lockCohort } from '../db/locks.js';
import { cohortsRepository } from '../db/repositories/cohortsRepository.js';
import { dogCompletedClassesRepository } from '../db/repositories/dogCompletedClassesRepository.js';
import { dogsRepository } from '../db/repositories/dogsRepository.js';
import { groupClassesRepository } from '../db/repositories/groupClassesRepository.js';
import {
  cohortFullError,
  eligibilityMissingError,
  type EligibilityGap,
} from '../lib/bookingErrors.js';
import { checkBookingGates } from '../lib/bookingGatePreCheck.js';
import { insertBookingWithGateMapping } from '../lib/insertBookingWithGateMapping.js';
import { computeCohortSessionDates } from '../lib/cohortSchedule.js';
import { toBookingWire, type BookingWire } from '../lib/bookingWire.js';
import { computeCancelDeadline } from '../lib/cancelWindow.js';
import { ApiError } from '../lib/errors.js';
import { pgTimestampToDate } from '../lib/pgTimestamp.js';
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
 *   9. NO credit_ledger debit — group-class is paid per-purchase
 *      (Day 14), not per-credit.
 *  10. Post-commit: no cache invalidation today (the cohort catalog
 *      cache is keyed by class_key, not cohort id, and a `filled`
 *      bump doesn't change the catalog wire shape). Day-19 staff
 *      cohort edits will add `cohorts:*` patterns.
 *
 * Body shape per DATA-CONTRACT §C line 495 + §C.1 Model 2:
 *   `{ cohort_id: uuid, dog_ids: uuid[] }`
 * Returns 201 + `BookingWire[]` length = `|dog_ids| × cohort.weeks`,
 * ASC by scheduled_at then dog_id (stable across runs).
 *
 * Owner-only. Staff principals get 403 — the Day-19 staff portal will
 * surface cohort enrollments via the cohort detail screen but never
 * via this endpoint.
 *
 * Known caveat: duplicate-enrollment prevention is not enforced
 * server-side today. An owner enrolling the same dog into the same
 * cohort twice (deliberate race with two different Idempotency-Keys,
 * same body would replay) would create duplicate bookings. The FE
 * prevents the double-click case, idempotency catches the retry case;
 * a (cohort_id, lead_dog_id) live-bookings check inside the txn would
 * close the rare race. Deferred — flag for Day 13 (cancel) revisit
 * since "re-enroll after cancel" would interact.
 */

/**
 * Body cap on dogs per enrollment request. Matches Day-10's same-named
 * limit on POST /bookings — a hostile body bounded BEFORE we touch the
 * DB. Five is the realistic ceiling (NWA's three-dog households
 * dominate; 5 covers every plausible household).
 */
const MAX_DOGS_PER_REQUEST = 5;

const postEnrollmentBodySchema = z
  .object({
    cohort_id: z.string().uuid(),
    dog_ids: z.array(z.string().uuid()).min(1).max(MAX_DOGS_PER_REQUEST),
  })
  .strict();

type PostEnrollmentBody = z.infer<typeof postEnrollmentBodySchema>;

export type EnrollmentsRouteOptions = AuthRouteOptions;

export function registerEnrollmentsRoute(
  app: FastifyInstance,
  opts: EnrollmentsRouteOptions = {},
): void {
  const authHook = resolveAuthHook(opts);

  app.post(
    '/enrollments',
    { preHandler: [authHook] },
    async (request, reply): Promise<BookingWire[]> => {
      const principal = requirePrincipal(request);
      requireOwner(principal, 'enroll');
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
      const body = parseOrThrow(postEnrollmentBodySchema, request.body, 'body');
      const parsed = validateEnrollmentBody(body);

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
          });

          // 7. Materialize per-week scheduled_at (DST-preserving Chicago
          //    wall-time cadence). For each (dog × week) pair, INSERT
          //    a single-dog booking. Trigger fallback wraps the INSERT
          //    so a concurrent gate state-change between pre-check and
          //    insert surfaces as a typed ApiError.
          const startInstant = pgTimestampToDate(cohortRow.startDate);
          const sessionDates = computeCohortSessionDates(startInstant, cohortRow.weeks);
          // Iterate dogs in sorted order so multi-dog enrollments
          // produce deterministic id sequences across runs (matches
          // the Day-10 dog-sort convention for advisory-lock ordering).
          const sortedDogIds = [...parsed.dogIds].sort();

          const insertedWires: BookingWire[] = [];
          for (const scheduledAt of sessionDates) {
            const cancelDeadlineAt = computeCancelDeadline('group-class', scheduledAt);
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

          return { status: 201, body: insertedWires };
        },
      );

      reply.code(outcome.status);
      return outcome.body;
    },
  );
}

// ---- helpers ---------------------------------------------------------

/**
 * Narrow the principal to owner. `[asserts]` predicate so subsequent
 * `principal.ownerId` reads compile without a cast. Mirrors the
 * `requireOwner` shape in `routes/bookings.ts` (rule-of-two — extract
 * to `lib/principalNarrows.ts` if Day 12 surfaces a third call site;
 * for now the literal-union action keeps both call sites local to
 * their route).
 */
function requireOwner(
  principal: ReturnType<typeof requirePrincipal>,
  action: 'enroll',
): asserts principal is { kind: 'owner'; ownerId: string; supabaseUid: string } {
  if (principal.kind !== 'owner') {
    throw new ApiError('forbidden', `only owners may ${action} dogs in a cohort`);
  }
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
}

function validateEnrollmentBody(body: PostEnrollmentBody): ValidatedEnrollmentBody {
  const dogIdSet = new Set(body.dog_ids);
  if (dogIdSet.size !== body.dog_ids.length) {
    throw new ApiError('invalid_payload', 'dog_ids must contain distinct values');
  }
  return {
    cohortId: body.cohort_id,
    dogIds: body.dog_ids,
  };
}
