import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  agreementUnsignedError,
  alreadyBookedError,
  beyondBookingHorizonError,
  capacityBelowBookedError,
  gateTriggerErrorToApiError,
  insufficientCapacityError,
  insufficientCreditsError,
  paymentRequiredError,
  vaccineMissingError,
} from '../src/lib/bookingErrors.js';
import { ApiError } from '../src/lib/errors.js';

// Day 10 unit tests for the typed gate-error constructors + the
// `gateTriggerErrorToApiError` fallback mapper. The route layer uses
// the constructors directly for pre-check failures; the mapper handles
// the defense-in-depth path where a BEFORE-INSERT trigger fires due to
// a race window the pre-check missed. The mapper is text-matched on
// the trigger's RAISE EXCEPTION message — these tests inject the
// canonical message shape from schema.sql so the route surfaces the
// right typed code even when the trigger is the failure path.

// ──────────────────────────────────────────────────────────────────────────
// Constructors — assert code + details.kind + envelope-ready shape
// ──────────────────────────────────────────────────────────────────────────

test('paymentRequiredError → code=payment_required, details.kind=payment_required', () => {
  const err = paymentRequiredError();
  assert.ok(err instanceof ApiError);
  assert.equal(err.code, 'payment_required');
  assert.equal(err.status, 422);
  assert.deepEqual(err.details, { kind: 'payment_required' });
});

test('vaccineMissingError carries per-dog missing[] with deep-link-ready data', () => {
  const err = vaccineMissingError([
    { dog_id: 'dog-1', requirement_key: 'rabies', label: 'Rabies' },
    { dog_id: 'dog-2', requirement_key: 'bordetella', label: 'Bordetella' },
  ]);
  assert.equal(err.code, 'vaccine_missing');
  assert.equal(err.status, 422);
  assert.deepEqual(err.details, {
    kind: 'vaccine_missing',
    missing: [
      { dog_id: 'dog-1', requirement_key: 'rabies', label: 'Rabies' },
      { dog_id: 'dog-2', requirement_key: 'bordetella', label: 'Bordetella' },
    ],
  });
  assert.match(err.message, /Rabies, Bordetella/);
});

test('vaccineMissingError truncates summary at 3 with "and N more" suffix', () => {
  const err = vaccineMissingError([
    { dog_id: 'd1', requirement_key: 'rabies', label: 'Rabies' },
    { dog_id: 'd2', requirement_key: 'bordetella', label: 'Bordetella' },
    { dog_id: 'd3', requirement_key: 'dhpp', label: 'DHPP' },
    { dog_id: 'd4', requirement_key: 'lepto', label: 'Leptospirosis' },
    { dog_id: 'd5', requirement_key: 'lyme', label: 'Lyme' },
  ]);
  assert.match(err.message, /Rabies, Bordetella, DHPP \(and 2 more\)/);
  // details still carries every entry — the truncation is a message
  // affordance, not a data loss.
  assert.equal((err.details as { missing: unknown[] }).missing.length, 5);
});

test('vaccineMissingError throws on empty missing[] (defensive — empty would hide gate failure on wire)', () => {
  assert.throws(() => vaccineMissingError([]), /missing array must be non-empty/);
});

test('agreementUnsignedError carries document_key + label for FE deep-link', () => {
  const err = agreementUnsignedError([
    { document_key: 'liability-waiver', label: 'General Liability Waiver' },
  ]);
  assert.equal(err.code, 'agreement_unsigned');
  assert.equal(err.status, 422);
  assert.deepEqual(err.details, {
    kind: 'agreement_unsigned',
    missing: [{ document_key: 'liability-waiver', label: 'General Liability Waiver' }],
  });
});

test('agreementUnsignedError throws on empty missing[]', () => {
  assert.throws(() => agreementUnsignedError([]), /missing array must be non-empty/);
});

const POOL = { location: 'fayetteville', mode: 'school', tier: 'regular' } as const;
const OFFER = { count: 2, unit_price_cents: 6000, total_cents: 12000, package_key: 'single' };

