import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import {
  LOCATIONS,
  SETTINGS_DOMAINS,
  type AccountSettingsWire,
  type AlumniSettingsWire,
  type CashSettingsWire,
  type CreditSettingsWire,
  type DayProgramCampusSettingsWire,
  type DayProgramGlobalSettingsWire,
  type DogGateSettingsWire,
  type EvaluationCampusSettingsWire,
  type EvaluationGlobalSettingsWire,
  type GetStaffSettingsResponse,
  type LocationKey,
  type MigrationSettingsWire,
  type NotificationSettingsWire,
  type PatchStaffSettingsPayRequest,
  type PatchStaffSettingsResponse,
  type ReportsSettingsWire,
  type SettingsAuditKey,
  type SettingsDomain,
  type SettingsPatchByDomain,
  type VaccineSettingsWire,
} from '../contracts/wire.js';
import { hashRequestBody, requireIdempotencyKey, withMutation } from '../db/mutation.js';
import { settingsRepository } from '../db/repositories/settingsRepository.js';
import type { Tx } from '../db/tx.js';
import { ApiError } from '../lib/errors.js';
import { requireStaff } from '../lib/principalNarrows.js';
import {
  SETTINGS_REGISTRY,
  SETTINGS_TABLE_BY_DOMAIN,
  isPatchable,
  mayEditClass,
  type SettingEntry,
  type SettingValue,
} from '../lib/settingsRegistry.js';
import { formatZodIssues } from '../lib/zodIssues.js';

/**
 * `GET` and `PATCH /staff/settings/:domain[/:location]` `[staff]` — every
 * staff-editable setting of the thirteen P01 domains (SET-U01, STAFF-U07's
 * per-key class gate; design §1.1:628-649, §2.1:1849-1869; wire 2.0.0-lg1.1
 * § settings). `day` and `eval` have two tiers: the bare path is the global
 * row, `/:location` that campus's row. Any staff role reads every key; an
 * owner (family) principal is 403.
 *
 * **The PATCH.** Partial: the editor sends its dirty set and every key in the
 * body is an edit (no stored-value compare). A jsonb key is one value, replaced
 * whole. Atomic, refused in this order, and a refused body writes nothing:
 *
 *   1. 400 `bad_request` — a bad path, the strict shape parse (an unknown key —
 *      including the other tier's, and any key whose store has not landed — or
 *      a value of the wrong JSON type), an empty body, a missing
 *      `Idempotency-Key`, or a `charge_timing_mode` scope with no row;
 *   2. 403 `forbidden` + `refused_keys` — a key whose class the caller's role
 *      may not edit (`settingsRegistry.mayEditClass`; no role edits a price);
 *   3. 422 `setting_inert` + `inert_keys` — a key with no v1 reader;
 *   4. 422 `invalid_payload` — a value outside its bounds (the registry's,
 *      which mirror the table's CHECKs; every integer is also held to int4,
 *      DECISIONS 65; no string the body can carry holds a C0 control
 *      character, DECISIONS 71), or a Postgres `23514`, `22003`, `22P02`,
 *      `22P05` or `22021` from anything the bounds do not catch — logged at
 *      warn with its code, never paged.
 *
 * The three request services' `offerings` switches (boarding, board-and-train,
 * private-lesson) are `ops` like the rest: "Editable by any role, so turning
 * one on is a deliberate act in the settings editor" (design.md:3719-3722;
 * DECISIONS 69 reverses 63).
 *
 * `refused_keys` and `inert_keys` list every such key as the body spelled it.
 * The idempotency `requestHash` covers `{domain, location, ...body}`, so one
 * key sent to a second campus is 422 `idempotency_mismatch`. The response is
 * the row(s) read back in the write's transaction; `updated_by_staff_id` is
 * the caller.
 *
 * The body schemas are GENERATED from the registry: a body key is a settings
 * column (or a `payment_settings` key) whose registry entry is patchable. The
 * key sets are pinned to the wire's `SettingsPatchByDomain` below; a mismatch
 * refuses to load this module.
 */

// ── targets: which row a path addresses ──────────────────────────────────────

const TIERED = new Set<SettingsDomain>(['day', 'eval']);

