import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import {
  deepLinkToPath,
  type PostStaffRequestsApproveRequest,
  type PostStaffRequestsDenyRequest,
  type StaffRequestWire,
} from '../contracts/wire.js';
import type { Equal, Expect } from '../contracts/typeAsserts.js';
import { hashRequestBody, requireIdempotencyKey, withMutation } from '../db/mutation.js';
import { dogsRepository } from '../db/repositories/dogsRepository.js';
import { requireStaff } from '../lib/principalNarrows.js';
import {
  requestsRepository,
  type PendingRequestFullRow,
} from '../db/repositories/requestsRepository.js';
import { notificationsRepository } from '../db/repositories/notificationsRepository.js';
import { staffRepository, type TrainerRow } from '../db/repositories/staffRepository.js';
import { LOCATION_SLUGS, requestStatus } from '../db/schema/schema.js';
import type { Tx } from '../db/tx.js';
import { boardTrainPriceCentsForLengthWeeks } from '../lib/boardTrainPricing.js';
import { ApiError } from '../lib/errors.js';
import { checkBookingGates } from '../lib/bookingGatePreCheck.js';
import { enqueueBookingReminders } from '../lib/enqueueBookingReminders.js';
import { insertBookingWithGateMapping } from '../lib/insertBookingWithGateMapping.js';
import { pgEnumTuple } from '../lib/pgEnumTuple.js';
import { pgTimestampToDate } from '../lib/pgTimestamp.js';
import {
  BOARD_TRAIN_WEEKS,
  assertNoRemovedDog,
  assertNoStayOverlap,
  chicagoDay,
  chicagoDayTime,
  dollars,
  lockRequestDogs,
  namedTrainer,
  trainerServes,
  type RequestServiceCategory,
} from '../lib/requestServices.js';
import { bucketToChicagoDate } from '../lib/chicagoDate.js';
import { groupRequestDogs, type PendingRequestWire } from '../lib/requestWire.js';
import { wireOneRequest } from '../lib/wireOneRequest.js';
import { sortRequestsBySubmittedAt } from '../lib/wireManyRequests.js';
import { wireStaffRequests } from '../lib/wireStaffRequests.js';
import type { LocationKey } from '../lib/bookingWire.js';
import { uuidId } from '../lib/uuidId.js';
import { parseOrThrow } from '../lib/zodIssues.js';