test('insufficientCreditsError counts shortfall on the dates, never on balance', () => {
  // A balance of 9 and two dates short: `required - balance` would answer a negative
  // number here, which is the arithmetic D22 retired.
  const err = insufficientCreditsError({
    gap: { ...POOL, balance: 9, required: 3 },
    shortDates: [
      {
        date: '2026-06-02',
        reason: 'credits_expire_first',
        expires_at: '2026-06-01T17:00:00.000Z',
      },
      { date: '2026-06-03', reason: 'no_credit' },
    ],
    offer: OFFER,
  });
  assert.equal(err.code, 'insufficient_credits');
  assert.equal(err.status, 422);
  assert.match(err.message, /Insufficient school credits: 2 short\./);
  assert.deepEqual(err.details, {
    kind: 'insufficient_credits',
    gaps: [{ ...POOL, balance: 9, required: 3 }],
    shortfall: 2,
    short_dates: [
      {
        date: '2026-06-02',
        reason: 'credits_expire_first',
        expires_at: '2026-06-01T17:00:00.000Z',
      },
      { date: '2026-06-03', reason: 'no_credit' },
    ],
    top_up_offer: OFFER,
  });
});

test('insufficientCreditsError names the alternative pack only when one is passed', () => {
  const err = insufficientCreditsError({
    gap: { ...POOL, balance: 0, required: 1 },
    shortDates: [{ date: '2026-06-03', reason: 'no_credit' }],
    offer: null,
    alternativePackageKey: 'school-2x-weekly-fayetteville',
  });
  const details = err.details as { top_up_offer: unknown; alternative_package_key?: string };
  assert.equal(details.top_up_offer, null);
  assert.equal(details.alternative_package_key, 'school-2x-weekly-fayetteville');
});

test('insufficientCreditsError with nothing short is a 422 with shortfall 0, gaps [] and no offer', () => {
  // A `top_up` that no longer fits: the client re-sends on credits alone (D22).
  const err = insufficientCreditsError({
    gap: { ...POOL, balance: 3, required: 3 },
    shortDates: [],
    offer: OFFER,
    alternativePackageKey: 'never-shown',
  });
  assert.equal(err.status, 422);
  assert.deepEqual(err.details, {
    kind: 'insufficient_credits',
    gaps: [],
    shortfall: 0,
    short_dates: [],
    top_up_offer: null,
  });
});

test('insufficientCapacityError carries location/date/remaining/requested, and no mode', () => {
  const err = insufficientCapacityError({
    location: 'fayetteville',
    date: '2026-06-15',
    openings_remaining: 1,
    requested: 3,
  });
  assert.equal(err.code, 'insufficient_capacity');
  assert.equal(err.status, 422);
  assert.deepEqual(err.details, {
    kind: 'insufficient_capacity',
    location: 'fayetteville',
    date: '2026-06-15',
    openings_remaining: 1,
    requested: 3,
  });
  assert.match(err.message, /2026-06-15 at fayetteville is full/);
  assert.doesNotMatch(err.message, /Day School|Day Care/);
});

test('beyondBookingHorizonError: 422, no details, names the date and the last one', () => {
  const err = beyondBookingHorizonError('2026-08-20', '2026-08-19');
  assert.equal(err.code, 'beyond_booking_horizon');
  assert.equal(err.status, 422);
  assert.equal(err.details, undefined);
  assert.match(err.message, /2026-08-20.*2026-08-19/);
});

test('capacityBelowBookedError: 422 with every date, as given', () => {
  const err = capacityBelowBookedError(['2026-10-23', '2026-10-30']);
  assert.equal(err.code, 'capacity_below_booked');
  assert.equal(err.status, 422);
  assert.deepEqual(err.details, {
    kind: 'capacity_below_booked',
    dates: ['2026-10-23', '2026-10-30'],
  });
});

test('capacityBelowBookedError throws on no dates: the wire says never empty', () => {
  assert.throws(() => capacityBelowBookedError([]), /dates must be non-empty/);
});

// ──────────────────────────────────────────────────────────────────────────
// `gateTriggerErrorToApiError` — defense-in-depth fallback for the race
// window where a BEFORE-INSERT trigger fires (vaccine soft-expired
// mid-tx, payment-method removed mid-tx, agreement version bumped
// mid-tx). The route catches the raw pg error and maps to a typed
// ApiError via this helper. The trigger's RAISE EXCEPTION text from
// schema.sql is the only signal we have — these tests inject the
// canonical message shape verbatim.
// ──────────────────────────────────────────────────────────────────────────

test('gateTriggerErrorToApiError: payment guarantee trigger → payment_required', () => {
  const pgError = {
    code: '23514', // check_violation
    message: 'payment guarantee: owner abc has no card on file — booking blocked (anti-scam)',
  };
  const mapped = gateTriggerErrorToApiError(pgError);
  assert.ok(mapped instanceof ApiError, 'must return an ApiError');
  assert.equal(mapped.code, 'payment_required');
  assert.equal(mapped.status, 422);
  assert.equal((mapped.details as { kind: string }).kind, 'payment_required');
});

