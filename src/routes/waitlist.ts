import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import { hashRequestBody, requireIdempotencyKey, withMutation } from '../db/mutation.js';
import { db } from '../db/client.js';
import { withDivertRequestLocks, withDogModeLocks } from '../db/locks.js';
import { cohortsRepository } from '../db/repositories/cohortsRepository.js';
import { creditsInvalidationPattern } from '../db/repositories/creditsRepository.js';
import { dayCapacityRepository } from '../db/repositories/dayCapacityRepository.js';
import { dogsRepository } from '../db/repositories/dogsRepository.js';
import { requestsRepository } from '../db/repositories/requestsRepository.js';
import {
  waitlistRepository,
  type WaitlistEntryRow,
  type WaitlistTarget,
} from '../db/repositories/waitlistRepository.js';
import { LOCATIONS, type DivertedBookingWire } from '../contracts/wire.js';
import { resolveApprovalDivert } from '../lib/bookingApprovalDivert.js';
import { alreadyRequestedError } from '../lib/bookingErrors.js';
import { checkBookingGates } from '../lib/bookingGatePreCheck.js';
import {
  DEFAULT_DROPOFF_TIME,
  DROPOFF_TIME_REGEX,
  assertDropoffWithinWindow,
  computeDayProgramScheduledAt,
  parseDropoffTime,
} from '../lib/bookingSchedule.js';
import {
  assertAllIntentsSucceeded,
  chargeEachDogNow,
  createCohortEnrollment,
  resolvePerDogPriceCents,
  unwindCapturedIntents,
} from '../lib/createCohortEnrollment.js';
import {
  createDayProgramBookings,
  resolvePaygPlan,
  type DayProgramPaymentPlan,
} from '../lib/createDayProgramBookings.js';
import { ApiError } from '../lib/errors.js';
import { requireOwner, type OwnerPrincipal } from '../lib/principalNarrows.js';
import { defaultStripeClient, type StripeClient } from '../lib/stripe.js';
import { wireOneRequest } from '../lib/wireOneRequest.js';
import { parseOrThrow } from '../lib/zodIssues.js';
import type { FastifyBaseLogger } from 'fastify';
import type { BookingWire } from '../lib/bookingWire.js';
import type { IdempotencyOutcome } from '../db/idempotency.js';
import type { LocationKey } from '../db/schema/schema.js';
import type { BookingMode } from '../lib/bookingMode.js';
import type { Tx } from '../db/tx.js';

/**
 * Waitlist routes (Allison 2026-07-29/30).
 *
 * The owner-facing half of the feature: join a full queue, see where you are,
 * leave, and answer an offer — accept or decline. Promotion (a seat freeing →
 * an OFFER) is the scheduler's job and lives in `lib/waitlistPromotion`; this
 * file covers only what the owner initiates.
 *
 * Two rules land here rather than in the promotion path, because both are about
 * whether you should be IN the queue at all:
 *
 *   - **Gates are enforced at join.** Allison 2026-07-30 point 5: you can't
 *     queue for a session you couldn't book. Queuing someone who'd be blocked
 *     at the finish line wastes their time and holds a seat away from someone
 *     who could actually take it. They run AGAIN at accept, because the
 *     acceptance is what creates the booking and state moves in between.
 *   - **You can only queue for something that's actually full.** If seats are
 *     free the honest answer is "just book it" — a waitlist entry would sit
 *     there looking like progress while the real action is one tap away.
 *
 * Money moves in exactly ONE place: accept. Joining is free and holds nothing,
 * mirroring the approval-divert rule that money never moves at submit. The
 * accept then runs the ordinary booking transaction — the same
 * `lib/createDayProgramBookings` core POST /bookings uses, and the same
 * `lib/createCohortEnrollment` core POST /enrollments uses — so a seat taken
 * off the waitlist is gated, priced and paid for on identical rules to one
 * booked directly. There is no waitlist-flavoured booking path to drift.
 *
 * "Identical rules" includes the two accept used to skip (fixed 2026-07-31):
 *
 *   - **The approval divert.** POST /bookings parks a stale-or-intact roster as
 *     a `pending_requests` row for staff eyes; accept now runs the same check
 *     before the same creation core, so the waitlist can't be the way around it.
 *   - **The staff cap override.** Ruling 2 says staff can override the cap, and
 *     `waitlist_entries.offered_by_staff_id` records that they did. Accept
 *     honours it by letting the day-program booking past the capacity ceiling —
 *     an override is about CAPACITY, not safety, so every gate still runs.
 */

export interface WaitlistRouteOptions extends AuthRouteOptions {
  /**
   * Injectable clock. Accept is time-sensitive in two ways an offer's own
   * columns can't express (has the deadline passed, has the session date gone
   * by), so a contract test needs a deterministic now. Default = `new Date()`,
   * matching `routes/bookings.ts` and `routes/enrollments.ts`.
   */
  now?: () => Date;
  /**
   * Stripe seam. Accepting a GROUP-CLASS offer is an enrollment, and
   * group-class is money-paid: the pay-now card charge is confirmed before the
   * transaction opens, exactly as `POST /enrollments` does it. Contract tests
   * inject an in-memory stub; production wires `defaultStripeClient`.
   */
  stripe?: StripeClient;
}

const DAY_PROGRAM_CATEGORIES = ['day-school', 'day-care'] as const;