/**
 * `POST /staff/requests/:id/approve` `[staff]` and
 * `POST /staff/requests/:id/deny` `[staff]` — the Day-19 staff-portal
 * verb 1 family. The owner-side request CRUD lives in
 * `routes/requests.ts`; the URL surface here is structurally distinct
 * (`/staff/requests/*`) and the principal narrows differently
 * (`requireStaff` instead of `requireOwner`). Same shape decision Day-11
 * made for `routes/enrollments.ts` vs `routes/bookings.ts`.
 *
 * From 9.0.0 (plan unit P49; design request-services-v1 §2.2 A3, A7, A13; her 413,
 * 414): nothing is booked until staff approve. A private lesson is booked when staff
 * confirm one of her times; a Board & Train when staff approve dates and a trainer and
 * the family says yes (`routes/requestConfirm.ts`). No arm moves money: the bill after
 * the service is plan unit P51's.
 *
 * Approve transaction (DATA-CONTRACT §C.1 Model 3, schema.sql ~line 1307):
 *
 *   withMutation(staff principal) opens; withActor stamps app.actor
 *     1. lockById on pending_requests (row lock — concurrent approves, her edit, her
 *        Withdraw and her yes on the same request serialize here).
 *     2. assert exists + live — else 404.
 *     3. assert status='submitted' — else 409 `conflict` (idempotency
 *        catches replay; explicit state guard catches state-race).
 *     4. branch on category:
 *          board-and-train: one of her starts, a pick-up on a later Chicago day, a live
 *            eligible trainer (the one she named, if any), length 2 → the dog locks → no
 *            dog removed, no dog's stay overlapping (design § 14, A1) → the four approved
 *            fields stored (M5.21), the request parked at 'approved-awaiting-payment'
 *            (waiting for her yes; nothing is paid), her `request-approved` notice queued.
 *            NO booking: her yes inserts it.
 *          private-lesson: one of her times, in the future, a live priced trainer (the
 *            one she named unless "anyone") → no dog removed → gate pre-check → INSERT
 *            booking with the trainer, length and quote (that trainer's price now) →
 *            markConverted → 'booking-confirmed' naming time, trainer and price, paid after.
 *          boarding: unchanged but for A1 — the dog locks (so a Board & Train's yes cannot
 *            read past this stay) → no dog removed → gate pre-check → INSERT booking (+
 *            booking_dogs) + stay window → markConverted → 'booking-confirmed'.
 *          any other category: 409 `conflict`, nothing written. Only a
 *            day-school or day-care row from before M2.17 could reach this
 *            (wire 3.0.0; DECISIONS 118(a)); it stays `submitted`, and deny
 *            still works on it.
 *     5. re-read + emit the updated PendingRequestWire.
 *
 * Gate pre-check uses the shared `lib/bookingGatePreCheck.ts` (rule-of-
 * three with Day-10 + Day-11), so a PL request whose owner's vaccine
 * lapsed between submission and approval surfaces the same typed 422
 * the booking flow would have. Gates fire on the booking insert path:
 * here for a lesson or boarding, at her yes for a Board & Train.
 *
 * The approve and the yes do not read `offerings`: the switch stops new requests only,
 * so an approval in flight stands when a service is switched off (DECISIONS 463(3)).
 *
 * Deny transaction: lockById → assert status='submitted', or a Board & Train at
 * 'approved-awaiting-payment' (the portal's **Take back**, 9.0.0, A13) → markCancelled
 * with `approvedByStaffId` set (the discriminator that distinguishes staff deny from
 * owner self-cancel in the absence of a 'denied' enum value). A taken-back row keeps its
 * approved fields. The `request_status` enum has no 'denied' state — see the HANDOFF for
 * the documented semantic gap.
 */

const LOCATION_KEYS = LOCATION_SLUGS;
const REQUEST_STATUS_VALUES = pgEnumTuple(requestStatus);
const uuidParamSchema = z.object({ id: uuidId() });
const statusQuerySchema = z.object({ status: z.enum(REQUEST_STATUS_VALUES).optional() });

const isoDateTimeSchema = z.string().datetime({ offset: true });

/** A lesson's length when staff give none (design §4.1). */
const DEFAULT_LESSON_MINUTES = 60;

/**
 * Approve body — flat and fully optional; which keys a category requires is checked
 * against the locked request's category (`validateLessonApproval`,
 * `validateBoardTrainApproval`, `validateBoardingApproval`). The request's category isn't
 * known until the locked row is read, so a Zod discriminated union on the body alone
 * wouldn't help. Zod bounds only what a hostile body could send: an instant, a uuid, and
 * `duration_minutes` 15..240 (a guard, not a lesson-length rule; notes mechanic 5).
 */
const approveBodySchema = z
  .object({
    scheduled_at: isoDateTimeSchema.optional(),
    pickup_at: isoDateTimeSchema.optional(),
    location: z.enum(LOCATION_KEYS).optional(),
    notes: z.string().max(2000).optional(),
    trainer_staff_id: uuidId().optional(),
    dropoff_at: isoDateTimeSchema.optional(),
    duration_minutes: z.number().int().min(15).max(240).optional(),
  })
  .strict();

type ApproveBody = z.infer<typeof approveBodySchema>;

/** §5.1.3 pin — see `PostBookingsBodyConformance` in `routes/bookings.ts`. */
export type PostStaffRequestsApproveBodyConformance = Expect<
  Equal<z.input<typeof approveBodySchema>, PostStaffRequestsApproveRequest>
>;

const denyBodySchema = z
  .object({
    // Reserved for future use (deny reason). Empty body is the default
    // shape today.
    reason: z.string().max(500).optional(),
  })
  .strict();

