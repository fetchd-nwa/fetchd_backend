import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import type { PostRequestsConfirmResponse } from '../contracts/wire.js';
import { hashRequestBody, requireIdempotencyKey, withMutation } from '../db/mutation.js';
import { bookingsRepository } from '../db/repositories/bookingsRepository.js';
import { ownersRepository } from '../db/repositories/ownersRepository.js';
import { requestsRepository } from '../db/repositories/requestsRepository.js';
import { staffRepository } from '../db/repositories/staffRepository.js';
import { checkBookingGates } from '../lib/bookingGatePreCheck.js';
import { enqueueBookingReminders } from '../lib/enqueueBookingReminders.js';
import { ApiError } from '../lib/errors.js';
import { insertBookingWithGateMapping } from '../lib/insertBookingWithGateMapping.js';
import { pgTimestampToDate } from '../lib/pgTimestamp.js';
import { requireOwner } from '../lib/principalNarrows.js';
import {
  assertNoRemovedDog,
  assertNoStayOverlap,
  lockRequestDogs,
  trainerServes,
} from '../lib/requestServices.js';
import { groupRequestDogs } from '../lib/requestWire.js';
import { uuidId } from '../lib/uuidId.js';
import { wireManyBookings } from '../lib/wireManyBookings.js';
import { wireOneRequest } from '../lib/wireOneRequest.js';
import { formatZodIssues, parseOrThrow } from '../lib/zodIssues.js';

/**
 * `POST /requests/:id/confirm` `[owner]` (wire 9.0.0; plan unit P49; design
 * request-services-v1 §2.2 A2, §3.2; BT-20, BT-21, BT-52; her 413, 414): the family's
 * **Yes, book it** to a Board & Train that staff approved. Her yes, and only her yes
 * after staff approved, books it.
 *
 * **It moves $0.** No Stripe client is passed to this route and none is reached: no
 * order, no invoice, no charge. A card on file is required (the booking gates), and
 * nothing is charged then: the stay is billed after the cue transfer session and the
 * family taps to pay (Shanthi #6.4, `12-shanthi-answers-10-01.md:40-41`, `:146`; plan unit
 * P51). It replaces `POST /requests/:id/confirm-payment` (A1; BUG-6, NOTE-7), which
 * charged $2,000.00 at confirm and now answers 404.
 *
 * Body: none, or `{}`, `.strict()`: nothing she sends can change what she says yes to.
 * The dates, the trainer and the price are the request's approved fields as staff
 * stored them. `Idempotency-Key` required; a same-key replay returns the stored 200.
 *
 * One transaction under the request's row lock, the lock the staff approve, the staff
 * deny (Take back), her Withdraw and her edit take, so a yes racing a Withdraw or a Take
 * back has exactly one winner (Fable r2 M1). Refusals, in this order:
 *   1. 404 `not_found`: no live request with this id, or not hers.
 *   2. 409 `conflict`: not a Board & Train at 'approved-awaiting-payment'.
 *   3. 409 `conflict`: the approved drop-off is at or before now.
 *   4. 409 `conflict`: the approved trainer is no longer live or Board & Train eligible
 *      (DECISIONS 466); staff take it back.
 *   Then the dog lock for every dog on the request, sorted (the lock the day-program create
 *   and the boarding approve take; design request-services-v1 § 14, Amendment A1), and:
 *   4a. 409 `conflict`, `details.reason: 'dog_removed'`: a dog on it is no longer on her
 *       account (A1.2).
 *   4b. 409 `conflict`, `details.reason: 'stay_overlap'`: a dog on it already holds a live
 *       boarding or Board & Train stay over these Chicago dates (A1.1). One dog refuses the
 *       whole yes; the request stays waiting, and she withdraws it.
 *   5. 422, the booking gates for 'board-and-train' (no evaluation gate, A12).
 * The service switch (`offerings`) is not read: an approval in flight stands
 * (DECISIONS 463(3)). No notice is queued: she tapped it herself (notes R5).
 */

const uuidParamSchema = z.object({ id: uuidId() });

/** No body, or `{}`; any key is 400 `bad_request` (notes mechanic 1). */
const confirmBodySchema = z.object({}).strict();

export interface RequestConfirmRouteOptions extends AuthRouteOptions {
  /** Injectable clock for the passed-drop-off refusal and the booking's `can_cancel`. */
  now?: () => Date;
}

