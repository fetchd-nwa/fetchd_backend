import { withDogLocks } from '../db/locks.js';
import { bookingsRepository } from '../db/repositories/bookingsRepository.js';
import { dogsRepository } from '../db/repositories/dogsRepository.js';
import { staffRepository, type TrainerRow } from '../db/repositories/staffRepository.js';
import type { Tx } from '../db/tx.js';
import { bucketToChicagoDate } from './chicagoDate.js';
import { ApiError } from './errors.js';
import { pgTimestampToDate } from './pgTimestamp.js';

/**
 * The two services staff approve before anything is booked (plan unit P49, wire 9.0.0;
 * design request-services-v1 Part A; her 413, 414): a private lesson, booked when staff
 * confirm one of her times, and a Board & Train, booked when staff approve dates and a
 * trainer and the family says yes. Neither moves money (Shanthi #6.4, #6.8): the bill
 * after the service is plan unit P51's. What the three routes share lives here:
 * `routes/requests.ts` (A4), `routes/staffRequests.ts` (A3) and `routes/requestConfirm.ts`
 * (A2).
 */
export type RequestServiceCategory = 'private-lesson' | 'board-and-train';

export function isRequestService(category: string): category is RequestServiceCategory {
  return category === 'private-lesson' || category === 'board-and-train';
}

/** The one Board & Train program with a price (`lib/boardTrainPricing.ts`). */
export const BOARD_TRAIN_WEEKS = 2;

/**
 * Whether a staffer may be named for, and assigned, this service now: live, with a lesson
 * price for a lesson (having a price is what "teaches lessons" means) or Board & Train
 * eligible for a Board & Train. `GET /trainers` lists exactly these.
 */
export function trainerServes(row: TrainerRow, category: RequestServiceCategory): boolean {
  if (row.expiredAt !== null) return false;
  return category === 'private-lesson' ? row.lessonPriceCents !== null : row.boardTrainEligible;
}

/**
 * The staffer her `focus.staff_preference` names, live or expired, or `undefined` when she
 * chose "anyone": `'any'`, no preference, or a value naming no staff row (an old slug such
 * as `'rachel'`, dev only; notes R2).
 */
export async function namedTrainer(
  tx: Tx,
  preference: string | null,
): Promise<TrainerRow | undefined> {
  if (preference === null || preference === '' || preference === 'any') return undefined;
  return staffRepository.findTrainer(tx, preference);
}

/**
 * `POST /requests` and `PATCH /requests/:id` on a lesson or a Board & Train (A4): the
 * preference is `'any'` or the id of a staffer who serves the category now; omitted or
 * cleared means "anyone" and stays NULL. Answers the value to store: a staff id as the
 * staff row spells it, so the approve compares ids exactly. Anything else is 422.
 */
export async function validateStaffPreference(
  tx: Tx,
  category: RequestServiceCategory,
  preference: string | null,
): Promise<string | null> {
  if (preference === null || preference === 'any') return preference;
  const trainer = await staffRepository.findTrainer(tx, preference);
  if (trainer === undefined || !trainerServes(trainer, category)) {
    const what =
      category === 'private-lesson'
        ? 'a live staffer with a lesson price'
        : 'a live staffer who takes Board & Train';
    throw new ApiError(
      'invalid_payload',
      `focus.staff_preference must be 'any' or the staff_id of ${what}, as GET /trainers lists them`,
    );
  }
  return trainer.id;
}

const CHICAGO_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago',
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function chicagoParts(at: Date): Record<string, string> {
  return Object.fromEntries(CHICAGO_PARTS.formatToParts(at).map((p) => [p.type, p.value]));
}

/** "Mon 8 Jun", in America/Chicago. */
export function chicagoDay(at: Date): string {
  const p = chicagoParts(at);
  return `${p.weekday} ${p.day} ${p.month}`;
}

/** "Sat 6 Jun 10:00", in America/Chicago, 24-hour. */
export function chicagoDayTime(at: Date): string {
  const p = chicagoParts(at);
  return `${chicagoDay(at)} ${p.hour}:${p.minute}`;
}

/** "$150", "$2,000", "$150.50": whole dollars when there are no cents. */
export function dollars(cents: number): string {
  const whole = cents % 100 === 0;
  return `$${(cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  })}`;
}

// ---- the dogs on a request (design request-services-v1 § 14, Amendment A1) ----------------

