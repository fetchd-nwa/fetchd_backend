import { LOCATIONS, type LocationKey, type StaffBellWire } from '../contracts/wire.js';
import { ownersRepository } from '../db/repositories/ownersRepository.js';
import { requestsRepository } from '../db/repositories/requestsRepository.js';
import { threadsRepository } from '../db/repositories/threadsRepository.js';
import { isAddressedTo, type StaffReader } from './wireManyThreads.js';

/**
 * `GET /staff/notifications/summary` (9.2.0 `StaffBellWire`; design 7.1.0 NOTIF-U33, signed
 * §2.9:4554; her answer 5: the desk is told by the bell and the tab title). Both campuses for
 * every caller, keyed by the FAMILY's `location` (CR36):
 *   · `unread_client_threads`: the threads addressed to the reader with anything unread for HER,
 *     read off the same rows and the same rule as `GET /staff/threads` (`isAddressedTo`,
 *     `staff_unread_count`), so a read clears only the reader's bell (question 72);
 *   · `pending_requests`: live `submitted` requests, the read behind
 *     `GET /staff/requests?status=submitted` (`requestsRepository.findLive`, A2.3).
 * A family with no campus (`owners.location` NULL) counts on BOTH campuses, threads and requests
 * alike: a family with no campus belongs to either (her precedent, DECISIONS 494 (f); the Opus
 * pass-2 seat's M2, default ruled in MB42, pending her answer). A sum over both campuses counts
 * her twice. Nothing about money (RULING §10 item 8).
 */
export async function staffBell(reader: StaffReader): Promise<StaffBellWire> {
  const [threads, submitted] = await Promise.all([
    threadsRepository.findLiveForStaff(),
    requestsRepository.findLive('submitted'),
  ]);
  const [unread, families] = await Promise.all([
    threadsRepository.findStaffUnreadCounts(
      threads.map((t) => t.id),
      reader.staffId,
    ),
    ownersRepository.findNamesByIds([
      ...threads.map((t) => t.ownerId),
      ...submitted.map((r) => r.ownerId),
    ]),
  ]);
  const by = Object.fromEntries(
    LOCATIONS.map((l) => [l, { unread_client_threads: 0, pending_requests: 0 }]),
  ) as StaffBellWire['by_location'];
  // MB42's default, pending her answer: no campus → both. Counting her on neither is `[]` here.
  const campusesOf = (ownerId: string): readonly LocationKey[] => {
    const campus = families.get(ownerId)?.location ?? null;
    return campus === null ? LOCATIONS : [campus];
  };
  for (const thread of threads) {
    if (!isAddressedTo(thread, reader) || (unread.get(thread.id) ?? 0) === 0) continue;
    for (const campus of campusesOf(thread.ownerId)) by[campus].unread_client_threads += 1;
  }
  for (const request of submitted) {
    for (const campus of campusesOf(request.ownerId)) by[campus].pending_requests += 1;
  }
  return { by_location: by };
}
