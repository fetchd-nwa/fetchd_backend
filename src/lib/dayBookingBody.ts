import { z } from 'zod';
import {
  MAX_DATES_PER_PART,
  MAX_DOG_DATES_PER_ORDER,
  type BookingMode,
  type PostBookingOrdersRequest,
} from '../contracts/wire.js';
import type { Equal, Expect } from '../contracts/typeAsserts.js';
import { LOCATION_SLUGS } from '../db/schema/schema.js';
import type { DayProgramCategory } from './bookingSchedule.js';
import { dayProgramCategoryToMode } from './bookingMode.js';
import { isValidCalendarDate } from './chicagoDate.js';
import { ApiError } from './errors.js';
import { uuidId } from './uuidId.js';

/**
 * The day-program booking body, shared by `POST /bookings` (one body) and
 * `POST /booking-orders` (one body per part, without `payment`; wire 9.1.0,
 * designs/credits-joint-booking.md §4). Moved here from `routes/bookings.ts` unchanged, so
 * that route parses and refuses byte for byte as before.
 *
 * `MAX_DATES_PER_PART` — a request-size guard, a semester at a time. 30 days ×
 * 3 dogs × 1 INSERT booking + 1 INSERT booking_dog row + 3 INSERT credit_ledger
 * debits = 30 × (1 + 3 + 3) = 210 INSERTs in one tx upper bound, well within a
 * single tx's budget. Larger windows are split into multiple requests, each with
 * its own Idempotency-Key. The wire exports the number (9.1.0), so the phone's
 * pre-check and this parse read one constant.
 *
 * `ADDITIONAL_DOGS_PARSE_CEILING` — this is a hostile-body ceiling and nothing
 * else. How many dogs a booking takes is `day.max_dogs_per_booking_count`, read at
 * runtime and answered 422 `invalid_payload`, so raising that setting past 5 needs
 * no release. This bound sits far above any setting a campus would hold, only so a
 * thousand-entry array is refused before anything is read.
 *
 * The horizon is `day.booking_horizon_months` (`lib/bookingHorizon.ts`).
 */
const ADDITIONAL_DOGS_PARSE_CEILING = 99;

/** `POST /booking-orders`' hostile-body ceiling on `parts` (wire: doc only, mechanic 17). */
const ORDER_PARTS_PARSE_CEILING = 100;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const LOCATION_KEYS = LOCATION_SLUGS;

/**
 * A dog id as the booking core may hold it: lowercased here, at the parse
 * boundary. `withDogLocks` keys a string, and Postgres reads a uuid in either
 * case, so a capitalised spelling would otherwise be a second lock for one dog,
 * a second entry past the distinct check, and a second seat at the other campus.
 */
const dogIdField = uuidId();

/**
 * POST /bookings body — day-program creation (day-school / day-care).
 * Other categories (group-class, B&T, boarding, private-lesson,
 * evaluation) hit different endpoints (POST /enrollments, request
 * flows, staff-picked slots); narrowing `category` here keeps the
 * route's static type honest about what it accepts. The route's
 * `validateBookingBody` adds the cross-field invariants Zod doesn't
 * express cleanly (dates distinct, lead not in additionals). No arrival
 * time is taken (DAY-U11): `dropoff_time` is an unknown key to `.strict()`.
 *
 * `payment` says credits, the only tender (R1): required, so every booking says so
 * and one body has one spelling, which is what the request key hashes. `.strict()`
 * here too, so `kind: 'payg'`, `kind: 'card'` and a top-level `payment_method_id` are
 * 400. `tier` names the pool. `top_up` buys what the dates are short, on the engine.
 */