const dayProgramTargetSchema = z.object({
  category: z.enum(DAY_PROGRAM_CATEGORIES),
  session_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'session_date must be YYYY-MM-DD'),
  location: z.enum(LOCATIONS as unknown as [LocationKey, ...LocationKey[]]),
  dog_ids: z.array(z.string().uuid()).min(1).max(5),
});

const groupClassTargetSchema = z.object({
  category: z.literal('group-class'),
  cohort_id: z.string().uuid('cohort_id must be a UUID'),
  dog_ids: z.array(z.string().uuid()).min(1).max(5),
});

const joinBodySchema = z
  .union([dayProgramTargetSchema, groupClassTargetSchema])
  .refine(
    (body) => new Set(body.dog_ids).size === body.dog_ids.length,
    'dog_ids must not repeat a dog',
  );

const entryIdParamSchema = z.object({ id: z.string().uuid('id must be a UUID') });

/**
 * Accept body — the booking details the QUEUE ENTRY doesn't carry.
 *
 * An entry records what you're waiting for (which day, which school, which
 * dogs), never how you'd pay for it or when you'd drop off: nothing was decided
 * at join, because nothing was owed at join. Those are exactly the fields
 * POST /bookings takes, and they're asked here for the same reason it asks —
 * this IS the booking request, it just happens to be answering an offer.
 *
 * Every field is optional so a bare DAY-PROGRAM accept works: drop-off defaults
 * to the open of the window, payment defaults to credits.
 *
 * A group-class accept is an enrollment, and group-class is money-paid rather
 * than credit-paid (Δ 2026-06-09), so it requires `payment_method_id` and reads
 * `pay_later` — the two fields POST /enrollments takes. `dropoff_time` and
 * `payment` are day-program-only: a cohort's session times come from the cohort
 * row, and there is no credits axis to charge against.
 */
const acceptBodySchema = z
  .object({
    dropoff_time: z.string().regex(DROPOFF_TIME_REGEX, 'must be HH:MM').optional(),
    notes: z.string().max(2000).optional(),
    payment: z.enum(['credits', 'payg']).optional(),
    payment_method_id: z.string().uuid('payment_method_id must be a UUID').optional(),
    pay_later: z.boolean().optional(),
  })
  .strict();

type AcceptBody = z.infer<typeof acceptBodySchema>;

/** The owner-facing shape of a queue entry. Hand-mirrored (not in wire.ts yet —
 *  the waitlist surface joins the contract with the rest of the owner surfaces;
 *  see STATUS.md's owner-surface expansion follow-up). */
export interface WaitlistEntryWire {
  id: string;
  category: string;
  status: string;
  dog_ids: string[];
  /** 1-based place in line among live entries for the same target. */
  position: number;
  session_date?: string;
  location?: string;
  cohort_id?: string;
  /** Offered entries only — when the offer lapses if unanswered. */
  offer_expires_at?: string;
  created_at: string;
}

function toWaitlistEntryWire(entry: WaitlistEntryRow, position: number): WaitlistEntryWire {
  const wire: WaitlistEntryWire = {
    id: entry.id,
    category: entry.category,
    status: entry.status,
    dog_ids: entry.dogIds,
    position,
    created_at: entry.createdAt,
  };
  if (entry.sessionDate !== null) wire.session_date = entry.sessionDate;
  if (entry.location !== null) wire.location = entry.location;
  if (entry.cohortId !== null) wire.cohort_id = entry.cohortId;
  if (entry.offerExpiresAt !== null) wire.offer_expires_at = entry.offerExpiresAt;
  return wire;
}

/** `day-school` runs on the school credits axis, `day-care` on daycare. */
function modeForCategory(category: 'day-school' | 'day-care'): BookingMode {
  return category === 'day-school' ? 'school' : 'daycare';
}

