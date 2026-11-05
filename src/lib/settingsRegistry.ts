import type { Equal, Expect } from '../contracts/typeAsserts.js';
import {
  NOTIFICATION_TYPES,
  SERVICE_CATEGORIES,
  SETTINGS_DOMAINS,
  SIGNUP_FIELDS,
  type ServiceCategory,
  type SettingCatalog,
  type SettingClass,
  type SettingsDomain,
  type StaffRole,
} from '../contracts/wire.js';

/**
 * **The settings registry** (SET-U01 / STAFF-U07; design §2.1 "The registry",
 * §3 every key and its seed; P01, wire 2.0.0-lg1.1).
 *
 * A typed map, written by hand and checked by tests, from every setting key of
 * the fourteen domains of `wire.ts`'s `SETTINGS_DOMAINS` (acct, alum, cash,
 * cred, day, dog, eval, mig, msg, notif, pay, rpt, vax — and `staff`, P02's,
 * DECISIONS 47) to:
 *
 *   - its **store**: a column of its domain's settings table; a
 *     `payment_settings` key and scope; a path inside a jsonb column (a
 *     read-only name for part of another key's value); or a catalog row that
 *     another route edits (`credit_packages`, `service_rates`,
 *     `required_vaccines`, `dog_descriptors`, `intake_field_settings`,
 *     `day_capacity`) — read-only here;
 *   - its **class**: `ops` (any role, STAFF-73), `money` (owner and manager,
 *     STAFF-77), `price` (no role in v1: question 27 → (a)), `roles` (owner
 *     only) — or `null` for a key §3 gives no class (a catalog fact with no v1
 *     editor), which no role edits;
 *   - whether it is **inert** — stored, with no v1 reader, so the PATCH answers
 *     422 `setting_inert` and the editor shows it read-only (question 28). The
 *     set is §3's *stored* rows plus the 11-02 re-cut's deferred arms (each
 *     names the unit that un-inerts it);
 *   - its **value**: the shape and bounds the domain's zod schema mirrors, the
 *     same bounds as the table's CHECK constraints (`schema.sql`, M1.01–M1.16).
 *
 * A key whose store has not landed is not here (design §2.1: no applies-from
 * marker; 400 unknown key). The tests hold this map to the Drizzle schema
 * (every settings column has exactly one editable key, no key names two
 * tables) and to the design's §3 (class and inert, key by key).
 *
 * The domain list is the wire's own tuple (P02; contract notes Part 4 item 3):
 * a domain appended to `SETTINGS_DOMAINS` fails `tsc` here until
 * `SETTINGS_TABLE_BY_DOMAIN` names its table, and that entry is what puts the
 * table under the generated audit test.
 */

/** The four role classes are the wire's (2.0.0 serves them on the manifest),
 *  re-exported so that one union exists (the `RefundStatus` precedent). */
export type { SettingClass };

export { SETTINGS_DOMAINS, type SettingsDomain };

/** Every settings table, by domain: P01's (M1.01–M1.16 less M1.03, M1.04,
 *  M1.14) and P02's `staff_settings` (M1.21). Keyed by the WIRE's domain union,
 *  so a missing domain does not compile. */
export const SETTINGS_TABLE_BY_DOMAIN = {
  acct: 'account_settings',
  alum: 'alumni_settings',
  cash: 'cash_settings',
  cred: 'credit_settings',
  day: 'day_program_settings',
  dog: 'dog_gate_settings',
  eval: 'evaluation_settings',
  mig: 'migration_settings',
  msg: 'messaging_settings',
  notif: 'notification_settings',
  pay: 'payment_settings',
  rpt: 'reports_settings',
  vax: 'vaccine_settings',
  staff: 'staff_settings',
} as const satisfies Record<SettingsDomain, string>;
export type SettingsTable = (typeof SETTINGS_TABLE_BY_DOMAIN)[SettingsDomain];
export const SETTINGS_TABLES: readonly SettingsTable[] = Object.values(SETTINGS_TABLE_BY_DOMAIN);

/**
 * Every settings table under the audit trigger (M1.18, STAFF-U22; M1.21): the
 * four that predate LG1 and every settings table LG1 creates, `staff_settings`
 * included (it joins through `SETTINGS_TABLE_BY_DOMAIN`). The audit test is
 * generated from this list.
 */
export const AUDITED_SETTINGS_TABLES: readonly string[] = [
  'cancel_window_settings',
  'credit_expiry_settings',
  'intake_field_settings',
  'dog_descriptors',
  ...SETTINGS_TABLES,
];

/** The two-tier tables: one global row (location NULL) and one per campus. */
export type Tier = 'global' | 'campus';

export type CatalogTable =
  | 'credit_packages'
  | 'service_rates'
  | 'required_vaccines'
  | 'dog_descriptors'
  | 'intake_field_settings'
  | 'day_capacity';
/** The manifest serves a catalog key's table as the wire's `SettingCatalog`
 *  (2.0.0), a transcription of this union: pinned, so neither drifts. */
export type CatalogTableConformance = Expect<Equal<CatalogTable, SettingCatalog>>;

/** Every integer setting is an `integer` column: int4 is the bound where an
 *  entry sets no `max` — the PATCH's 422 (DECISIONS 65) and the manifest's
 *  served `max` read this one constant. */
export const INT4_MAX = 2147483647;

export type SettingStore =
  /** A column of the domain's settings table — what the settings PATCH writes. */
  | { kind: 'column'; table: SettingsTable; column: string; tier?: Tier }
  /** One field inside a jsonb column; read-only here, edited as part of `via`. */
  | {
      kind: 'path';
      table: SettingsTable;
      column: string;
      path: readonly string[];
      via: string;
      tier: Tier;
    }
  /** A `payment_settings` row: `scope` 'global', or one row per service. */
  | { kind: 'payment'; key: string; scope: 'global' | 'per-service' }
  /** A catalog row another route (or a seed step) edits; read-only here. */
  | { kind: 'catalog'; table: CatalogTable; where: string };

/** §3's Sc column: g, c, s, p (and k, d, which no P01 key has). */
export type SettingScope = 'global' | 'campus' | 'service' | 'package';

