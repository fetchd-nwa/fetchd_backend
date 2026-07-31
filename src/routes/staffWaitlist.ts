import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asc, eq, inArray } from 'drizzle-orm';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import { deepLinkToPath } from '../contracts/wire.js';
import { db } from '../db/client.js';
import { lockCohort } from '../db/locks.js';
import { hashRequestBody, requireIdempotencyKey, withMutation } from '../db/mutation.js';
import { dayCapacityRepository } from '../db/repositories/dayCapacityRepository.js';
import { scheduledNotificationsRepository } from '../db/repositories/scheduledNotificationsRepository.js';
import {
  waitlistRepository,
  waitlistTargetOf,
  LIVE_WAITLIST_STATUSES,
  type WaitlistTarget,
} from '../db/repositories/waitlistRepository.js';
import { waitlistEntries, waitlistEntryDogs } from '../db/schema/schema.js';
import { DAY_PROGRAM_DROPOFF_WINDOW } from '../lib/bookingBucket.js';
import { chicagoWallTimeToUtc } from '../lib/chicagoDate.js';
import { ApiError } from '../lib/errors.js';
import { pgTimestampToDate } from '../lib/pgTimestamp.js';
import { requireStaff } from '../lib/principalNarrows.js';
import { OFFER_WINDOW_HOURS } from '../lib/waitlistPromotion.js';
import { parseOrThrow } from '../lib/zodIssues.js';
import type { Tx } from '../db/tx.js';

/**
 * Staff waitlist surface (Allison 2026-07-30 ruling 2: "staff can override the
 * cap"). Two verbs:
 *
 *   - `GET  /staff/waitlist`           — every live queue, FIFO, with positions.
 *   - `POST /staff/waitlist/:id/offer` — offer a seat REGARDLESS of capacity.
 *
 * The override is deliberately narrow. It skips the *capacity* check that the
 * automatic promotion path waits on — nothing else. It still refuses a CLOSED
 * day and a session that has already started, takes the same per-queue lock
 * promotion takes, and clamps its deadline to the session start the same way:
 * an override is a decision to exceed the cap, not a second, looser way to hand
 * out a seat. The four booking gates
 * (vaccines, agreements, evaluation, balance) are BEFORE-INSERT triggers on
 * `bookings` and stay unbypassable: this verb creates no booking, it creates an
 * OFFER, and the gates re-run when the owner accepts (ruling 5). So an override
 * can hand someone a seat they still can't take — which is correct, because the
 * alternative is staff silently bypassing a rabies-vaccine requirement.
 *
 * `offered_by_staff_id` is the provenance column: NULL means a seat genuinely
 * freed, set means a human decided to exceed the cap. That distinction is the
 * whole audit trail for "why does this day have 13 dogs in 12 slots".
 *
 * No money moves here (ruling 1) — the owner pays on accept, through the normal
 * payment flow.
 *
 * Injectable clock: a `now?: () => Date` factory keeps contract tests
 * deterministic; production uses `() => new Date()`.
 */

export interface StaffWaitlistRouteOptions extends AuthRouteOptions {
  now?: () => Date;
}

/**
 * An overridden offer stands for the same window an automatic one does —
 * `OFFER_WINDOW_HOURS` from `lib/waitlistPromotion`, imported rather than
 * re-declared. Two independent "24" constants would drift the day someone
 * retunes one of them, and an owner would get a different deadline depending on
 * which surface handed them the seat. Staff can shorten or lengthen theirs; the
 * window is never optional, because an offer without a deadline stalls everyone
 * behind it forever (schema.sql's `waitlist_offer_has_deadline` CHECK exists
 * for exactly this).
 */
const MAX_OFFER_WINDOW_HOURS = 168;

const HOURS_IN_MS = 60 * 60 * 1000;

const offerBodySchema = z
  .object({
    offer_expires_in_hours: z
      .number()
      .int()
      .min(1)
      .max(MAX_OFFER_WINDOW_HOURS)
      .optional(),
  })
  .strict();

const entryIdParamSchema = z.object({ id: z.string().uuid('id must be a UUID') });

/**
 * The staff view of a queue entry. Distinct from the owner-facing
 * `WaitlistEntryWire` in `routes/waitlist.ts` rather than shared with it,
 * because the two audiences differ in exactly the fields that matter: staff need
 * `owner_id` (who is waiting) and `offered_by_staff_id` (who overrode the cap),
 * and the owner surface deliberately exposes neither.
 */