export function registerRequestConfirmRoute(
  app: FastifyInstance,
  opts: RequestConfirmRouteOptions = {},
): void {
  const authHook = resolveAuthHook(opts);
  const nowFactory = opts.now ?? ((): Date => new Date());

  app.post(
    '/requests/:id/confirm',
    { preHandler: [authHook] },
    async (request, reply): Promise<PostRequestsConfirmResponse> => {
      const principal = requirePrincipal(request);
      requireOwner(principal, 'confirm their requests');
      const { id } = parseUuidParam(request.params);
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
      const body = parseOrThrow(confirmBodySchema, request.body ?? {}, 'body');

      // cache-noop: neither requests nor bookings are in the §3 cache map, and the yes
      // moves no credit and no day-program capacity.
      const outcome = await withMutation<PostRequestsConfirmResponse>(
        {
          principal,
          idempotencyKey,
          endpoint: 'POST /requests/:id/confirm',
          requestHash: hashRequestBody({ id, ...body }),
          keysToInvalidate: () => [],
        },
        async (tx) => {
          // 1. The row lock, then the 404 collapse: missing, expired, not hers.
          const row = await requestsRepository.lockById(tx, id);
          if (row === undefined || row.expiredAt !== null || row.ownerId !== principal.ownerId) {
            throw new ApiError('not_found', `pending request ${id} not found`);
          }
          // 2. Only a Board & Train staff approved, still waiting on her yes.
          if (row.category !== 'board-and-train' || row.status !== 'approved-awaiting-payment') {
            throw new ApiError(
              'conflict',
              `pending request ${id} is ${row.status} and cannot be confirmed`,
            );
          }
          // An approval written before 9.0.0 stored no dates; M5.23 sends such a row back
          // to staff, so none should remain. If one does, there is nothing to say yes to.
          if (
            row.approvedDropoffAt === null ||
            row.approvedPickupAt === null ||
            row.approvedTrainerStaffId === null ||
            row.approvedPriceCents === null ||
            row.approvedByStaffId === null
          ) {
            throw new ApiError(
              'conflict',
              `pending request ${id} was approved without dates, a trainer and a price; the school takes it back, and you send it again`,
            );
          }
          const now = nowFactory();
          const dropoffAt = pgTimestampToDate(row.approvedDropoffAt);
          const pickupAt = pgTimestampToDate(row.approvedPickupAt);

          // 3. The approved drop-off has passed: she withdraws and asks again, or staff
          //    take it back. The request stays waiting.
          if (dropoffAt.getTime() <= now.getTime()) {
            throw new ApiError(
              'conflict',
              `the approved drop-off of pending request ${id} has passed`,
            );
          }

          // 4. The approved trainer is still live and still takes Board & Train
          //    (DECISIONS 466: the rule the approve applied). Read FOR SHARE, so a roster
          //    run cannot expire her between this check and the INSERT.
          const trainer = await staffRepository.findTrainer(tx, row.approvedTrainerStaffId, {
            lock: true,
          });
          if (trainer === undefined || !trainerServes(trainer, 'board-and-train')) {
            throw new ApiError(
              'conflict',
              `the trainer approved for pending request ${id} can no longer take it; the school needs to update the request`,
            );
          }

          const dogRows = await requestsRepository.findDogsByRequestIds([id], tx);
          const dogs = groupRequestDogs(dogRows).get(id);
          if (dogs === undefined) {
            throw new Error(`pending_request ${id}: no live pending_request_dogs rows`);
          }
          const dogIds = [dogs.lead, ...dogs.additional];

          // 4a, 4b. Under the dogs' locks, so no stay of theirs lands between this read and
          //     the INSERT (A1.3): a removed dog first, then another stay (A1.2, A1.1).
          await lockRequestDogs(tx, dogIds);
          await assertNoRemovedDog(tx, dogIds, 'yes');
          await assertNoStayOverlap(tx, { dogIds, dropoffAt, pickupAt, at: 'yes' });

          // 5. The booking gates (card on file, vaccines, agreements; no evaluation).
          await checkBookingGates(tx, {
            ownerId: row.ownerId,
            dogIds,
            category: 'board-and-train',
          });

          // 6. The stay, at exactly what staff approved, at her home campus (none when
          //    she has none). Through the trigger-mapping wrapper, so a trigger refusal
          //    is a typed 422 and never a 500 (Fable r2 L3).
          const location = await ownersRepository.homeCampus(row.ownerId, tx);
          const inserted = await insertBookingWithGateMapping(tx, {
            ownerId: row.ownerId,
            leadDogId: dogs.lead,
            category: 'board-and-train',
            scheduledAt: dropoffAt,
            dropoffAt,
            pickupAt,
            location,
            notes: null,
            additionalDogIds: dogs.additional,
            trainerStaffId: trainer.id,
            quotedPriceCents: row.approvedPriceCents,
          });

          // 7. Its reminders, as for any Board & Train (the 24h profile check anchors on
          //    the drop-off).
          await enqueueBookingReminders(tx, {
            bookingId: inserted.id,
            ownerId: row.ownerId,
            leadDogId: dogs.lead,
            category: 'board-and-train',
            scheduledAt: dropoffAt,
            dropoffAt,
          });

          // 8. 'converted', keeping the STORED approver's id (never '', NOTE-7) and the
          //    approval instant.
          await requestsRepository.markConverted(tx, id, {
            approvedByStaffId: row.approvedByStaffId,
            convertedBookingId: inserted.id,
            keepApprovedAt: true,
          });

          const updated = await requestsRepository.findFullByIdInTx(tx, id);
          const booked = await bookingsRepository.findFullByIdInTx(tx, inserted.id);
          if (updated === undefined || booked === undefined) {
            throw new Error(`confirm ${id}: a row vanished before re-fetch`);
          }
          const [booking] = await wireManyBookings([booked], { now, viewer: 'owner', runner: tx });
          if (booking === undefined) {
            throw new Error(`confirm ${id}: wire assembly for booking ${inserted.id} returned no row`);
          }
          return {
            status: 200,
            body: { request: await wireOneRequest(tx, updated), booking },
          };
        },
      );

      reply.code(outcome.status);
      return outcome.body;
    },
  );
}

function parseUuidParam(params: unknown): { id: string } {
  const parsed = uuidParamSchema.safeParse(params);
  if (!parsed.success) {
    throw new ApiError('bad_request', `invalid path: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}