export type EnumValue = { type: 'enum'; values: readonly string[]; nullable?: true };

export type SettingValue =
  | { type: 'boolean' }
  | { type: 'integer'; min: number; max?: number; nullable?: true }
  /** A numeric fraction in [0, 1]; `oneOf` narrows it to listed values. */
  | { type: 'fraction'; oneOf?: readonly number[] }
  /** Wall-clock `HH:MM`, America/Chicago. */
  | { type: 'time' }
  | EnumValue
  | { type: 'enum-list'; values: readonly string[] }
  /** `nonEmpty` and `distinct` hold the list itself (DECISIONS 61). */
  | { type: 'integer-list'; min: number; max?: number; nonEmpty?: true; distinct?: true }
  /** A text setting never holds a control character (DECISIONS 66: the two
   *  that exist become email headers at NOTIF-U04). */
  | { type: 'text'; nullable?: true }
  | { type: 'text-list' }
  | { type: 'staff-id'; nullable: true }
  /** A jsonb object with exactly these keys, each value an enum. A key in
   *  `fixed` may hold only its one value: a PATCH naming another is 422
   *  `invalid_payload` (the manifest still serves the enum's value set). */
  | {
      type: 'record';
      keys: readonly string[];
      value: EnumValue;
      fixed?: Readonly<Record<string, string>>;
    }
  /** `day.offerings`: service → {offered, client_visible, name, description}.
   *  Every switch is `ops`, the three request services' included: "Editable by
   *  any role, so turning one on is a deliberate act" (design.md:3719-3722;
   *  DECISIONS 69). `name` and `description` hold at most these many Unicode
   *  code points (2.0.0; build DECISIONS 89, J17): the PATCH's bound and the
   *  manifest's served caps. */
  | {
      type: 'offerings';
      services: readonly ServiceCategory[];
      nameMaxLength: number;
      descriptionMaxLength: number;
    }
  /** A set of staff roles (`staff_role[]`, M1.21): a role outside the enum, or
   *  one named twice, is a bad shape (400, DECISIONS 59); an empty list is out
   *  of range (422 — the column's `cardinality > 0` CHECK). */
  | { type: 'role-list' }
  /** A catalog fact: not a value the settings PATCH carries. */
  | { type: 'catalog' };

export type Inertness =
  | false
  /** §3 marks the key *stored*: no v1 reader (question 28). */
  | { kind: 'stored'; note?: string }
  /** Live in the design, held inert by the 11-02 re-cut until `until` lands its reader. */
  | { kind: 'deferred'; until: 'P06' | 'P07' | 'P09'; note: string };

export interface SettingEntry {
  key: string;
  domain: SettingsDomain;
  scope: SettingScope;
  class: SettingClass | null;
  store: SettingStore;
  value: SettingValue;
  inert: Inertness;
}

// ── Building blocks ──────────────────────────────────────────────────────────

const LIVE = false as const;
const STORED: Inertness = { kind: 'stored' };
const storedUntil = (note: string): Inertness => ({ kind: 'stored', note });

// The 11-02 re-cut (plan.json P01 deferred_arms): keys the design reads in v1
// whose reader lands in a later unit. Each is un-inerted by the unit named.
const UNTIL_P06: Inertness = {
  kind: 'deferred',
  until: 'P06',
  note: 'the gate and card switches wait for S07 (P06), which reads them',
};
const UNTIL_P07: Inertness = {
  kind: 'deferred',
  until: 'P07',
  note: "VAX-U07's vax.* keys wait for S08 (P07)",
};
const UNTIL_P09: Inertness = {
  kind: 'deferred',
  until: 'P09',
  note: 'the spay/neuter keys wait for S11 (P09); the staff-dog exemption for S07 and S11 both',
};

const BOOLEAN: SettingValue = { type: 'boolean' };
const ROLE_LIST: SettingValue = { type: 'role-list' };
const TIME: SettingValue = { type: 'time' };
const FRACTION: SettingValue = { type: 'fraction' };
const atLeast = (min: number): SettingValue => ({ type: 'integer', min });
const between = (min: number, max: number): SettingValue => ({ type: 'integer', min, max });

function column(table: SettingsTable, name: string, tier?: Tier): SettingStore {
  return tier === undefined
    ? { kind: 'column', table, column: name }
    : { kind: 'column', table, column: name, tier };
}

type Entry = Omit<SettingEntry, 'domain' | 'scope'> & { scope?: SettingScope };

const DAY = 'day_program_settings' as const;
const EVAL = 'evaluation_settings' as const;

/** The services an `offerings` document names, and a day program's services. */
const OFFERING_SERVICES: readonly ServiceCategory[] = SERVICE_CATEGORIES;
/** The offerings copy caps, in Unicode code points (build DECISIONS 89, J17):
 *  about 1.9× and 3.5× today's longest name (32) and tile description (81). */
const OFFERING_NAME_MAX_LENGTH = 60;
const OFFERING_DESCRIPTION_MAX_LENGTH = 280;
const QUIET_HOURS_CLASSES: readonly string[] = [...NOTIFICATION_TYPES, 'closure', 'staff-reply'];
const PROGRAMS_WITH_REMINDERS = ['day-school', 'day-care', 'group-class', 'evaluation'] as const;
// No 'package' service and no 'purchase' event: §1.1 never builds that rule
// (DECISIONS 53, D1).
const CASH_DUE_SERVICES = [
  'day-school',
  'day-care',
  'group-class',
  'walk-in',
  'event',
  'private-lesson',
  'board-and-train',
  'boarding',
] as const;
const CASH_DUE_EVENTS = [
  'drop-off',
  'first-meeting-start',
  'front-desk-or-pickup',
  'event-start',
  'close-out',
] as const;

// ── The registry ─────────────────────────────────────────────────────────────

