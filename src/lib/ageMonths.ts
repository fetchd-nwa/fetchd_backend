import { bucketToChicagoDate } from './chicagoDate.js';

/**
 * Derive a dog's age in whole months from `dogs.birthdate` (preferred) or
 * `dogs.age_months_override` (import-era fallback when birthdate is unknown).
 * The schema CHECK `birthdate IS NOT NULL OR age_months_override IS NOT NULL`
 * guarantees one is set — both null is a data-integrity fault, not a reachable
 * state, so it throws.
 *
 * Counts only complete months in the **America/Chicago** calendar. If the
 * birthdate's day-of-month has not been reached this month, the result rounds
 * down (born March 15, today is April 14 → 0 months). Floored at 0 — a future
 * birthdate is a write-time error the route validates; the read path returns
 * 0 instead of negative to avoid leaking nonsense through the contract.
 *
 * `today` is injectable so tests can pin a deterministic Chicago date instead
 * of `now()`; production callers omit it.
 */
export function ageInMonths(args: {
  birthdate: string | null;
  ageMonthsOverride: number | null;
  today?: Date;
}): number {
  const { birthdate, ageMonthsOverride } = args;
  if (birthdate === null) {
    if (ageMonthsOverride === null) {
      throw new Error('ageInMonths: birthdate and ageMonthsOverride are both null');
    }
    return ageMonthsOverride;
  }
  const today = parseYmd(bucketToChicagoDate(args.today ?? new Date()));
  const bd = parseYmd(birthdate);
  const months = (today.y - bd.y) * 12 + (today.m - bd.m) - (today.d < bd.d ? 1 : 0);
  return Math.max(0, months);
}

interface Ymd {
  y: number;
  m: number;
  d: number;
}

function parseYmd(iso: string): Ymd {
  // 'YYYY-MM-DD' — both bucketToChicagoDate output and Postgres `date` columns
  // serialize this way. Strict split parse (no `new Date(...)` — that would
  // introduce a host-TZ interpretation we already eliminated upstream).
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) {
    throw new Error(`ageInMonths: invalid YYYY-MM-DD: ${iso}`);
  }
  return { y, m, d };
}