export interface StaffWaitlistEntryWire {
  id: string;
  owner_id: string;
  category: string;
  status: string;
  dog_ids: string[];
  /** 1-based place in line among the live entries for the same target. */
  position: number;
  /** Offered entries only — when the offer lapses if unanswered. */
  offer_expires_at?: string;
  /** Set ⇒ this offer was a staff cap override, not a freed seat. */
  offered_by_staff_id?: string;
  created_at: string;
}

/** One queue: the thing there's a shortage of, plus who is in line for it. */
export interface StaffWaitlistQueueWire {
  category: string;
  session_date?: string;
  location?: string;
  cohort_id?: string;
  entries: StaffWaitlistEntryWire[];
}

/**
 * Cross-owner reads of `waitlist_entries`. `waitlistRepository`'s finders are
 * all owner-scoped (`findByIdForOwner`, `findLiveForOwner`) or single-target
 * (`findWaitingQueue`); staff need every owner's rows and every target at once,
 * which no seam exposes today. Kept as a narrow projection in the route rather
 * than a hand-rolled Drizzle query scattered through the handlers — the same
 * shape decision `routes/agreements.ts` made for its catalog join.
 */
const STAFF_ENTRY_PROJECTION = {
  id: waitlistEntries.id,
  ownerId: waitlistEntries.ownerId,
  leadDogId: waitlistEntries.leadDogId,
  category: waitlistEntries.category,
  status: waitlistEntries.status,
  sessionDate: waitlistEntries.sessionDate,
  location: waitlistEntries.location,
  mode: waitlistEntries.mode,
  cohortId: waitlistEntries.cohortId,
  offerExpiresAt: waitlistEntries.offerExpiresAt,
  offeredByStaffId: waitlistEntries.offeredByStaffId,
  createdAt: waitlistEntries.createdAt,
} as const;

type StaffWaitlistRow = Pick<
  typeof waitlistEntries.$inferSelect,
  keyof typeof STAFF_ENTRY_PROJECTION
>;

/** Polymorphic runner — pool for reads, Tx for in-mutation work. */
type Runner = Tx | typeof db;

