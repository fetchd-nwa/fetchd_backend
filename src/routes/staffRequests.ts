import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import { deepLinkToPath } from '../contracts/wire.js';
import { hashRequestBody, requireIdempotencyKey, withMutation } from '../db/mutation.js';
import { requireStaff } from '../lib/principalNarrows.js';
import {
  requestsRepository,
  type PendingRequestFullRow,
} from '../db/repositories/requestsRepository.js';
import { notificationsRepository } from '../db/repositories/notificationsRepository.js';
import { creditsInvalidationPattern } from '../db/repositories/creditsRepository.js';
import { LOCATION_SLUGS, requestStatus } from '../db/schema/schema.js';
import { ApiError } from '../lib/errors.js';
import { checkBookingGates } from '../lib/bookingGatePreCheck.js';
import { cancelWindowSettingsRepository } from '../db/repositories/cancelWindowSettingsRepository.js';
import { computeCancelDeadlineFromHours } from '../lib/cancelWindow.js';
import { bucketToChicagoDate } from '../lib/chicagoDate.js';
import {
  createDayProgramBookings,
  type DayProgramPaymentPlan,
  type DayProgramSession,
} from '../lib/createDayProgramBookings.js';
import { enqueueBookingReminders } from '../lib/enqueueBookingReminders.js';
import { insertBookingWithGateMapping } from '../lib/insertBookingWithGateMapping.js';
import { pgEnumTuple } from '../lib/pgEnumTuple.js';
import { groupRequestDogs, type PendingRequestWire } from '../lib/requestWire.js';
import { wireOneRequest } from '../lib/wireOneRequest.js';
import { sortRequestsBySubmittedAt, wireManyRequests } from '../lib/wireManyRequests.js';
import type { LocationKey } from '../lib/bookingWire.js';
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
 * Approve transaction (DATA-CONTRACT §C.1 Model 3, schema.sql ~line 1307):
 *
 *   withMutation(staff principal) opens; withActor stamps app.actor
 *     1. lockById on pending_requests (row lock — concurrent approves
 *        on the same request serialize here).
 *     2. assert exists + owner ownership stays (the request row's
 *        ownerId carries through verbatim onto the booking).
 *     3. assert status='submitted' — else 409 `conflict` (idempotency
 *        catches replay; explicit state guard catches state-race).
 *     4. branch on category:
 *          board-and-train: markApprovedAwaitingPayment — NO booking
 *            inserted yet; the Day-14 confirm-payment verb completes
 *            the conversion by INSERTing the booking + flipping to
 *            'converted'.
 *          private-lesson / boarding: gate pre-check → INSERT booking
 *            (+ booking_dogs) → markConverted (with converted_booking_id) →
 *            enqueue 'booking-confirmed' notification.
 *     5. re-read + emit the updated PendingRequestWire.
 *
 * Gate pre-check uses the shared `lib/bookingGatePreCheck.ts` (rule-of-
 * three with Day-10 + Day-11), so a PL request whose owner's vaccine
 * lapsed between submission and approval surfaces the same typed 422
 * the booking flow would have. Gates fire on the booking insert path
 * for PL/boarding; B&T's gates fire at confirm-payment (Day 14).
 *
 * Deny transaction: lockById → assert status='submitted' → markCancelled
 * with `approvedByStaffId` set (the discriminator that distinguishes
 * staff deny from owner self-cancel in the absence of a 'denied' enum
 * value). The `request_status` enum has no 'denied' state — see the
 * HANDOFF for the documented semantic gap.
 */

const LOCATION_KEYS = LOCATION_SLUGS;
const REQUEST_STATUS_VALUES = pgEnumTuple(requestStatus);
const uuidParamSchema = z.object({ id: z.string().uuid() });
const statusQuerySchema = z.object({ status: z.enum(REQUEST_STATUS_VALUES).optional() });

const isoDateTimeSchema = z.string().datetime({ offset: true });

/**
 * Approve body — per-category required fields:
 *   - private-lesson: scheduled_at REQUIRED; location OPTIONAL
 *   - boarding: scheduled_at + pickup_at + location ALL REQUIRED
 *   - board-and-train: body MAY be empty (no booking created)
 *
 * Modeled as a flat permissive schema with cross-field validation in
 * `validateApproveBody` (against the locked request's category). The
 * request body shape isn't known until the locked row is read, so a
 * Zod discriminated union on the body alone wouldn't help.
 */