type Target =
  | { domain: Exclude<SettingsDomain, 'day' | 'eval'>; location: null }
  | { domain: 'day' | 'eval'; location: LocationKey | null };

function targetName(target: { domain: SettingsDomain; location: LocationKey | null }): string {
  if (!TIERED.has(target.domain)) return target.domain;
  return `${target.domain}/${target.location === null ? 'global' : 'campus'}`;
}

const pathSchema = z
  .object({ domain: z.enum(SETTINGS_DOMAINS), location: z.enum(LOCATIONS).optional() })
  .strict();

function parseTarget(params: unknown): Target {
  const parsed = pathSchema.safeParse(params);
  if (!parsed.success) {
    throw new ApiError('bad_request', `invalid settings path: ${formatZodIssues(parsed.error)}`);
  }
  const { domain, location } = parsed.data;
  if (domain === 'day' || domain === 'eval') return { domain, location: location ?? null };
  if (location !== undefined) {
    throw new ApiError(
      'bad_request',
      `the ${domain} settings have one row; a /:location names nothing`,
    );
  }
  return { domain, location: null };
}

// ── the body, generated from the registry ────────────────────────────────────

/** The body field a registry entry is edited under: its column, or its pay key. */
function fieldOf(entry: SettingEntry): string {
  if (entry.store.kind === 'payment') return entry.store.key;
  if (entry.store.kind === 'column') return entry.store.column;
  throw new Error(`settings registry: ${entry.key} is not patchable`);
}

function entriesFor(target: {
  domain: SettingsDomain;
  location: LocationKey | null;
}): Map<string, SettingEntry> {
  const table = SETTINGS_TABLE_BY_DOMAIN[target.domain];
  const tier = TIERED.has(target.domain)
    ? target.location === null
      ? 'global'
      : 'campus'
    : undefined;
  const fields = new Map<string, SettingEntry>();
  for (const entry of SETTINGS_REGISTRY) {
    if (entry.domain !== target.domain || !isPatchable(entry)) continue;
    const { store } = entry;
    if (store.kind === 'column' && (store.table !== table || store.tier !== tier)) continue;
    const field = fieldOf(entry);
    if (fields.has(field)) throw new Error(`settings registry: two keys edit ${table}.${field}`);
    fields.set(field, entry);
  }
  return fields;
}