const ENTRIES: readonly Entry[] = [
  // acct — account_settings (M1.01; §3.15)
  {
    key: 'acct.close_auto_refund_fraction',
    class: 'money',
    store: column('account_settings', 'close_auto_refund_fraction'),
    value: FRACTION,
    inert: STORED,
  },
  {
    key: 'acct.close_blocked_by_pending_refund_enabled',
    class: 'money',
    store: column('account_settings', 'close_blocked_by_pending_refund_enabled'),
    value: BOOLEAN,
    inert: STORED,
  },
  {
    key: 'acct.email_verification_grace_days',
    class: 'ops',
    store: column('account_settings', 'email_verification_grace_days'),
    value: atLeast(0),
    inert: storedUntil('unread while sign-ups are off (question 29)'),
  },
  {
    key: 'acct.locked_account_view_mode',
    class: 'ops',
    store: column('account_settings', 'locked_account_view_mode'),
    value: { type: 'enum', values: ['lock_screen', 'actions_refused'], nullable: true },
    inert: storedUntil('NOT SEEDED: NULL, and no reader defaults it'),
  },
  {
    key: 'acct.pause_reserved_service_return_mode',
    class: 'money',
    store: column('account_settings', 'pause_reserved_service_return_mode'),
    value: {
      type: 'record',
      keys: ['group-class', 'boarding'],
      value: { type: 'enum', values: ['refund', 'none'] },
    },
    inert: STORED,
    scope: 'service',
  },
  {
    key: 'acct.reactivation_restores_expired_value_enabled',
    class: 'money',
    store: column('account_settings', 'reactivation_restores_expired_value_enabled'),
    value: BOOLEAN,
    inert: STORED,
  },
  {
    key: 'acct.signup_field_requirement_map',
    class: 'ops',
    store: column('account_settings', 'signup_fields'),
    value: {
      type: 'record',
      keys: SIGNUP_FIELDS,
      value: { type: 'enum', values: ['off', 'asked', 'mandatory'] },
      // "email is fixed in the map, not switchable" (design §2.2:2244; X5):
      // the login identity, never empty, so never anything but mandatory.
      fixed: { email: 'mandatory' },
    },
    inert: LIVE,
  },

  // alum — alumni_settings (M1.02; §3.11)
  {
    key: 'alum.recheck_after_months_unseen',
    class: 'ops',
    store: column('alumni_settings', 'recheck_after_months_unseen'),
    value: atLeast(1),
    inert: LIVE,
  },
  {
    key: 'alum.recheck_due_mirrors_reeval_due_enabled',
    class: 'ops',
    store: column('alumni_settings', 'recheck_due_mirrors_reeval_due_enabled'),
    value: BOOLEAN,
    inert: storedUntil('until S14 and ALUM-U08'),
  },

  // cash — cash_settings (M1.05; §3.9): every key stored only (R2)
  {
    key: 'cash.bounced_check_fee_cents',
    class: 'money',
    store: column('cash_settings', 'bounced_check_fee_cents'),
    value: atLeast(0),
    inert: STORED,
  },
  {
    key: 'cash.did_not_pay_undo_window_hours',
    class: 'money',
    store: column('cash_settings', 'did_not_pay_undo_window_hours'),
    value: atLeast(0),
    inert: STORED,
  },
  {
    key: 'cash.due_event',
    class: 'money',
    store: column('cash_settings', 'due_event_by_service'),
    value: {
      type: 'record',
      keys: CASH_DUE_SERVICES,
      value: { type: 'enum', values: CASH_DUE_EVENTS, nullable: true },
    },
    inert: STORED,
    scope: 'service',
  },
  {
    key: 'cash.pack_grant_on_promise_enabled',
    class: 'money',
    store: column('cash_settings', 'pack_grant_on_promise_enabled'),
    value: BOOLEAN,
    inert: STORED,
  },
  {
    key: 'cash.pack_partial_payment_destination',
    class: 'money',
    store: column('cash_settings', 'pack_partial_payment_destination'),
    value: { type: 'enum', values: ['account-credit', 'cash-refund'] },
    inert: STORED,
  },
  {
    key: 'cash.unpaid_checkout_block_enabled',
    class: 'money',
    store: column('cash_settings', 'unpaid_checkout_block_enabled'),
    value: BOOLEAN,
    inert: STORED,
  },

  // cred — credit_settings (M1.06; §3.5), and the credit_packages catalog
  {
    key: 'cred.account_deletion_expires_credits_enabled',
    class: 'money',
    store: column('credit_settings', 'account_deletion_expires_credits_enabled'),
    value: BOOLEAN,
    inert: STORED,
  },
  {
    key: 'cred.booking_outlives_lot_expiry_enabled',
    class: 'money',
    store: column('credit_settings', 'booking_outlives_lot_expiry_enabled'),
    value: BOOLEAN,
    inert: LIVE,
  },
  {
    key: 'cred.dispute_auto_reversal_enabled',
    class: 'money',
    store: column('credit_settings', 'dispute_auto_reversal_enabled'),
    value: BOOLEAN,
    inert: STORED,
  },
  {
    key: 'cred.expiry_enforced_enabled',
    class: 'money',
    store: column('credit_settings', 'expiry_enforced_enabled'),
    value: BOOLEAN,
    inert: LIVE,
  },
  {
    key: 'cred.expiry_warning_lead_days',
    class: 'ops',
    store: column('credit_settings', 'expiry_warning_lead_days'),
    // Never empty (an empty list warns no family before credits lapse) and no
    // repeats (DECISIONS 61); M1.06 CHECKs the non-empty half.
    value: { type: 'integer-list', min: 0, nonEmpty: true, distinct: true },
    inert: LIVE,
  },
  {
    key: 'cred.manual_grant_expiry_months',
    class: 'money',
    store: column('credit_settings', 'manual_grant_expiry_months'),
    value: atLeast(1),
    inert: LIVE,
  },
  {
    key: 'cred.pause_daily_expiry_extension_days',
    class: 'money',
    store: column('credit_settings', 'pause_daily_expiry_extension_days'),
    value: atLeast(0),
    inert: STORED,
  },
  {
    key: 'cred.returned_credit_expiry_months',
    class: 'money',
    store: column('credit_settings', 'returned_credit_expiry_months'),
    value: atLeast(0),
    inert: LIVE,
  },
  {
    key: 'cred.single_day_purchase_max_count',
    class: 'ops',
    store: column('credit_settings', 'single_day_purchase_max_count'),
    value: atLeast(1),
    inert: LIVE,
  },
  {
    key: 'cred.unpaid_payment_auto_reversal_enabled',
    class: 'money',
    store: column('credit_settings', 'unpaid_payment_auto_reversal_enabled'),
    value: BOOLEAN,
    inert: STORED,
  },
  {
    key: 'cred.package_campus_mode',
    class: null,
    store: { kind: 'catalog', table: 'credit_packages', where: 'location, per row' },
    value: { type: 'catalog' },
    inert: LIVE,
    scope: 'package',
  },
  {
    key: 'cred.package_credits_count',
    class: null,
    store: { kind: 'catalog', table: 'credit_packages', where: 'credits, per row' },
    value: { type: 'catalog' },
    inert: LIVE,
    scope: 'package',
  },
  {
    key: 'cred.package_price_cents',
    class: 'price',
    store: {
      kind: 'catalog',
      table: 'credit_packages',
      where: 'price_cents, per row (a change is a seed step, q27 (a))',
    },
    value: { type: 'catalog' },
    inert: LIVE,
    scope: 'package',
  },
  {
    key: 'cred.package_program_mode',
    class: null,
    store: { kind: 'catalog', table: 'credit_packages', where: 'mode, per row' },
    value: { type: 'catalog' },
    inert: LIVE,
    scope: 'package',
  },

  // day — day_program_settings (M1.07; §3.4): the global row …
  {
    key: 'day.after_school_price_cents',
    class: 'price',
    store: column(DAY, 'after_school_price_cents', 'global'),
    value: atLeast(0),
    inert: LIVE,
  },
  {
    key: 'day.booking_horizon_months',
    class: 'ops',
    store: column(DAY, 'booking_horizon_months', 'global'),
    // A year ahead. A lowering edit takes one lock per date it lowers across the
    // whole horizon, in one transaction, so an unbounded value takes bookings down.
    value: between(1, 12),
    inert: LIVE,
  },
  {
    key: 'day.closure_return_fraction',
    class: 'money',
    store: column(DAY, 'closure_return_fraction', 'global'),
    value: FRACTION,
    inert: STORED,
  },
  {
    key: 'day.day_school_one_on_one_minutes',
    class: 'ops',
    store: column(DAY, 'day_school_one_on_one_minutes', 'global'),
    value: atLeast(1),
    inert: LIVE,
  },
  {
    key: 'day.max_dogs_per_booking_count',
    class: 'ops',
    store: column(DAY, 'max_dogs_per_booking_count', 'global'),
    // `POST /bookings` parses a lead and at most 99 more before it reads the setting,
    // so 100 dogs reach this refusal and 101 is the parse's. A value past 100 would
    // promise what the route refuses; 99 stays one under that.
    value: between(1, 99),
    inert: LIVE,
  },
  {
    key: 'day.midstay_day_charge_fraction',
    class: 'money',
    store: column(DAY, 'midstay_day_charge_fraction', 'global'),
    value: FRACTION,
    inert: STORED,
  },
  {
    key: 'day.occupied_block_end_time',
    class: 'ops',
    store: column(DAY, 'occupied_block_end_time', 'global'),
    value: TIME,
    inert: STORED,
  },
  {
    key: 'day.sent_home_after_training_return_fraction',
    class: 'money',
    store: column(DAY, 'sent_home_after_training_return_fraction', 'global'),
    value: { type: 'fraction', oneOf: [0, 1] },
    inert: LIVE,
  },
  {
    key: 'day.sent_home_before_training_return_fraction',
    class: 'money',
    store: column(DAY, 'sent_home_before_training_return_fraction', 'global'),
    value: FRACTION,
    inert: LIVE,
  },
  // … and each campus row
  {
    key: 'day.after_school_capacity_count',
    class: 'ops',
    store: column(DAY, 'after_school_capacity_count', 'campus'),
    value: atLeast(0),
    inert: LIVE,
  },
  {
    key: 'day.after_school_end_time',
    class: 'ops',
    store: column(DAY, 'after_school_end_time', 'campus'),
    value: TIME,
    inert: LIVE,
  },
  {
    key: 'day.after_school_start_time',
    class: 'ops',
    store: column(DAY, 'after_school_start_time', 'campus'),
    value: TIME,
    inert: LIVE,
  },
  {
    key: 'day.daily_capacity_dogs',
    class: 'ops',
    store: column(DAY, 'daily_capacity_dogs', 'campus'),
    value: atLeast(0),
    inert: LIVE,
  },
  {
    key: 'day.dropoff_close_time',
    class: 'ops',
    store: column(DAY, 'dropoff_close_time', 'campus'),
    value: TIME,
    inert: LIVE,
  },
  {
    key: 'day.dropoff_open_time',
    class: 'ops',
    store: column(DAY, 'dropoff_open_time', 'campus'),
    value: TIME,
    inert: LIVE,
  },
  {
    key: 'day.late_pickup_call_time',
    class: 'ops',
    store: column(DAY, 'late_pickup_call_time', 'campus'),
    value: TIME,
    inert: LIVE,
  },
  {
    key: 'day.late_pickup_fee_cents',
    class: 'money',
    store: column(DAY, 'late_pickup_fee_cents', 'campus'),
    value: atLeast(0),
    inert: STORED,
  },
  {
    key: 'day.late_pickup_grace_minutes',
    class: 'ops',
    store: column(DAY, 'late_pickup_grace_minutes', 'campus'),
    value: atLeast(0),
    inert: STORED,
  },
  {
    key: 'day.open_weekdays_list',
    class: 'ops',
    store: column(DAY, 'open_weekdays_list', 'campus'),
    value: { type: 'integer-list', min: 1, max: 7 },
    inert: LIVE,
  },
  {
    key: 'day.pickup_close_time',
    class: 'ops',
    store: column(DAY, 'pickup_close_time', 'campus'),
    value: TIME,
    inert: LIVE,
  },
  {
    key: 'day.pickup_open_time',
    class: 'ops',
    store: column(DAY, 'pickup_open_time', 'campus'),
    value: TIME,
    inert: LIVE,
  },
  {
    key: 'day.same_day_cutoff_time',
    class: 'ops',
    store: column(DAY, 'same_day_cutoff_time', 'campus'),
    value: TIME,
    inert: LIVE,
  },
  // E03's per-campus service document. Design-added: §3 names no key for it
  // (§2.1, M1.07). Its day-school and day-care `offered` are §3's two flags,
  // which are names for that part of it, not columns (DECISIONS 53, D2).
  {
    key: 'day.offerings',
    class: 'ops',
    store: column(DAY, 'offerings', 'campus'),
    value: {
      type: 'offerings',
      services: OFFERING_SERVICES,
      nameMaxLength: OFFERING_NAME_MAX_LENGTH,
      descriptionMaxLength: OFFERING_DESCRIPTION_MAX_LENGTH,
    },
    inert: LIVE,
  },
  {
    key: 'day.day_school_offered_flag',
    class: 'ops',
    store: {
      kind: 'path',
      table: DAY,
      column: 'offerings',
      path: ['day-school', 'offered'],
      via: 'day.offerings',
      tier: 'campus',
    },
    value: BOOLEAN,
    inert: LIVE,
  },
  {
    key: 'day.daycare_offered_flag',
    class: 'ops',
    store: {
      kind: 'path',
      table: DAY,
      column: 'offerings',
      path: ['day-care', 'offered'],
      via: 'day.offerings',
      tier: 'campus',
    },
    value: BOOLEAN,
    inert: LIVE,
  },
  {
    key: 'day.capacity_override_dogs',
    class: 'ops',
    store: {
      kind: 'catalog',
      table: 'day_capacity',
      where:
        'per (location, date) row; set with PUT and DELETE /staff/day-capacity/:location/:date',
    },
    value: { type: 'catalog' },
    inert: LIVE,
    scope: 'campus',
  },

  // dog — dog_gate_settings (M1.08; §3.1), and two catalogs
  {
    key: 'dog.card_required_at_board_train_confirm_enabled',
    class: 'ops',
    store: column('dog_gate_settings', 'card_required_at_board_train_confirm'),
    value: BOOLEAN,
    inert: STORED,
  },
  {
    key: 'dog.card_required_for_evaluation_booking_enabled',
    class: 'ops',
    store: column('dog_gate_settings', 'card_required_for_evaluation_booking_enabled'),
    value: BOOLEAN,
    inert: UNTIL_P06,
  },
  {
    key: 'dog.gate_agreements_enabled',
    class: 'ops',
    store: column('dog_gate_settings', 'gate_agreements_enabled'),
    value: BOOLEAN,
    inert: UNTIL_P06,
  },
  {
    key: 'dog.gate_card_on_file_enabled',
    class: 'ops',
    store: column('dog_gate_settings', 'gate_card_on_file_enabled'),
    value: BOOLEAN,
    inert: UNTIL_P06,
  },
  {
    key: 'dog.gate_evaluation_enabled',
    class: 'ops',
    store: column('dog_gate_settings', 'gate_evaluation_enabled'),
    value: BOOLEAN,
    inert: UNTIL_P06,
  },
  {
    key: 'dog.gate_vaccines_enabled',
    class: 'ops',
    store: column('dog_gate_settings', 'gate_vaccines_enabled'),
    value: BOOLEAN,
    inert: UNTIL_P06,
  },
  {
    key: 'dog.gate_override_allowed_gate_list',
    class: 'ops',
    store: column('dog_gate_settings', 'gate_override_allowed_gate_keys'),
    value: { type: 'text-list' },
    inert: STORED,
  },
  {
    key: 'dog.spay_neuter_gated_service_list',
    class: 'ops',
    store: column('dog_gate_settings', 'spay_neuter_gated_categories'),
    value: { type: 'enum-list', values: SERVICE_CATEGORIES },
    inert: UNTIL_P09,
  },
  {
    key: 'dog.spay_neuter_reminder_time',
    class: 'ops',
    store: column('dog_gate_settings', 'spay_neuter_reminder_time'),
    value: TIME,
    inert: STORED,
  },
  {
    key: 'dog.spay_neuter_required_by_age_months',
    class: 'ops',
    store: column('dog_gate_settings', 'spay_neuter_required_by_age_months'),
    value: atLeast(1),
    inert: UNTIL_P09,
  },
  {
    key: 'dog.staff_dog_exempt_gate_list',
    class: 'ops',
    store: column('dog_gate_settings', 'staff_dog_exempt_gate_keys'),
    value: { type: 'text-list' },
    inert: UNTIL_P09,
  },
  {
    key: 'dog.descriptor_list',
    class: 'ops',
    store: {
      kind: 'catalog',
      table: 'dog_descriptors',
      where: 'the rows (8 live); the descriptor editor is DOG-U16',
    },
    value: { type: 'catalog' },
    inert: LIVE,
  },
  {
    key: 'dog.intake_field_mode',
    class: 'ops',
    store: { kind: 'catalog', table: 'intake_field_settings', where: 'one row per field_key' },
    value: { type: 'catalog' },
    inert: LIVE,
  },

  // eval — evaluation_settings (M1.09; §3.2), and the evaluation's service_rates rows
  {
    key: 'eval.failed_rebook_wait_hours',
    class: 'ops',
    store: column(EVAL, 'failed_rebook_wait_hours', 'global'),
    value: atLeast(0),
    inert: STORED,
  },
  {
    key: 'eval.reeval_after_months_unseen',
    class: 'ops',
    store: column(EVAL, 'reeval_after_months_unseen', 'global'),
    // NULL switches the clock off (EVAL-53; DECISIONS 62). Seeded 3.
    value: { type: 'integer', min: 1, nullable: true },
    inert: storedUntil('inert until S14 lands (dated before first import + 3 months, R5)'),
  },
  {
    key: 'eval.max_per_day_dogs',
    class: 'ops',
    store: column(EVAL, 'max_per_day_dogs', 'campus'),
    value: { type: 'integer', min: 1, nullable: true },
    inert: STORED,
  },
  {
    key: 'eval.price_cents',
    class: 'price',
    store: {
      kind: 'catalog',
      table: 'service_rates',
      // DECISIONS 93: the note says what is true. `POST /staff/rates` accepts an
      // evaluation rate from the owner or a manager until DAY-U23 narrows it at
      // design 4.0.0 (design.md:2089-2090; DECISIONS 74 X6); the portal draws no
      // rate editor in v1, and the preflight's price clause flags a rate off its seed.
      where:
        "the campus's category = 'evaluation' row (amount_cents), edited only by POST /staff/rates (owner and manager); no portal screen in v1, and every price is kept at its seed (q27 (a))",
    },
    value: { type: 'catalog' },
    inert: LIVE,
    scope: 'campus',
  },

  // mig — migration_settings (M1.10; §3.16)
  {
    key: 'mig.full_transfer_after_pilot_months',
    class: 'ops',
    store: column('migration_settings', 'full_transfer_after_pilot_months'),
    value: atLeast(1),
    inert: STORED,
  },
  {
    key: 'mig.gingr_retention_billing_cycles',
    class: 'ops',
    store: column('migration_settings', 'gingr_retention_billing_cycles'),
    value: atLeast(1),
    inert: STORED,
  },
  {
    key: 'mig.import_credit_balances_enabled',
    class: 'money',
    store: column('migration_settings', 'import_credit_balances_enabled'),
    value: BOOLEAN,
    inert: LIVE,
  },
  {
    key: 'mig.import_unpaid_balances_enabled',
    class: 'ops',
    store: column('migration_settings', 'import_unpaid_balances_enabled'),
    value: BOOLEAN,
    inert: STORED,
  },
  {
    key: 'mig.imported_credit_expiry_months',
    class: 'money',
    store: column('migration_settings', 'imported_credit_expiry_months'),
    value: atLeast(1),
    inert: LIVE,
  },
  {
    key: 'mig.invite_recent_within_months',
    class: 'ops',
    store: column('migration_settings', 'invite_recent_within_months'),
    value: atLeast(1),
    inert: STORED,
  },
  {
    key: 'mig.pilot_family_count',
    class: 'ops',
    store: column('migration_settings', 'pilot_family_count'),
    value: atLeast(1),
    inert: LIVE,
  },

  // msg — messaging_settings (M1.11; §3.13)
  {
    key: 'msg.max_attachments_per_message_count',
    class: 'ops',
    store: column('messaging_settings', 'max_attachments_per_message'),
    value: atLeast(1),
    inert: STORED,
  },
  {
    key: 'msg.max_text_length_chars',
    class: 'ops',
    store: column('messaging_settings', 'max_text_length_chars'),
    value: atLeast(1),
    inert: storedUntil('the three message verbs keep the shared 4000 constant (cut C6)'),
  },
  {
    key: 'msg.referral_subtopic_enabled_flag',
    class: 'ops',
    store: column('messaging_settings', 'referral_subtopic_enabled'),
    value: BOOLEAN,
    inert: LIVE,
  },
  {
    key: 'msg.reply_signature_mode',
    class: 'ops',
    store: column('messaging_settings', 'reply_signature_mode'),
    value: { type: 'enum', values: ['staffer_first_name', 'school_name'] },
    inert: LIVE,
  },
  {
    key: 'msg.request_reply_window_hours',
    class: 'ops',
    store: column('messaging_settings', 'request_reply_window_hours'),
    value: atLeast(1),
    inert: STORED,
  },
  {
    key: 'msg.school_backup_responder_staff_id',
    class: 'ops',
    store: column('messaging_settings', 'school_backup_responder_staff_id'),
    value: { type: 'staff-id', nullable: true },
    inert: storedUntil('set by staff:provision, read by nothing until MSG-U27'),
  },
  {
    key: 'msg.school_default_responder_out_flag',
    class: 'ops',
    store: column('messaging_settings', 'school_default_responder_out'),
    value: BOOLEAN,
    inert: storedUntil('read by nothing until MSG-U27'),
  },
  {
    key: 'msg.school_default_responder_staff_id',
    class: 'ops',
    store: column('messaging_settings', 'school_default_responder_staff_id'),
    value: { type: 'staff-id', nullable: true },
    inert: storedUntil('set by staff:provision, read by nothing until MSG-U27'),
  },
  {
    key: 'msg.video_max_duration_seconds',
    class: 'ops',
    store: column('messaging_settings', 'video_max_duration_seconds'),
    value: atLeast(1),
    inert: STORED,
  },
  {
    key: 'msg.video_max_size_mb',
    class: 'ops',
    store: column('messaging_settings', 'video_max_size_mb'),
    value: atLeast(1),
    inert: STORED,
  },

  // notif — notification_settings (M1.12; §3.12)
  {
    key: 'notif.booking_reminder_lead_hours',
    class: 'ops',
    store: column('notification_settings', 'booking_reminder_lead_hours'),
    value: atLeast(0),
    inert: LIVE,
  },
  {
    key: 'notif.broadcast_audience_list',
    class: 'ops',
    store: column('notification_settings', 'broadcast_audience_list'),
    value: { type: 'enum-list', values: ['everyone', 'campus', 'class', 'day-school-families'] },
    inert: STORED,
  },
  {
    key: 'notif.card_expiry_warning_days_before',
    class: 'ops',
    store: column('notification_settings', 'card_expiry_warning_days_before'),
    value: atLeast(0),
    inert: LIVE,
  },
  {
    key: 'notif.cash_payment_due_reminder_lead_hours',
    class: 'ops',
    store: column('notification_settings', 'cash_payment_due_reminder_lead_hours'),
    value: atLeast(0),
    inert: STORED,
  },
  {
    key: 'notif.email_inflight_alarm_minutes',
    class: 'ops',
    store: column('notification_settings', 'email_inflight_alarm_minutes'),
    value: atLeast(1),
    inert: LIVE,
  },
  {
    key: 'notif.email_sender_address',
    class: 'ops',
    store: column('notification_settings', 'email_sender_address'),
    value: { type: 'text', nullable: true },
    inert: LIVE,
  },
  {
    key: 'notif.email_sender_display_name',
    class: 'ops',
    store: column('notification_settings', 'email_sender_display_name'),
    value: { type: 'text' },
    inert: LIVE,
  },
  {
    key: 'notif.expiry_notice_channel',
    class: 'ops',
    store: column('notification_settings', 'expiry_notice_channel'),
    value: { type: 'enum', values: ['push_only', 'push_then_email'] },
    inert: LIVE,
  },
  {
    key: 'notif.quiet_hours_bypass_types',
    class: 'ops',
    store: column('notification_settings', 'quiet_hours_bypass_types'),
    // The wire's QuietHoursClass: a notification type, or 'closure' / 'staff-reply'.
    value: { type: 'enum-list', values: QUIET_HOURS_CLASSES },
    inert: STORED,
  },
  {
    key: 'notif.quiet_hours_end_time',
    class: 'ops',
    store: column('notification_settings', 'quiet_hours_end_time'),
    value: TIME,
    inert: STORED,
  },
  {
    key: 'notif.quiet_hours_start_time',
    class: 'ops',
    store: column('notification_settings', 'quiet_hours_start_time'),
    value: TIME,
    inert: STORED,
  },
  {
    key: 'notif.reminder_channel_by_program',
    class: 'ops',
    store: column('notification_settings', 'reminder_channel_by_program'),
    value: {
      type: 'record',
      keys: PROGRAMS_WITH_REMINDERS,
      value: { type: 'enum', values: ['push_only', 'push_then_email'] },
    },
    inert: LIVE,
  },
  {
    key: 'notif.scan_send_time',
    class: 'ops',
    store: column('notification_settings', 'scan_send_time'),
    value: TIME,
    inert: LIVE,
  },

  // pay — payment_settings (M1.13; §3.7)
  {
    key: 'pay.automatic_return_instrument_mode',
    class: 'money',
    store: { kind: 'payment', key: 'automatic_return_instrument_mode', scope: 'global' },
    value: { type: 'enum', values: ['original_card'] },
    inert: STORED,
  },
  {
    key: 'pay.card_attempts_max_count',
    class: 'money',
    store: { kind: 'payment', key: 'card_attempts_max_count', scope: 'global' },
    value: between(1, 5),
    inert: LIVE,
  },
  {
    key: 'pay.charge_timing_mode',
    class: 'money',
    store: { kind: 'payment', key: 'charge_timing_mode', scope: 'per-service' },
    value: { type: 'enum', values: ['at_confirm', 'at_close_out'] },
    inert: STORED,
    scope: 'service',
  },
  {
    key: 'pay.custom_invoice_card_kind_list',
    class: 'money',
    store: { kind: 'payment', key: 'custom_invoice_card_kind_list', scope: 'global' },
    value: { type: 'text-list' },
    inert: LIVE,
  },
  {
    key: 'pay.custom_invoice_kind_list',
    class: 'money',
    store: { kind: 'payment', key: 'custom_invoice_kind_list', scope: 'global' },
    value: { type: 'text-list' },
    inert: LIVE,
  },
  {
    key: 'pay.max_sessions_per_booking_count',
    class: 'ops',
    store: { kind: 'payment', key: 'max_sessions_per_booking_count', scope: 'global' },
    value: atLeast(1),
    inert: STORED,
  },
  {
    key: 'pay.price_change_notice_days',
    class: 'money',
    store: { kind: 'payment', key: 'price_change_notice_days', scope: 'global' },
    value: atLeast(0),
    inert: storedUntil('q27 (a): a price change is a seed step; the 409 reader waits for PAY-U44'),
  },
  {
    key: 'pay.processing_hold_max_minutes',
    class: 'money',
    store: { kind: 'payment', key: 'processing_hold_max_minutes', scope: 'global' },
    value: between(1, 60),
    inert: LIVE,
  },
  {
    key: 'pay.refund_any_role_limit_cents',
    // §3.7: money (owner and manager). DECISIONS 60 had ruled it `roles`;
    // Allison reverted that ruling (DECISIONS 73, "B is good"), so the §3
    // check holds this key with no exception.
    class: 'money',
    store: { kind: 'payment', key: 'refund_any_role_limit_cents', scope: 'global' },
    value: atLeast(0),
    inert: LIVE,
  },
  {
    key: 'pay.seat_hold_max_minutes',
    class: 'money',
    store: { kind: 'payment', key: 'seat_hold_max_minutes', scope: 'global' },
    value: between(1, 5),
    inert: LIVE,
  },

  // rpt — reports_settings (M1.15; §3.17)
  {
    key: 'rpt.event_max_dogs_per_rsvp_count',
    class: 'ops',
    store: column('reports_settings', 'event_max_dogs_per_rsvp'),
    value: atLeast(1),
    inert: STORED,
  },
  {
    key: 'rpt.events_enabled_flag',
    class: 'ops',
    store: column('reports_settings', 'events_enabled'),
    value: BOOLEAN,
    inert: LIVE,
  },
  {
    key: 'rpt.gallery_enabled_flag',
    class: 'ops',
    store: column('reports_settings', 'gallery_enabled'),
    value: BOOLEAN,
    inert: LIVE,
  },
  {
    key: 'rpt.gallery_max_dogs_count',
    class: 'ops',
    store: column('reports_settings', 'gallery_max_dogs'),
    value: atLeast(1),
    inert: STORED,
  },
  {
    key: 'rpt.gallery_rate_limit_requests_per_minute',
    class: 'ops',
    store: column('reports_settings', 'gallery_rate_limit_per_minute'),
    value: atLeast(1),
    inert: STORED,
  },
  {
    key: 'rpt.media_max_upload_megabytes',
    class: 'ops',
    store: column('reports_settings', 'media_max_upload_megabytes'),
    value: between(1, 25),
    inert: LIVE,
  },

  // vax — vaccine_settings (M1.16; §3.3), and the required_vaccines catalog.
  // Every vax.* key is inert until P07 (re-cut 11-02).
  {
    key: 'vax.proof_file_type_list',
    class: 'ops',
    store: column('vaccine_settings', 'proof_file_types'),
    value: { type: 'text-list' },
    inert: UNTIL_P07,
  },
  {
    key: 'vax.typical_full_vaccination_age_months',
    class: 'ops',
    store: column('vaccine_settings', 'typical_full_vaccination_age_months'),
    value: atLeast(1),
    inert: UNTIL_P07,
  },
  {
    key: 'vax.catalog_vaccine_list',
    class: null,
    store: { kind: 'catalog', table: 'required_vaccines', where: 'the live rows' },
    value: { type: 'catalog' },
    inert: UNTIL_P07,
  },
  {
    key: 'vax.class_exempt_flag',
    class: null,
    store: {
      kind: 'catalog',
      table: 'required_vaccines',
      where: 'exempt_class_keys, per row (VAX-U05/U06 later)',
    },
    value: { type: 'catalog' },
    inert: UNTIL_P07,
  },
  {
    key: 'vax.gate_applies_flag',
    class: null,
    store: {
      kind: 'catalog',
      table: 'required_vaccines',
      where: 'gates_categories, per row (VAX-U05/U06 later)',
    },
    value: { type: 'catalog' },
    inert: UNTIL_P07,
    scope: 'service',
  },
  {
    key: 'vax.vaccine_label_text',
    class: null,
    store: { kind: 'catalog', table: 'required_vaccines', where: 'label, per row' },
    value: { type: 'catalog' },
    inert: UNTIL_P07,
  },

  // staff — staff_settings (M1.21; §3.14). Every key is `roles` class: only
  // the owner role edits who may use a money verb, or how long a money session
  // outlives its staffer at the shared desk (§2.1:1791-1798). The owner role
  // passes every list regardless (STAFF-09). None is inert: the lists' reader
  // in this release is `GET /me`'s capabilities, the minutes' is the portal's
  // idle sign-out (STAFF-U11).
  {
    key: 'staff.refund_role_list',
    class: 'roles',
    store: column('staff_settings', 'refund_roles'),
    value: ROLE_LIST,
    inert: LIVE,
  },
  {
    key: 'staff.credit_hand_edit_role_list',
    class: 'roles',
    store: column('staff_settings', 'credit_hand_edit_roles'),
    value: ROLE_LIST,
    inert: LIVE,
  },
  {
    key: 'staff.desk_sale_role_list',
    class: 'roles',
    store: column('staff_settings', 'desk_sale_roles'),
    value: ROLE_LIST,
    inert: LIVE,
  },
  {
    key: 'staff.custom_invoice_role_list',
    class: 'roles',
    store: column('staff_settings', 'custom_invoice_roles'),
    value: ROLE_LIST,
    inert: LIVE,
  },
  {
    key: 'staff.cash_day_totals_role_list',
    class: 'roles',
    store: column('staff_settings', 'cash_day_totals_roles'),
    value: ROLE_LIST,
    inert: LIVE,
  },
  {
    key: 'staff.portal_idle_signout_minutes',
    class: 'roles',
    store: column('staff_settings', 'portal_idle_signout_minutes'),
    value: between(1, 60),
    inert: LIVE,
  },
];

