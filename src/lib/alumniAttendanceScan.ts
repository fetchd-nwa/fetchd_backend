import {
  dogProgramsRepository,
  type AlumniDogAttendance,
} from '../db/repositories/dogProgramsRepository.js';
import { dogsRepository } from '../db/repositories/dogsRepository.js';
import { scheduledNotificationsRepository } from '../db/repositories/scheduledNotificationsRepository.js';
import type { Tx } from '../db/tx.js';
import {
  ALUMNI_MIN_MONTHLY_SESSIONS,
  isFirstOfChicagoMonth,
  previousChicagoMonthWindow,
} from './alumni.js';

/**
 * §J.3 monthly alumni-attendance scan. Mirrors `enqueueCreditExpiryWarnings`
 * (a scheduled scan with no single triggering event) but runs MONTHLY: on the
 * 1st (Chicago), for each alumni dog, count attended qualifying sessions in
 * the just-closed Chicago month; `< ALUMNI_MIN_MONTHLY_SESSIONS` ⇒ enqueue an
 * `alumni-attendance` notification to the owner and stamp
 * `dogs.alumni_attendance_flagged_at`.
 *
 * Ordering invariant: the flag is stamped ONLY when the enqueue actually
 * inserted. The dedupe key (`alumni-attendance:<dogId>:<YYYY-MM>`) is
 * per-month, so it doubles as the once-per-month-per-dog guard: a staff clear
 * later in the month is NOT re-flagged by a later tick that same month (the
 * dedupe row already exists ⇒ no insert ⇒ no re-stamp). A dog still flagged
 * from a prior month keeps its ORIGINAL flag timestamp (`setAlumniAttendance-
 * Flag` is only-if-NULL) while the owner still gets the new month's nudge.
 *
 * Runs inside ONE caller-provided tx (atomic per tick; a mid-scan crash rolls
 * back and the next 1st-of-month tick re-scans safely under the dedupe).
 */

export interface AlumniAttendanceScanResult {
  /** False when `now` isn't the 1st (Chicago) — the scan did nothing. */
  ran: boolean;
  /** Alumni dogs evaluated against the closed month. */
  scanned: number;
  /** New `alumni-attendance` notifications enqueued (dedupe skips excluded). */
  enqueued: number;
  /** Flags newly stamped this tick (≤ enqueued — already-flagged dogs skip). */
  flagged: number;
}

/** Owner-facing copy: the flag means "check in with staff before booking". */
function attendanceBody(dog: AlumniDogAttendance): string {
  return (
    `${dog.dogName} attended fewer than ${ALUMNI_MIN_MONTHLY_SESSIONS} sessions last month. ` +
    `Reach out to the team for a quick check-in before your next visit.`
  );
}

export async function enqueueAlumniAttendanceFlags(
  tx: Tx,
  now: Date,
): Promise<AlumniAttendanceScanResult> {
  if (!isFirstOfChicagoMonth(now)) {
    return { ran: false, scanned: 0, enqueued: 0, flagged: 0 };
  }

  const window = previousChicagoMonthWindow(now);
  const alumniDogs = await dogProgramsRepository.findAlumniDogsWithAttendance(tx, {
    windowStartIso: window.startUtc.toISOString(),
    windowEndIso: window.endUtc.toISOString(),
  });

  let enqueued = 0;
  let flagged = 0;
  for (const dog of alumniDogs) {
    if (dog.attendedCount >= ALUMNI_MIN_MONTHLY_SESSIONS) continue;
    const row = await scheduledNotificationsRepository.enqueueIdempotent(tx, {
      ownerId: dog.ownerId,
      type: 'alumni-attendance',
      trigger: 'alumni-attendance',
      dedupeKey: `alumni-attendance:${dog.dogId}:${window.monthKey}`,
      scheduledFor: now,
      title: 'Alumni check-in needed',
      body: attendanceBody(dog),
      deepLinkPath: `/dog-profile/${dog.dogId}`,
      dogId: dog.dogId,
    });
    // `undefined` = dedupe fired (this month already handled for this dog) —
    // don't re-stamp a flag staff may have just cleared.
    if (row === undefined) continue;
    enqueued += 1;
    if (await dogsRepository.setAlumniAttendanceFlag(tx, dog.dogId, now)) {
      flagged += 1;
    }
  }
  return { ran: true, scanned: alumniDogs.length, enqueued, flagged };
}
