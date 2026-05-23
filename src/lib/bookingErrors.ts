import { ApiError } from './errors.js';
import type { BookingMode } from './bookingMode.js';
import type { GroupClassKey } from '../db/repositories/groupClassesRepository.js';
import type { locationKey } from '../db/schema/schema.js';

/**
 * Typed `details` payloads for the booking-write surface (Day 10+). The
 * envelope (`auth/plugin.ts`) emits these verbatim; the FE branches on
 * `kind` to render category-specific recovery copy + deep links instead
 * of parsing prose. §A amendment 2026-05-22 documents the wire shape.
 *
 * Design note — single-gate-at-a-time reporting:
 *
 * Each gate (payment / vaccine / agreement) is pre-checked in sequence
 * (payment → vaccine → agreement); the FIRST failing gate aborts the
 * request, surfacing the complete state of THAT gate (every missing
 * vaccine across every dog; every unsigned required agreement). The user
 * fixes that gate, retries, and the next gate surfaces (if any). This
 * keeps the wire shape simple — one `kind` per error — and never sends
 * partial information for a gate ("here are 2 of your 5 missing
 * vaccines"). The trade-off is multi-gate-failing new users see one
 * issue per round-trip; multi-gate consolidation can layer on later
 * without restructuring (add a `multi_gate_block` arm + a `code: 'invalid_payload'`
 * path, the existing single-gate arms stay valid).
 */

type LocationKey = (typeof locationKey.enumValues)[number];

/**
 * One missing vaccine for one dog. `requirement_key` lets the FE deep-
 * link to the right `/dogs/{dog_id}/vaccines` add flow with the
 * requirement pre-selected; `label` is the human-readable copy
 * (`required_vaccines.label`); `dog_id` carries multi-dog disambiguation
 * (a 3-dog booking surfaces missing vaccines by dog).
 */
export interface VaccineGap {
  readonly dog_id: string;
  readonly requirement_key: string;
  readonly label: string;
}

/** One unsigned required agreement. `document_key` matches `agreement_documents.key`. */
export interface AgreementGap {
  readonly document_key: string;
  readonly label: string;
}

/**
 * One under-balance dog-mode pair. `required` is the number of credits
 * the booking would consume (debits across all requested dates for this
 * dog × this mode); `balance` is the dog's current balance before the
 * mutation. `balance < required` ⇒ blocked.
 */
export interface CreditGap {
  readonly dog_id: string;
  readonly mode: BookingMode;
  readonly balance: number;
  readonly required: number;
}

/**
 * Day-program capacity exhaustion for one date. The FE can branch on
 * this to render "Day School is full on Tue Aug 12 in Fayetteville — try
 * another date" with a deep link back into the calendar picker.
 *
 * `openings_remaining` is the number of seats still free at the moment
 * the check fired (≥ 0 — if zero, the request asked for at least one
 * over the cap). Useful for "1 seat left, you asked for 2" messaging.
 */
export interface CapacityGap {
  readonly location: LocationKey;
  readonly date: string;
  readonly mode: BookingMode;
  readonly openings_remaining: number;
  readonly requested: number;
}

/**
 * Day-11 cohort capacity gap — the M:N enrollment counterpart to
 * `CapacityGap`. Same shape intent (seats remaining vs requested) but
 * scoped to one cohort row, not a (location, date, mode) bucket. The
 * cohort row's `filled` is checked against `capacity` under the cohort
 * row lock (`lockCohort`); this details payload is what surfaces when
 * the assertion fails. FE branch: "Spring '26 Manners-2 is full —
 * here are other cohorts to consider."
 */
export interface CohortFullDetails {
  readonly cohort_id: string;
  readonly capacity: number;
  readonly filled: number;
  readonly requested: number;
}

/**
 * Day-11 R7 eligibility gap for one dog. The cohort's class has at
 * least one `class_prereq_options` row (OR-alternatives) and this dog
 * has not completed ANY of the listed prereqs. `missing_alternatives`
 * is the list of class keys the dog could complete to unlock this
 * cohort (e.g., `['manners-1']` for Manners-2). FE branch: link the
 * dog to the missing class catalog + show prereq path.
 */
export interface EligibilityGap {
  readonly dog_id: string;
  readonly missing_alternatives: readonly GroupClassKey[];
}

// ---- Constructors --------------------------------------------------------
//
// Throw via these helpers, not via raw `new ApiError(...)` at the gate
// sites, so the `details.kind` literal stays in lockstep with the `code`
// and the helper name. Future readers grep `vaccineMissingError(` and
// land on every gate-failure path the route can produce.

export function paymentRequiredError(): ApiError {
  return new ApiError('payment_required', 'A payment method on file is required before booking.', {
    kind: 'payment_required',
  });
}

export function vaccineMissingError(missing: readonly VaccineGap[]): ApiError {
  if (missing.length === 0) {
    // Defensive — callers should only throw this when there's at least
    // one gap. Empty arrays would hide the gate failure on the wire.
    throw new Error('vaccineMissingError: missing array must be non-empty');
  }
  const summary = missing
    .map((g) => g.label)
    .slice(0, 3)
    .join(', ');
  const more = missing.length > 3 ? ` (and ${missing.length - 3} more)` : '';
  return new ApiError(
    'vaccine_missing',
    `Required vaccination(s) missing or expired: ${summary}${more}.`,
    { kind: 'vaccine_missing', missing: [...missing] },
  );
}