test('gateTriggerErrorToApiError: vaccine gate trigger → vaccine_missing (with empty missing[] — race-window edge)', () => {
  const pgError = {
    code: '23514',
    message:
      'vaccine gate: dog 33333333-... missing/expired required vaccination(s): Rabies (fixture) (category day-school)',
  };
  const mapped = gateTriggerErrorToApiError(pgError);
  assert.ok(mapped instanceof ApiError);
  assert.equal(mapped.code, 'vaccine_missing');
  assert.equal((mapped.details as { kind: string; missing: unknown[] }).kind, 'vaccine_missing');
  // Empty missing[] — the trigger doesn't give us structured per-key
  // data; the route's pre-check is the typical path for structured
  // details. Documented in `gateTriggerErrorToApiError`.
  assert.deepEqual((mapped.details as { missing: unknown[] }).missing, []);
  assert.match(mapped.message, /retry to see details/);
});

test('gateTriggerErrorToApiError: agreement gate trigger → agreement_unsigned', () => {
  const pgError = {
    code: '23514',
    message:
      'agreement gate: owner 11111111-... has not signed current required agreement(s): General Liability Waiver (fixture) (category day-school)',
  };
  const mapped = gateTriggerErrorToApiError(pgError);
  assert.ok(mapped instanceof ApiError);
  assert.equal(mapped.code, 'agreement_unsigned');
  assert.equal((mapped.details as { kind: string; missing: unknown[] }).kind, 'agreement_unsigned');
  assert.deepEqual((mapped.details as { missing: unknown[] }).missing, []);
});

test('gateTriggerErrorToApiError: non-check_violation error → undefined (caller re-throws)', () => {
  // FK violation (23503) is NOT a gate-trigger error; mapper should
  // pass it through unmapped so the caller re-throws (it likely surfaces
  // as a 500 / generic error, which is the right behavior — gate-
  // trigger fallback is narrow on intent).
  const fkError = {
    code: '23503',
    message: 'insert or update on table "bookings" violates foreign key constraint',
  };
  const mapped = gateTriggerErrorToApiError(fkError);
  assert.equal(mapped, undefined);
});

test('gateTriggerErrorToApiError: check_violation with non-gate message → undefined', () => {
  // A future CHECK constraint that isn't one of the three gates
  // should NOT be coerced to a gate error. Mapper passes it through.
  const unknownCheck = {
    code: '23514',
    message: 'check_violation: dogs_check1 — invariant failed',
  };
  const mapped = gateTriggerErrorToApiError(unknownCheck);
  assert.equal(mapped, undefined);
});

test('gateTriggerErrorToApiError: non-Error object → undefined', () => {
  assert.equal(gateTriggerErrorToApiError(null), undefined);
  assert.equal(gateTriggerErrorToApiError(undefined), undefined);
  assert.equal(gateTriggerErrorToApiError('string error'), undefined);
  assert.equal(gateTriggerErrorToApiError(42), undefined);
  // Object without a `code` field doesn't match the pg-error shape.
  assert.equal(gateTriggerErrorToApiError({ message: 'something' }), undefined);
});

// ── P15 plan_added (P12 r1 Opus N7): the sentence counted conflicts and said days. ──

describe('alreadyBookedError counts days, and says who', () => {
  const day1 = '2026-06-01';
  const day2 = '2026-06-02';
  const sentence = (conflicts: { dog_id: string; date: string }[]): string =>
    alreadyBookedError(conflicts.map((c) => ({ ...c, category: 'day-school' as const }))).message;

  test('two dogs on one date is one day', () => {
    assert.equal(
      sentence([
        { dog_id: 'a', date: day1 },
        { dog_id: 'b', date: day1 },
      ]),
      `These dogs already have bookings on ${day1}.`,
    );
  });

  test('one dog on two dates is two days', () => {
    assert.equal(
      sentence([
        { dog_id: 'a', date: day1 },
        { dog_id: 'a', date: day2 },
      ]),
      'This dog already has bookings on 2 of the requested days.',
    );
  });

  test('two dogs on two dates is two days', () => {
    assert.equal(
      sentence([
        { dog_id: 'a', date: day1 },
        { dog_id: 'b', date: day1 },
        { dog_id: 'a', date: day2 },
        { dog_id: 'b', date: day2 },
      ]),
      'These dogs already have bookings on 2 of the requested days.',
    );
  });

  test('one dog on one date reads as it always did', () => {
    assert.equal(
      sentence([{ dog_id: 'a', date: day1 }]),
      `This dog already has a booking on ${day1}.`,
    );
  });
});
