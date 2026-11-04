import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../client.js';
import {
  accountSettings,
  alumniSettings,
  cashSettings,
  creditSettings,
  dayProgramSettings,
  dogGateSettings,
  evaluationSettings,
  groupClasses,
  messagingSettings,
  migrationSettings,
  notificationSettings,
  paymentSettings,
  reportsSettings,
  staff,
  staffSettings,
  vaccineSettings,
} from '../schema/schema.js';
import type { Tx } from '../tx.js';
import type {
  AccountSettingsWire,
  AlumniSettingsWire,
  CashSettingsWire,
  CreditSettingsWire,
  DayProgramCampusSettingsWire,
  DayProgramGlobalSettingsWire,
  DogGateSettingsWire,
  EvaluationCampusSettingsWire,
  EvaluationGlobalSettingsWire,
  LocationKey,
  MessagingSettingsWire,
  MigrationSettingsWire,
  NotificationSettingsWire,
  OwnerClassSettingsWire,
  PaymentSettingWire,
  ReportsSettingsWire,
  StaffSettingsWire,
  VaccineSettingsWire,
} from '../../contracts/wire.js';
import { ApiError } from '../../lib/errors.js';
import { pgTimestampToIso } from '../../lib/pgTimestamp.js';
import type { SettingsTable } from '../../lib/settingsRegistry.js';

/**
 * Data access for the LG1 settings tables (SET-U01; design §2.1 "Service file
 * plan": one typed read per table). Every read goes to Postgres — there is no
 * cache in front of any settings table (conflict 19), so a PATCH is visible to
 * the very next read.
 *
 * Each read returns its domain's wire shape (`contracts/wire.ts` § settings):
 * columns are the wire's field names (DECISIONS 53, D5), `time` columns are
 * served `HH:MM`, `numeric` fractions as numbers, `updated_at` as ISO-8601.
 * jsonb columns are served as stored: the settings PATCH is their one writer
 * and validates the shape before it writes, and their seeds are the steps'.
 *
 * A missing seeded row is a broken database, not an absence to paper over:
 * every read refuses with `not_found`, naming the step that seeds the row.
 */

type Runner = Tx | typeof db;

/** `time` → `HH:MM` (the column has no seconds in any seed or PATCH). */
function hhmm(value: string): string {
  return value.slice(0, 5);
}

function audit(row: { updatedAt: string; updatedByStaffId: string | null }) {
  return { updated_at: pgTimestampToIso(row.updatedAt), updated_by_staff_id: row.updatedByStaffId };
}

function seeded<T>(row: T | undefined, what: string, step: string): T {
  if (row === undefined) {
    throw new ApiError('not_found', `${what} has no seeded row — apply ${step}`);
  }
  return row;
}