export function registerStaffWaitlistRoutes(
  app: FastifyInstance,
  opts: StaffWaitlistRouteOptions = {},
): void {
  const authHook = resolveAuthHook(opts);
  const nowFactory = opts.now ?? ((): Date => new Date());

  // --- GET /staff/waitlist -------------------------------------------------
  //
  // Read-only triage view: who is waiting for what, in the order they'll be
  // promoted. Staff read this BEFORE overriding, so the override is a decision
  // about a specific person rather than a blind cap bump.
  app.get(
    '/staff/waitlist',
    { preHandler: [authHook] },
    async (request): Promise<{ queues: StaffWaitlistQueueWire[] }> => {
      const principal = requirePrincipal(request);
      requireStaff(principal, 'read the waitlist queues');

      // Ordered by target first, then FIFO within it, so the groups come out
      // contiguous AND each entry's index inside its group IS its position —
      // the same (created_at, id) tiebreak `waitlistRepository.positionOf`
      // uses, so the two surfaces can never disagree about who is first.
      const rows = await db
        .select(STAFF_ENTRY_PROJECTION)
        .from(waitlistEntries)
        .where(inArray(waitlistEntries.status, [...LIVE_WAITLIST_STATUSES]))
        .orderBy(
          asc(waitlistEntries.sessionDate),
          asc(waitlistEntries.location),
          asc(waitlistEntries.mode),
          asc(waitlistEntries.cohortId),
          asc(waitlistEntries.createdAt),
          asc(waitlistEntries.id),
        );

      const dogIdsByEntry = await readDogIdsByEntry(db, rows);
      return { queues: groupIntoQueues(rows, dogIdsByEntry) };
    },
  );

  // --- POST /staff/waitlist/:id/offer --------------------------------------
  app.post(
    '/staff/waitlist/:id/offer',
    { preHandler: [authHook] },
    async (request, reply): Promise<StaffWaitlistEntryWire> => {
      const principal = requirePrincipal(request);
      requireStaff(principal, 'offer a waitlist spot');
      const { id } = parseOrThrow(entryIdParamSchema, request.params, 'params');
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
      const body = parseOrThrow(offerBodySchema, request.body ?? {}, 'body');
      const windowHours = body.offer_expires_in_hours ?? OFFER_WINDOW_HOURS;

      const outcome = await withMutation<StaffWaitlistEntryWire>(
        {
          principal,
          idempotencyKey,
          endpoint: 'POST /staff/waitlist/:id/offer',
          requestHash: hashRequestBody({ id, ...body }),
        },
        async (tx) => {
          const now = nowFactory();
          const entry = await findEntryById(tx, id);
          // Unknown, or already offered/resolved: nothing here for staff to
          // act on. Collapsed to 404 rather than split into 404/409 because
          // the queue view is the only way to reach this verb and it never
          // shows a resolved entry — a stale id and a stale state are the
          // same mistake to the caller.
          if (entry === undefined || entry.status !== 'waiting') {
            throw new ApiError('not_found', 'waitlist entry not found');
          }
          const dogIds = (await readDogIdsByEntry(tx, [entry])).get(entry.id) ?? [];
          const target = waitlistTargetOf({ ...entry, dogIds });

          // Serialize against the scheduler's promotion pass on this queue.
          // Both surfaces hand out seats, and an offer HOLDS its seats — so a
          // staff offer racing a promotion can leave two entries holding one
          // seat. `markOffered`'s status guard cannot catch that: the two
          // passes pick DIFFERENT rows and both UPDATEs succeed. Taken before
          // anything is decided, and before `lockCohort` below, which is the
          // order `promoteForTarget` acquires them in.
          await waitlistRepository.lockQueue(tx, target);

          // Ruling 4: the entry dies when the session starts. Offering into a
          // session already under way produces an offer the owner cannot
          // accept — and `cancelEntriesForStartedSessions` would cancel it on
          // the very next scheduler tick anyway.
          const sessionStartsAt = await resolveSessionStart(tx, target);
          if (sessionStartsAt === undefined) {
            throw new ApiError('conflict', 'that class is no longer scheduled');
          }
          if (sessionStartsAt.getTime() <= now.getTime()) {
            throw new ApiError(
              'conflict',
              entry.sessionDate === null
                ? 'that class has already started'
                : `that session was ${entry.sessionDate} — it has already started`,
            );
          }
          await assertDayIsOpen(tx, target);

          // Never let an offer outlive the session it is for — the same clamp
          // `promoteForTarget` applies, for the same reason: an offer that
          // expires after drop-off can't be accepted and would hold the seat
          // until then instead of rolling to someone who could still use it.
          const offerExpiresAt = new Date(
            Math.min(now.getTime() + windowHours * HOURS_IN_MS, sessionStartsAt.getTime()),
          );
          // No capacity check — this verb IS the cap override. The conditional
          // update is still the concurrency guard: if the automatic promotion
          // pass offered this entry between our read and here, we get `false`
          // and 404 rather than double-offering one seat.
          const offered = await waitlistRepository.markOffered(tx, {
            id,
            offeredAt: now,
            offerExpiresAt,
            offeredByStaffId: principal.staffId,
          });
          if (!offered) {
            throw new ApiError('not_found', 'waitlist entry not found');
          }

          await scheduledNotificationsRepository.enqueueIdempotent(tx, {
            ownerId: entry.ownerId,
            type: 'waitlist-spot-open',
            // The provenance the automatic path can't claim: a human decided
            // this seat existed. `offered_by_staff_id` carries the same fact on
            // the entry; this carries it into the notification audit trail.
            trigger: 'waitlist-staff-override',
            // Keyed on the OFFER, not the entry: `offered_at` is restamped by
            // every `markOffered`, so an entry that lapses and is re-offered
            // gets a fresh key and a second notification instead of being
            // swallowed by ON CONFLICT DO NOTHING.
            dedupeKey: `waitlist-spot-open:${entry.id}:${now.toISOString()}`,
            scheduledFor: now,
            title: 'A spot opened up',
            body: offerNotificationBody(entry, offerExpiresAt),
            deepLinkPath: deepLinkToPath({ kind: 'waitlist', id: entry.id }),
            deepLinkKind: 'waitlist',
            deepLinkId: entry.id,
            dogId: entry.leadDogId,
          });

          // An offered entry keeps its place in line, so the position is the
          // one the owner already saw — re-read it rather than assume 1.
          const position = (await waitlistRepository.positionOf(tx, entry.id)) ?? 1;
          // The conditional UPDATE above returned true, so these three fields
          // ARE what was persisted — cheaper and no less honest than a re-read.
          const wire = toStaffEntryWire(
            {
              ...entry,
              status: 'offered',
              offerExpiresAt: offerExpiresAt.toISOString(),
              offeredByStaffId: principal.staffId,
            },
            dogIds,
            position,
          );
          return { status: 200, body: wire };
        },
      );

      reply.code(outcome.status);
      return outcome.body;
    },
  );
}