export function agreementUnsignedError(missing: readonly AgreementGap[]): ApiError {
  if (missing.length === 0) {
    throw new Error('agreementUnsignedError: missing array must be non-empty');
  }
  const summary = missing
    .map((g) => g.label)
    .slice(0, 3)
    .join(', ');
  const more = missing.length > 3 ? ` (and ${missing.length - 3} more)` : '';
  return new ApiError(
    'agreement_unsigned',
    `Required agreement(s) unsigned at current version: ${summary}${more}.`,
    { kind: 'agreement_unsigned', missing: [...missing] },
  );
}

export function insufficientCreditsError(gaps: readonly CreditGap[]): ApiError {
  if (gaps.length === 0) {
    throw new Error('insufficientCreditsError: gaps array must be non-empty');
  }
  return new ApiError(
    'insufficient_credits',
    gaps.length === 1
      ? `Insufficient ${gaps[0]!.mode} credits — need ${gaps[0]!.required}, have ${gaps[0]!.balance}.`
      : `Insufficient credits across ${gaps.length} dogs.`,
    { kind: 'insufficient_credits', gaps: [...gaps] },
  );
}

export function insufficientCapacityError(gap: CapacityGap): ApiError {
  return new ApiError(
    'insufficient_capacity',
    `${gap.mode === 'school' ? 'Day School' : 'Day Care'} is full on ${gap.date} at ${gap.location} (${gap.openings_remaining} seat(s) remaining, ${gap.requested} requested).`,
    { kind: 'insufficient_capacity', ...gap },
  );
}

export function cohortFullError(details: CohortFullDetails): ApiError {
  const seatsLeft = Math.max(0, details.capacity - details.filled);
  return new ApiError(
    'cohort_full',
    `This cohort is full (${seatsLeft} seat(s) remaining, ${details.requested} requested).`,
    { kind: 'cohort_full', ...details },
  );
}

export function eligibilityMissingError(gaps: readonly EligibilityGap[]): ApiError {
  if (gaps.length === 0) {
    // Defensive — callers should only throw this when at least one dog
    // is missing prereqs. Empty arrays would hide the gate failure.
    throw new Error('eligibilityMissingError: gaps array must be non-empty');
  }
  // The structured `gaps` carry the deep-link data; the prose is a
  // friendly summary keyed off dog count.
  const summary =
    gaps.length === 1
      ? `1 dog is missing required prerequisites for this class.`
      : `${gaps.length} dogs are missing required prerequisites for this class.`;
  return new ApiError('eligibility_missing', summary, {
    kind: 'eligibility_missing',
    // Spread + map so the wire shape's `missing_alternatives` is a
    // plain mutable array (JSON-serializable) rather than the
    // `readonly` interface view we hold internally.
    gaps: gaps.map((g) => ({
      dog_id: g.dog_id,
      missing_alternatives: [...g.missing_alternatives],
    })),
  });
}

/**
 * Best-effort mapping from a Postgres `check_violation` raised by one of
 * the three gate triggers (`bookings_payment_guarantee`,
 * `bookings_vaccine_guard`, `bookings_agreement_guard`) to a typed
 * `ApiError`. The route-layer pre-check is the primary defense; this
 * fallback exists for the race window where the pre-check passes but
 * a concurrent mutation (vaccine soft-expire, payment-method removal,
 * agreement-document version bump) invalidates the state between the
 * check and the INSERT. Defense in depth — the trigger is the
 * unbypassable floor.
 *
 * The trigger's `RAISE EXCEPTION` text is the only signal we have to
 * route the mapping, so this is text-matched. Test coverage exercises
 * each branch by triggering the underlying race or by injecting the
 * pg error directly.
 *
 * Returns `undefined` for any error that is NOT a gate-trigger
 * violation — caller re-throws.
 */
export function gateTriggerErrorToApiError(err: unknown): ApiError | undefined {
  if (!isPgError(err)) return undefined;
  if (err.code !== '23514') return undefined; // 23514 = check_violation
  const text = typeof err.message === 'string' ? err.message : '';
  if (text.startsWith('payment guarantee:')) {
    return new ApiError(
      'payment_required',
      'A payment method on file is required before booking.',
      { kind: 'payment_required' },
    );
  }
  if (text.startsWith('vaccine gate:')) {
    // The trigger raises with the missing labels concatenated into the
    // message — we don't have structured per-key data to reconstruct
    // the full VaccineGap[] from text alone. Surface the gate failure
    // with an empty `missing[]` and rely on the pre-check to be the
    // path that produces structured details in 99.9% of cases.
    return new ApiError(
      'vaccine_missing',
      'Required vaccination(s) missing or expired (state changed mid-request — retry to see details).',
      { kind: 'vaccine_missing', missing: [] },
    );
  }
  if (text.startsWith('agreement gate:')) {
    return new ApiError(
      'agreement_unsigned',
      'Required agreement(s) unsigned (state changed mid-request — retry to see details).',
      { kind: 'agreement_unsigned', missing: [] },
    );
  }
  return undefined;
}

function isPgError(err: unknown): err is { code?: string; message?: unknown } {
  return typeof err === 'object' && err !== null && 'code' in err;
}