/** §5.1.3 pin. `reason` is accepted and DISCARDED — no column stores it
 *  (DISCREPANCIES.md:671); persisting it needs DDL and is deferred to phase 3.
 *  (An earlier draft cited "§6 batch #7" — the delivered batch's item 7 is
 *  scope confirmations and contains no requests-policy content; corrected in
 *  the 1.13.0 fix round, 2.6 adversary, same repair `wire.ts` got.) The wire
 *  type documents the embarrassment rather than removing the field, which
 *  would be a tightening (§14.1). */
export type PostStaffRequestsDenyBodyConformance = Expect<
  Equal<z.input<typeof denyBodySchema>, PostStaffRequestsDenyRequest>
>;

export interface StaffRequestsRouteOptions extends AuthRouteOptions {
  /**
   * Injectable clock (9.0.0): a lesson is confirmed, and a Board & Train's drop-off
   * approved, only at an instant still ahead of it (DECISIONS 463(1)). Contract tests
   * inject the fixture clock. Default = `() => new Date()`.
   */
  now?: () => Date;
}

export function registerStaffRequestsRoute(
  app: FastifyInstance,
  opts: StaffRequestsRouteOptions = {},
): void {
  const authHook = resolveAuthHook(opts);
  const nowFactory = opts.now ?? ((): Date => new Date());

  // --- GET /staff/requests?status= ----------------------------------------
  //
  // Day-19 staff-portal queue (verb-1 read). Cross-owner by design —
  // `requireStaff` gates the route, so every owner's live requests are
  // visible. The portal passes `?status=submitted` to triage the
  // approve/deny queue; status is optional (omitted → all live).
  // Newest-submitted first, mirroring the owner-side GET /requests sort.
  // From 9.0.0 each row is a `StaffRequestWire` (A7): the names the portal prints.
  app.get(
    '/staff/requests',
    { preHandler: [authHook] },
    async (request): Promise<StaffRequestWire[]> => {
      const principal = requirePrincipal(request);
      requireStaff(principal, 'read the staff request queue');
      const { status } = parseStatusQuery(request.query);
      const rows = await requestsRepository.findLive(status);
      const sorted = sortRequestsBySubmittedAt(rows, 'desc');
      return wireStaffRequests(sorted);
    },
  );

  // --- POST /staff/requests/:id/approve -----------------------------------
  app.post(
    '/staff/requests/:id/approve',
    { preHandler: [authHook] },
    async (request, reply): Promise<PendingRequestWire> => {
      const principal = requirePrincipal(request);
      requireStaff(principal, 'approve pending requests');
      const { id } = parseUuidParam(request.params);
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
      const body = parseOrThrow(approveBodySchema, request.body ?? {}, 'body');

      const outcome = await withMutation<PendingRequestWire>(
        {
          principal,
          idempotencyKey,
          endpoint: 'POST /staff/requests/:id/approve',
          requestHash: hashRequestBody({ id, ...body }),
          // Request reads aren't cached, and no arm here moves credits or
          // day-program capacity.
          keysToInvalidate: () => [],
        },
        async (tx) => {
          // 1. Row-lock the pending_request — serializes concurrent
          //    approve attempts. Returns undefined if the id doesn't
          //    exist.
          const row = await requestsRepository.lockById(tx, id);
          if (row === undefined || row.expiredAt !== null) {
            throw new ApiError('not_found', `pending request ${id} not found`);
          }
          if (row.status !== 'submitted') {
            throw new ApiError(
              'conflict',
              `pending request ${id} is ${row.status} and cannot be approved`,
            );
          }
          const now = nowFactory();

          // 2. Branch on category.
          if (row.category === 'board-and-train') {
            // Staff approve dates and a trainer; nothing is booked until her yes.
            const approval = await validateBoardTrainApproval(tx, body, row, now);
            // A1: the dogs' locks, then a removed dog, then another stay (design § 14).
            const dogIds = await readRequestDogIds(tx, id);
            await lockRequestDogs(tx, dogIds.allDogIds);
            await assertNoRemovedDog(tx, dogIds.allDogIds, 'approve');
            await assertNoStayOverlap(tx, {
              dogIds: dogIds.allDogIds,
              dropoffAt: approval.dropoffAt,
              pickupAt: approval.pickupAt,
              at: 'approve',
            });
            await requestsRepository.markApprovedAwaitingPayment(tx, id, {
              approvedByStaffId: principal.staffId,
              trainerStaffId: approval.trainer.id,
              dropoffAt: approval.dropoffAt,
              pickupAt: approval.pickupAt,
              priceCents: approval.priceCents,
            });
            const dogName = (await dogsRepository.findNamesByIds([row.leadDogId], tx)).get(
              row.leadDogId,
            );
            await notificationsRepository.enqueue(tx, {
              ownerId: row.ownerId,
              type: 'request-approved',
              title: 'Board & Train approved',
              body:
                `${approval.trainer.name} can take ${dogName ?? 'your dog'} ` +
                `${chicagoDay(approval.dropoffAt)} – ${chicagoDay(approval.pickupAt)}. Tap to confirm.`,
              deepLinkPath: deepLinkToPath({
                kind: 'request',
                id,
                params: { category: 'board-and-train' },
              }),
              deepLinkKind: 'request',
              deepLinkId: id,
              dogIds: [row.leadDogId],
            });
          } else if (row.category === 'private-lesson') {
            // Staff confirm one of her times, and that books it.
            const lesson = await validateLessonApproval(tx, body, row, now);
            const quotedPriceCents = lesson.trainer.lessonPriceCents as number;
            // A1.2: a removed dog (a lesson sits inside a day: no stay guard, no dog lock).
            const dogIds = await readRequestDogIds(tx, id);
            await assertNoRemovedDog(tx, dogIds.allDogIds, 'approve');
            await bookOnApproval(tx, row, dogIds, {
              scheduledAt: lesson.scheduledAt,
              location: lesson.location,
              notes: lesson.notes,
              trainerStaffId: lesson.trainer.id,
              durationMinutes: lesson.durationMinutes,
              quotedPriceCents,
              approvedByStaffId: principal.staffId,
              noticeBody:
                `Booked: ${chicagoDayTime(lesson.scheduledAt)} with ${lesson.trainer.name}, ` +
                `${dollars(quotedPriceCents)}, paid after.`,
            });
          } else if (row.category === 'boarding') {
            const stay = validateBoardingApproval(body, row);
            // A1: the dogs' locks before the INSERT (no new refusal), and a removed dog.
            const dogIds = await readRequestDogIds(tx, id);
            await lockRequestDogs(tx, dogIds.allDogIds);
            await assertNoRemovedDog(tx, dogIds.allDogIds, 'approve');
            await bookOnApproval(tx, row, dogIds, {
              scheduledAt: stay.scheduledAt,
              location: stay.location,
              notes: stay.notes,
              stayPickupAt: stay.pickupAt,
              approvedByStaffId: principal.staffId,
              noticeBody: boardingNoticeBody(stay.scheduledAt),
            });
          } else {
            // A day program books and pays at POST /bookings, and staff
            // approval moves no money (R1, PAY-16), so a surviving row has
            // nothing to convert into. Falling through to the arm above would
            // book it with no credit and no charge.
            throw new ApiError(
              'conflict',
              `pending request ${id} is ${row.category} and cannot be approved`,
            );
          }

          // 3. Re-read + emit the updated PendingRequest wire shape.
          const updated = await requestsRepository.findFullByIdInTx(tx, id);
          if (updated === undefined) {
            throw new Error(`approve ${id}: row vanished before re-fetch`);
          }
          const wire = await wireOneRequest(tx, updated);
          return { status: 200, body: wire };
        },
      );

      reply.code(outcome.status);
      return outcome.body;
    },
  );

  // --- POST /staff/requests/:id/deny --------------------------------------
  //
  // Staff portal denial. Sets status='cancelled' (the enum has no
  // 'denied' state — see HANDOFF) + stamps approved_by_staff_id so the
  // wire-shape distinguishes staff-deny from owner self-cancel. From 9.0.0 it also takes
  // back a Board & Train waiting on her yes (A13), under the lock her yes takes.
  app.post(
    '/staff/requests/:id/deny',
    { preHandler: [authHook] },
    async (request): Promise<PendingRequestWire> => {
      const principal = requirePrincipal(request);
      requireStaff(principal, 'deny pending requests');
      const { id } = parseUuidParam(request.params);
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
      const body = parseOrThrow(denyBodySchema, request.body ?? {}, 'body');

      const outcome = await withMutation<PendingRequestWire>(
        {
          principal,
          idempotencyKey,
          endpoint: 'POST /staff/requests/:id/deny',
          requestHash: hashRequestBody({ id, ...body }),
          keysToInvalidate: () => [],
        },
        async (tx) => {
          const row = await requestsRepository.lockById(tx, id);
          if (row === undefined || row.expiredAt !== null) {
            throw new ApiError('not_found', `pending request ${id} not found`);
          }
          const takeBack =
            row.category === 'board-and-train' && row.status === 'approved-awaiting-payment';
          if (row.status !== 'submitted' && !takeBack) {
            throw new ApiError(
              'conflict',
              `pending request ${id} is ${row.status} and cannot be denied`,
            );
          }

          await requestsRepository.markCancelled(tx, id, {
            approvedByStaffId: principal.staffId,
          });

          const updated = await requestsRepository.findFullByIdInTx(tx, id);
          if (updated === undefined) {
            throw new Error(`deny ${id}: row vanished before re-fetch`);
          }
          const wire = await wireOneRequest(tx, updated);
          return { status: 200, body: wire };
        },
      );
      return outcome.body;
    },
  );
}