export const settingsRepository = {
  async account(runner: Runner = db): Promise<AccountSettingsWire> {
    const [row] = await runner.select().from(accountSettings).limit(1);
    const r = seeded(row, 'account_settings', 'M1.01');
    return {
      email_verification_grace_days: r.emailVerificationGraceDays,
      close_blocked_by_pending_refund_enabled: r.closeBlockedByPendingRefundEnabled,
      close_auto_refund_fraction: Number(r.closeAutoRefundFraction),
      reactivation_restores_expired_value_enabled: r.reactivationRestoresExpiredValueEnabled,
      locked_account_view_mode:
        r.lockedAccountViewMode as AccountSettingsWire['locked_account_view_mode'],
      pause_reserved_service_return_mode:
        r.pauseReservedServiceReturnMode as AccountSettingsWire['pause_reserved_service_return_mode'],
      signup_fields: r.signupFields as AccountSettingsWire['signup_fields'],
      ...audit(r),
    };
  },

  async alumni(runner: Runner = db): Promise<AlumniSettingsWire> {
    const [row] = await runner.select().from(alumniSettings).limit(1);
    const r = seeded(row, 'alumni_settings', 'M1.02');
    return {
      recheck_after_months_unseen: r.recheckAfterMonthsUnseen,
      recheck_due_mirrors_reeval_due_enabled: r.recheckDueMirrorsReevalDueEnabled,
      ...audit(r),
    };
  },

  async cash(runner: Runner = db): Promise<CashSettingsWire> {
    const [row] = await runner.select().from(cashSettings).limit(1);
    const r = seeded(row, 'cash_settings', 'M1.05');
    return {
      unpaid_checkout_block_enabled: r.unpaidCheckoutBlockEnabled,
      pack_grant_on_promise_enabled: r.packGrantOnPromiseEnabled,
      did_not_pay_undo_window_hours: r.didNotPayUndoWindowHours,
      pack_partial_payment_destination:
        r.packPartialPaymentDestination as CashSettingsWire['pack_partial_payment_destination'],
      bounced_check_fee_cents: r.bouncedCheckFeeCents,
      due_event_by_service: r.dueEventByService as CashSettingsWire['due_event_by_service'],
      ...audit(r),
    };
  },

  async credit(runner: Runner = db): Promise<CreditSettingsWire> {
    const [row] = await runner.select().from(creditSettings).limit(1);
    const r = seeded(row, 'credit_settings', 'M1.06');
    return {
      expiry_enforced_enabled: r.expiryEnforcedEnabled,
      expiry_warning_lead_days: r.expiryWarningLeadDays,
      manual_grant_expiry_months: r.manualGrantExpiryMonths,
      returned_credit_expiry_months: r.returnedCreditExpiryMonths,
      booking_outlives_lot_expiry_enabled: r.bookingOutlivesLotExpiryEnabled,
      single_day_purchase_max_count: r.singleDayPurchaseMaxCount,
      account_deletion_expires_credits_enabled: r.accountDeletionExpiresCreditsEnabled,
      dispute_auto_reversal_enabled: r.disputeAutoReversalEnabled,
      pause_daily_expiry_extension_days: r.pauseDailyExpiryExtensionDays,
      unpaid_payment_auto_reversal_enabled: r.unpaidPaymentAutoReversalEnabled,
      ...audit(r),
    };
  },

  async dayGlobal(runner: Runner = db): Promise<DayProgramGlobalSettingsWire> {
    const [row] = await runner
      .select()
      .from(dayProgramSettings)
      .where(isNull(dayProgramSettings.location))
      .limit(1);
    return dayGlobalWire(seeded(row, 'day_program_settings (global row)', 'M1.07'));
  },

  /**
   * The global row `FOR SHARE`, the cap-lowering check's first step: a horizon edit
   * holds this row until it commits, so an edit and a horizon raise queue, and the
   * check's window stays the horizon in force until the check's own COMMIT. A booking
   * reads this row with a plain SELECT, which neither lock blocks.
   */
  async shareDayGlobal(tx: Tx): Promise<DayProgramGlobalSettingsWire> {
    const [row] = await tx
      .select()
      .from(dayProgramSettings)
      .where(isNull(dayProgramSettings.location))
      .for('share');
    return dayGlobalWire(seeded(row, 'day_program_settings (global row)', 'M1.07'));
  },

  async dayCampus(
    location: LocationKey,
    runner: Runner = db,
  ): Promise<DayProgramCampusSettingsWire> {
    const [row] = await runner
      .select()
      .from(dayProgramSettings)
      .where(eq(dayProgramSettings.location, location))
      .limit(1);
    return dayCampusWire(location, seeded(row, `day_program_settings (${location})`, 'M1.07'));
  },

  /**
   * The campus row `FOR UPDATE`, for the cap-lowering PATCH (DECISIONS 128(i)): two
   * PATCHes queue here, so each compares its edit with the row the other left. A
   * booking reads this row with a plain SELECT, which a row lock does not block.
   */
  async lockDayCampus(location: LocationKey, tx: Tx): Promise<DayProgramCampusSettingsWire> {
    const [row] = await tx
      .select()
      .from(dayProgramSettings)
      .where(eq(dayProgramSettings.location, location))
      .for('update');
    return dayCampusWire(location, seeded(row, `day_program_settings (${location})`, 'M1.07'));
  },

  async dayCampuses(runner: Runner = db): Promise<DayProgramCampusSettingsWire[]> {
    const rows = await runner
      .select()
      .from(dayProgramSettings)
      .where(isNotNull(dayProgramSettings.location));
    return rows.map((r) => dayCampusWire(r.location as LocationKey, r));
  },

  async dogGate(runner: Runner = db): Promise<DogGateSettingsWire> {
    const [row] = await runner.select().from(dogGateSettings).limit(1);
    const r = seeded(row, 'dog_gate_settings', 'M1.08');
    return {
      spay_neuter_required_by_age_months: r.spayNeuterRequiredByAgeMonths,
      spay_neuter_gated_categories: r.spayNeuterGatedCategories,
      spay_neuter_reminder_time: hhmm(r.spayNeuterReminderTime),
      card_required_at_board_train_confirm: r.cardRequiredAtBoardTrainConfirm,
      card_required_for_evaluation_booking_enabled: r.cardRequiredForEvaluationBookingEnabled,
      gate_override_allowed_gate_keys: r.gateOverrideAllowedGateKeys,
      staff_dog_exempt_gate_keys: r.staffDogExemptGateKeys,
      gate_card_on_file_enabled: r.gateCardOnFileEnabled,
      gate_evaluation_enabled: r.gateEvaluationEnabled,
      gate_vaccines_enabled: r.gateVaccinesEnabled,
      gate_agreements_enabled: r.gateAgreementsEnabled,
      ...audit(r),
    };
  },

  async evaluationGlobal(runner: Runner = db): Promise<EvaluationGlobalSettingsWire> {
    const [row] = await runner
      .select()
      .from(evaluationSettings)
      .where(isNull(evaluationSettings.location))
      .limit(1);
    const r = seeded(row, 'evaluation_settings (global row)', 'M1.09');
    return {
      location: null,
      // NULL = the re-evaluation clock is off (EVAL-53; DECISIONS 62).
      reeval_after_months_unseen: r.reevalAfterMonthsUnseen,
      failed_rebook_wait_hours: r.failedRebookWaitHours as number,
      ...audit(r),
    };
  },

  async evaluationCampus(
    location: LocationKey,
    runner: Runner = db,
  ): Promise<EvaluationCampusSettingsWire> {
    const [row] = await runner
      .select()
      .from(evaluationSettings)
      .where(eq(evaluationSettings.location, location))
      .limit(1);
    const r = seeded(row, `evaluation_settings (${location})`, 'M1.09');
    return { location, max_per_day_dogs: r.maxPerDayDogs, ...audit(r) };
  },

  async migration(runner: Runner = db): Promise<MigrationSettingsWire> {
    const [row] = await runner.select().from(migrationSettings).limit(1);
    const r = seeded(row, 'migration_settings', 'M1.10');
    return {
      pilot_family_count: r.pilotFamilyCount,
      full_transfer_after_pilot_months: r.fullTransferAfterPilotMonths,
      import_credit_balances_enabled: r.importCreditBalancesEnabled,
      imported_credit_expiry_months: r.importedCreditExpiryMonths,
      import_unpaid_balances_enabled: r.importUnpaidBalancesEnabled,
      invite_recent_within_months: r.inviteRecentWithinMonths,
      gingr_retention_billing_cycles: r.gingrRetentionBillingCycles,
      ...audit(r),
    };
  },

  /** With the two responders' first names resolved from their staff rows
   *  (MSG-U02; an expired staffer still resolves — the row is kept). */
  async messaging(runner: Runner = db): Promise<MessagingSettingsWire> {
    const defaultResponder = alias(staff, 'default_responder');
    const backupResponder = alias(staff, 'backup_responder');
    const [row] = await runner
      .select({
        settings: messagingSettings,
        defaultName: defaultResponder.name,
        backupName: backupResponder.name,
      })
      .from(messagingSettings)
      .leftJoin(
        defaultResponder,
        eq(defaultResponder.id, messagingSettings.schoolDefaultResponderStaffId),
      )
      .leftJoin(
        backupResponder,
        eq(backupResponder.id, messagingSettings.schoolBackupResponderStaffId),
      )
      .limit(1);
    const { settings: r, defaultName, backupName } = seeded(row, 'messaging_settings', 'M1.11');
    return {
      referral_subtopic_enabled: r.referralSubtopicEnabled,
      school_default_responder_staff_id: r.schoolDefaultResponderStaffId,
      school_backup_responder_staff_id: r.schoolBackupResponderStaffId,
      school_default_responder_out: r.schoolDefaultResponderOut,
      video_max_duration_seconds: r.videoMaxDurationSeconds,
      video_max_size_mb: r.videoMaxSizeMb,
      max_attachments_per_message: r.maxAttachmentsPerMessage,
      max_text_length_chars: r.maxTextLengthChars,
      request_reply_window_hours: r.requestReplyWindowHours,
      reply_signature_mode: r.replySignatureMode as MessagingSettingsWire['reply_signature_mode'],
      school_default_responder_first_name: firstName(defaultName),
      school_backup_responder_first_name: firstName(backupName),
      ...audit(r),
    };
  },

  async notification(runner: Runner = db): Promise<NotificationSettingsWire> {
    const [row] = await runner.select().from(notificationSettings).limit(1);
    const r = seeded(row, 'notification_settings', 'M1.12');
    return {
      quiet_hours_start_time: hhmm(r.quietHoursStartTime),
      quiet_hours_end_time: hhmm(r.quietHoursEndTime),
      quiet_hours_bypass_types:
        r.quietHoursBypassTypes as NotificationSettingsWire['quiet_hours_bypass_types'],
      scan_send_time: hhmm(r.scanSendTime),
      booking_reminder_lead_hours: r.bookingReminderLeadHours,
      card_expiry_warning_days_before: r.cardExpiryWarningDaysBefore,
      email_sender_address: r.emailSenderAddress,
      broadcast_audience_list:
        r.broadcastAudienceList as NotificationSettingsWire['broadcast_audience_list'],
      cash_payment_due_reminder_lead_hours: r.cashPaymentDueReminderLeadHours,
      email_sender_display_name: r.emailSenderDisplayName,
      reminder_channel_by_program:
        r.reminderChannelByProgram as NotificationSettingsWire['reminder_channel_by_program'],
      expiry_notice_channel:
        r.expiryNoticeChannel as NotificationSettingsWire['expiry_notice_channel'],
      email_inflight_alarm_minutes: r.emailInflightAlarmMinutes,
      ...audit(r),
    };
  },

  /** Every `payment_settings` row, key then scope order. */
  async payment(runner: Runner = db): Promise<PaymentSettingWire[]> {
    const rows = await runner
      .select()
      .from(paymentSettings)
      .orderBy(paymentSettings.key, paymentSettings.scope);
    if (rows.length === 0)
      throw new ApiError('not_found', 'payment_settings has no seeded rows — apply M1.13');
    return rows.map(
      (r) =>
        ({
          key: r.key,
          scope: r.scope,
          value: r.value,
          ...audit(r),
        }) as PaymentSettingWire,
    );
  },

  async reports(runner: Runner = db): Promise<ReportsSettingsWire> {
    const [row] = await runner.select().from(reportsSettings).limit(1);
    const r = seeded(row, 'reports_settings', 'M1.15');
    return {
      events_enabled: r.eventsEnabled,
      event_max_dogs_per_rsvp: r.eventMaxDogsPerRsvp,
      gallery_enabled: r.galleryEnabled,
      gallery_max_dogs: r.galleryMaxDogs,
      gallery_rate_limit_per_minute: r.galleryRateLimitPerMinute,
      media_max_upload_megabytes: r.mediaMaxUploadMegabytes,
      ...audit(r),
    };
  },

  async vaccine(runner: Runner = db): Promise<VaccineSettingsWire> {
    const [row] = await runner.select().from(vaccineSettings).limit(1);
    const r = seeded(row, 'vaccine_settings', 'M1.16');
    return {
      proof_file_types: r.proofFileTypes,
      typical_full_vaccination_age_months: r.typicalFullVaccinationAgeMonths,
      ...audit(r),
    };
  },

  /** The `staff` domain (M1.21): the five role lists and the idle minutes. */
  async staff(runner: Runner = db): Promise<StaffSettingsWire> {
    const [row] = await runner.select().from(staffSettings).limit(1);
    const r = seeded(row, 'staff_settings', 'M1.21');
    return {
      refund_roles: r.refundRoles,
      credit_hand_edit_roles: r.creditHandEditRoles,
      desk_sale_roles: r.deskSaleRoles,
      custom_invoice_roles: r.customInvoiceRoles,
      cash_day_totals_roles: r.cashDayTotalsRoles,
      portal_idle_signout_minutes: r.portalIdleSignoutMinutes,
      ...audit(r),
    };
  },

  /**
   * `pay.refund_any_role_limit_cents` (M1.13; §3.7): what a role OFF
   * `staff.refund_role_list` may refund; above 0 it opens `refund_money` to
   * every role. A missing row or a non-integer value is a broken database,
   * never a silent 0.
   */
  async refundAnyRoleLimitCents(runner: Runner = db): Promise<number> {
    const [row] = await runner
      .select({ value: paymentSettings.value })
      .from(paymentSettings)
      .where(
        and(
          eq(paymentSettings.key, 'refund_any_role_limit_cents'),
          eq(paymentSettings.scope, 'global'),
        ),
      );
    const r = seeded(row, 'payment_settings refund_any_role_limit_cents', 'M1.13');
    if (typeof r.value !== 'number' || !Number.isInteger(r.value)) {
      throw new Error(
        `payment_settings refund_any_role_limit_cents holds ${JSON.stringify(r.value)}, not a whole number of cents`,
      );
    }
    return r.value;
  },

  /**
   * The owner document's `cls` section: every live class's price, weeks and
   * capacity, read from Postgres — NOT `groupClassesRepository.findAll`, whose
   * Redis read-through the document must not sit behind (conflict 19).
   */
  async liveClasses(runner: Runner = db): Promise<OwnerClassSettingsWire[]> {
    const rows = await runner
      .select({
        key: groupClasses.key,
        price_per_dog_cents: groupClasses.pricePerDogCents,
        weeks: groupClasses.weeks,
        capacity: groupClasses.capacity,
      })
      .from(groupClasses)
      .where(isNull(groupClasses.expiredAt))
      .orderBy(groupClasses.key);
    return rows;
  },

  /** The scopes that hold a `charge_timing_mode` row. */
  async chargeTimingScopes(runner: Runner = db): Promise<string[]> {
    const rows = await runner
      .select({ scope: paymentSettings.scope })
      .from(paymentSettings)
      .where(eq(paymentSettings.key, 'charge_timing_mode'));
    return rows.map((r) => r.scope);
  },

  /**
   * Write one settings row: every `(column, value)` pair, plus `updated_at` and
   * `updated_by_staff_id`. `row` picks the singleton (`id`), a two-tier table's
   * global row (`location: null`) or a campus row. `jsonbColumns` are sent as
   * JSON text and cast — node-postgres would otherwise send a JS array as a
   * Postgres array literal. A CHECK violation surfaces as Postgres `23514` for
   * the caller to map. Returns the rows written (1, or 0 if the row is absent).
   * Every value goes as one bound parameter (`sql.param`): interpolated bare,
   * drizzle would expand a JS array into a row expression.
   */
  async updateRow(
    tx: Tx,
    args: {
      table: SettingsTable;
      row: { kind: 'singleton' } | { kind: 'tier'; location: LocationKey | null };
      values: ReadonlyArray<{ column: string; value: unknown; jsonb: boolean }>;
      staffId: string;
    },
  ): Promise<number> {
    const assignments = args.values.map(({ column, value, jsonb }) =>
      jsonb
        ? sql`${sql.identifier(column)} = ${JSON.stringify(value)}::jsonb`
        : // sql.param: ONE placeholder — a bare array would expand to a row
          sql`${sql.identifier(column)} = ${sql.param(value)}`,
    );
    const where =
      args.row.kind === 'singleton'
        ? sql`id`
        : args.row.location === null
          ? sql`location IS NULL`
          : sql`location = ${args.row.location}`;
    const result = await tx.execute(sql`
      UPDATE ${sql.identifier(args.table)}
         SET ${sql.join(assignments, sql`, `)},
             updated_at = now(),
             updated_by_staff_id = ${args.staffId}
       WHERE ${where}`);
    return result.rowCount ?? 0;
  },

  /** Write one `payment_settings` row's value. Returns the rows written. */
  async updatePaymentValue(
    tx: Tx,
    args: { key: string; scope: string; value: unknown; staffId: string },
  ): Promise<number> {
    const rows = await tx
      .update(paymentSettings)
      .set({
        value: sql`${JSON.stringify(args.value)}::jsonb`,
        updatedAt: sql`now()`,
        updatedByStaffId: args.staffId,
      })
      .where(and(eq(paymentSettings.key, args.key), eq(paymentSettings.scope, args.scope)))
      .returning({ key: paymentSettings.key });
    return rows.length;
  },
};