// ---- target checks ----------------------------------------------------

/**
 * When the thing this entry is queued for actually starts. It is both the
 * ruling-4 death line and the ceiling on any offer deadline.
 *
 * A day-program row carries only a DATE, so the earliest a seat could be used
 * is the drop-off window opening — the same `DAY_PROGRAM_DROPOFF_WINDOW.open`
 * constant `computeDayProgramScheduledAt` defaults a booking to and
 * `waitlistRepository.findLiveWithStartedSession` reconstructs in SQL. A cohort
 * carries a real start instant, row-locked the way `promoteForTarget` locks it.
 *
 * `undefined` = the target no longer exists (a soft-expired cohort). There is
 * nothing to offer a seat in, which is a different answer from "it started".
 */
async function resolveSessionStart(tx: Tx, target: WaitlistTarget): Promise<Date | undefined> {
  if (target.kind === 'day-program') {
    return chicagoWallTimeToUtc(
      target.sessionDate,
      DAY_PROGRAM_DROPOFF_WINDOW.open.hour,
      DAY_PROGRAM_DROPOFF_WINDOW.open.minute,
    );
  }
  const cohort = await lockCohort(tx, target.cohortId);
  if (cohort === undefined || cohort.expiredAt !== null) return undefined;
  return pgTimestampToDate(cohort.startDate);
}

/**
 * `openings === 0` means the school is CLOSED that day — categorically
 * different from full, and the one thing the cap override does NOT cover. Staff
 * can seat a 13th dog in 12 slots; they cannot seat a dog on a day the school
 * isn't running, because accepting would have to create a booking on a closed
 * day. Both other waitlist surfaces (`POST /waitlist`'s join check and
 * `promoteForTarget`) draw the same line.
 *
 * Group-class entries have no day capacity to be closed; their equivalent —
 * the cohort no longer being live — is handled in `resolveSessionStart`.
 */
async function assertDayIsOpen(tx: Tx, target: WaitlistTarget): Promise<void> {
  if (target.kind !== 'day-program') return;
  const { openings } = await dayCapacityRepository.capacityForDay(tx, {
    location: target.location,
    date: target.sessionDate,
    mode: target.mode,
  });
  if (openings === 0) {
    throw new ApiError('conflict', 'the school is closed that day — there is no seat to offer');
  }
}

// ---- cross-owner reads ------------------------------------------------

/**
 * One entry, any owner — the staff counterpart to `findByIdForOwner`.
 *
 * Selects every column rather than `STAFF_ENTRY_PROJECTION`: the offer handler
 * hands the row (plus its dogs) to `waitlistTargetOf`, which takes a whole
 * `WaitlistEntryRow`. Projecting would mean re-listing that type's columns here
 * and re-listing them again every time the waitlist grows one. It is a
 * single-row read on one table — there is nothing to save.
 */
async function findEntryById(
  runner: Runner,
  id: string,
): Promise<typeof waitlistEntries.$inferSelect | undefined> {
  const [row] = await runner
    .select()
    .from(waitlistEntries)
    .where(eq(waitlistEntries.id, id))
    .limit(1);
  return row;
}

/**
 * Every entry's dog ids in ONE round trip (no N+1 across the queue read), lead
 * first so the portal can render "Waffles + 1" without re-sorting — the same
 * ordering `waitlistRepository`'s `withDogs` produces.
 */
async function readDogIdsByEntry(
  runner: Runner,
  rows: readonly { id: string }[],
): Promise<Map<string, string[]>> {
  const byEntry = new Map<string, string[]>();
  if (rows.length === 0) return byEntry;
  const links = await runner
    .select({
      entryId: waitlistEntryDogs.waitlistEntryId,
      dogId: waitlistEntryDogs.dogId,
      isLead: waitlistEntryDogs.isLead,
    })
    .from(waitlistEntryDogs)
    .where(
      inArray(
        waitlistEntryDogs.waitlistEntryId,
        rows.map((r) => r.id),
      ),
    );
  const grouped = new Map<string, { dogId: string; isLead: boolean }[]>();
  for (const link of links) {
    const list = grouped.get(link.entryId) ?? [];
    list.push({ dogId: link.dogId, isLead: link.isLead });
    grouped.set(link.entryId, list);
  }
  for (const [entryId, dogs] of grouped) {
    byEntry.set(
      entryId,
      dogs.sort((a, b) => Number(b.isLead) - Number(a.isLead)).map((d) => d.dogId),
    );
  }
  return byEntry;
}