export function registerWaitlistRoutes(
  app: FastifyInstance,
  opts: WaitlistRouteOptions = {},
): void {
  const authHook = resolveAuthHook(opts);
  const nowFactory = opts.now ?? ((): Date => new Date());
  const stripe = opts.stripe ?? defaultStripeClient;

  app.post(
    '/waitlist',
    { preHandler: [authHook] },
    async (request, reply): Promise<WaitlistEntryWire> => {
      const principal = requirePrincipal(request);
      requireOwner(principal, 'join a waitlist');
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
      const body = parseOrThrow(joinBodySchema, request.body, 'body');

      // Every dog must be this owner's. 404 rather than 403 — dog ids don't
      // enumerate across owners, so missing and not-yours collapse.
      for (const dogId of body.dog_ids) {
        const owned = await dogsRepository.findOwnedExists(dogId, principal.ownerId);
        if (!owned) throw new ApiError('not_found', 'one or more dogs were not found');
      }
      // The FIRST id is the lead, matching the booking body convention.
      const leadDogId = body.dog_ids[0];
      if (leadDogId === undefined) throw new ApiError('bad_request', 'dog_ids must not be empty');

      const target: WaitlistTarget =
        body.category === 'group-class'
          ? { kind: 'group-class', cohortId: body.cohort_id }
          : {
              kind: 'day-program',
              category: body.category,
              sessionDate: body.session_date,
              location: body.location,
              mode: modeForCategory(body.category),
            };

      const outcome = await withMutation<WaitlistEntryWire>(
        {
          principal,
          idempotencyKey,
          endpoint: 'POST /waitlist',
          requestHash: hashRequestBody({ ownerId: principal.ownerId, ...body }),
        },
        async (tx) => {
          // Gates FIRST: cheapest honest rejection, and the same order the
          // booking path uses so the owner sees the same blocker they'd hit.
          await checkBookingGates(tx, {
            ownerId: principal.ownerId,
            dogIds: body.dog_ids,
            category: body.category,
            ...(body.category === 'group-class'
              ? { groupClassKey: await resolveCohortClassKey(body.cohort_id) }
              : {}),
          });

          // Then: is it actually full? Seats free means book it, don't queue.
          await assertTargetIsFull(tx, target, body.dog_ids.length);

          // One place in line per dog. The DB indexes only cover the lead, so
          // this is what stops a dog riding along on a second entry.
          const alreadyQueued = await waitlistRepository.findDogsAlreadyQueued(tx, {
            dogIds: body.dog_ids,
            target,
          });
          if (alreadyQueued.length > 0) {
            throw new ApiError(
              'already_waitlisted',
              'one or more of these dogs is already on this waitlist',
            );
          }

          const entry = await waitlistRepository.join(tx, {
            ownerId: principal.ownerId,
            leadDogId,
            dogIds: body.dog_ids,
            target,
          });
          const position = (await waitlistRepository.positionOf(tx, entry.id)) ?? 1;
          return { status: 201, body: toWaitlistEntryWire(entry, position) };
        },
      );
      reply.code(outcome.status);
      return outcome.body;
    },
  );

  app.get(
    '/waitlist',
    { preHandler: [authHook] },
    async (request): Promise<{ items: WaitlistEntryWire[] }> => {
      const principal = requirePrincipal(request);
      requireOwner(principal, 'read your waitlist entries');
      const entries = await waitlistRepository.findLiveForOwner(db, principal.ownerId);
      const items = await Promise.all(
        entries.map(async (entry) =>
          toWaitlistEntryWire(entry, (await waitlistRepository.positionOf(db, entry.id)) ?? 1),
        ),
      );
      return { items };
    },
  );

  app.delete('/waitlist/:id', { preHandler: [authHook] }, async (request, reply): Promise<null> => {
    const principal = requirePrincipal(request);
    requireOwner(principal, 'leave a waitlist');
    const { id } = parseOrThrow(entryIdParamSchema, request.params, 'params');
    const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);

    const outcome = await withMutation<null>(
      {
        principal,
        idempotencyKey,
        endpoint: 'DELETE /waitlist/:id',
        requestHash: hashRequestBody({ ownerId: principal.ownerId, id }),
      },
      async (tx) => {
        const entry = await waitlistRepository.findByIdForOwner(tx, {
          id,
          ownerId: principal.ownerId,
        });
        // Not yours / unknown / already resolved all collapse to 404 — the row
        // is not something this owner can act on.
        if (entry === undefined || (entry.status !== 'waiting' && entry.status !== 'offered')) {
          throw new ApiError('not_found', 'waitlist entry not found');
        }
        const resolved = await waitlistRepository.resolve(tx, {
          id,
          from: entry.status,
          to: 'cancelled',
          resolvedAt: new Date(),
        });
        if (!resolved) {
          // The read above saw a live entry; the conditional UPDATE then matched
          // nothing, so something resolved it between the two — under READ
          // COMMITTED the UPDATE blocks on the row and re-evaluates against the
          // winner's committed status. Almost always the owner's own accept,
          // landing a millisecond earlier: replying 204 here would tell them
          // they had left the waitlist while they were in fact holding a fresh
          // booking and a charged card. Same code and wording as decline's
          // identical race.
          throw new ApiError('conflict', 'this waitlist entry was already resolved');
        }
        return { status: 204, body: null };
      },
    );
    reply.code(outcome.status);
    return outcome.body;
  });

  // --- POST /waitlist/:id/accept -----------------------------------------
  //
  // Take the seat. Allison 2026-07-30 point 1: the offer is where the money
  // finally moves, and point 5: the gates are re-run here because THIS is the
  // call that creates the booking — a vaccine can expire between joining a
  // queue in April and a seat freeing in June.
  //
  // The whole verb is one transaction on purpose. A booking that committed
  // while the entry stayed 'offered' would leave the same offer answerable a
  // second time, and the conditional `resolve` in each branch is what makes two
  // simultaneous accepts produce exactly one booking: the loser's `resolve`
  // returns false, it throws, and its booking rolls back with it.
  //
  // Three outcomes, matching the two endpoints this verb stands in for:
  //   201 `BookingWire[]`      — booked (day program) or enrolled (group class)
  //   202 `DivertedBookingWire`— the roster tripped an approval rule and is now
  //                              a `pending_requests` row for staff (see below)
  //   4xx                      — a gate, the deadline, or a lost race
  //
  // 201 returns the bookings rather than the entry, exactly like POST /bookings
  // and POST /enrollments — accept IS a booking-creation verb, and the owner's
  // next screen is the booking, not the queue entry they just left. (Returning
  // the entry would also mean inventing a `position` for a row that no longer
  // has one: `positionOf` only ranks live entries.)
  app.post(
    '/waitlist/:id/accept',
    { preHandler: [authHook] },
    async (request, reply): Promise<BookingWire[] | DivertedBookingWire> => {
      const principal = requirePrincipal(request);
      requireOwner(principal, 'accept a waitlist offer');
      const { id } = parseOrThrow(entryIdParamSchema, request.params, 'params');
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
      // A bare accept carries no body at all — every field has a default.
      const body = parseOrThrow(acceptBodySchema, request.body ?? {}, 'body');

      // Which KIND of offer this is has to be known before the transaction
      // opens, because a group-class accept charges a card first and a long
      // Stripe call must not pin a transaction (the rule POST /enrollments
      // works to).
      //
      // Read WITHOUT asserting the status: an idempotent replay arrives with the
      // entry already 'accepted', and 404-ing on that here would refuse a retry
      // `withMutation` is supposed to answer from the stored response. Each
      // branch's in-transaction `requireOfferedEntry` is the authoritative
      // status check.
      const entry = await waitlistRepository.findByIdForOwner(db, {
        id,
        ownerId: principal.ownerId,
      });
      if (entry === undefined) throw new ApiError('not_found', 'waitlist offer not found');

      const outcome =
        entry.category === 'group-class'
          ? await acceptCohortOffer({
              principal,
              entry,
              idempotencyKey,
              body,
              now: nowFactory,
              stripe,
              log: request.log,
            })
          : await acceptDayProgramOffer({
              principal,
              entryId: id,
              idempotencyKey,
              body,
              now: nowFactory,
            });

      reply.code(outcome.status);
      return outcome.body;
    },
  );

  // --- POST /waitlist/:id/decline ----------------------------------------
  //
  // "No thanks." Same 404 rules as accept; the entry goes terminal and the seat
  // it was holding rolls to the next dog in line.
  //
  // 204 like DELETE /waitlist/:id, and for the same reason: both are terminal
  // resolves that create nothing, and the entry they return would only ever say
  // "you are no longer in this queue" — which the status code already said.
  app.post(
    '/waitlist/:id/decline',
    { preHandler: [authHook] },
    async (request, reply): Promise<null> => {
      const principal = requirePrincipal(request);
      requireOwner(principal, 'decline a waitlist offer');
      const { id } = parseOrThrow(entryIdParamSchema, request.params, 'params');
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);

      const outcome = await withMutation<null>(
        {
          principal,
          idempotencyKey,
          endpoint: 'POST /waitlist/:id/decline',
          requestHash: hashRequestBody({ ownerId: principal.ownerId, id }),
        },
        async (tx) => {
          const now = nowFactory();
          // Note the asymmetry with accept: a LAPSED offer is still declinable.
          // "No thanks" is true whether or not the deadline passed, and the
          // entry ends up terminal either way. Only accept needs the freshness
          // check, because only accept takes a seat the sweep may already have
          // handed to someone else.
          await requireOfferedEntry(tx, { id, ownerId: principal.ownerId });
          const resolved = await waitlistRepository.resolve(tx, {
            id,
            from: 'offered',
            to: 'declined',
            resolvedAt: now,
          });
          if (!resolved) {
            throw new ApiError('conflict', 'this waitlist offer was already resolved');
          }
          // TODO(waitlist-promotion): roll the freed seat to the next dog in
          // line. Bind the entry `requireOfferedEntry` returns above, then:
          //     await promoteForTarget(tx, targetOfEntry(entry), now);
          // from `lib/waitlistPromotion.ts` — HERE, after the resolve and
          // inside this transaction: the seat only counts as free once the
          // decline has landed, and `promoteForTarget` takes its own queue
          // lock. Left uncalled rather than imported speculatively — that
          // module is being written in parallel, and a second copy of "who is
          // next" is how the two versions start disagreeing.
          return { status: 204, body: null };
        },
      );
      reply.code(outcome.status);
      return outcome.body;
    },
  );
}