function scopeOf(entry: Entry): SettingScope {
  if (entry.scope !== undefined) return entry.scope;
  if (
    (entry.store.kind === 'column' || entry.store.kind === 'path') &&
    entry.store.tier === 'campus'
  ) {
    return 'campus';
  }
  return 'global';
}

function domainOf(key: string): SettingsDomain {
  const prefix = key.slice(0, key.indexOf('.'));
  const domain = SETTINGS_DOMAINS.find((d) => d === prefix);
  if (domain === undefined) throw new Error(`settings registry: '${key}' has no settings domain`);
  return domain;
}

/** Every registered key, in registry order. */
export const SETTINGS_REGISTRY: readonly SettingEntry[] = ENTRIES.map((entry) => ({
  ...entry,
  domain: domainOf(entry.key),
  scope: scopeOf(entry),
}));

const BY_KEY: ReadonlyMap<string, SettingEntry> = new Map(SETTINGS_REGISTRY.map((e) => [e.key, e]));

export function settingEntry(key: string): SettingEntry | undefined {
  return BY_KEY.get(key);
}

/**
 * True for a key the settings PATCH writes: its own column or payment row, and
 * a class some role may hold. A path is edited through its `via` key; a catalog
 * row through its own route.
 */
export function isPatchable(entry: SettingEntry): boolean {
  return (entry.store.kind === 'column' || entry.store.kind === 'payment') && entry.class !== null;
}