/** The JSON type a value must have — the 400 half of the parse. */
function shapeOf(value: SettingValue, perScope: boolean): z.ZodTypeAny {
  if (perScope) return z.record(z.string(), z.string());
  switch (value.type) {
    case 'boolean':
      return z.boolean();
    case 'integer':
      return value.nullable === true ? z.number().nullable() : z.number();
    case 'fraction':
      return z.number();
    case 'time':
      return z.string();
    case 'enum':
      return value.nullable === true ? z.string().nullable() : z.string();
    case 'text':
      return value.nullable === true ? z.string().nullable() : z.string();
    case 'staff-id':
      return z.string().nullable();
    case 'enum-list':
    case 'text-list':
      return z.array(z.string());
    case 'integer-list':
      return z.array(z.number());
    case 'record': {
      const member = value.value.nullable === true ? z.string().nullable() : z.string();
      return z.object(Object.fromEntries(value.keys.map((k) => [k, member]))).strict();
    }
    case 'offerings': {
      const offering = z
        .object({
          offered: z.boolean(),
          client_visible: z.boolean(),
          name: z.string().nullable(),
          description: z.string().nullable(),
        })
        .strict();
      return z.object(Object.fromEntries(value.services.map((s) => [s, offering]))).strict();
    }
    case 'catalog':
      throw new Error('a catalog key is never in a settings body');
  }
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Every integer setting is an `integer` column: a value past int4 is out of
 *  range here (422), not a Postgres 22003 (DECISIONS 65). */
const INT4_MAX = 2147483647;

/** The C0 control set (U+0000–U+001F). Refused in EVERY string a PATCH can
 *  write (DECISIONS 66, 71): CR and LF in a value that becomes a mail header,
 *  NUL anywhere (Postgres refuses it in text and jsonb — 22021, 22P05). */
const CONTROL_CHARACTER = /[\u0000-\u001f]/;
const CONTROL_MESSAGE = 'must not hold a control character (CR, LF, tab, NUL…)';

/** Whether a well-shaped value is in bounds — the 422 half. `null` = valid. */
function boundsError(value: SettingValue, input: unknown, perScope: boolean): string | null {
  if (perScope) {
    if (value.type !== 'enum') return 'not a per-scope enum';
    const bad = Object.values(input as Record<string, string>).filter(
      (v) => !value.values.includes(v),
    );
    return bad.length === 0 ? null : `not one of ${value.values.join(', ')}`;
  }
  if (input === null) return null; // the shape parse admitted null only where it is allowed
  switch (value.type) {
    case 'boolean':
    case 'staff-id':
      return null;
    case 'offerings': {
      const strings = Object.entries(
        input as Record<string, { name: string | null; description: string | null }>,
      ).flatMap(([service, o]) => [
        [`${service}.name`, o.name],
        [`${service}.description`, o.description],
      ]);
      const bad = strings.filter(([, v]) => v !== null && CONTROL_CHARACTER.test(v as string));
      return bad.length === 0
        ? null
        : `${bad.map(([where]) => where).join(', ')}: ${CONTROL_MESSAGE}`;
    }
    case 'integer': {
      const n = input as number;
      if (!Number.isInteger(n)) return 'must be a whole number';
      if (n < value.min) return `must be at least ${value.min}`;
      const max = value.max ?? INT4_MAX;
      if (n > max) return `must be at most ${max}`;
      return null;
    }
    case 'fraction': {
      const n = input as number;
      if (value.oneOf !== undefined)
        return value.oneOf.includes(n) ? null : `must be one of ${value.oneOf.join(', ')}`;
      return n >= 0 && n <= 1 ? null : 'must be between 0 and 1';
    }
    case 'time':
      return TIME.test(input as string) ? null : 'must be HH:MM (24-hour)';
    case 'enum':
      return value.values.includes(input as string)
        ? null
        : `must be one of ${value.values.join(', ')}`;
    case 'text': {
      const text = input as string;
      if (text.trim().length === 0) return 'must not be blank';
      return CONTROL_CHARACTER.test(text) ? CONTROL_MESSAGE : null;
    }
    case 'enum-list': {
      // A control character can only fail membership, which says so below.
      const bad = (input as string[]).filter((v) => !value.values.includes(v));
      return bad.length === 0 ? null : `${bad.join(', ')} is not one of ${value.values.join(', ')}`;
    }
    case 'text-list': {
      const list = input as string[];
      if (!list.every((v) => v.trim().length > 0)) return 'must not hold a blank entry';
      return list.some((v) => CONTROL_CHARACTER.test(v)) ? `an entry ${CONTROL_MESSAGE}` : null;
    }
    case 'integer-list': {
      const list = input as number[];
      const max = value.max ?? INT4_MAX;
      if (value.nonEmpty === true && list.length === 0) return 'must hold at least one entry';
      if (value.distinct === true && new Set(list).size !== list.length)
        return 'must not repeat an entry';
      const ok = list.every((n) => Number.isInteger(n) && n >= value.min && n <= max);
      return ok ? null : `every entry must be a whole number from ${value.min} to ${max}`;
    }
    case 'record': {
      const entries = Object.entries(input as Record<string, string | null>);
      const bad = entries.filter(([, v]) =>
        v === null ? value.value.nullable !== true : !value.value.values.includes(v),
      );
      return bad.length === 0
        ? null
        : `${bad.map(([k]) => k).join(', ')}: not one of ${value.value.values.join(', ')}`;
    }
    case 'catalog':
      return 'not editable here';
  }
}

function isJsonb(value: SettingValue): boolean {
  return value.type === 'record' || value.type === 'offerings';
}

interface Plan {
  fields: Map<string, SettingEntry>;
  shape: z.ZodType<Record<string, unknown>>;
}

function planFor(target: { domain: SettingsDomain; location: LocationKey | null }): Plan {
  const fields = entriesFor(target);
  const shape = z
    .object(
      Object.fromEntries(
        [...fields].map(([field, entry]) => [
          field,
          shapeOf(entry.value, isPerScope(entry)).optional(),
        ]),
      ),
    )
    .strict() as unknown as z.ZodType<Record<string, unknown>>;
  return { fields, shape };
}

function isPerScope(entry: SettingEntry): boolean {
  return entry.store.kind === 'payment' && entry.store.scope === 'per-service';
}

// ── the wire pins: each body's key set, exactly ──────────────────────────────

type Keys<T> = Record<keyof T, true>;
type BodyOf<W> = Omit<W, SettingsAuditKey | 'location'>;

const WIRE_BODY_KEYS: Record<string, Record<string, true>> = {
  acct: {
    email_verification_grace_days: true,
    close_blocked_by_pending_refund_enabled: true,
    close_auto_refund_fraction: true,
    reactivation_restores_expired_value_enabled: true,
    locked_account_view_mode: true,
    pause_reserved_service_return_mode: true,
    signup_fields: true,
  } satisfies Keys<BodyOf<AccountSettingsWire>>,
  alum: {
    recheck_after_months_unseen: true,
    recheck_due_mirrors_reeval_due_enabled: true,
  } satisfies Keys<BodyOf<AlumniSettingsWire>>,
  cash: {
    unpaid_checkout_block_enabled: true,
    pack_grant_on_promise_enabled: true,
    did_not_pay_undo_window_hours: true,
    pack_partial_payment_destination: true,
    bounced_check_fee_cents: true,
    due_event_by_service: true,
  } satisfies Keys<BodyOf<CashSettingsWire>>,
  cred: {
    expiry_enforced_enabled: true,
    expiry_warning_lead_days: true,
    manual_grant_expiry_months: true,
    returned_credit_expiry_months: true,
    booking_outlives_lot_expiry_enabled: true,
    single_day_purchase_max_count: true,
    account_deletion_expires_credits_enabled: true,
    dispute_auto_reversal_enabled: true,
    pause_daily_expiry_extension_days: true,
    unpaid_payment_auto_reversal_enabled: true,
  } satisfies Keys<BodyOf<CreditSettingsWire>>,
  'day/global': {
    booking_horizon_months: true,
    max_dogs_per_booking_count: true,
    day_school_one_on_one_minutes: true,
    after_school_price_cents: true,
    occupied_block_end_time: true,
    midstay_day_charge_fraction: true,
    sent_home_before_training_return_fraction: true,
    sent_home_after_training_return_fraction: true,
    closure_return_fraction: true,
  } satisfies Keys<BodyOf<DayProgramGlobalSettingsWire>>,
  'day/campus': {
    offerings: true,
    open_weekdays_list: true,
    dropoff_open_time: true,
    dropoff_close_time: true,
    pickup_open_time: true,
    pickup_close_time: true,
    same_day_cutoff_time: true,
    daily_capacity_dogs: true,
    late_pickup_call_time: true,
    late_pickup_fee_cents: true,
    late_pickup_grace_minutes: true,
    after_school_start_time: true,
    after_school_end_time: true,
    after_school_capacity_count: true,
  } satisfies Keys<BodyOf<DayProgramCampusSettingsWire>>,
  dog: {
    spay_neuter_required_by_age_months: true,
    spay_neuter_gated_categories: true,
    spay_neuter_reminder_time: true,
    card_required_at_board_train_confirm: true,
    card_required_for_evaluation_booking_enabled: true,
    gate_override_allowed_gate_keys: true,
    staff_dog_exempt_gate_keys: true,
    gate_card_on_file_enabled: true,
    gate_evaluation_enabled: true,
    gate_vaccines_enabled: true,
    gate_agreements_enabled: true,
  } satisfies Keys<BodyOf<DogGateSettingsWire>>,
  'eval/global': {
    reeval_after_months_unseen: true,
    failed_rebook_wait_hours: true,
  } satisfies Keys<BodyOf<EvaluationGlobalSettingsWire>>,
  'eval/campus': { max_per_day_dogs: true } satisfies Keys<BodyOf<EvaluationCampusSettingsWire>>,
  mig: {
    pilot_family_count: true,
    full_transfer_after_pilot_months: true,
    import_credit_balances_enabled: true,
    imported_credit_expiry_months: true,
    import_unpaid_balances_enabled: true,
    invite_recent_within_months: true,
    gingr_retention_billing_cycles: true,
  } satisfies Keys<BodyOf<MigrationSettingsWire>>,
  msg: {
    referral_subtopic_enabled: true,
    school_default_responder_staff_id: true,
    school_backup_responder_staff_id: true,
    school_default_responder_out: true,
    video_max_duration_seconds: true,
    video_max_size_mb: true,
    max_attachments_per_message: true,
    max_text_length_chars: true,
    request_reply_window_hours: true,
    reply_signature_mode: true,
  } satisfies Keys<SettingsPatchByDomain['msg']>,
  notif: {
    quiet_hours_start_time: true,
    quiet_hours_end_time: true,
    quiet_hours_bypass_types: true,
    scan_send_time: true,
    booking_reminder_lead_hours: true,
    card_expiry_warning_days_before: true,
    email_sender_address: true,
    broadcast_audience_list: true,
    cash_payment_due_reminder_lead_hours: true,
    email_sender_display_name: true,
    reminder_channel_by_program: true,
    expiry_notice_channel: true,
    email_inflight_alarm_minutes: true,
  } satisfies Keys<BodyOf<NotificationSettingsWire>>,
  pay: {
    card_attempts_max_count: true,
    seat_hold_max_minutes: true,
    processing_hold_max_minutes: true,
    custom_invoice_kind_list: true,
    custom_invoice_card_kind_list: true,
    refund_any_role_limit_cents: true,
    price_change_notice_days: true,
    max_sessions_per_booking_count: true,
    automatic_return_instrument_mode: true,
    charge_timing_mode: true,
  } satisfies Keys<PatchStaffSettingsPayRequest>,
  rpt: {
    events_enabled: true,
    event_max_dogs_per_rsvp: true,
    gallery_enabled: true,
    gallery_max_dogs: true,
    gallery_rate_limit_per_minute: true,
    media_max_upload_megabytes: true,
  } satisfies Keys<BodyOf<ReportsSettingsWire>>,
  vax: {
    proof_file_types: true,
    typical_full_vaccination_age_months: true,
  } satisfies Keys<BodyOf<VaccineSettingsWire>>,
};

/** Every row a path can address. */
export const SETTINGS_TARGETS: ReadonlyArray<{
  domain: SettingsDomain;
  location: LocationKey | null;
}> = SETTINGS_DOMAINS.flatMap((domain) =>
  TIERED.has(domain)
    ? [
        { domain, location: null },
        { domain, location: LOCATIONS[0] },
      ]
    : [{ domain, location: null }],
);

const PLANS = new Map<string, Plan>(SETTINGS_TARGETS.map((t) => [targetName(t), planFor(t)]));

// The registry and the wire must agree on every body's key set — checked once,
// at load, so a server whose registry drifted from the contract never serves.
for (const [name, plan] of PLANS) {
  const generated = [...plan.fields.keys()].sort();
  const wire = Object.keys(WIRE_BODY_KEYS[name] ?? {}).sort();
  if (generated.join(',') !== wire.join(',')) {
    throw new Error(
      `settings registry and wire.ts disagree on the ${name} body: registry [${generated.join(', ')}], wire [${wire.join(', ')}]`,
    );
  }
}

/**
 * The bound each field of `body` breaks, as `field: why` — what the PATCH's
 * step 4 refuses. Exported so a test can hold the seeds to the same bounds.
 */
export function boundsErrors(
  target: { domain: SettingsDomain; location: LocationKey | null },
  body: Record<string, unknown>,
): string[] {
  const plan = PLANS.get(targetName(target)) as Plan;
  return Object.entries(body).flatMap(([field, input]) => {
    const entry = plan.fields.get(field);
    if (entry === undefined) return [];
    const error = boundsError(entry.value, input, isPerScope(entry));
    return error === null ? [] : [`${field}: ${error}`];
  });
}

/** The body keys `PATCH` accepts on a path — for the registry tests. */
export function patchableFields(target: {
  domain: SettingsDomain;
  location: LocationKey | null;
}): string[] {
  return [...(PLANS.get(targetName(target))?.fields.keys() ?? [])];
}

// ── reads and writes ─────────────────────────────────────────────────────────

async function read(target: Target, runner?: Tx): Promise<GetStaffSettingsResponse> {
  switch (target.domain) {
    case 'acct':
      return settingsRepository.account(runner);
    case 'alum':
      return settingsRepository.alumni(runner);
    case 'cash':
      return settingsRepository.cash(runner);
    case 'cred':
      return settingsRepository.credit(runner);
    case 'day':
      return target.location === null
        ? settingsRepository.dayGlobal(runner)
        : settingsRepository.dayCampus(target.location, runner);
    case 'dog':
      return settingsRepository.dogGate(runner);
    case 'eval':
      return target.location === null
        ? settingsRepository.evaluationGlobal(runner)
        : settingsRepository.evaluationCampus(target.location, runner);
    case 'mig':
      return settingsRepository.migration(runner);
    case 'msg':
      return settingsRepository.messaging(runner);
    case 'notif':
      return settingsRepository.notification(runner);
    case 'pay':
      return settingsRepository.payment(runner);
    case 'rpt':
      return settingsRepository.reports(runner);
    case 'vax':
      return settingsRepository.vaccine(runner);
  }
}

async function write(
  tx: Tx,
  target: Target,
  plan: Plan,
  body: Record<string, unknown>,
  staffId: string,
): Promise<void> {
  if (target.domain === 'pay') {
    for (const [field, input] of Object.entries(body)) {
      const entry = plan.fields.get(field) as SettingEntry;
      const rows = isPerScope(entry)
        ? Object.entries(input as Record<string, string>).map(([scope, value]) => ({
            scope,
            value,
          }))
        : [{ scope: 'global', value: input }];
      for (const { scope, value } of rows) {
        const written = await settingsRepository.updatePaymentValue(tx, {
          key: field,
          scope,
          value,
          staffId,
        });
        if (written !== 1)
          throw new ApiError('not_found', `payment_settings has no ${field}/${scope} row`);
      }
    }
    return;
  }
  const written = await settingsRepository.updateRow(tx, {
    table: SETTINGS_TABLE_BY_DOMAIN[target.domain],
    row: TIERED.has(target.domain)
      ? { kind: 'tier', location: target.location }
      : { kind: 'singleton' },
    values: Object.entries(body).map(([column, value]) => ({
      column,
      value,
      jsonb: isJsonb((plan.fields.get(column) as SettingEntry).value),
    })),
    staffId,
  });
  if (written !== 1) {
    throw new ApiError(
      'not_found',
      `${SETTINGS_TABLE_BY_DOMAIN[target.domain]} has no row for ${targetName(target)}`,
    );
  }
}

/**
 * A Postgres error that is the value's fault, not the server's — answered 422
 * `invalid_payload`, never 500. Walks the `cause` chain.
 */
export function isValueRefusal(err: unknown): boolean {
  const code = postgresErrorOf(err)?.code;
  return code !== undefined && VALUE_REFUSAL_CODES.has(code);
}

/** check_violation, numeric_value_out_of_range, invalid_text_representation,
 *  untranslatable_character (a NUL in jsonb), character_not_in_repertoire (a
 *  NUL in text) — DECISIONS 65, 71. */
const VALUE_REFUSAL_CODES: ReadonlySet<string> = new Set([
  '23514',
  '22003',
  '22P02',
  '22P05',
  '22021',
]);

/** The first error on the `cause` chain that carries a Postgres SQLSTATE. */
function postgresErrorOf(err: unknown): { code: string; message: string } | undefined {
  for (
    let e: unknown = err;
    typeof e === 'object' && e !== null;
    e = (e as { cause?: unknown }).cause
  ) {
    const { code, message } = e as { code?: unknown; message?: unknown };
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) {
      return { code, message: typeof message === 'string' ? message : '' };
    }
  }
  return undefined;
}