// ---- wire shaping -----------------------------------------------------

/**
 * The partition an entry queues in — the same tuple
 * `waitlistRepository.positionOf` partitions its `row_number()` over. Built
 * from the raw nullable columns (not a prettified label) so the two definitions
 * of "same queue" cannot drift apart.
 */
function targetKey(row: StaffWaitlistRow): string {
  return [row.sessionDate, row.location, row.mode, row.cohortId].join('|');
}

function toStaffEntryWire(
  row: StaffWaitlistRow,
  dogIds: string[],
  position: number,
): StaffWaitlistEntryWire {
  const wire: StaffWaitlistEntryWire = {
    id: row.id,
    owner_id: row.ownerId,
    category: row.category,
    status: row.status,
    dog_ids: dogIds,
    position,
    created_at: row.createdAt,
  };
  if (row.offerExpiresAt !== null) wire.offer_expires_at = row.offerExpiresAt;
  if (row.offeredByStaffId !== null) wire.offered_by_staff_id = row.offeredByStaffId;
  return wire;
}

function toQueueWire(row: StaffWaitlistRow): Omit<StaffWaitlistQueueWire, 'entries'> {
  const queue: Omit<StaffWaitlistQueueWire, 'entries'> = { category: row.category };
  if (row.sessionDate !== null) queue.session_date = row.sessionDate;
  if (row.location !== null) queue.location = row.location;
  if (row.cohortId !== null) queue.cohort_id = row.cohortId;
  return queue;
}

/**
 * Cut the target-ordered scan into queues. Relies on the caller's ORDER BY
 * putting same-target rows next to each other — a group boundary is simply the
 * point where `targetKey` changes, and an entry's index inside its group is its
 * FIFO position.
 */
function groupIntoQueues(
  rows: readonly StaffWaitlistRow[],
  dogIdsByEntry: Map<string, string[]>,
): StaffWaitlistQueueWire[] {
  const queues: StaffWaitlistQueueWire[] = [];
  let currentKey: string | undefined;
  let current: StaffWaitlistQueueWire | undefined;
  for (const row of rows) {
    const key = targetKey(row);
    if (current === undefined || key !== currentKey) {
      current = { ...toQueueWire(row), entries: [] };
      queues.push(current);
      currentKey = key;
    }
    current.entries.push(
      toStaffEntryWire(row, dogIdsByEntry.get(row.id) ?? [], current.entries.length + 1),
    );
  }
  return queues;
}

// ---- notification copy ------------------------------------------------

/**
 * `session_date` is a DATE column — a Chicago calendar day, not an instant. It
 * is formatted as a pure UTC round-trip: re-reading it through a Chicago
 * formatter would shift it a day, because midnight UTC lands on the previous
 * Chicago day.
 */
function formatSessionDate(sessionDate: string): string {
  return new Date(`${sessionDate}T00:00:00Z`).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
  });
}

/** The offer deadline IS an instant, so it reads in the business timezone. */
function formatOfferDeadline(at: Date): string {
  return at.toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * The offer copy. It says "nothing is charged" out loud because that is the
 * ruling most likely to be misread (Allison 2026-07-30 ruling 1): this is an
 * offer, money moves on accept, and an owner who assumes they've been billed
 * calls the front desk.
 */
function offerNotificationBody(row: StaffWaitlistRow, offerExpiresAt: Date): string {
  const claimBy = `Accept by ${formatOfferDeadline(offerExpiresAt)} to claim it — nothing is charged until you accept.`;
  if (row.cohortId !== null) {
    return `A spot opened up in your group class. ${claimBy}`;
  }
  if (row.sessionDate === null) {
    throw new Error(`waitlist entry ${row.id}: day-program entry has no session_date`);
  }
  // The DDL's `waitlist_target_shape` CHECK limits a dated entry to the two
  // day-program categories, so the binary choice is total.
  const label = row.category === 'day-care' ? 'Day Care' : 'Day School';
  return `A ${label} spot opened up for ${formatSessionDate(row.sessionDate)}. ${claimBy}`;
}
