import { ApiError } from './errors.js';
import type {
  AgreementGap,
  AlreadyBookedConflict,
  AlreadyEnrolledDetails,
  AlreadyRequestedDetails,
  CapacityGap,
  ChargeBlocker,
  CohortFullDetails,
  CreditGap,
  EligibilityGap,
  EnrollmentDogResultWire,
  EvaluationGap,
  UnpassedEvaluationStatus,
  VaccineGap,
} from '../contracts/wire.js';

// Wire 1.13.0 fold-in (§3.3): the detail shapes are THE CONTRACT now — they
// live in wire.ts §1 with their prose and are re-exported here so this file's
// importers keep one import seam. The constructors below are unchanged in
// behavior; `ApiError.details` is typed as the closed `ApiErrorDetailWire`
// union, so a literal drifting from the contract fails `tsc` at the
// construction site.
export type {
  AgreementGap,
  AlreadyBookedConflict,
  AlreadyEnrolledDetails,
  AlreadyRequestedDetails,
  CapacityGap,
  CohortFullDetails,
  CreditGap,
  EligibilityGap,
  EvaluationGap,
  UnpassedEvaluationStatus,
  VaccineGap,
};

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

export function evaluationRequiredError(missing: readonly EvaluationGap[]): ApiError {
  if (missing.length === 0) {
    // Defensive — callers only throw this when at least one dog is
    // unpassed. Empty arrays would hide the gate failure on the wire.
    throw new Error('evaluationRequiredError: missing array must be non-empty');
  }
  // Friendly prose summary; the structured `missing[]` carries the
  // per-dog state for the FE to render the right copy variant + the
  // deep-link to /booking-flow/evaluation?dogId=…
  const summary =
    missing.length === 1
      ? `1 dog needs to complete an evaluation before booking.`
      : `${missing.length} dogs need to complete an evaluation before booking.`;
  return new ApiError('evaluation_required', summary, {
    kind: 'evaluation_required',
    missing: [...missing],
  });
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

export function alreadyBookedError(conflicts: readonly AlreadyBookedConflict[]): ApiError {
  if (conflicts.length === 0) {
    throw new Error('alreadyBookedError: conflicts array must be non-empty');
  }
  const summary =
    conflicts.length === 1
      ? `This dog already has a booking on ${conflicts[0]!.date}.`
      : `These dogs already have bookings on ${conflicts.length} of the requested days.`;
  return new ApiError('already_booked', summary, {
    kind: 'already_booked',
    conflicts: [...conflicts],
  });
}

export function alreadyEnrolledError(details: Omit<AlreadyEnrolledDetails, 'kind'>): ApiError {
  return new ApiError(
    'already_enrolled',
    details.dog_ids.length === 1
      ? 'This dog is already enrolled in this class.'
      : `${details.dog_ids.length} dogs are already enrolled in this class.`,
    { kind: 'already_enrolled', cohort_id: details.cohort_id, dog_ids: [...details.dog_ids] },
  );
}

export function alreadyRequestedError(details: Omit<AlreadyRequestedDetails, 'kind'>): ApiError {
  return new ApiError(
    'already_requested',
    details.dog_ids.length === 1
      ? 'This dog already has an open request of this type.'
      : `${details.dog_ids.length} dogs already have an open request of this type.`,
    { kind: 'already_requested', category: details.category, dog_ids: [...details.dog_ids] },
  );
}

// ---- Per-dog enrollment results (wire 1.11.0) ----------------------------
//
// The partial-success counterpart of the constructors above. Same discipline,
// different shape: a multi-dog enrollment that sends `allow_partial: true`
// REPORTS each dog rather than throwing on the first failure (Allison,
// 2026-08-12: "it shoudl report per dog … not transactional where we fail the
// entire ting"), so these build `EnrollmentDogResultWire` values instead of
// `ApiError`s. Both vocabularies stay live: the `allow_partial`-absent path
// still throws the whole-request errors above, unchanged.
//
// They live here, beside the errors they mirror, so the day a reason is added
// to one vocabulary the other is one screen away — the two drifting apart is
// how a dog ends up with a failure the client has no copy for.
//
// `wire.ts` stays dependency-free: this file imports FROM it, never the
// reverse.

/**
 * Anti-enumeration, preserved per-dog: `not_found` answers identically for "not
 * your dog" and "no such dog", exactly as the whole-request 404 does. A
 * per-dog envelope would otherwise be a free oracle for probing dog ids across
 * owners — the granularity Allison asked for must not become that.
 */
export function dogNotFoundResult(dogId: string): EnrollmentDogResultWire {
  return { dog_id: dogId, enrolled: false, reason: 'not_found' };
}

/**
 * The duplicate guard's per-dog voice. A calm fact, not an error: this is the
 * result of the self-healing resubmit (fix one dog, send the whole roster
 * again under a fresh key), and it is the reason that resubmit cannot double
 * charge or double enroll.
 */
export function dogAlreadyEnrolledResult(dogId: string): EnrollmentDogResultWire {
  return { dog_id: dogId, enrolled: false, reason: 'already_enrolled' };
}

/** R7: this dog completed none of the class's OR-prereqs. */
export function dogEligibilityMissingResult(
  dogId: string,
  missingAlternatives: readonly string[],
): EnrollmentDogResultWire {
  return {
    dog_id: dogId,
    enrolled: false,
    reason: 'eligibility_missing',
    missing_prereq_alternatives: [...missingAlternatives],
  };
}

/**
 * This dog's COMPLETE vaccine gap list — the same "one full picture per gate"
 * rule the whole-request `vaccineMissingError` follows, scoped to one dog.
 * Takes the {@link VaccineGap} shape the gate produces and drops `dog_id`,
 * which the parent row already carries.
 */
export function dogVaccineMissingResult(
  dogId: string,
  gaps: readonly VaccineGap[],
): EnrollmentDogResultWire {
  if (gaps.length === 0) {
    // Same defensive posture as `vaccineMissingError`: an empty list would
    // report a gate failure with nothing the owner could act on.
    throw new Error('dogVaccineMissingResult: gaps array must be non-empty');
  }
  return {
    dog_id: dogId,
    enrolled: false,
    reason: 'vaccine_missing',
    missing_vaccines: gaps.map((g) => ({ requirement_key: g.requirement_key, label: g.label })),
  };
}

/**
 * More healthy dogs than seats. `seats_remaining` is the count at decision
 * time and the server assigns NOBODY — it refuses to choose which dog misses
 * class (design §3.6). Every passing dog gets this same result so the owner
 * sees the real choice rather than a silent alphabetical pick.
 */
export function dogSeatShortfallResult(
  dogId: string,
  seatsRemaining: number,
): EnrollmentDogResultWire {
  return {
    dog_id: dogId,
    enrolled: false,
    reason: 'seat_shortfall',
    seats_remaining: seatsRemaining,
  };
}

/**
 * The authorization was refused. `charge_blocker` is the 1.8.0 taxonomy and
 * carries only the two arms that send the owner to a card:
 * `declined` / `authentication_required`. **Never `processing`** — an in-flight
 * authorization is {@link dogChargeUnverifiedResult}, because "your card was
 * declined, try another" while money may be moving is the reachable double
 * charge this whole taxonomy exists to prevent.
 *
 * **`blocker` is optional, and omitting it is a real answer** (ADDENDUM 1 R5,
 * 2026-08-20). Two arms reach `charge_failed` with no cause to name: a hold
 * someone ELSE released (retrieved `canceled` — the card was never asked) and
 * an adopted `succeeded` intent whose money is already recorded against an
 * earlier request. Reporting `declined` for either tells an owner their card
 * failed when it never did, sends them to change a working card, and is the
 * same category error wire 1.9.0 was cut to fix. The wire types
 * `charge_blocker` optional precisely so "we are not going to guess" is
 * expressible.
 */
export function dogChargeFailedResult(
  dogId: string,
  blocker?: Exclude<ChargeBlocker, 'processing'>,
): EnrollmentDogResultWire {
  return {
    dog_id: dogId,
    enrolled: false,
    reason: 'charge_failed',
    ...(blocker !== undefined ? { charge_blocker: blocker } : {}),
  };
}

/**
 * The authorization is still verifying. Under manual capture this sentence is
 * simply true and it is the one the automatic-capture protocol could not say:
 * an authorization holds NO captured money and cannot capture itself, so
 * nothing will be charged, the hold expires on its own, and the owner may
 * retry shortly. No cancel is attempted on it — a `processing` intent is
 * precisely the one Stripe will not let us cancel.
 *
 * **`verifyKey` is REQUIRED, and that is the point (ADDENDUM 3 §A3.14).** This
 * is the one refusal that leaves a LIVE, non-terminal intent for this dog, and
 * `verify_key` is the client key under which that intent EXECUTED — this
 * request's own key when the mint happened now, or the carried `retry_of` when
 * a re-verify found it still `processing`. An auto-retry client echoes it back
 * as `retry_of`, which is what keeps at most one live hold per dog across a
 * retry chain.
 *
 * The parameter is required rather than optional because the fact is only
 * knowable server-side and the client cannot infer it: a FRESH mint whose own
 * intent goes `processing` is reported `charge_unverified` byte-identically to
 * a no-mint still-processing re-verify, and carrying the wrong key forward
 * re-verifies a DEAD intent and mints beside a live one — the double-hold the
 * retry rule exists to prevent. A caller that had to remember to pass it would
 * eventually not.
 */
export function dogChargeUnverifiedResult(
  dogId: string,
  verifyKey: string,
): EnrollmentDogResultWire {
  return {
    dog_id: dogId,
    enrolled: false,
    reason: 'charge_unverified',
    verify_key: verifyKey,
  };
}

/**
 * The dog is in. `payment_state` is money truth, not celebration: `'paid'`
 * only once the capture returned, `'pending'` while a capture is still being
 * completed by the reconciler, `'pay-later'` for an open invoice. A `'pending'`
 * dog is excluded from `total_captured_cents` — the sheet must never announce
 * money that has not moved.
 */
export function dogEnrolledResult(
  dogId: string,
  paymentState: 'paid' | 'pay-later' | 'pending',
  amountCents: number,
): EnrollmentDogResultWire {
  return {
    dog_id: dogId,
    enrolled: true,
    payment_state: paymentState,
    amount_cents: amountCents,
  };
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
  if (text.startsWith('evaluation gate:')) {
    // Same shape as the other gate-trigger fallbacks: the trigger raises
    // with the lead dog id in the message text, but we don't have
    // structured per-dog state to reconstruct the full EvaluationGap[].
    // The pre-check produces structured details in 99.9% of cases; this
    // path covers the narrow race where a dog's evaluation_status flipped
    // between the pre-check and the INSERT.
    return new ApiError(
      'evaluation_required',
      'Dog evaluation required (state changed mid-request — retry to see details).',
      { kind: 'evaluation_required', missing: [] },
    );
  }
  return undefined;
}

function isPgError(err: unknown): err is { code?: string; message?: unknown } {
  return typeof err === 'object' && err !== null && 'code' in err;
}