/**
 * The entry this owner is allowed to answer. Missing, not-yours and
 * already-resolved all collapse to 404 — the same rule DELETE uses, for the
 * same reason: an entry the owner can't act on should be indistinguishable from
 * one that never existed.
 */
async function requireOfferedEntry(
  tx: Tx,
  args: { id: string; ownerId: string },
): Promise<WaitlistEntryRow> {
  const entry = await waitlistRepository.findByIdForOwner(tx, args);
  if (entry === undefined || entry.status !== 'offered') {
    throw new ApiError('not_found', 'waitlist offer not found');
  }
  return entry;
}

/**
 * Everything an accept branch needs that the route handler already parsed. The
 * two branches are separate functions rather than one with a fork because they
 * share almost nothing past this: one books against credits under day-capacity
 * locks, the other charges a card outside the transaction and enrolls under a
 * cohort row lock.
 */
interface AcceptOfferArgs {
  principal: OwnerPrincipal;
  entryId: string;
  idempotencyKey: string;
  body: AcceptBody;
  now: () => Date;
}

/**
 * Accept a DAY-PROGRAM offer: book the session, or — when the roster trips an
 * approval rule — park it for staff exactly as POST /bookings would.
 */
async function acceptDayProgramOffer(
  args: AcceptOfferArgs,
): Promise<IdempotencyOutcome<BookingWire[] | DivertedBookingWire>> {
  const { principal, entryId, body } = args;
  const dropoff =
    body.dropoff_time !== undefined ? parseDropoffTime(body.dropoff_time) : DEFAULT_DROPOFF_TIME;
  assertDropoffWithinWindow(dropoff);
  const payment = resolveAcceptPaymentPlan(body);

  // Closure-captured for the post-commit wipes, same pattern as POST /bookings.
  // Neither is known until the entry is read inside the tx.
  //
  // The location's `avail:*` ranges go stale on BOTH outcomes: booking spends a
  // seat, and the divert releases the seat this offer was holding (an 'offered'
  // entry counts against `remaining` — see `countHeldSeats`). Only the credits
  // branch moves per-dog balances.
  let touchedLocation: LocationKey | undefined;
  let creditDebitedDogIds = new Set<string>();

  return withMutation<BookingWire[] | DivertedBookingWire>(
    {
      principal,
      idempotencyKey: args.idempotencyKey,
      endpoint: 'POST /waitlist/:id/accept',
      requestHash: hashRequestBody({ ownerId: principal.ownerId, id: entryId, ...body }),
      patternsToInvalidate: () => [
        ...(touchedLocation === undefined ? [] : [`avail:${touchedLocation}:*`]),
        ...[...creditDebitedDogIds].map(creditsInvalidationPattern),
      ],
    },
    async (tx) => {
      const now = args.now();
      const entry = await requireOfferedEntry(tx, { id: entryId, ownerId: principal.ownerId });
      const target = targetOfEntry(entry);
      if (target.kind !== 'day-program') {
        // The pre-tx peek routed on `category`; a row that changed shape between
        // the two reads is a violated DDL CHECK, not a request to handle.
        throw new Error(`waitlist entry ${entryId}: expected a day-program target`);
      }
      assertOfferStillAcceptable(entry, target, now);
      touchedLocation = target.location;

      // Ownership is re-checked, not trusted from join time. Accept must never
      // be a looser path into a booking than POST /bookings, which gates every
      // dog on every request.
      for (const dogId of entry.dogIds) {
        const owned = await dogsRepository.findOwnedExists(dogId, principal.ownerId, tx);
        if (!owned) throw new ApiError('not_found', 'one or more dogs were not found');
      }

      const scheduledAt = computeDayProgramScheduledAt(
        target.category,
        target.sessionDate,
        dropoff,
      );

      // The approval divert (Shanthi 2026-07-14) runs BEFORE the creation core,
      // the same order POST /bookings runs it in. A staff cap override does NOT
      // suppress it: offering a seat says "there is room", not "I have looked at
      // this dog", and the staff verb that overrides the divert is
      // `POST /staff/requests/:id/approve`.
      const divertReasons = await resolveApprovalDivert(tx, { dogIds: entry.dogIds, now });
      if (divertReasons.length > 0) {
        const requestWire = await divertAcceptToStaff(tx, {
          entry,
          target,
          scheduledAt,
          payment,
          notes: body.notes ?? null,
          divertReasons,
          now,
        });
        // The offer is consumed either way — leaving it 'offered' would let the
        // deadline lapse into a re-offer of a seat a pending request is already
        // spoken for, and would let the owner file a second request. It resolves
        // to 'cancelled' rather than 'accepted' because `waitlist_entries` has
        // no column for the request it became (`booking_id` is the only link,
        // and `waitlist_accepted_has_booking` requires it): 'cancelled' is the
        // one terminal status that honestly says "out of the queue, nothing
        // owed", which is the state the owner is in while staff review. Their
        // seat is released to the next in line — the alternative is holding a
        // seat hostage to a staff queue that may take days.
        const resolved = await waitlistRepository.resolve(tx, {
          id: entryId,
          from: 'offered',
          to: 'cancelled',
          resolvedAt: now,
        });
        if (!resolved) {
          throw new ApiError('conflict', 'this waitlist offer was already resolved');
        }
        return {
          status: 202,
          body: { diverted: true, divert_reasons: divertReasons, request: requestWire },
        };
      }

      // The shared creation core. It re-runs `checkBookingGates` itself — and
      // does it INSIDE the (dog, mode) + (location, date) locks, which is
      // strictly better than re-checking out here where a concurrent change
      // could slip between the check and the insert. That call is Allison's
      // point-5 re-run; there is deliberately no second one.
      const result = await createDayProgramBookings(tx, {
        ownerId: principal.ownerId,
        category: target.category,
        leadDogId: entry.leadDogId,
        additionalDogIds: entry.dogIds.filter((dogId) => dogId !== entry.leadDogId),
        sessions: [{ date: target.sessionDate, scheduledAt }],
        location: target.location,
        notes: body.notes ?? null,
        payment,
        now,
        // Ruling 2. The day is full by definition — that is the only state a
        // waitlist entry can exist in — so without this a staff override
        // notifies the owner "a spot opened up" and then 422s at accept.
        allowOverCapacity: entry.offeredByStaffId !== null,
        // This entry's own hold is the seat being booked; counting it would
        // refuse the owner their own offer.
        convertingWaitlistEntryId: entryId,
      });
      creditDebitedDogIds = result.creditDebitedDogIds;

      const booking = result.wires[0];
      if (booking === undefined) {
        // One session in, one booking out — an empty result is a bug in the
        // creation core, not a state the owner can reach.
        throw new Error(`waitlist accept ${entryId}: booking creation returned no rows`);
      }

      const resolved = await waitlistRepository.resolve(tx, {
        id: entryId,
        from: 'offered',
        to: 'accepted',
        resolvedAt: now,
        bookingId: booking.id,
      });
      if (!resolved) {
        // Someone else moved the entry out of 'offered' while we were booking
        // (a racing accept, or the expiry sweep). Fail so the booking rolls
        // back — a committed booking with no entry pointing at it is a seat
        // nobody can account for.
        throw new ApiError('conflict', 'this waitlist offer was already resolved');
      }
      return { status: 201, body: result.wires };
    },
  );
}

