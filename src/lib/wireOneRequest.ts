import {
  requestsRepository,
  type PendingRequestFullRow,
} from '../db/repositories/requestsRepository.js';
import { staffRepository } from '../db/repositories/staffRepository.js';
import type { Tx } from '../db/tx.js';
import { pgTimestampToIso } from './pgTimestamp.js';
import { groupRequestDogs, toRequestWire, type PendingRequestWire } from './requestWire.js';

/**
 * Resolve one full pending-request row to its `PendingRequestWire` shape,
 * reading the dependent join tables (dogs + preferred-dates) inside the
 * same tx so freshly-updated state is visible before the mutation commits.
 *
 * Extracted Day-15 at the rule-of-two trigger — `routes/staffRequests.ts`
 * (Day-12 approve + deny) is the first caller; `routes/requestConfirm.ts`
 * (9.0.0, the family's Board & Train yes) is the second. The helper couples the wire
 * shaper to repo calls deliberately — both call sites need the live
 * join-row resolve and a pure wire function would punt the same two
 * queries into each route file.
 */
export async function wireOneRequest(
  tx: Tx,
  row: PendingRequestFullRow,
): Promise<PendingRequestWire> {
  const [dogRows, dateRows, trainerNames] = await Promise.all([
    requestsRepository.findDogsByRequestIds([row.id], tx),
    requestsRepository.findPreferredDatesByRequestIds([row.id], tx),
    staffRepository.findAnyNamesByIds(
      row.approvedTrainerStaffId === null ? [] : [row.approvedTrainerStaffId],
      tx,
    ),
  ]);
  const dogIds = groupRequestDogs(dogRows).get(row.id);
  if (dogIds === undefined) {
    throw new Error(`pending_request ${row.id}: no pending_request_dogs rows`);
  }
  const dates = dateRows.map((r) => pgTimestampToIso(r.preferredAt));
  const trainer =
    row.approvedTrainerStaffId === null ? undefined : trainerNames.get(row.approvedTrainerStaffId);
  return toRequestWire(row, dogIds, dates, trainer);
}