// ---- body validation -------------------------------------------------

function refuse(message: string): never {
  throw new ApiError('invalid_payload', message);
}

/** Refuse each key a category does not take (9.0.0, A3; notes mechanic 4). */
function refuseKeys(
  body: ApproveBody,
  keys: readonly (keyof ApproveBody)[],
  category: string,
  why: string,
): void {
  for (const key of keys) {
    if (body[key] !== undefined) {
      refuse(`${key} is not taken when approving a ${category} request: ${why}`);
    }
  }
}

/**
 * The instant staff chose is one of her own `preferred_dates` (the same instant) and
 * still ahead (at or before now is 422, DECISIONS 463(1)): staff approve one of the
 * family's own times, and there is no counter offer (her edit is the road).
 */
async function assertOneOfHerTimes(
  tx: Tx,
  requestId: string,
  key: 'scheduled_at' | 'dropoff_at',
  at: Date,
  now: Date,
): Promise<void> {
  const dates = await requestsRepository.findPreferredDatesByRequestIds([requestId], tx);
  const hers = dates.some((d) => pgTimestampToDate(d.preferredAt).getTime() === at.getTime());
  if (!hers) {
    refuse(`${key} must be one of the family's preferred_dates`);
  }
  if (at.getTime() <= now.getTime()) {
    refuse(`${key} ${at.toISOString()} has already passed; approve a time still ahead`);
  }
}