/**
 * Park a diverted accept as a `pending_requests` row — byte-for-byte the
 * sequence POST /bookings runs, down to the lock order, so staff see one kind
 * of request whatever created it.
 */
async function divertAcceptToStaff(
  tx: Tx,
  args: {
    entry: WaitlistEntryRow;
    target: Extract<WaitlistTarget, { kind: 'day-program' }>;
    scheduledAt: Date;
    payment: DayProgramPaymentPlan;
    notes: string | null;
    divertReasons: string[];
    now: Date;
  },
): Promise<Awaited<ReturnType<typeof wireOneRequest>>> {
  const { entry, target } = args;
  const additionalDogIds = entry.dogIds.filter((dogId) => dogId !== entry.leadDogId);

  // Two lock layers (Δ 2026-07-16): the outer location-AGNOSTIC divert lock
  // serializes the duplicate guard — "one open request per (dog, category)" is
  // location-agnostic — and the inner (dog, mode, location) locks keep the same
  // canonical order as `createDayProgramBookings`, so a concurrent instant-book
  // on the same dog serializes too.
  return withDivertRequestLocks(tx, entry.dogIds, target.category, () =>
    withDogModeLocks(tx, entry.dogIds, target.mode, target.location, async () => {
      // Everything ELSE about the submission must be valid before we park it in
      // the staff queue — gates + (for PAYG) the card/rate — so staff never
      // approve into a guaranteed bounce and the owner fixes real blockers NOW,
      // not after a wasted approval round-trip.
      await checkBookingGates(tx, {
        ownerId: entry.ownerId,
        dogIds: entry.dogIds,
        category: target.category,
      });
      await resolvePaygPlan(tx, {
        payment: args.payment,
        category: target.category,
        location: target.location,
        ownerId: entry.ownerId,
        now: args.now,
      });

      const alreadyRequested = await requestsRepository.findOpenByDogsAndCategory(
        tx,
        entry.dogIds,
        target.category,
      );
      if (alreadyRequested.length > 0) {
        throw alreadyRequestedError({ category: target.category, dog_ids: alreadyRequested });
      }

      const { id: requestId } = await requestsRepository.create(tx, {
        ownerId: entry.ownerId,
        leadDogId: entry.leadDogId,
        category: target.category,
        notesPerDog: null,
        notesJoint: args.notes,
        staffPreference: null,
        descriptorKeys: [],
        lengthWeeks: null,
        location: target.location,
        payment: args.payment.kind,
        ...(args.payment.kind === 'payg' ? { paymentMethodId: args.payment.paymentMethodId } : {}),
        divertReasons: args.divertReasons,
      });
      await requestsRepository.addDogs(tx, requestId, {
        lead: entry.leadDogId,
        additional: additionalDogIds,
      });
      // The exact session instant rides in preferred_dates — the approve
      // conversion books it verbatim (no recompute).
      await requestsRepository.addPreferredDates(tx, requestId, [args.scheduledAt.toISOString()]);

      const full = await requestsRepository.findFullByIdInTx(tx, requestId);
      if (full === undefined) {
        throw new Error(`divert ${requestId}: row vanished before re-fetch`);
      }
      return wireOneRequest(tx, full);
    }),
  );
}

