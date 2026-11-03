import type {
  SettingEditorWire,
  SettingInertWire,
  SettingReadWire,
  SettingValueSpecWire,
  SettingsManifestEntryWire,
  StaffRole,
  StaffSettingsManifestWire,
} from '../contracts/wire.js';
import { staffRole } from '../db/schema/schema.js';
import { pgEnumTuple } from './pgEnumTuple.js';
import {
  INT4_MAX,
  SETTINGS_REGISTRY,
  isPatchable,
  mayEditClass,
  type Inertness,
  type SettingEntry,
  type SettingStore,
  type SettingValue,
} from './settingsRegistry.js';

/**
 * `GET /staff/settings/manifest` (wire 2.0.0; build DECISIONS 85, contract
 * notes J11–J16): every registry key as the settings editor needs it, built
 * from the registry on every call — so it is exactly what this server's PATCH
 * enforces, and a later unit un-inerting a key changes its `inert` value and
 * nothing else. Every switch below is exhaustive with no `default` arm: a new
 * store kind or value type fails `tsc` here until the manifest says what it is.
 */

const STAFF_ROLES: StaffRole[] = [...pgEnumTuple(staffRole)];

/**
 * One key, for one caller. `editable` is the PATCH's own answer (J12): the
 * settings PATCH writes the key (`isPatchable`: its own column or payment row),
 * the key is live, and the caller's role may edit its class — so `true`
 * promises the PATCH will not answer 403 `refused_keys` or 422 `setting_inert`.
 */
export function manifestEntry(entry: SettingEntry, role: StaffRole): SettingsManifestEntryWire {
  return {
    key: entry.key,
    domain: entry.domain,
    class: entry.class,
    read: readOf(entry.store),
    editor: editorOf(entry.store),
    inert: inertOf(entry.inert),
    editable: isPatchable(entry) && entry.inert === false && mayEditClass(role, entry.class),
    value: valueSpecOf(entry.value),
  };
}

/** Every registry key once, in registry order, for this caller. */
export function settingsManifest(role: StaffRole): StaffSettingsManifestWire {
  return { entries: SETTINGS_REGISTRY.map((entry) => manifestEntry(entry, role)) };
}

function readOf(store: SettingStore): SettingReadWire | null {
  switch (store.kind) {
    case 'column':
      return { tier: store.tier ?? 'global', field: store.column };
    case 'payment':
      return { tier: 'global', field: store.key };
    case 'path':
      return { tier: store.tier, field: store.column, path: [...store.path] };
    case 'catalog':
      return null;
  }
}

function editorOf(store: SettingStore): SettingEditorWire {
  switch (store.kind) {
    case 'column':
    case 'payment':
      return { kind: 'here' };
    case 'path':
      return { kind: 'via', key: store.via };
    case 'catalog':
      return { kind: 'elsewhere', catalog: store.table, note: store.where };
  }
}

/** The registry's `until` (a build-plan unit id) is not a wire fact (X6). */
function inertOf(inert: Inertness): SettingInertWire {
  if (inert === false) return false;
  return inert.note === undefined ? { kind: inert.kind } : { kind: inert.kind, note: inert.note };
}

function valueSpecOf(value: SettingValue): SettingValueSpecWire {
  switch (value.type) {
    case 'boolean':
      return { type: 'boolean' };
    case 'integer':
      return {
        type: 'integer',
        min: value.min,
        max: value.max ?? INT4_MAX,
        nullable: value.nullable === true,
      };
    case 'fraction':
      return value.oneOf === undefined
        ? { type: 'fraction' }
        : { type: 'fraction', one_of: [...value.oneOf] };
    case 'time':
      return { type: 'time' };
    case 'enum':
      return { type: 'enum', values: [...value.values], nullable: value.nullable === true };
    case 'enum-list':
      return { type: 'enum-list', values: [...value.values] };
    case 'integer-list':
      return {
        type: 'integer-list',
        min: value.min,
        max: value.max ?? INT4_MAX,
        non_empty: value.nonEmpty === true,
        distinct: value.distinct === true,
      };
    case 'text':
      return { type: 'text', nullable: value.nullable === true };
    case 'text-list':
      return { type: 'text-list' };
    case 'staff-id':
      return { type: 'staff-id', nullable: value.nullable };
    case 'record':
      return {
        type: 'record',
        keys: [...value.keys],
        value: { values: [...value.value.values], nullable: value.value.nullable === true },
      };
    case 'offerings':
      return {
        type: 'offerings',
        services: [...value.services],
        name_max_length: value.nameMaxLength,
        description_max_length: value.descriptionMaxLength,
      };
    case 'role-list':
      return { type: 'role-list', values: [...STAFF_ROLES] };
    case 'catalog':
      return { type: 'catalog' };
  }
}
