import type { FastifyInstance } from 'fastify';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import {
  LOCATIONS,
  type DayProgramCampusSettingsWire,
  type GetSettingsResponse,
  type LocationKey,
  type OwnerDayCampusSettingsWire,
  type OwnerEvaluationCampusSettingsWire,
  type PaymentChargeTimingMode,
  type ServiceCategory,
  type ServiceOfferingWire,
} from '../contracts/wire.js';
import { serviceRatesRepository } from '../db/repositories/serviceRatesRepository.js';
import { settingsRepository } from '../db/repositories/settingsRepository.js';
import { bucketChicagoToday } from '../lib/chicagoDate.js';

/**
 * `GET /settings` `[auth]` — the owner settings document (SET-U01, E51;
 * design §1.1:608-627, §2.1:1870-1887; wire `OwnerSettingsWire`): every
 * domain's public subset in one read.
 *
 * Built from Postgres on EVERY call — no Redis, no invalidation hook, no TTL
 * (conflict 19) — so a settings PATCH is visible to the very next call. On the
 * ordinary `authenticate` guard with no principal-kind gate: the document is
 * the same for everyone and names no family. It never reads `staff_settings`,
 * `cash_settings`, `migration_settings`, `account_settings` or
 * `alumni_settings` (no owner section), and it has no `cxl` and no `mig`
 * section in v1.
 *
 * A store that has not landed emits `null`, never a default: the evaluation's
 * per-campus price is the row `GET /rates` would select (category
 * `evaluation`), which M3.05 seeds at 0; `null` if a campus has no active row.
 */

export interface SettingsRouteOptions extends AuthRouteOptions {
  /** Clock for the effective-dated evaluation price lookup. Default: now. */
  now?: () => Date;
}

const OWNER_DAY_CAMPUS_KEYS = [
  'open_weekdays_list',
  'dropoff_open_time',
  'dropoff_close_time',
  'pickup_open_time',
  'pickup_close_time',
  'same_day_cutoff_time',
  'after_school_start_time',
  'after_school_end_time',
  'late_pickup_call_time',
] as const satisfies ReadonlyArray<keyof OwnerDayCampusSettingsWire>;

function byLocation<T>(
  rows: readonly { location: LocationKey }[],
  pick: (location: LocationKey) => T,
): Record<LocationKey, T> {
  const present = new Set(rows.map((r) => r.location));
  const missing = LOCATIONS.filter((l) => !present.has(l));
  if (missing.length > 0) {
    // A broken database, a 500 whose log names the row (STAFF-U45, P21).
    throw new Error(`day_program_settings has no row for ${missing.join(', ')} — apply M1.07`);
  }
  return Object.fromEntries(LOCATIONS.map((l) => [l, pick(l)])) as Record<LocationKey, T>;
}