/**
 * Accept a GROUP-CLASS offer: enroll the dogs in the cohort through the same
 * `lib/createCohortEnrollment` core POST /enrollments runs, including the
 * pre-transaction card charge and its unwind.
 *
 * Group-class is money-paid per (cohort, dog), so `payment_method_id` is
 * required here even though a day-program accept can omit it. Pay-now (the
 * default) confirms one PaymentIntent per dog BEFORE the transaction — a long
 * Stripe call can't pin a transaction open, and a declined card must block the
 * accept — and every path that fails afterwards unwinds that money.
 *
 * KNOWN LIMIT (2026-07-31): a staff cap override cannot get past a full cohort.
 * `cohorts` carries `CHECK (filled <= capacity)` in the DDL, so unlike the
 * day-program ceiling there is nothing the API can relax — the `filled` bump
 * itself would abort. An overridden cohort offer therefore still answers
 * `cohort_full`; the remedy is raising `cohorts.capacity`, which is a staff
 * cohort edit, not an accept-time flag.
 */
async function acceptCohortOffer(
  args: Omit<AcceptOfferArgs, 'entryId'> & {
    /** The pre-transaction read, for the cohort id and the roster to charge. */
    entry: WaitlistEntryRow;
    stripe: StripeClient;
    log: FastifyBaseLogger;
  },
): Promise<IdempotencyOutcome<BookingWire[] | DivertedBookingWire>> {
  const { principal, entry, body, idempotencyKey } = args;
  const entryId = entry.id;
  if (body.payment_method_id === undefined) {
    throw new ApiError(
      'invalid_payload',
      'payment_method_id is required to accept a group-class offer',
    );
  }
  const paymentMethodId = body.payment_method_id;
  const payLater = body.pay_later ?? false;

  const target = targetOfEntry(entry);
  if (target.kind !== 'group-class') {
    throw new Error(`waitlist entry ${entryId}: expected a group-class target`);
  }
  // Deterministic dog order, matching POST /enrollments: the charge loop and the
  // booking rows walk the same sorted list.
  const dogIds = [...entry.dogIds].sort();

  const amountPerDogCents = await resolvePerDogPriceCents(target.cohortId);
  // Only a LIVE offer reaches the card. An idempotent replay arrives with the
  // entry already 'accepted' and must not re-enter the card flow — `withMutation`
  // answers it from the stored response — and an offer that is dead for any
  // other reason should 404 out of the transaction with no money moved.
  const paidIntents =
    payLater || entry.status !== 'offered'
      ? []
      : await chargeEachDogNow({
          stripe: args.stripe,
          ownerId: principal.ownerId,
          paymentMethodId,
          cohortId: target.cohortId,
          dogIds,
          amountPerDogCents,
          idempotencyKey,
          log: args.log,
        });

  try {
    assertAllIntentsSucceeded(paidIntents);

    return await withMutation<BookingWire[] | DivertedBookingWire>(
      {
        principal,
        idempotencyKey,
        endpoint: 'POST /waitlist/:id/accept',
        requestHash: hashRequestBody({ ownerId: principal.ownerId, id: entryId, ...body }),
        // Enrollment touches no cache key today — same declaration
        // POST /enrollments makes, for the same reason.
        keysToInvalidate: () => [],
      },
      async (tx) => {
        const now = args.now();
        const locked = await requireOfferedEntry(tx, { id: entryId, ownerId: principal.ownerId });
        const lockedTarget = targetOfEntry(locked);
        if (lockedTarget.kind !== 'group-class' || lockedTarget.cohortId !== target.cohortId) {
          throw new Error(`waitlist entry ${entryId}: target changed between read and accept`);
        }
        assertOfferStillAcceptable(locked, lockedTarget, now);

        // Ownership is re-checked, not trusted from join time — accept must
        // never be a looser path into an enrollment than POST /enrollments.
        for (const dogId of dogIds) {
          const owned = await dogsRepository.findOwnedExists(dogId, principal.ownerId, tx);
          if (!owned) throw new ApiError('not_found', 'one or more dogs were not found');
        }

        const wires = await createCohortEnrollment(tx, {
          ownerId: principal.ownerId,
          cohortId: lockedTarget.cohortId,
          dogIds,
          payment: payLater
            ? { kind: 'pay-later', paymentMethodId, amountPerDogCents }
            : { kind: 'pay-now', intents: paidIntents },
        });

        const booking = wires[0];
        if (booking === undefined) {
          // `cohorts.weeks > 0` and at least one dog, so the core always
          // produces rows — an empty result is a bug, not a reachable state.
          throw new Error(`waitlist accept ${entryId}: enrollment returned no rows`);
        }
        const resolved = await waitlistRepository.resolve(tx, {
          id: entryId,
          from: 'offered',
          to: 'accepted',
          resolvedAt: now,
          // The first weekly session stands for the enrollment: `booking_id` is
          // singular and `waitlist_accepted_has_booking` demands one, so it
          // points at the session the owner is next going to.
          bookingId: booking.id,
        });
        if (!resolved) {
          throw new ApiError('conflict', 'this waitlist offer was already resolved');
        }
        return { status: 201, body: wires };
      },
    );
  } catch (err) {
    // Money was captured but the enrollment did not commit — refund/cancel it
    // all so nothing is stranded, then re-raise the original error so the owner
    // still gets the right 4xx (cohort_full, eligibility_missing, …).
    await unwindCapturedIntents(args.stripe, paidIntents, idempotencyKey, args.log);
    throw err;
  }
}

