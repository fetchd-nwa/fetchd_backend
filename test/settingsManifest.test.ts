import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { SettingsManifestEntryWire, StaffRole } from '../src/contracts/wire.js';
import { manifestEntry, settingsManifest } from '../src/lib/settingsManifest.js';
import { SETTINGS_REGISTRY, settingEntry, type SettingEntry } from '../src/lib/settingsRegistry.js';

/**
 * The settings manifest (`GET /staff/settings/manifest`, wire 2.0.0; build
 * DECISIONS 85, contract notes J11–J16): every registry key, served with its
 * class, store, editor, inertness, value spec and — computed for the caller —
 * `editable`. Pure: built from `src/lib/settingsRegistry.ts`. The route-level
 * proof that `editable` agrees with the PATCH is
 * `test/contracts/settings-manifest.test.ts`.
 */

const ROLES: readonly StaffRole[] = ['owner', 'manager', 'trainer'];

function entryFor(key: string, role: StaffRole): SettingsManifestEntryWire {
  const found = settingsManifest(role).entries.find((e) => e.key === key);
  assert.ok(found, `${key} is not in the manifest`);
  return found;
}

describe('the settings manifest, built from the registry', () => {
  test('every registry key once, in registry order, with its own domain and class', () => {
    for (const role of ROLES) {
      const { entries } = settingsManifest(role);
      assert.deepEqual(
        entries.map((e) => e.key),
        SETTINGS_REGISTRY.map((e) => e.key),
      );
      assert.equal(new Set(entries.map((e) => e.key)).size, entries.length);
      entries.forEach((e, i) => {
        assert.equal(e.domain, SETTINGS_REGISTRY[i]?.domain, e.key);
        assert.equal(e.class, SETTINGS_REGISTRY[i]?.class, e.key);
      });
    }
  });

  test('a price key is editable by no role, the owner included (question 27 → (a))', () => {
    for (const key of [
      'day.after_school_price_cents',
      'cred.package_price_cents',
      'eval.price_cents',
    ]) {
      for (const role of ROLES)
        assert.equal(entryFor(key, role).editable, false, `${key} for ${role}`);
    }
  });

  test('a staff.* key is editable by the owner alone; a money key by the owner and the manager', () => {
    const staffKeys = SETTINGS_REGISTRY.filter((e) => e.domain === 'staff').map((e) => e.key);
    assert.equal(staffKeys.length, 6);
    for (const key of staffKeys) {
      assert.deepEqual(
        ROLES.map((role) => entryFor(key, role).editable),
        [true, false, false],
        key,
      );
    }
    assert.deepEqual(
      ROLES.map((role) => entryFor('cred.expiry_enforced_enabled', role).editable),
      [true, true, false],
    );
  });

  test('every inert key, and every key edited elsewhere or through another key, is editable by no role', () => {
    for (const role of ROLES) {
      for (const e of settingsManifest(role).entries) {
        if (e.inert !== false || e.editor.kind !== 'here')
          assert.equal(e.editable, false, `${e.key} for ${role}`);
      }
    }
  });

  test('the stores map to read and editor as the wire documents them', () => {
    assert.deepEqual(entryFor('cred.expiry_enforced_enabled', 'owner').read, {
      tier: 'global',
      field: 'expiry_enforced_enabled',
    });
    assert.deepEqual(entryFor('day.offerings', 'owner').read, {
      tier: 'campus',
      field: 'offerings',
    });
    assert.deepEqual(entryFor('day.day_school_offered_flag', 'owner').read, {
      tier: 'campus',
      field: 'offerings',
      path: ['day-school', 'offered'],
    });
    assert.deepEqual(entryFor('day.day_school_offered_flag', 'owner').editor, {
      kind: 'via',
      key: 'day.offerings',
    });
    const pay = SETTINGS_REGISTRY.find((e) => e.store.kind === 'payment') as SettingEntry;
    assert.deepEqual(entryFor(pay.key, 'owner').read, {
      tier: 'global',
      field: (pay.store as { key: string }).key,
    });
    const price = entryFor('cred.package_price_cents', 'owner');
    assert.equal(price.read, null);
    assert.equal(price.editor.kind, 'elsewhere');
    assert.equal(price.editor.kind === 'elsewhere' ? price.editor.catalog : '', 'credit_packages');
    assert.deepEqual(price.value, { type: 'catalog' });
  });

  test('the value specs: int4 where the registry sets no max, explicit booleans, the roles and the offerings caps', () => {
    const integerWithoutMax = SETTINGS_REGISTRY.find(
      (e) => e.value.type === 'integer' && e.value.max === undefined,
    ) as SettingEntry;
    const spec = entryFor(integerWithoutMax.key, 'owner').value;
    assert.equal(spec.type === 'integer' ? spec.max : -1, 2147483647);
    assert.equal(spec.type === 'integer' ? typeof spec.nullable : '', 'boolean');
    assert.deepEqual(entryFor('staff.refund_role_list', 'owner').value, {
      type: 'role-list',
      values: ['owner', 'manager', 'trainer'],
    });
    const offerings = entryFor('day.offerings', 'owner').value;
    assert.equal(offerings.type, 'offerings');
    assert.equal(offerings.type === 'offerings' ? offerings.name_max_length : 0, 60);
    assert.equal(offerings.type === 'offerings' ? offerings.description_max_length : 0, 280);
  });

  test('the two day ceilings are served, so the editor refuses what the PATCH refuses (P13 F1)', () => {
    assert.deepEqual(
      (({ type, min, max }) => ({ type, min, max }))(
        entryFor('day.booking_horizon_months', 'trainer').value as {
          type: string;
          min: number;
          max: number;
        },
      ),
      { type: 'integer', min: 1, max: 12 },
    );
    assert.deepEqual(
      (({ type, min, max }) => ({ type, min, max }))(
        entryFor('day.max_dogs_per_booking_count', 'trainer').value as {
          type: string;
          min: number;
          max: number;
        },
      ),
      { type: 'integer', min: 1, max: 99 },
    );
  });

  test('a record serves `fixed` when the registry fixes a key, and omits it when it does not (P05 N4)', () => {
    const fixed = entryFor('acct.signup_field_requirement_map', 'owner').value;
    assert.equal(fixed.type, 'record');
    assert.deepEqual(fixed.type === 'record' ? fixed.fixed : undefined, { email: 'mandatory' });

    const unfixed = SETTINGS_REGISTRY.find(
      (e) => e.value.type === 'record' && e.value.fixed === undefined,
    ) as SettingEntry;
    const spec = entryFor(unfixed.key, 'owner').value;
    assert.equal(spec.type, 'record');
    assert.equal(Object.hasOwn(spec, 'fixed'), false, 'the wire omits it, never `undefined`');
  });

  test('un-inerting a key changes data, never shape: only `inert` and `editable` differ', () => {
    const key = 'dog.gate_card_on_file_enabled';
    const inert = settingEntry(key) as SettingEntry;
    assert.notEqual(inert.inert, false, `precondition: ${key} is inert`);
    const live: SettingEntry = { ...inert, inert: false };
    for (const role of ROLES) {
      const before = manifestEntry(inert, role);
      const after = manifestEntry(live, role);
      assert.deepEqual(Object.keys(after), Object.keys(before), 'the entry gained or lost a field');
      const { inert: wasInert, editable: wasEditable, ...rest } = before;
      const { inert: isInert, editable: isEditable, ...restAfter } = after;
      assert.deepEqual(restAfter, rest);
      assert.notEqual(wasInert, false);
      assert.equal(isInert, false);
      assert.equal(wasEditable, false);
      assert.equal(isEditable, true, `an ops key, live, is editable by ${role}`);
    }
  });
});