const bookingPaymentSchema = z
  .object({
    kind: z.literal('credits'),
    tier: z.enum(['regular', 'alumni']).optional(),
    top_up: z
      .object({
        count: z.number().int().positive(),
        payment_method_id: uuidId(),
        package_key: z
          .string()
          .regex(/^[a-z0-9-]{1,64}$/)
          .optional(),
        expected_total_cents: z.number().int().positive(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** A Chicago calendar day, `YYYY-MM-DD`, that exists. */
const calendarDate = z
  .string()
  .regex(ISO_DATE, 'must be YYYY-MM-DD')
  .refine(isValidCalendarDate, 'not a real calendar date');

export const postBookingBodySchema = z
  .object({
    category: z.enum(['day-school', 'day-care']),
    lead_dog_id: dogIdField,
    additional_dog_ids: z.array(dogIdField).max(ADDITIONAL_DOGS_PARSE_CEILING).optional(),
    dates: z.array(calendarDate).min(1).max(MAX_DATES_PER_PART),
    location: z.enum(LOCATION_KEYS),
    notes: z.string().max(2000).optional(),
    payment: bookingPaymentSchema,
    // The after-school opt-in (6.0.0-lg5.2; DAY-U43): dog → dates. Each key lowercased
    // here, like every dog id at this boundary, so a capitalised key is that dog; a key
    // that is not a UUID or a value that is not a date is this parse's 400. Its fit with
    // the request is `validateBookingBody`'s (D11).
    after_school: z.record(dogIdField, z.array(calendarDate).max(MAX_DATES_PER_PART)).optional(),
  })
  .strict();

export type PostBookingBody = z.infer<typeof postBookingBodySchema>;

/**
 * Validated, derived form of the request body. `parseOrThrow` handles
 * the Zod-shape errors; this helper layers on the cross-field invariants
 * Zod doesn't express cleanly and that need NO CLOCK AND NO SETTING: dates
 * distinct, lead not in additionals. A rule that reads either belongs inside
 * `withMutation`, or a replay meets it.
 *
 * Returns the route-internal `ValidatedBookingBody` — every downstream
 * call (gate pre-check, capacity assertion, INSERT) takes this typed
 * shape. The route handler doesn't touch the raw Zod-parsed body after
 * this point.
 */
export interface ValidatedBookingBody {
  category: DayProgramCategory;
  leadDogId: string;
  additionalDogIds: string[];
  allDogIds: string[];
  sortedDates: string[];
  location: (typeof LOCATION_KEYS)[number];
  notes: string | null;
  payment: PostBookingBody['payment'];
  /** Dog → the dates she stays for after school; only dogs with a tick. */
  afterSchool: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * D11: the after-school map against its own request, each a 422 `invalid_payload`. A key
 * that is not a dog of this request, a date not in `dates`, a date listed twice for one
 * dog, any tick on a day-care request ("refused on a daycare date", design §2.3:2560), or
 * two keys that name one dog in two spellings. Pure checks of the body, true or false
 * whenever it is sent, so they run before the claim; the count, which a replay must not
 * re-read, is the core's, after it.
 */
function validateAfterSchool(
  body: Pick<PostBookingBody, 'after_school' | 'category'>,
  rawBody: unknown,
  dogIds: ReadonlySet<string>,
  dates: ReadonlySet<string>,
): Map<string, Set<string>> {
  const ticks = new Map<string, Set<string>>();
  const map = body.after_school;
  if (map === undefined) return ticks;
  const rawKeys = Object.keys(
    ((rawBody as { after_school?: Record<string, unknown> }).after_school ?? {}) as object,
  );
  if (rawKeys.length !== Object.keys(map).length) {
    throw new ApiError('invalid_payload', 'after_school names one dog twice');
  }
  for (const [dogId, listed] of Object.entries(map)) {
    if (!dogIds.has(dogId)) {
      throw new ApiError(
        'invalid_payload',
        `after_school names ${dogId}, not a dog of this booking`,
      );
    }
    if (listed.length > 0 && body.category === 'day-care') {
      throw new ApiError('invalid_payload', 'after-school is offered on day-school dates only');
    }
    const own = new Set<string>();
    for (const date of listed) {
      if (!dates.has(date)) {
        throw new ApiError(
          'invalid_payload',
          `after_school's ${date} is not one of this booking's dates`,
        );
      }
      if (own.has(date)) {
        throw new ApiError('invalid_payload', `after_school lists ${date} twice for one dog`);
      }
      own.add(date);
    }
    if (own.size > 0) ticks.set(dogId, own);
  }
  return ticks;
}

/** What a body and an order part share: everything but `payment`. */
type DayBookingFields = Omit<PostBookingBody, 'payment'>;

/** The per-body checks of {@link validateBookingBody}, without `payment`. */
function validateDayBookingFields(
  body: DayBookingFields,
  rawBody: unknown,
): Omit<ValidatedBookingBody, 'payment'> {
  // Combined dog list — lead first, then additionals.
  const additionalDogIds = body.additional_dog_ids ?? [];
  const allDogIds = [body.lead_dog_id, ...additionalDogIds];
  const dogIdSet = new Set(allDogIds);
  if (dogIdSet.size !== allDogIds.length) {
    // lead_dog_id appearing in additional_dog_ids OR an additional id
    // listed twice — both are the same defect from the user's POV.
    throw new ApiError('invalid_payload', 'lead_dog_id and additional_dog_ids must be distinct');
  }

  const dateSet = new Set<string>();
  for (const date of body.dates) {
    if (dateSet.has(date)) {
      throw new ApiError('invalid_payload', `dates contains duplicate ${date}`);
    }
    dateSet.add(date);
  }
  const sortedDates = [...body.dates].sort();
  const afterSchool = validateAfterSchool(body, rawBody, dogIdSet, dateSet);

  return {
    category: body.category,
    leadDogId: body.lead_dog_id,
    additionalDogIds,
    allDogIds,
    sortedDates,
    location: body.location,
    notes: body.notes ?? null,
    afterSchool,
  };
}

export function validateBookingBody(body: PostBookingBody, rawBody: unknown): ValidatedBookingBody {
  return { ...validateDayBookingFields(body, rawBody), payment: body.payment };
}

// ---- POST /booking-orders (9.1.0) ---------------------------------------------

/**
 * One part: a `POST /bookings` body without `payment` (wire `BookingOrderPart`). `.strict()`
 * is kept from the body it is cut from, so a part carrying `payment` is 400 (mechanic 5).
 */
const bookingOrderPartSchema = postBookingBodySchema.omit({ payment: true });

/**
 * Her "Use a day care credit": one entry per pool, `count` a positive integer by the parse
 * (mechanic 6). A repeated `(location, mode)` is the order's 422, not this parse's.
 */
const alumniOnRegularSchema = z
  .object({
    location: z.enum(LOCATION_KEYS),
    mode: z.enum(['school', 'daycare']),
    count: z.number().int().positive(),
  })
  .strict();

export const postBookingOrdersBodySchema = z
  .object({
    parts: z.array(bookingOrderPartSchema).min(1).max(ORDER_PARTS_PARSE_CEILING),
    alumni_on_regular: z.array(alumniOnRegularSchema).optional(),
  })
  .strict();

export type PostBookingOrdersBody = z.infer<typeof postBookingOrdersBodySchema>;

/** §5.1.3 pin, as `PostBookingsBodyConformance`: the wire's `PostBookingOrdersRequest` IS
 *  this schema's input type. If this stops compiling, the wire type is what is wrong. */
export type PostBookingOrdersBodyConformance = Expect<
  Equal<z.input<typeof postBookingOrdersBodySchema>, PostBookingOrdersRequest>
>;

/** One part, validated: a body's checks, in body order. */
export interface ValidatedOrderPart extends Omit<ValidatedBookingBody, 'payment'> {
  /** The part's credit axis. */
  mode: BookingMode;
}

export interface ValidatedBookingOrder {
  parts: ValidatedOrderPart[];
  /** Every dog of the order, in the order's dog order: first appearance in the body. */
  dogOrder: string[];
  /** `(location, mode)` → her consent's `count`. */
  consent: ReadonlyMap<string, number>;
}

/** The key the consent map and the plan's pool groups share. */
export function poolGroupKey(location: string, mode: BookingMode): string {
  return `${location}:${mode}`;
}

/**
 * Every check of an order body that needs no clock and no setting, so it runs before the
 * claim (as {@link validateBookingBody} does for one body): each part's own checks, in body
 * order, then the order-wide bounds of `PostBookingOrdersRequest`, each 422
 * `invalid_payload`. The dog ceiling reads `day.max_dogs_per_booking_count`, so it is the
 * transaction's, after the claim.
 */
export function validateBookingOrderBody(
  body: PostBookingOrdersBody,
  rawBody: unknown,
): ValidatedBookingOrder {
  const rawParts = (rawBody as { parts?: unknown[] }).parts ?? [];
  const parts: ValidatedOrderPart[] = body.parts.map((part, index) => {
    const fields = validateDayBookingFields(part, rawParts[index]);
    return { ...fields, mode: dayProgramCategoryToMode(fields.category) };
  });

  const dogOrder: string[] = [];
  for (const part of parts) {
    for (const dogId of part.allDogIds) {
      if (!dogOrder.includes(dogId)) dogOrder.push(dogId);
    }
  }

  const maxParts = dogOrder.length * 4;
  if (parts.length > maxParts) {
    throw new ApiError(
      'invalid_payload',
      `at most ${maxParts} parts for ${dogOrder.length} dog(s) (got ${parts.length})`,
    );
  }

  const dogDates = parts.reduce(
    (sum, part) => sum + part.allDogIds.length * part.sortedDates.length,
    0,
  );
  if (dogDates > MAX_DOG_DATES_PER_ORDER) {
    throw new ApiError(
      'invalid_payload',
      `at most ${MAX_DOG_DATES_PER_ORDER} dog-dates per order (got ${dogDates})`,
    );
  }

  const seen = new Set<string>();
  for (const part of parts) {
    for (const dogId of part.allDogIds) {
      for (const date of part.sortedDates) {
        const key = `${dogId}:${date}`;
        if (seen.has(key)) {
          throw new ApiError('invalid_payload', `dog ${dogId} is on ${date} in two parts`);
        }
        seen.add(key);
      }
    }
  }

  const consent = new Map<string, number>();
  for (const entry of body.alumni_on_regular ?? []) {
    const key = poolGroupKey(entry.location, entry.mode);
    if (consent.has(key)) {
      throw new ApiError(
        'invalid_payload',
        `alumni_on_regular names ${entry.location} ${entry.mode} twice`,
      );
    }
    consent.set(key, entry.count);
  }

  return { parts, dogOrder, consent };
}