// ── Who may edit which class ─────────────────────────────────────────────────

/**
 * The one place a role meets a class (design §2.1:1779-1798, §3.14; STAFF-U07,
 * replacing DECISIONS 48's interim map): the owner edits `ops`, `money` and
 * `roles`; the manager `ops` and `money` (STAFF-77, RULING §5 "money =
 * owner/manager edit"); the trainer `ops` (STAFF-73). No role passes `price`
 * in v1, the owner included (question 27 → (a)): every price is its seed.
 * `GET /me`'s `edit_prices` and `edit_money_policy` read this same map.
 */
const EDITABLE_CLASSES: Readonly<Record<StaffRole, ReadonlySet<SettingClass>>> = {
  owner: new Set<SettingClass>(['ops', 'money', 'roles']),
  manager: new Set<SettingClass>(['ops', 'money']),
  trainer: new Set<SettingClass>(['ops']),
};

export function mayEditClass(role: StaffRole, settingClass: SettingClass | null): boolean {
  // A role the map does not hold (a hand-edited row, a value from a later enum)
  // edits nothing: 403, never a TypeError's 500 (DECISIONS 71).
  const classes = Object.hasOwn(EDITABLE_CLASSES, role) ? EDITABLE_CLASSES[role] : undefined;
  return settingClass !== null && classes !== undefined && classes.has(settingClass);
}

/**
 * The keys of `keys` the role may not edit — the 403 `refused_keys` list. A key
 * with no class, or not in the registry, is refused: nothing is editable by
 * default. (Unknown keys are the strict zod parse's 400 before this runs.)
 */
export function refusedKeys(role: StaffRole, keys: readonly string[]): string[] {
  return keys.filter((key) => !mayEditClass(role, BY_KEY.get(key)?.class ?? null));
}

/** The keys of `keys` that are inert — the 422 `setting_inert` list. */
export function inertKeys(keys: readonly string[]): string[] {
  return keys.filter((key) => {
    const entry = BY_KEY.get(key);
    return entry !== undefined && entry.inert !== false;
  });
}