/**
 * The trainer staff chose serves this service now (live, with a lesson price or Board &
 * Train eligibility), and is the one she named unless she chose "anyone" (`'any'`, none,
 * or a value naming no staff row; notes R2). Her named trainer binds (PL-08): the price
 * is per trainer, so another would change her price without her yes. A named trainer
 * since expired or unpriced fails the first check: staff ask her to edit, or deny (R1).
 * The row is read `FOR SHARE`, so a roster run cannot change it before this commits.
 */
async function assertTrainer(
  tx: Tx,
  body: ApproveBody,
  row: PendingRequestFullRow,
  category: RequestServiceCategory,
): Promise<TrainerRow> {
  if (body.trainer_staff_id === undefined) {
    refuse(`trainer_staff_id is required when approving a ${category} request`);
  }
  const trainer = await staffRepository.findTrainer(tx, body.trainer_staff_id, { lock: true });
  if (trainer === undefined || !trainerServes(trainer, category)) {
    refuse(
      category === 'private-lesson'
        ? 'trainer_staff_id must be a live staffer with a lesson price'
        : 'trainer_staff_id must be a live staffer who takes Board & Train',
    );
  }
  const named = await namedTrainer(tx, row.staffPreference);
  if (named !== undefined && named.id !== trainer.id) {
    // Fable b1 N1: when she no longer serves, approving with her is refused above, so the
    // sentence must not send staff there.
    refuse(
      trainerServes(named, category)
        ? `this family asked for ${named.name}: approve with ${named.name}, or ask them to edit the request`
        : `this family asked for ${named.name}, who no longer takes ${category === 'private-lesson' ? 'lessons' : 'Board & Train'}: ask them to edit the request, or deny it`,
    );
  }
  return trainer;
}

