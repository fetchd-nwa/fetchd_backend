import { db } from '../db/client.js';
import {
  requestsRepository,
  type PendingRequestRow,
} from '../db/repositories/requestsRepository.js';
import type { Tx } from '../db/tx.js';
import { pgTimestampToDate, pgTimestampToIso } from './pgTimestamp.js';
import { groupRequestDogs, toRequestWire, type PendingRequestWire } from './requestWire.js';

/**
 * Batched denormalization of N pending-request rows to `PendingRequestWire`
 * shapes. Two join lookups (dogs + preferred-dates) regardless of row count.
 *
 * Polymorphic runner (`db` default; pass a Tx to read uncommitted writes
 * back inside a mutation). This is the list sibling of `wireOneRequest` —
 * extracted at the rule-of-two when the Day-19 staff queue
 * (`GET /staff/requests`) became the second consumer of the owner read's
 * batched denormalizer. Same deliberate repo coupling as `wireOneRequest`:
 * both call sites need the live join-row resolve, and a pure wire function
 * would punt the same two queries into each route.
 *
 * Throws if any request has no `pending_request_dogs` rows — a structural
 * invariant (every request has at least a lead dog), so a loud throw beats
 * a silently dropped row.
 */
export async function wireManyRequests(
  rows: PendingRequestRow[],
  runner: Tx | typeof db = db,
): Promise<PendingRequestWire[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [dogRows, dateRows] = await Promise.all([
    requestsRepository.findDogsByRequestIds(ids, runner),
    requestsRepository.findPreferredDatesByRequestIds(ids, runner),
  ]);
  const dogsByRequest = groupRequestDogs(dogRows);
  const datesByRequest = groupPreferredDates(dateRows);
  return rows.map((row) => {
    const dogIds = dogsByRequest.get(row.id);
    if (dogIds === undefined) {
      throw new Error(`pending_request ${row.id}: no pending_request_dogs rows found`);
    }
    const dates = datesByRequest.get(row.id) ?? [];
    return toRequestWire(row, dogIds, dates);
  });
}

/**
 * Sort pending-request rows by `submitted_at`. Uses `pgTimestampToDate`
 * (not `new Date`) so PG's default timestamptz format (single-pair `+TZ`,
 * V8-incompatible) round-trips correctly — same parser as
 * `routes/bookings.ts:sortByScheduledAt`.
 */
export function sortRequestsBySubmittedAt(
  rows: PendingRequestRow[],
  direction: 'asc' | 'desc',
): PendingRequestRow[] {
  const sorted = [...rows].sort(
    (a, b) =>
      pgTimestampToDate(a.submittedAt).getTime() - pgTimestampToDate(b.submittedAt).getTime(),
  );
  return direction === 'desc' ? sorted.reverse() : sorted;
}

/**
 * Group preferred-date rows into a per-request ISO array. Repo sorts by
 * `ordinal` ASC; this preserves that order and converts timestamptz to
 * ISO 8601 for emit.
 */
function groupPreferredDates(
  rows: { requestId: string; ordinal: number; preferredAt: string }[],
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const row of rows) {
    const existing = result.get(row.requestId) ?? [];
    existing.push(pgTimestampToIso(row.preferredAt));
    result.set(row.requestId, existing);
  }
  return result;
}