export async function buildOwnerSettings(today: string): Promise<GetSettingsResponse> {
  const [
    dayGlobal,
    dayCampuses,
    dogGate,
    evalGlobal,
    credit,
    classes,
    messaging,
    notification,
    reports,
    vaccine,
    payment,
  ] = await Promise.all([
    settingsRepository.dayGlobal(),
    settingsRepository.dayCampuses(),
    settingsRepository.dogGate(),
    settingsRepository.evaluationGlobal(),
    settingsRepository.credit(),
    settingsRepository.liveClasses(),
    settingsRepository.messaging(),
    settingsRepository.notification(),
    settingsRepository.reports(),
    settingsRepository.vaccine(),
    settingsRepository.payment(),
  ]);
  const evalPrices = await Promise.all(
    LOCATIONS.map(async (location): Promise<[LocationKey, OwnerEvaluationCampusSettingsWire]> => {
      const rate = await serviceRatesRepository.findActiveRate('evaluation', location, today);
      return [location, { price_cents: rate?.amount_cents ?? null }];
    }),
  );

  const campus = new Map<LocationKey, DayProgramCampusSettingsWire>(
    dayCampuses.map((c) => [c.location, c]),
  );
  const at = (location: LocationKey) => campus.get(location) as DayProgramCampusSettingsWire;

  const chargeTiming: Record<string, PaymentChargeTimingMode> = {};
  let maxSessions: number | undefined;
  for (const row of payment) {
    if (row.key === 'charge_timing_mode') chargeTiming[row.scope] = row.value;
    if (row.key === 'max_sessions_per_booking_count') maxSessions = row.value;
  }
  if (maxSessions === undefined) {
    throw new Error('payment_settings has no max_sessions_per_booking_count row — apply M1.13');
  }

  return {
    offerings: byLocation<Record<ServiceCategory, ServiceOfferingWire>>(
      dayCampuses,
      (l) => at(l).offerings,
    ),
    day: {
      booking_horizon_months: dayGlobal.booking_horizon_months,
      max_dogs_per_booking_count: dayGlobal.max_dogs_per_booking_count,
      day_school_one_on_one_minutes: dayGlobal.day_school_one_on_one_minutes,
      after_school_price_cents: dayGlobal.after_school_price_cents,
      by_location: byLocation(dayCampuses, (l) => {
        const row = at(l);
        return Object.fromEntries(
          OWNER_DAY_CAMPUS_KEYS.map((k) => [k, row[k]]),
        ) as OwnerDayCampusSettingsWire;
      }),
    },
    gates: {
      card_on_file: dogGate.gate_card_on_file_enabled,
      evaluation: dogGate.gate_evaluation_enabled,
      vaccines: dogGate.gate_vaccines_enabled,
      agreements: dogGate.gate_agreements_enabled,
    },
    eval: {
      reeval_after_months_unseen: evalGlobal.reeval_after_months_unseen,
      by_location: Object.fromEntries(evalPrices) as Record<
        LocationKey,
        OwnerEvaluationCampusSettingsWire
      >,
    },
    cred: {
      expiry_enforced_enabled: credit.expiry_enforced_enabled,
      expiry_warning_lead_days: credit.expiry_warning_lead_days,
      // 5.0.0 (P18 mobile G5, G6): the calendar's "no credit reaches this date" is true
      // only while the outliving switch is off, and the shop's stepper stops at the cap
      // the purchase route enforces rather than meeting 422 `count_not_allowed`.
      booking_outlives_lot_expiry_enabled: credit.booking_outlives_lot_expiry_enabled,
      single_day_purchase_max_count: credit.single_day_purchase_max_count,
    },
    cls: classes,
    msg: {
      request_reply_window_hours: messaging.request_reply_window_hours,
      referral_subtopic_enabled: messaging.referral_subtopic_enabled,
      max_attachments_per_message: messaging.max_attachments_per_message,
      max_text_length_chars: messaging.max_text_length_chars,
      video_max_duration_seconds: messaging.video_max_duration_seconds,
      video_max_size_mb: messaging.video_max_size_mb,
    },
    notif: {
      booking_reminder_lead_hours: notification.booking_reminder_lead_hours,
      quiet_hours_start_time: notification.quiet_hours_start_time,
      quiet_hours_end_time: notification.quiet_hours_end_time,
      quiet_hours_bypass_types: notification.quiet_hours_bypass_types,
    },
    rpt: {
      events_enabled: reports.events_enabled,
      gallery_enabled: reports.gallery_enabled,
      media_max_upload_megabytes: reports.media_max_upload_megabytes,
    },
    vax: {
      proof_file_types: vaccine.proof_file_types,
      typical_full_vaccination_age_months: vaccine.typical_full_vaccination_age_months,
    },
    pay: { charge_timing_mode: chargeTiming, max_sessions_per_booking_count: maxSessions },
  };
}

export function registerSettingsRoute(app: FastifyInstance, opts: SettingsRouteOptions = {}): void {
  const authHook = resolveAuthHook(opts);
  const now = opts.now ?? ((): Date => new Date());

  app.get(
    '/settings',
    { preHandler: [authHook] },
    async (request): Promise<GetSettingsResponse> => {
      requirePrincipal(request);
      return buildOwnerSettings(bucketChicagoToday(now()));
    },
  );
}