interface LessonApproval {
  scheduledAt: Date;
  location: LocationKey;
  notes: string | null;
  trainer: TrainerRow;
  durationMinutes: number;
}

/**
 * Private lesson (9.0.0, A3): `scheduled_at` one of her times and ahead, `location`
 * required (the portal pre-fills her home campus; the server does not default it, notes
 * R3), a priced `trainer_staff_id` per `assertTrainer`, `duration_minutes` defaulting to
 * 60. `pickup_at` and `dropoff_at` are a stay's, refused here.
 */
async function validateLessonApproval(
  tx: Tx,
  body: ApproveBody,
  row: PendingRequestFullRow,
  now: Date,
): Promise<LessonApproval> {
  refuseKeys(body, ['pickup_at', 'dropoff_at'], 'private-lesson', 'a lesson has no stay window');
  if (body.scheduled_at === undefined) {
    refuse('scheduled_at is required when approving a private-lesson or boarding request');
  }
  const scheduledAt = new Date(body.scheduled_at);
  await assertOneOfHerTimes(tx, row.id, 'scheduled_at', scheduledAt, now);
  if (body.location === undefined) {
    refuse('location is required when approving a request');
  }
  const trainer = await assertTrainer(tx, body, row, 'private-lesson');
  return {
    scheduledAt,
    location: body.location,
    notes: body.notes ?? null,
    trainer,
    durationMinutes: body.duration_minutes ?? DEFAULT_LESSON_MINUTES,
  };
}

interface BoardTrainApproval {
  dropoffAt: Date;
  pickupAt: Date;
  trainer: TrainerRow;
  priceCents: number;
}

/**
 * Board & Train (9.0.0, A3): `dropoff_at` one of her starts and ahead, `pickup_at` after
 * it and on a later Chicago day (at least one night, design § 14 A1 item 3; the cue transfer
 * session), an eligible `trainer_staff_id` per `assertTrainer`, and
 * the two-week program. `scheduled_at`, `location`, `duration_minutes` and `notes` are
 * refused: nothing stores them, because the stay starts at `dropoff_at`, at her home
 * campus, from her yes.
 */
async function validateBoardTrainApproval(
  tx: Tx,
  body: ApproveBody,
  row: PendingRequestFullRow,
  now: Date,
): Promise<BoardTrainApproval> {
  refuseKeys(
    body,
    ['scheduled_at', 'location', 'duration_minutes', 'notes'],
    'board-and-train',
    "the stay starts at dropoff_at, at the family's home campus, from their yes",
  );
  if (row.lengthWeeks !== BOARD_TRAIN_WEEKS) {
    refuse(
      row.lengthWeeks === null
        ? 'This request names no length; only the two-week program has a price. Ask the family to edit it.'
        : `This request asks for ${row.lengthWeeks} week${row.lengthWeeks === 1 ? '' : 's'}; only the two-week program has a price. Ask the family to edit it.`,
    );
  }
  if (body.dropoff_at === undefined) {
    refuse('dropoff_at is required when approving a board-and-train request');
  }
  const dropoffAt = new Date(body.dropoff_at);
  await assertOneOfHerTimes(tx, row.id, 'dropoff_at', dropoffAt, now);
  if (body.pickup_at === undefined) {
    refuse('pickup_at is required when approving a board-and-train request');
  }
  const pickupAt = new Date(body.pickup_at);
  // A1 item 3 (wire 9.0.0 v3): at least one night, on Chicago dates (P51 divides by nights
  // booked). It replaces "strictly after": a pick-up at or before the drop-off is on no
  // later day either.
  if (bucketToChicagoDate(pickupAt) <= bucketToChicagoDate(dropoffAt)) {
    refuse('The hand-back must be on a later day than the drop-off.');
  }
  const trainer = await assertTrainer(tx, body, row, 'board-and-train');
  return {
    dropoffAt,
    pickupAt,
    trainer,
    priceCents: boardTrainPriceCentsForLengthWeeks(BOARD_TRAIN_WEEKS),
  };
}

