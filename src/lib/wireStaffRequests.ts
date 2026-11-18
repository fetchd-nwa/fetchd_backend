import type { StaffRequestWire } from '../contracts/wire.js';
import { dogsRepository } from '../db/repositories/dogsRepository.js';
import { ownersRepository } from '../db/repositories/ownersRepository.js';
import type { PendingRequestRow } from '../db/repositories/requestsRepository.js';
import { staffRepository } from '../db/repositories/staffRepository.js';
import { wireManyRequests } from './wireManyRequests.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A queue row: the request plus the family it belongs to. */
export type StaffQueueRow = PendingRequestRow & { ownerId: string };

/**
 * `GET /staff/requests` rows (wire 9.0.0, A7; design request-services-v1 §2.2):
 * `PendingRequestWire` with the names the portal prints, because the base wire carries
 * ids only. Three batched lookups beyond `wireManyRequests`' own, whatever the row count.
 *   - `owner`: her name (else her email) and her home campus, omitted when she has none.
 *   - `dogs`: the lead (`dog_id`) first, then `additional_dog_ids` in their order.
 *   - `preferred_trainer`: the staffer `focus.staff_preference` names, live or since
 *     expired; omitted for `'any'`, none, or a value naming no staff row (a slug).
 */
export async function wireStaffRequests(rows: StaffQueueRow[]): Promise<StaffRequestWire[]> {
  const wires = await wireManyRequests(rows);
  const dogIds = wires.flatMap((w) => [w.dog_id, ...(w.additional_dog_ids ?? [])]);
  // Only a uuid-shaped preference can name a staff row; a slug never reaches the cast.
  const preferenceIds = rows
    .map((r) => r.staffPreference)
    .filter((p): p is string => p !== null && UUID.test(p))
    .map((p) => p.toLowerCase());
  const [ownersById, dogNames, trainerNames] = await Promise.all([
    ownersRepository.findNamesByIds(rows.map((r) => r.ownerId)),
    dogsRepository.findNamesByIds(dogIds),
    staffRepository.findAnyNamesByIds(preferenceIds),
  ]);
  return wires.map((wire, i) => {
    const row = rows[i] as StaffQueueRow;
    const owner = ownersById.get(row.ownerId);
    if (owner === undefined) {
      throw new Error(`pending_request ${row.id}: owner ${row.ownerId} has no owners row`);
    }
    const preferred = row.staffPreference?.toLowerCase();
    const trainerName = preferred === undefined ? undefined : trainerNames.get(preferred);
    return {
      ...wire,
      owner: {
        id: row.ownerId,
        name: owner.name,
        ...(owner.location !== null ? { location: owner.location } : {}),
      },
      dogs: [wire.dog_id, ...(wire.additional_dog_ids ?? [])].map((id) => ({
        id,
        name: dogNames.get(id) ?? '',
      })),
      ...(preferred !== undefined && trainerName !== undefined
        ? { preferred_trainer: { staff_id: preferred, name: trainerName } }
        : {}),
    };
  });
}