/**
 * Can this offer still become a booking? Two ways it can't, both checked here
 * rather than left to the expiry sweep — the sweep runs on a schedule, and "the
 * cleanup job hasn't got to it yet" is not a reason to hand out a seat that has
 * already moved on:
 *
 *   - The deadline passed. The seat is the next dog's now.
 *   - The session has STARTED (ruling 4, "the entry dies when the session
 *     starts"). POST /bookings refuses to book a past day outright, and
 *     accepting into one would make the waitlist the loose path into a booking.
 *     Not redundant with the deadline above: `promoteForTarget` clamps its
 *     offers to the session start, but the staff cap-override in
 *     `routes/staffWaitlist.ts` calls `markOffered` directly with a plain
 *     now+window deadline, which can outlive the day it is for.
 *
 *     The comparison is against the session's INSTANT — 07:30 America/Chicago,
 *     the drop-off window's opening — because that is what the rest of the
 *     system means by "the session started": `waitlistPromotion` refuses to
 *     promote past it, `waitlistRepository.findLiveWithStartedSession` sweeps
 *     against it, and the booking this creates is scheduled from it. Comparing
 *     calendar DATES instead (the 2026-07-30 spelling) accepted an offer at
 *     4pm into a session that had been running since half past seven.
 *
 * Group-class offers carry no date on the entry — the cohort row owns the start
 * instant — so their liveness is the cohort lock's business, not this check's.
 *
 * Deliberately NOT called by decline — see the note there.
 */