interface BoardingApproval {
  scheduledAt: Date;
  pickupAt: Date;
  location: LocationKey;
  notes: string | null;
}

/**
 * Boarding, unchanged: `scheduled_at`, `pickup_at` (strictly after) and `location` all
 * required. From 9.0.0 the three new keys are refused (they were unknown keys, 400,
 * before; notes mechanic 4).
 */
function validateBoardingApproval(body: ApproveBody, row: PendingRequestFullRow): BoardingApproval {
  refuseKeys(
    body,
    ['trainer_staff_id', 'dropoff_at', 'duration_minutes'],
    'boarding',
    'boarding is approved with scheduled_at, pickup_at and location',
  );
  if (body.scheduled_at === undefined) {
    refuse('scheduled_at is required when approving a private-lesson or boarding request');
  }
  const scheduledAt = new Date(body.scheduled_at);
  if (body.location === undefined) {
    refuse('location is required when approving a request');
  }
  if (body.pickup_at === undefined) {
    refuse(`pickup_at is required when approving a ${row.category} request`);
  }
  const pickupAt = new Date(body.pickup_at);
  if (pickupAt.getTime() <= scheduledAt.getTime()) {
    refuse('pickup_at must be strictly after scheduled_at');
  }
  return { scheduledAt, pickupAt, location: body.location, notes: body.notes ?? null };
}

// ---- the booking an approve makes ----------------------------------------

/**
 * A lesson's or a boarding stay's booking, made by the approve: the gate pre-check, the
 * INSERT through the trigger-mapping wrapper (so a trigger refusal is a typed 422, never
 * a 500), the reminders, 'converted' with the approver, and her 'booking-confirmed'
 * notice. No money moves.
 */
async function bookOnApproval(
  tx: Tx,
  row: PendingRequestFullRow,
  dogIds: RequestDogIds,
  args: {
    scheduledAt: Date;
    location: LocationKey;
    notes: string | null;
    trainerStaffId?: string;
    durationMinutes?: number;
    quotedPriceCents?: number;
    /** Boarding only: the stay's pick-up (its drop-off is `scheduledAt`). */
    stayPickupAt?: Date;
    approvedByStaffId: string;
    noticeBody: string;
  },
): Promise<void> {
  const category = row.category as 'private-lesson' | 'boarding';
  await checkBookingGates(tx, { ownerId: row.ownerId, dogIds: dogIds.allDogIds, category });

  const inserted = await insertBookingWithGateMapping(tx, {
    ownerId: row.ownerId,
    leadDogId: row.leadDogId,
    category,
    scheduledAt: args.scheduledAt,
    location: args.location,
    notes: args.notes,
    additionalDogIds: dogIds.additionalDogIds,
    // Δ 2026-07-14: the private lesson's home/public setting rides
    // the conversion so the owner's bookings card can label it.
    lessonSetting: row.lessonSetting,
    // 9.0.0 (A3, A8): a lesson's trainer, length and quote.
    trainerStaffId: args.trainerStaffId ?? null,
    durationMinutes: args.durationMinutes ?? null,
    quotedPriceCents: args.quotedPriceCents ?? null,
  });

  // Boarding carries a real pick-up timestamp; a lesson does not. The bookings row's
  // pickup_at + dropoff_at columns are schema-gated to category IN
  // ('boarding','board-and-train') (CHECK constraint).
  if (args.stayPickupAt !== undefined) {
    await setBoardingStayWindow(tx, inserted.id, {
      dropoffAt: args.scheduledAt,
      pickupAt: args.stayPickupAt,
    });
  }

  // Day-16: enqueue reminder + (boarding only) the 24h-pre-drop-off profile check. For
  // boarding, dropoff_at equals scheduledAt (set the same way above).
  await enqueueBookingReminders(tx, {
    bookingId: inserted.id,
    ownerId: row.ownerId,
    leadDogId: row.leadDogId,
    category,
    scheduledAt: args.scheduledAt,
    dropoffAt: category === 'boarding' ? args.scheduledAt : null,
  });

  await requestsRepository.markConverted(tx, row.id, {
    approvedByStaffId: args.approvedByStaffId,
    convertedBookingId: inserted.id,
  });

  // Enqueue the booking-confirmed notification. The FE bell popover reads
  // `notifications.received_at` DESC, so the owner sees this at the top of the feed the
  // next time they open the app.
  await notificationsRepository.enqueue(tx, {
    ownerId: row.ownerId,
    type: 'booking-confirmed',
    title: 'Booking confirmed!',
    body: args.noticeBody,
    deepLinkPath: deepLinkToPath({ kind: 'booking', id: inserted.id }),
    deepLinkKind: 'booking',
    deepLinkId: inserted.id,
    dogIds: [row.leadDogId, ...dogIds.additionalDogIds],
  });
}

