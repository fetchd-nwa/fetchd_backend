import { bookingsRepository } from '../db/repositories/bookingsRepository.js';
import { dogProgramsRepository } from '../db/repositories/dogProgramsRepository.js';
import { dogsRepository } from '../db/repositories/dogsRepository.js';
import type { Tx } from '../db/tx.js';

/**
 * Day-program approval-divert rules (Shanthi rulings 2026-07-14, pinned in
 * DATA-CONTRACT "Amendment 2026-07-14"). A day-school / day-care submission
 * that trips ANY of these does not book instantly — POST /bookings creates a
 * `pending_requests` row instead and staff approve it from the portal queue
 * (`POST /staff/requests/:id/approve` converts it into the real bookings).
 *
 * Two rules, both per-dog across the whole roster:
 *
 *   1. **`reevaluation-stale`** — NWA hasn't SEEN the dog in over 3 months.
 *      "Seen" = the dog's last ATTENDED day-school / day-care session
 *      (`booking_dogs.attendance = 'attended'`); group classes, private
 *      lessons, and stays deliberately do NOT reset the clock (Allison
 *      2026-07-14), and a dog that has never attended a day program is
 *      stale by definition (its first booking gets staff eyes — which is
 *      exactly the "catch a missing/too-old evaluation" intent). Attending
 *      the approved session is what freshens the dog: the staff attendance
 *      verb writes the row this rule reads, so approval alone does NOT
 *      clear staleness — showing up does.
 *      **Alumni are exempt** ("super alumni" — the §J.3 derived alumni,
 *      5 live `dog_completed_programs` rows).
 *
 *   2. **`not-spayed-neutered`** — the owner answered the profile question
 *      with an explicit "no" (`dogs.spayed_neutered = FALSE`). Any age:
 *      a too-young intact dog is fine policy-wise but still diverts for
 *      staff eyes (Allison 2026-07-14). NULL (never answered — every
 *      pre-existing dog) does NOT divert; this only bites once the owner
 *      has actually answered. No alumni exemption — this rule is about
 *      the dog's current state, not familiarity.
 *
 * Staff-owned dogs are exempt from BOTH rules — the uniform staff-dog
 * exemption every booking gate carries (§H ruling 2026-05-19).
 *
 * This is deliberately a WORKFLOW rule, not a schema trigger floor like the
 * payment/vaccine/agreement/eval gates: staff paths (the approve conversion,
 * staff on-behalf booking) must be able to create these bookings — staff
 * action IS the override. The only owner-facing create path is
 * POST /bookings, which calls this.
 */

export const STALE_AFTER_MONTHS = 3;

export type DivertReason = 'reevaluation-stale' | 'not-spayed-neutered';

/** `now` minus N calendar months, UTC month arithmetic (mirrors
 * `creditExpiry.addMonthsUtc`, negative direction). */
function subtractMonthsUtc(now: Date, months: number): Date {
  const cutoff = new Date(now.getTime());
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  return cutoff;
}

/**
 * Which divert reasons (if any) apply to booking this roster of dogs right
 * now. Empty array = book instantly, exactly as before the ruling.
 */
export async function resolveApprovalDivert(
  tx: Tx,
  args: { dogIds: readonly string[]; now: Date },
): Promise<DivertReason[]> {
  const fields = await dogsRepository.findApprovalDivertFieldsInTx(tx, args.dogIds);
  const clientDogs = fields.filter((f) => f.staffOwnerId === null);
  if (clientDogs.length === 0) return [];

  const reasons = new Set<DivertReason>();

  if (clientDogs.some((f) => f.spayedNeutered === false)) {
    reasons.add('not-spayed-neutered');
  }

  const staleCutoff = subtractMonthsUtc(args.now, STALE_AFTER_MONTHS);
  for (const dog of clientDogs) {
    if (await dogProgramsRepository.isAlumni(dog.dogId, tx)) continue;
    const lastSeenAt = await bookingsRepository.findLastAttendedDayProgramAt(tx, dog.dogId);
    if (lastSeenAt === undefined || lastSeenAt < staleCutoff) {
      reasons.add('reevaluation-stale');
      break;
    }
  }

  return [...reasons];
}