function assertOfferStillAcceptable(
  entry: WaitlistEntryRow,
  target: WaitlistTarget,
  now: Date,
): void {
  if (entry.offerExpiresAt === null) {
    // `waitlist_offer_has_deadline` makes this unreachable for an 'offered'
    // row. Loud rather than lenient: a deadline-less offer never expires.
    throw new Error(`waitlist entry ${entry.id}: status 'offered' with no offer_expires_at`);
  }
  if (new Date(entry.offerExpiresAt).getTime() <= now.getTime()) {
    throw new ApiError(
      'conflict',
      'this offer has expired — the seat has gone to the next dog in line',
    );
  }
  if (target.kind === 'day-program') {
    const sessionStartsAt = computeDayProgramScheduledAt(
      target.category,
      target.sessionDate,
      DEFAULT_DROPOFF_TIME,
    );
    if (sessionStartsAt.getTime() <= now.getTime()) {
      // Same wording `routes/staffWaitlist.ts` refuses a stale override with.
      throw new ApiError('conflict', 'that session has already passed');
    }
  }
}

/**
 * The entry's target as the discriminated shape the rest of the waitlist code
 * speaks. The DDL's `waitlist_target_shape` CHECK already guarantees the
 * columns line up with the category, so a mismatch reaching here is a broken
 * invariant rather than a bad request — booking at a guessed school would be
 * worse than failing loudly.
 */
function targetOfEntry(entry: WaitlistEntryRow): WaitlistTarget {
  if (entry.category === 'group-class') {
    if (entry.cohortId === null) {
      throw new Error(`waitlist entry ${entry.id}: group-class entry has no cohort_id`);
    }
    return { kind: 'group-class', cohortId: entry.cohortId };
  }
  if (entry.category !== 'day-school' && entry.category !== 'day-care') {
    throw new Error(`waitlist entry ${entry.id}: unsupported category '${entry.category}'`);
  }
  if (entry.sessionDate === null || entry.location === null || entry.mode === null) {
    throw new Error(`waitlist entry ${entry.id}: day-program entry is missing its target columns`);
  }
  return {
    kind: 'day-program',
    category: entry.category,
    sessionDate: entry.sessionDate,
    location: entry.location,
    mode: entry.mode,
  };
}

/**
 * The accept body's payment fields as the tagged plan the creation core takes.
 * Credits is the default (field omitted); PAYG needs a card, whose ownership
 * and liveness `resolvePaygPlan` validates in-tx — presence is all that's
 * checked here.
 *
 * Twin of `resolvePaymentPlan` in `routes/bookings.ts`; the rule is identical
 * because accepting an offer pays for the seat on exactly the rules a direct
 * booking would have. Rule-of-two — worth extracting alongside
 * `postBookingBodySchema`'s payment fields if a third caller appears.
 */
function resolveAcceptPaymentPlan(body: AcceptBody): DayProgramPaymentPlan {
  if ((body.payment ?? 'credits') === 'credits') return { kind: 'credits' };
  if (body.payment_method_id === undefined) {
    throw new ApiError('invalid_payload', 'payment_method_id is required when payment is payg');
  }
  return { kind: 'payg', paymentMethodId: body.payment_method_id };
}

/** The cohort's class key, for the vaccine gate's class-key exemption. */
async function resolveCohortClassKey(cohortId: string): Promise<string> {
  const cohort = await cohortsRepository.findById(cohortId);
  if (cohort === undefined) throw new ApiError('not_found', 'cohort not found');
  return cohort.classKey;
}

/**
 * Reject a join when the target still has room for this many dogs. A waitlist
 * that accepts entries for a session you could just book is a UI that lies
 * about what's happening.
 */
async function assertTargetIsFull(
  tx: Tx,
  target: WaitlistTarget,
  requestedCount: number,
): Promise<void> {
  if (target.kind === 'day-program') {
    const { openings, remaining } = await dayCapacityRepository.capacityForDay(tx, {
      location: target.location,
      date: target.sessionDate,
      mode: target.mode,
    });
    // CLOSED is not FULL. A day with no openings at all (weekend under the
    // default rule, or a staff override to zero) can never free a seat, so a
    // queue for it would be a promise we can't keep. Caught in smoke testing —
    // the first join attempt happily queued a dog for a Sunday.
    if (openings === 0) {
      throw new ApiError(
        'waitlist_not_needed',
        'the school is closed that day — there is no seat to wait for',
      );
    }
    if (remaining >= requestedCount) {
      throw new ApiError(
        'waitlist_not_needed',
        `there are still ${remaining} seat(s) on that day — book it instead of joining the waitlist`,
      );
    }
    return;
  }
  const cohort = await cohortsRepository.findById(target.cohortId);
  if (cohort === undefined) throw new ApiError('not_found', 'cohort not found');
  const remaining = cohort.capacity - cohort.filled;
  if (remaining >= requestedCount) {
    throw new ApiError(
      'waitlist_not_needed',
      `there are still ${remaining} seat(s) in that class — enroll instead of joining the waitlist`,
    );
  }
}