// ── the routes ───────────────────────────────────────────────────────────────

const PATHS = ['/staff/settings/:domain', '/staff/settings/:domain/:location'] as const;

export function registerStaffSettingsRoute(
  app: FastifyInstance,
  opts: AuthRouteOptions = {},
): void {
  const authHook = resolveAuthHook(opts);

  for (const path of PATHS) {
    app.get(
      path,
      { preHandler: [authHook] },
      async (request): Promise<GetStaffSettingsResponse> => {
        const principal = requirePrincipal(request);
        requireStaff(principal, 'read the settings');
        return read(parseTarget(request.params));
      },
    );

    app.patch(
      path,
      { preHandler: [authHook] },
      async (request): Promise<PatchStaffSettingsResponse> => {
        const principal = requirePrincipal(request);
        requireStaff(principal, 'edit the settings');
        const target = parseTarget(request.params);
        const plan = PLANS.get(targetName(target)) as Plan;

        // 1. 400 — the shape: unknown keys (the other tier's included), JSON types.
        const parsed = plan.shape.safeParse(request.body);
        if (!parsed.success) {
          throw new ApiError(
            'bad_request',
            `invalid settings body: ${formatZodIssues(parsed.error)}`,
          );
        }
        const body = parsed.data;
        const fields = Object.keys(body);
        if (fields.length === 0) {
          throw new ApiError('bad_request', 'the body names no setting to edit');
        }
        const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
        if (target.domain === 'pay' && body.charge_timing_mode !== undefined) {
          const scopes = new Set(await settingsRepository.chargeTimingScopes());
          const missing = Object.keys(body.charge_timing_mode as Record<string, string>).filter(
            (s) => !scopes.has(s),
          );
          if (missing.length > 0) {
            throw new ApiError(
              'bad_request',
              `charge_timing_mode has no row for ${missing.join(', ')}`,
            );
          }
        }
        const entryOf = (field: string) => plan.fields.get(field) as SettingEntry;

        // 2. 403 — a key off the caller's class.
        const refused = fields.filter((f) => !mayEditClass(principal.role, entryOf(f).class));
        if (refused.length > 0) {
          throw new ApiError('forbidden', `your role may not edit ${refused.join(', ')}`, {
            kind: 'refused_keys',
            refused_keys: refused,
          });
        }

        // 3. 422 setting_inert — a key no code in this release reads.
        const inert = fields.filter((f) => entryOf(f).inert !== false);
        if (inert.length > 0) {
          throw new ApiError(
            'setting_inert',
            `stored, not read in this release: ${inert.join(', ')}`,
            {
              kind: 'setting_inert',
              inert_keys: inert,
            },
          );
        }

        // 4. 422 invalid_payload — a value out of bounds.
        const invalid = fields
          .map((f) => [f, boundsError(entryOf(f).value, body[f], isPerScope(entryOf(f)))] as const)
          .filter(([, error]) => error !== null);
        if (invalid.length > 0) {
          throw new ApiError(
            'invalid_payload',
            invalid.map(([f, error]) => `${f}: ${error}`).join('; '),
          );
        }

        const outcome = await withMutation<PatchStaffSettingsResponse>(
          {
            principal,
            idempotencyKey,
            endpoint: 'PATCH /staff/settings/:domain[/:location]',
            requestHash: hashRequestBody({
              domain: target.domain,
              location: target.location,
              ...body,
            }),
            // No cache: every settings read goes to Postgres (conflict 19).
            keysToInvalidate: () => [],
          },
          async (tx) => {
            try {
              await write(tx, target, plan, body, principal.staffId);
            } catch (err) {
              if (isValueRefusal(err)) {
                // The caller's 422 — but the registry's bounds were meant to
                // catch this first, so leave the server a trace (never a page).
                const pg = postgresErrorOf(err);
                request.log.warn(
                  {
                    pgCode: pg?.code,
                    pgMessage: pg?.message,
                    domain: target.domain,
                    location: target.location,
                  },
                  'settings PATCH refused by Postgres; answered 422 invalid_payload',
                );
                const refusal = new ApiError(
                  'invalid_payload',
                  'a value is outside what the database allows',
                );
                refusal.cause = err;
                throw refusal;
              }
              throw err;
            }
            return { status: 200, body: await read(target, tx) };
          },
        );
        return outcome.body;
      },
    );
  }
}