const approveBodySchema = z
  .object({
    scheduled_at: isoDateTimeSchema.optional(),
    pickup_at: isoDateTimeSchema.optional(),
    location: z.enum(LOCATION_KEYS).optional(),
    notes: z.string().max(2000).optional(),
  })
  .strict();

type ApproveBody = z.infer<typeof approveBodySchema>;

const denyBodySchema = z
  .object({
    // Reserved for future use (deny reason). Empty body is the default
    // shape today.
    reason: z.string().max(500).optional(),
  })
  .strict();

export function registerStaffRequestsRoute(
  app: FastifyInstance,
  opts: AuthRouteOptions = {},
): void {
  const authHook = resolveAuthHook(opts);

  // --- GET /staff/requests?status= ----------------------------------------
  //
  // Day-19 staff-portal queue (verb-1 read). Cross-owner by design —
  // `requireStaff` gates the route, so every owner's live requests are
  // visible. The portal passes `?status=submitted` to triage the
  // approve/deny queue; status is optional (omitted → all live).
  // Newest-submitted first, mirroring the owner-side GET /requests sort.
  app.get(
    '/staff/requests',
    { preHandler: [authHook] },
    async (request): Promise<PendingRequestWire[]> => {
      const principal = requirePrincipal(request);
      requireStaff(principal, 'read the staff request queue');
      const { status } = parseStatusQuery(request.query);
      const rows = await requestsRepository.findLive(status);
      const sorted = sortRequestsBySubmittedAt(rows, 'desc');
      return wireManyRequests(sorted);
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

      // Closure-captured by the day-program conversion arm: which dogs'
      // credit balances moved + where, for the post-commit cache wipes
      // (mirrors POST /bookings).
      let creditDebitedDogIds = new Set<string>();
      let bookedLocation: LocationKey | null = null;

      const outcome = await withMutation<PendingRequestWire>(
        {
          principal,
          idempotencyKey,
          endpoint: 'POST /staff/requests/:id/approve',
          requestHash: hashRequestBody({ id, ...body }),
          // Request reads aren't cached; the day-program conversion arm
          // invalidates availability + moved credit balances.
          patternsToInvalidate: () => [
            ...(bookedLocation !== null ? [`avail:${bookedLocation}:*`] : []),
            ...[...creditDebitedDogIds].map(creditsInvalidationPattern),
          ],
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

          // 2. Branch on category. B&T parks at approved-awaiting-payment
          //    and creates NO booking — body validation is skipped (the
          //    scheduled_at / pickup_at / location fields only apply to
          //    the booking insert path, which Day-14 confirm-payment
          //    will handle).
          if (row.category === 'board-and-train') {
            await requestsRepository.markApprovedAwaitingPayment(tx, id, {
              approvedByStaffId: principal.staffId,
            });
          } else if (row.category === 'day-school' || row.category === 'day-care') {
            // Day-program divert conversion (Shanthi 2026-07-14). The request
            // row carries everything POST /bookings validated at submit —
            // location, payment plan, exact session instants (preferred_dates)
            // — so approval takes NO body fields and runs the SAME creation
            // core the direct booking path uses: gates, credit debits / PAYG
            // invoice, capacity, overlap guard, reminders. A bounce here
            // (credits spent meanwhile, capacity filled, new conflict) is a
            // typed 422 back to the portal; the request stays 'submitted'.
            const { leadDogId, additionalDogIds } = await readRequestDogIds(tx, id);
            if (row.location === null) {
              throw new Error(`day-program request ${id} has no location — divert-create bug`);
            }
            const preferred = await requestsRepository.findPreferredDatesByRequestIds([id], tx);
            if (preferred.length === 0) {
              throw new Error(`day-program request ${id} has no preferred dates`);
            }
            const sessions: DayProgramSession[] = preferred
              .map((p) => {
                const scheduledAt = new Date(p.preferredAt);
                return { date: bucketToChicagoDate(scheduledAt), scheduledAt };
              })
              .sort((a, b) => a.date.localeCompare(b.date));
            const firstSession = sessions[0];
            if (firstSession === undefined) {
              throw new Error(`day-program request ${id} has no sessions after mapping`);
            }
            let payment: DayProgramPaymentPlan;
            if (row.payment === 'payg') {
              if (row.paymentMethodId === null) {
                throw new Error(`payg request ${id} has no payment_method_id — divert-create bug`);
              }
              payment = { kind: 'payg', paymentMethodId: row.paymentMethodId };
            } else {
              payment = { kind: 'credits' };
            }

            const result = await createDayProgramBookings(tx, {
              ownerId: row.ownerId,
              category: row.category,
              leadDogId,
              additionalDogIds,
              sessions,
              location: row.location,
              notes: row.notesJoint,
              payment,
              now: new Date(),
            });
            creditDebitedDogIds = result.creditDebitedDogIds;
            bookedLocation = row.location;

            const firstBooking = result.wires[0];
            if (firstBooking === undefined) {
              throw new Error(`day-program conversion ${id} created no bookings`);
            }
            // Multi-session conversions create N bookings; the single FK
            // records the first (earliest date) as the anchor the owner's
            // request card links to. All N appear in their bookings list.
            await requestsRepository.markConverted(tx, id, {
              approvedByStaffId: principal.staffId,
              convertedBookingId: firstBooking.id,
            });

            await notificationsRepository.enqueue(tx, {
              ownerId: row.ownerId,
              type: 'booking-confirmed',
              title: 'Booking confirmed',
              body: notificationBodyFor(row.category, firstSession.scheduledAt),
              deepLinkPath: deepLinkToPath({ kind: 'booking', id: firstBooking.id }),
              deepLinkKind: 'booking',
              deepLinkId: firstBooking.id,
              dogIds: [leadDogId, ...additionalDogIds],
            });
          } else {
            // PL / boarding: validate body, gate pre-check, INSERT
            // booking, mark converted, enqueue notification.
            const parsed = validateApproveBody(body, row);
            const allDogIds = await readRequestDogIds(tx, id);
            await checkBookingGates(tx, {
              ownerId: row.ownerId,
              dogIds: allDogIds.allDogIds,
              category: row.category,
            });

            const hours = await cancelWindowSettingsRepository.resolveHoursFor(row.category, tx);
            const cancelDeadlineAt = computeCancelDeadlineFromHours(parsed.scheduledAt, hours);
            const inserted = await insertBookingWithGateMapping(tx, {
              ownerId: row.ownerId,
              leadDogId: row.leadDogId,
              category: row.category,
              scheduledAt: parsed.scheduledAt,
              location: parsed.location,
              notes: parsed.notes,
              cancelDeadlineAt,
              additionalDogIds: allDogIds.additionalDogIds,
              // Δ 2026-07-14: the private lesson's home/public setting rides
              // the conversion so the owner's bookings card can label it.
              lessonSetting: row.lessonSetting,
            });

            // Boarding carries a real pick-up timestamp; PL does not.
            // The bookings row's pickup_at + dropoff_at columns are
            // schema-gated to category IN ('boarding','board-and-train')
            // (CHECK constraint), so only set them for boarding.
            if (row.category === 'boarding' && parsed.pickupAt !== null) {
              await setBoardingStayWindow(tx, inserted.id, {
                dropoffAt: parsed.scheduledAt,
                pickupAt: parsed.pickupAt,
              });
            }

            // Day-16: enqueue reminder + (boarding only) the 24h-pre-
            // drop-off profile check. For boarding, dropoff_at equals
            // parsed.scheduledAt (the row above set them the same way).
            await enqueueBookingReminders(tx, {
              bookingId: inserted.id,
              ownerId: row.ownerId,
              leadDogId: row.leadDogId,
              category: row.category,
              scheduledAt: parsed.scheduledAt,
              dropoffAt: row.category === 'boarding' ? parsed.scheduledAt : null,
            });

            await requestsRepository.markConverted(tx, id, {
              approvedByStaffId: principal.staffId,
              convertedBookingId: inserted.id,
            });

            // Enqueue the booking-confirmed notification. The FE bell
            // popover reads `notifications.received_at` DESC, so the
            // owner sees this at the top of the feed the next time
            // they open the app.
            await notificationsRepository.enqueue(tx, {
              ownerId: row.ownerId,
              type: 'booking-confirmed',
              title: 'Booking confirmed',
              body: notificationBodyFor(row.category, parsed.scheduledAt),
              deepLinkPath: deepLinkToPath({ kind: 'booking', id: inserted.id }),
              deepLinkKind: 'booking',
              deepLinkId: inserted.id,
              dogIds: [row.leadDogId, ...allDogIds.additionalDogIds],
            });
          }

          // 4. Re-read + emit the updated PendingRequest wire shape.
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
  // wire-shape distinguishes staff-deny from owner self-cancel.
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
          if (row.status !== 'submitted') {
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

interface ValidatedApproveBody {
  scheduledAt: Date;
  pickupAt: Date | null;
  location: LocationKey;
  notes: string | null;
}

/**
 * Per-category cross-field check. The locked request row carries the
 * authoritative category — owners and staff can't change it after
 * submission — so we branch on it here.
 *
 *   - private-lesson: scheduled_at REQUIRED; location defaults to the
 *     null-location-leaning rate; we require it explicitly so the
 *     trainer staff_id and rate lookup can resolve at booking time.
 *   - boarding: scheduled_at + pickup_at + location ALL required;
 *     pickup_at MUST be strictly after scheduled_at.
 *
 * B&T doesn't call this helper — the approve handler's category
 * branch goes straight to markApprovedAwaitingPayment.
 */
function validateApproveBody(body: ApproveBody, row: PendingRequestFullRow): ValidatedApproveBody {
  // PL + boarding both require scheduled_at (the staffer's chosen
  // date for the actual session). B&T was handled before this call.
  if (body.scheduled_at === undefined) {
    throw new ApiError(
      'invalid_payload',
      'scheduled_at is required when approving a private-lesson or boarding request',
    );
  }
  const scheduledAt = new Date(body.scheduled_at);
  if (Number.isNaN(scheduledAt.getTime())) {
    throw new ApiError('invalid_payload', 'scheduled_at is not a valid ISO timestamp');
  }

  if (body.location === undefined) {
    throw new ApiError('invalid_payload', 'location is required when approving a request');
  }

  let pickupAt: Date | null = null;
  if (row.category === 'boarding') {
    if (body.pickup_at === undefined) {
      throw new ApiError(
        'invalid_payload',
        'pickup_at is required when approving a boarding request',
      );
    }
    pickupAt = new Date(body.pickup_at);
    if (Number.isNaN(pickupAt.getTime())) {
      throw new ApiError('invalid_payload', 'pickup_at is not a valid ISO timestamp');
    }
    if (pickupAt.getTime() <= scheduledAt.getTime()) {
      throw new ApiError('invalid_payload', 'pickup_at must be strictly after scheduled_at');
    }
  } else if (body.pickup_at !== undefined) {
    throw new ApiError(
      'invalid_payload',
      `pickup_at is only valid for boarding requests, not ${row.category}`,
    );
  }

  return {
    scheduledAt,
    pickupAt,
    location: body.location,
    notes: body.notes ?? null,
  };
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
async function readRequestDogIds(
  tx: Parameters<typeof requestsRepository.findFullByIdInTx>[0],
  requestId: string,
): Promise<{ leadDogId: string; additionalDogIds: string[]; allDogIds: string[] }> {
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
 * booking. Done as a follow-up UPDATE rather than fields on
 * `bookingsRepository.create` because PL/day-program bookings never
 * carry these columns (schema CHECK forbids it for non-stay
 * categories). Adding two more optional create-params would push the
 * primitive's signature wider for one caller.
 *
 * Direct Drizzle update is justified here because (a) it's a single
 * narrow field set on a row we just inserted in the same tx, and (b)
 * promoting it to `bookingsRepository.setStayWindow` makes sense at
 * rule-of-two — Day-13 cancel for boarding may touch the same columns.
 */
async function setBoardingStayWindow(
  tx: Parameters<typeof requestsRepository.findFullByIdInTx>[0],
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
 * Build the notification body copy. Brief, category-aware. The deep
 * link goes to `/bookings/:id`; the body just orients the reader.
 */
function notificationBodyFor(
  category: PendingRequestFullRow['category'],
  scheduledAt: Date,
): string {
  const when = scheduledAt.toLocaleDateString('en-US', {
    timeZone: 'America/Chicago',
    month: 'short',
    day: 'numeric',
  });
  if (category === 'boarding') {
    return `Your boarding stay starting ${when} is confirmed.`;
  }
  if (category === 'private-lesson') {
    return `Your private lesson on ${when} is confirmed.`;
  }
  if (category === 'day-school') {
    return `Your Day School booking starting ${when} is approved and confirmed.`;
  }
  if (category === 'day-care') {
    return `Your Day Care booking starting ${when} is approved and confirmed.`;
  }
  // Remaining categories don't reach this helper (B&T parks at
  // awaiting-payment; group-class uses POST /enrollments); the default
  // keeps the fallback honest.
  return `Your session on ${when} is confirmed.`;
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