/** The tier CHECK makes every global column non-null on this row. */
function dayGlobalWire(r: typeof dayProgramSettings.$inferSelect): DayProgramGlobalSettingsWire {
  return {
    location: null,
    booking_horizon_months: r.bookingHorizonMonths as number,
    max_dogs_per_booking_count: r.maxDogsPerBookingCount as number,
    day_school_one_on_one_minutes: r.daySchoolOneOnOneMinutes as number,
    after_school_price_cents: r.afterSchoolPriceCents as number,
    occupied_block_end_time: hhmm(r.occupiedBlockEndTime as string),
    midstay_day_charge_fraction: Number(r.midstayDayChargeFraction),
    sent_home_before_training_return_fraction: Number(r.sentHomeBeforeTrainingReturnFraction),
    sent_home_after_training_return_fraction: Number(r.sentHomeAfterTrainingReturnFraction),
    closure_return_fraction: Number(r.closureReturnFraction),
    ...audit(r),
  };
}

function dayCampusWire(
  location: LocationKey,
  r: typeof dayProgramSettings.$inferSelect,
): DayProgramCampusSettingsWire {
  // The tier CHECK makes every campus column non-null on a campus row.
  return {
    location,
    offerings: r.offerings as DayProgramCampusSettingsWire['offerings'],
    open_weekdays_list: r.openWeekdaysList as number[],
    dropoff_open_time: hhmm(r.dropoffOpenTime as string),
    dropoff_close_time: hhmm(r.dropoffCloseTime as string),
    pickup_open_time: hhmm(r.pickupOpenTime as string),
    pickup_close_time: hhmm(r.pickupCloseTime as string),
    same_day_cutoff_time: hhmm(r.sameDayCutoffTime as string),
    daily_capacity_dogs: r.dailyCapacityDogs as number,
    late_pickup_call_time: hhmm(r.latePickupCallTime as string),
    late_pickup_fee_cents: r.latePickupFeeCents as number,
    late_pickup_grace_minutes: r.latePickupGraceMinutes as number,
    after_school_start_time: hhmm(r.afterSchoolStartTime as string),
    after_school_end_time: hhmm(r.afterSchoolEndTime as string),
    after_school_capacity_count: r.afterSchoolCapacityCount as number,
    ...audit(r),
  };
}

/** A staff row's first name — the name up to its first space. */
function firstName(name: string | null): string | null {
  if (name === null) return null;
  return name.trim().split(/\s+/)[0] ?? null;
}
