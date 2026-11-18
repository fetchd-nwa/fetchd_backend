import type { FastifyInstance } from 'fastify';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import type {
  GetStaffServiceBookingsResponse,
  StaffServiceBookingWire,
} from '../contracts/wire.js';
import { db } from '../db/client.js';
import { bookingsRepository } from '../db/repositories/bookingsRepository.js';
import { dogsRepository } from '../db/repositories/dogsRepository.js';
import { ownersRepository } from '../db/repositories/ownersRepository.js';
import { staffRepository } from '../db/repositories/staffRepository.js';
import { groupBookingDogs } from '../lib/bookingWire.js';
import { pgTimestampToIso } from '../lib/pgTimestamp.js';
import { requireStaff } from '../lib/principalNarrows.js';

/**
 * `GET /staff/service-bookings` `[staff]`, any role (wire 9.0.0; plan unit P49; design
 * request-services-v1 §2.2 A10): the portal's Requests → Booked tab, the one staff screen
 * a confirmed lesson appears on while the portal's calendar, bookings and lodging screens
 * are hidden. Every live, uncancelled private lesson and Board & Train of every family at
 * both campuses, past ones included (a started lesson or stay is closed out by a staff
 * record, plan unit P51), ordered by start, ties by id. Read only, and it carries no card,
 * payment or invoice field. An owner principal is 403.
 *
 * `trainer`, `quoted_price_cents` and `location` are omitted where the column is null: a
 * row booked before 9.0.0 (dev only), or a Board & Train whose family has no home campus
 * (notes mechanic 9). The trainer's name is the staff row's, expired or not.
 */
export function registerStaffServiceBookingsRoute(
  app: FastifyInstance,
  opts: AuthRouteOptions = {},
): void {
  const authHook = resolveAuthHook(opts);

  app.get(
    '/staff/service-bookings',
    { preHandler: [authHook] },
    async (request): Promise<GetStaffServiceBookingsResponse> => {
      const principal = requirePrincipal(request);
      requireStaff(principal, 'read the booked lessons and stays');
      const rows = await bookingsRepository.findServiceBookings();
      if (rows.length === 0) return [];
      // A share cancelled alone is not on the row (`groupBookingDogs` keeps it apart).
      const shares = await bookingsRepository.findSharesByBookingIds(
        db,
        rows.map((r) => r.id),
      );
      const dogsByBooking = groupBookingDogs(shares);
      const dogIds = [...dogsByBooking.values()].flatMap((d) => [d.lead, ...d.additional]);
      const [owners, dogNames, trainerNames] = await Promise.all([
        ownersRepository.findNamesByIds(rows.map((r) => r.ownerId)),
        dogsRepository.findNamesByIds(dogIds),
        staffRepository.findAnyNamesByIds(
          rows.map((r) => r.trainerStaffId).filter((id): id is string => id !== null),
        ),
      ]);
      return rows.map((row): StaffServiceBookingWire => {
        const dogs = dogsByBooking.get(row.id);
        const owner = owners.get(row.ownerId);
        if (dogs === undefined || owner === undefined) {
          throw new Error(`booking ${row.id}: no live booking_dogs row or no owners row`);
        }
        const trainerName =
          row.trainerStaffId === null ? undefined : trainerNames.get(row.trainerStaffId);
        return {
          booking_id: row.id,
          category: row.category as StaffServiceBookingWire['category'],
          owner: { id: row.ownerId, name: owner.name },
          dogs: [dogs.lead, ...dogs.additional].map((id) => ({
            id,
            name: dogNames.get(id) ?? '',
          })),
          scheduled_at: pgTimestampToIso(row.scheduledAt),
          ...(row.category === 'private-lesson' && row.durationMinutes !== null
            ? { duration_minutes: row.durationMinutes }
            : {}),
          ...(row.category === 'board-and-train' && row.dropoffAt !== null
            ? { dropoff_at: pgTimestampToIso(row.dropoffAt) }
            : {}),
          ...(row.category === 'board-and-train' && row.pickupAt !== null
            ? { pickup_at: pgTimestampToIso(row.pickupAt) }
            : {}),
          ...(row.trainerStaffId !== null && trainerName !== undefined
            ? { trainer: { staff_id: row.trainerStaffId, name: trainerName } }
            : {}),
          ...(row.quotedPriceCents !== null ? { quoted_price_cents: row.quotedPriceCents } : {}),
          ...(row.location !== null ? { location: row.location } : {}),
        };
      });
    },
  );
}
