/**
 * §J.1 membership billing math. PURE — no DB imports; the repository +
 * roll phase own the reads/writes, this module owns the period arithmetic.
 *
 * Two rules, chosen for edge-case correctness on end-of-month starts:
 *
 * 1. **Clamped month-adds, anchored on each period's own start**
 *    (`nextMonthlyPeriodEnd`): a period ends one calendar month after it
 *    starts, on the start's day-of-month clamped to the target month's last
 *    day. Naive month-adds overflow (Jan 31 +1mo normalizes to Mar 3 via JS
 *    Date); anchoring on the ORIGINAL started_at day instead would snap a
 *    post-pause-shift boundary to a days-long "month" billed at full price.
 *    Per-start clamping keeps every period 28-31 days under every shift; the
 *    mild drift-down on end-of-month chains (31 → 28 → 28…) is harmless
 *    because of rule 2. UTC calendar throughout — consistent with the
 *    credit-expiry window math (`lib/creditExpiry.ts`).
 *
 * 2. **Term exhaustion is a COUNT, not a date compare** (see the roll phase,
 *    `lib/membershipRoll.ts`): a term of N months bills exactly N periods —
 *    1 synchronous month-1 charge + (N−1) rolled invoices. Date-compare hard
 *    stops mis-bill on clamped boundaries and after a pause-resume shift;
 *    counting the membership's invoices is exact under both.
 */

/** Days in a UTC (year, month) — month is 1-12. */
function daysInUtcMonth(year: number, month: number): number {
  // Day 0 of the NEXT month = last day of this month.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Advance `from` by `months` calendar months, landing on `anchorDayOfMonth`
 * clamped to the target month's length. Time-of-day is preserved from `from`.
 */
export function addMonthsAnchored(from: Date, months: number, anchorDayOfMonth: number): Date {
  const totalMonths = from.getUTCFullYear() * 12 + from.getUTCMonth() + months;
  const targetYear = Math.floor(totalMonths / 12);
  const targetMonth = totalMonths % 12; // 0-11
  const day = Math.min(anchorDayOfMonth, daysInUtcMonth(targetYear, targetMonth + 1));
  return new Date(
    Date.UTC(
      targetYear,
      targetMonth,
      day,
      from.getUTCHours(),
      from.getUTCMinutes(),
      from.getUTCSeconds(),
      from.getUTCMilliseconds(),
    ),
  );
}

/** The subscription's boundary anchor: started_at's UTC day-of-month. */
export function anchorDayOf(startedAt: Date): number {
  return startedAt.getUTCDate();
}

/**
 * A billing period's end from its OWN start: start + 1 month, clamped to the
 * start's day-of-month. Anchoring on the period's own start (not started_at)
 * keeps every period 28-31 days long even after a pause-resume gap-shift
 * moved the boundary off the original anchor day — an original-anchor snap
 * could produce a days-long "month" billed at full price. Term exhaustion is
 * COUNT-based (see the roll), so the slight clamp drift on end-of-month
 * chains (31 → 28 → 28…) costs nothing.
 */
export function nextMonthlyPeriodEnd(periodStart: Date): Date {
  return addMonthsAnchored(periodStart, 1, anchorDayOf(periodStart));
}

/** Month-1 period bounds at POST: [now, now + 1 clamped month). */
export function firstPeriod(now: Date): { start: Date; end: Date } {
  return { start: now, end: nextMonthlyPeriodEnd(now) };
}

/**
 * Informational hard-stop date for the wire (`ends_at` = started + term,
 * anchored). The roll phase's actual stop is the billed-period count.
 */
export function membershipEndsAt(startedAt: Date, termMonths: number): Date {
  return addMonthsAnchored(startedAt, termMonths, anchorDayOf(startedAt));
}