/**
 * Where a request's dogs are checked: staff's approve (422 `invalid_payload`, words to the
 * approver) or the family's yes (409 `conflict` with `RequestStayConflictDetails`, words to
 * her; wire 9.0.0).
 */
export type RequestDogsCheckpoint = 'approve' | 'yes';

/** The first by name (`en` collation), ties by id: the dog a refusal names (A1). */
function firstByName<T extends { id: string; name: string }>(rows: readonly T[]): T | undefined {
  return [...rows].sort(
    (a, b) => a.name.localeCompare(b.name, 'en') || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )[0];
}

/**
 * A1.3: the dog lock the day-program create takes (`withDogLocks`, `db/locks.ts`), for
 * every dog on the request, in sorted id order. Taken after the request's row lock and
 * before the overlap read, and by the boarding approve before its INSERT, so no stay of
 * these dogs can land between a Board & Train's overlap read and its write. Held until the
 * transaction ends.
 */
export async function lockRequestDogs(tx: Tx, dogIds: readonly string[]): Promise<void> {
  await withDogLocks(tx, dogIds, async () => undefined);
}

/**
 * A1.2: a dog the family removed after asking (her `DELETE /dogs/:id`) refuses the whole
 * request, at every arm of the approve and at her yes. Nothing is booked for the others: she
 * said yes to all of them. Runs after the trainer refusal and before the overlap and the
 * gates, so a removed dog never surfaces as a vaccine 422.
 */
export async function assertNoRemovedDog(
  tx: Tx,
  dogIds: readonly string[],
  at: RequestDogsCheckpoint,
): Promise<void> {
  const removed = firstByName(await dogsRepository.findRemovedAmong(tx, dogIds));
  if (removed === undefined) return;
  if (at === 'yes') {
    throw new ApiError(
      'conflict',
      `${removed.name} is no longer on your account, so nothing was booked. Withdraw this request.`,
      { kind: 'conflict', reason: 'dog_removed', dog_id: removed.id },
    );
  }
  throw new ApiError(
    'invalid_payload',
    `${removed.name} is no longer on this family's account. Deny the request.`,
  );
}

/**
 * A1.1: a Board & Train is not booked over another stay. A dog on the request (lead or
 * additional) holding a live, uncancelled boarding or Board & Train stay whose Chicago-date
 * window overlaps [drop-off, hand-back] refuses the whole request: dates, not hours, so a
 * hand-back and a drop-off on one Chicago day overlap (`bookingsRepository.
 * findStaysOverlapping`). A lesson or a school day never refuses it. The sentence names the
 * first such dog by name and, at the approve, that dog's earliest overlapping stay ("from
 * {day}" when it has no pick-up yet). Run under `lockRequestDogs`.
 */
export async function assertNoStayOverlap(
  tx: Tx,
  args: { dogIds: readonly string[]; dropoffAt: Date; pickupAt: Date; at: RequestDogsCheckpoint },
): Promise<void> {
  const fromDate = bucketToChicagoDate(args.dropoffAt);
  const toDate = bucketToChicagoDate(args.pickupAt);
  const overlapping: { id: string; stay: { scheduledAt: string; pickupAt: string | null } }[] = [];
  for (const dogId of args.dogIds) {
    const [earliest] = await bookingsRepository.findStaysOverlapping(tx, dogId, fromDate, toDate);
    if (earliest !== undefined) overlapping.push({ id: dogId, stay: earliest });
  }
  if (overlapping.length === 0) return;
  const names = await dogsRepository.findNamesByIds(
    overlapping.map((o) => o.id),
    tx,
  );
  const dog = firstByName(overlapping.map((o) => ({ ...o, name: names.get(o.id) ?? '' })));
  if (dog === undefined) return;
  if (args.at === 'yes') {
    throw new ApiError(
      'conflict',
      `${dog.name} already has a stay booked over these dates, so nothing was booked. ` +
        'Withdraw this request and send a new one with other dates, or call the school.',
      { kind: 'conflict', reason: 'stay_overlap', dog_id: dog.id },
    );
  }
  const start = chicagoDay(pgTimestampToDate(dog.stay.scheduledAt));
  const booked =
    dog.stay.pickupAt === null
      ? `from ${start}`
      : `${start} – ${chicagoDay(pgTimestampToDate(dog.stay.pickupAt))}`;
  throw new ApiError(
    'invalid_payload',
    `${dog.name} already has a stay booked ${booked}, so this one can't be approved over it. ` +
      'Pick another of their starts or another hand-back, or deny it.',
  );
}