// ---- helpers ---------------------------------------------------------

/**
 * Resolve the lead + additional dog ids for one request inside the
 * approve txn. Reads the join table directly (no Tx-specific variant
 * needed — the request was created earlier, so the rows are visible at
 * READ COMMITTED isolation).
 *
 * Throws on the structural invariant violation that every request has
 * exactly one `is_lead=true` row. Tracks the same shape as
 * `groupRequestDogs` — extract if a fourth call site needs it.
 */
interface RequestDogIds {
  leadDogId: string;
  additionalDogIds: string[];
  allDogIds: string[];
}

async function readRequestDogIds(tx: Tx, requestId: string): Promise<RequestDogIds> {
  const rows = await requestsRepository.findDogsByRequestIds([requestId], tx);
  const grouped = groupRequestDogs(rows).get(requestId);
  if (grouped === undefined) {
    throw new Error(`pending_request ${requestId}: no live pending_request_dogs rows`);
  }
  return {
    leadDogId: grouped.lead,
    additionalDogIds: grouped.additional,
    allDogIds: [grouped.lead, ...grouped.additional],
  };
}

/**
 * Set `dropoff_at` + `pickup_at` on a freshly-INSERTed boarding
 * booking. Done as a follow-up UPDATE, as it always was for boarding; the
 * family's Board & Train yes passes its stay window to the INSERT itself
 * (`routes/requestConfirm.ts`, 9.0.0).
 */
async function setBoardingStayWindow(
  tx: Tx,
  bookingId: string,
  args: { dropoffAt: Date; pickupAt: Date },
): Promise<void> {
  const { bookings } = await import('../db/schema/schema.js');
  const { eq } = await import('drizzle-orm');
  await tx
    .update(bookings)
    .set({
      dropoffAt: args.dropoffAt.toISOString(),
      pickupAt: args.pickupAt.toISOString(),
    })
    .where(eq(bookings.id, bookingId));
}

/**
 * Boarding's notice body, unchanged. A lesson's names its time, trainer and price
 * instead (9.0.0; the approve arm above): it replaced "Your private lesson on Dec 5 is
 * confirmed."
 */
function boardingNoticeBody(scheduledAt: Date): string {
  const when = scheduledAt.toLocaleDateString('en-US', {
    timeZone: 'America/Chicago',
    month: 'short',
    day: 'numeric',
  });
  return `Your boarding stay starting ${when} is confirmed.`;
}

function parseUuidParam(params: unknown): { id: string } {
  const parsed = uuidParamSchema.safeParse(params);
  if (!parsed.success) {
    throw new ApiError('bad_request', `invalid path: ${parsed.error.message}`);
  }
  return parsed.data;
}

function parseStatusQuery(query: unknown): z.infer<typeof statusQuerySchema> {
  const parsed = statusQuerySchema.safeParse(query);
  if (!parsed.success) {
    throw new ApiError('bad_request', `invalid query: ${parsed.error.message}`);
  }
  return parsed.data;
}
