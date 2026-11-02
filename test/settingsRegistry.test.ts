import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { getTableColumns, getTableName, type Table } from 'drizzle-orm';
import { NOTIFICATION_TYPES, type StaffRole } from '../src/contracts/wire.js';
import * as schema from '../src/db/schema/schema.js';
import {
  SETTINGS_DOMAINS,
  SETTINGS_REGISTRY,
  SETTINGS_TABLES,
  isPatchable,
  mayEditClass,
  type SettingClass,
} from '../src/lib/settingsRegistry.js';
import { SETTINGS_TARGETS, patchableFields } from '../src/routes/staffSettings.js';

/**
 * The settings registry held to its two sources (design §2.1 "The registry",
 * §3; SET-U01 / STAFF-U07):
 *
 *   1. the Drizzle schema — every settings column has exactly one editable
 *      key, and no key names a column or table that is not there;
 *   2. today's role map (DECISIONS 48) — the trainer and office are refused
 *      every `money`, `price` and `roles` key; the owner role every `price` key;
 *   3. the design's §3 — key by key, its class, and its inertness (a §3
 *      *stored* key is inert; the only other inert keys are the 11-02 re-cut's).
 *
 * It prints the count of keys per class and of inert keys; no page restates
 * them by hand (r3-fable #11, r3-opus #12).
 *
 * **This file reads a document outside this repo.** Check 3 parses §3 of the
 * umbrella's `designs/fetchd-v1-technical-design.md` (one level above this
 * repo; override with `FETCHD_DESIGN_PATH`), because the design says the
 * registry's inert set is taken from §3's *Read by* column, not from a list
 * typed here (§2.1). A bare clone of `fetchd_backend` without the umbrella
 * FAILS this file, deliberately — it never skips: a check that passes when it
 * cannot find what it checks against is worthless in a gate (the same rule as
 * the clients' `FETCHD_REQUIRE_WIRE`).
 */

const STRUCTURAL = new Set(['id', 'location', 'updated_at', 'updated_by_staff_id']);
const PAYMENT_STRUCTURAL = new Set(['key', 'scope', 'value', 'updated_at', 'updated_by_staff_id']);

function drizzleTable(name: string): Table {
  const table = Object.values(schema).find(
    (value) => typeof value === 'object' && value !== null && getTableNameSafe(value) === name,
  );
  assert.ok(table !== undefined, `no Drizzle table ${name} in src/db/schema/schema.ts`);
  return table as Table;
}

function getTableNameSafe(value: object): string | undefined {
  try {
    return getTableName(value as Table);
  } catch {
    return undefined;
  }
}

function columnsOf(name: string): string[] {
  return Object.values(getTableColumns(drizzleTable(name))).map((c) => c.name);
}

describe('the registry against the Drizzle schema', () => {
  test('every settings column (bar the key and audit columns) has exactly one editable key', () => {
    for (const table of SETTINGS_TABLES) {
      if (table === 'payment_settings') continue; // key/value rows, checked below
      const editable = SETTINGS_REGISTRY.filter(
        (e) => isPatchable(e) && e.store.kind === 'column' && e.store.table === table,
      );
      for (const column of columnsOf(table).filter((c) => !STRUCTURAL.has(c))) {
        const keys = editable.filter((e) => e.store.kind === 'column' && e.store.column === column);
        assert.equal(
          keys.length,
          1,
          `${table}.${column}: ${keys.length} editable keys (${keys.map((k) => k.key).join(', ')})`,
        );
      }
    }
  });

  test('no key names a column, path or table that is not there', () => {
    for (const entry of SETTINGS_REGISTRY) {
      const { store } = entry;
      if (store.kind === 'column' || store.kind === 'path') {
        assert.ok(
          columnsOf(store.table).includes(store.column),
          `${entry.key} → ${store.table}.${store.column}`,
        );
        assert.ok(!STRUCTURAL.has(store.column), `${entry.key} names a structural column`);
      }
      if (store.kind === 'catalog') {
        assert.ok(columnsOf(store.table).length > 0, `${entry.key} → ${store.table}`);
      }
    }
    assert.deepEqual(columnsOf('payment_settings').sort(), [...PAYMENT_STRUCTURAL].sort());
  });

  test('every key is registered once, under its own domain', () => {
    const keys = SETTINGS_REGISTRY.map((e) => e.key);
    assert.equal(new Set(keys).size, keys.length, 'a key is registered twice');
    for (const entry of SETTINGS_REGISTRY) {
      assert.ok(entry.key.startsWith(`${entry.domain}.`), entry.key);
      assert.ok((SETTINGS_DOMAINS as readonly string[]).includes(entry.domain));
    }
  });

  test('the PATCH bodies are exactly the editable keys, and the wire pins them (staffSettings loads)', () => {
    for (const target of SETTINGS_TARGETS) {
      const fields = patchableFields(target);
      assert.ok(fields.length > 0, `${target.domain} accepts no key`);
    }
    const editable = SETTINGS_REGISTRY.filter(isPatchable).length;
    const accepted = SETTINGS_TARGETS.reduce((n, t) => n + patchableFields(t).length, 0);
    assert.equal(accepted, editable, 'an editable key is reachable from no path, or from two');
  });
});

describe("the class gate on today's roles (DECISIONS 48)", () => {
  const byClass = (cls: SettingClass) => SETTINGS_REGISTRY.filter((e) => e.class === cls);

  test('the trainer and office are refused every money, price and roles key, and pass every ops key', () => {
    for (const role of ['trainer', 'office'] as const satisfies readonly StaffRole[]) {
      for (const cls of ['money', 'price', 'roles'] as const) {
        for (const entry of byClass(cls))
          assert.equal(mayEditClass(role, entry.class), false, `${role} ${entry.key}`);
      }
      for (const entry of byClass('ops'))
        assert.equal(mayEditClass(role, entry.class), true, `${role} ${entry.key}`);
    }
  });

  test('every role, the owner included, is refused every price key (question 27 → (a))', () => {
    assert.ok(byClass('price').length > 0, 'no price key to refuse — the check would be vacuous');
    for (const role of [
      'owner-shanthi',
      'trainer',
      'office',
    ] as const satisfies readonly StaffRole[]) {
      for (const entry of byClass('price'))
        assert.equal(mayEditClass(role, entry.class), false, `${role} ${entry.key}`);
    }
  });

  test('the owner role passes ops, money and roles; no role edits a classless key', () => {
    for (const cls of ['ops', 'money', 'roles'] as const)
      assert.equal(mayEditClass('owner-shanthi', cls), true);
    for (const role of ['owner-shanthi', 'trainer', 'office'] as const)
      assert.equal(mayEditClass(role, null), false);
  });

  test('the counts, per class and inert', (t) => {
    const count = (pred: (e: (typeof SETTINGS_REGISTRY)[number]) => boolean) =>
      SETTINGS_REGISTRY.filter(pred).length;
    t.diagnostic(
      `registry: ${SETTINGS_REGISTRY.length} keys over ${SETTINGS_DOMAINS.length} domains`,
    );
    for (const cls of ['ops', 'money', 'price', 'roles'] as const) {
      t.diagnostic(`  class ${cls}: ${count((e) => e.class === cls)}`);
    }
    t.diagnostic(`  no class (catalog facts): ${count((e) => e.class === null)}`);
    t.diagnostic(
      `  inert: ${count((e) => e.inert !== false)} (stored ${count((e) => e.inert !== false && e.inert.kind === 'stored')}, deferred ${count((e) => e.inert !== false && e.inert.kind === 'deferred')})`,
    );
    for (const domain of SETTINGS_DOMAINS) {
      const mine = SETTINGS_REGISTRY.filter((e) => e.domain === domain);
      t.diagnostic(
        `  ${domain}: ${mine.length} keys, ${mine.filter((e) => e.inert !== false).length} inert`,
      );
    }
    assert.ok(SETTINGS_REGISTRY.length > 0);
  });
});

// ── the design's §3, key by key ──────────────────────────────────────────────

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DESIGN =
  process.env.FETCHD_DESIGN_PATH ??
  path.resolve(REPO_ROOT, '..', 'designs', 'fetchd-v1-technical-design.md');

/** §3 keys whose store has not landed at LG1, so they are not registered (400 unknown key). */
const NOT_LANDED: Readonly<Record<string, string>> = {
  'dog.evaluation_gated_categories': 'its column lands at M2.04',
  'cred.package_expiry_months': 'credit_packages.expiry_months lands at M4.05',
  'vax.service_min_age_weeks': 'M1.16 creates no column (DECISIONS 53, D7)',
  'rpt.event_price_per_dog_cents': 'M1.15 creates no column (D8)',
  'rpt.curriculum_levels_list': 'the curriculum_levels table is M9.03',
  'pay.auto_renew_enabled': 'no LG1 store (per package; contract notes D11)',
};

/** Keys the registry carries that §3 names no row for. */
/**
 * Keys whose registry class deliberately differs from §3's, each with the
 * ruling that overrides the design. The check below holds both ends: the
 * registry must carry the ruled class, and §3 must still say what the ruling
 * overrode (if §3 changes, the exception must be revisited, not kept).
 */
const CLASS_OVERRIDES: Readonly<
  Record<string, { design: SettingClass; ruled: SettingClass; why: string }>
> = {
  'pay.refund_any_role_limit_cents': {
    design: 'money',
    ruled: 'roles',
    why: 'DECISIONS 60: raising it widens who refunds money, and only the owner widens that (§2.1)',
  },
};

const DESIGN_ADDED: Readonly<Record<string, string>> = {
  'day.offerings': "E03's per-campus service document (M1.07, §2.1)",
};

/** The 11-02 re-cut (plan.json P01 deferred_arms): inert until P06, P07, P09. */
const RECUT_INERT = new Set([
  'dog.gate_card_on_file_enabled',
  'dog.gate_evaluation_enabled',
  'dog.gate_vaccines_enabled',
  'dog.gate_agreements_enabled',
  'dog.card_required_for_evaluation_booking_enabled',
  'dog.spay_neuter_required_by_age_months',
  'dog.spay_neuter_gated_service_list',
  'dog.staff_dog_exempt_gate_list',
  ...SETTINGS_REGISTRY.filter((e) => e.domain === 'vax').map((e) => e.key),
]);

interface DesignRow {
  key: string;
  cls: SettingClass | null;
  stored: boolean;
  dropped: boolean;
}

function readSection3(): DesignRow[] {
  assert.ok(
    fs.existsSync(DESIGN),
    `the design is not at ${DESIGN} — this test reads §3 from it (set FETCHD_DESIGN_PATH); a missing design is a failure, not a skip`,
  );
  const text = fs.readFileSync(DESIGN, 'utf8');
  const start = text.indexOf('## 3. Every setting and its seeded default');
  const end = text.indexOf('## 4. The migrations, in order');
  assert.ok(start >= 0 && end > start, 'cannot find §3 in the design');
  const domains = SETTINGS_DOMAINS.join('|');
  const rows: DesignRow[] = [];
  for (const line of text.slice(start, end).split('\n')) {
    const key = new RegExp(`^\\| \`((?:${domains})\\.[a-z0-9_]+)\` \\|`).exec(line)?.[1];
    if (key === undefined) continue;
    const cells = line.split(' | ').map((c) => c.trim());
    const readBy = (cells.at(-1) ?? '').replace(/\|$/, '').trim();
    const cls = (cells.at(-2) ?? '').replaceAll('*', '').trim();
    const seed = cells[1] ?? '';
    rows.push({
      key,
      cls: cls === '—' ? null : (cls as SettingClass),
      stored: readBy.startsWith('*stored'),
      dropped: readBy === '—' || /\*\*(dropped|retired)/.test(seed),
    });
  }
  return rows;
}

describe("the registry against the design's §3", () => {
  test('every §3 key of the thirteen domains is registered with §3’s class — or is dropped, or has no store yet', () => {
    const rows = readSection3();
    assert.ok(rows.length > 100, `parsed only ${rows.length} §3 rows`);
    const registry = new Map(SETTINGS_REGISTRY.map((e) => [e.key, e]));
    for (const row of rows) {
      const entry = registry.get(row.key);
      if (row.dropped || NOT_LANDED[row.key] !== undefined) {
        assert.equal(
          entry,
          undefined,
          `${row.key} is ${row.dropped ? 'dropped' : 'not landed'} but registered`,
        );
        continue;
      }
      assert.ok(entry !== undefined, `${row.key} is in §3 but not in the registry`);
      const override = CLASS_OVERRIDES[row.key];
      if (override !== undefined) {
        assert.equal(
          row.cls,
          override.design,
          `${row.key}: §3 no longer says ${override.design} — revisit ${override.why}`,
        );
        assert.equal(entry.class, override.ruled, `${row.key}: ${override.why}`);
        continue;
      }
      assert.equal(
        entry.class,
        row.cls,
        `${row.key}: registry class ${entry.class}, §3 ${row.cls}`,
      );
    }
    const inDesign = new Set(rows.map((r) => r.key));
    const extra = SETTINGS_REGISTRY.map((e) => e.key).filter((k) => !inDesign.has(k));
    assert.deepEqual(extra.sort(), Object.keys(DESIGN_ADDED).sort());
  });

  test('a §3 *stored* key is inert as stored; the only other inert keys are the re-cut’s, each deferred', () => {
    const stored = new Set(
      readSection3()
        .filter((r) => r.stored)
        .map((r) => r.key),
    );
    for (const entry of SETTINGS_REGISTRY) {
      if (stored.has(entry.key)) {
        assert.ok(
          entry.inert !== false && entry.inert.kind === 'stored',
          `${entry.key} is *stored* in §3 but not inert-stored`,
        );
      } else if (RECUT_INERT.has(entry.key)) {
        assert.ok(
          entry.inert !== false && entry.inert.kind === 'deferred',
          `${entry.key} is a re-cut key but not deferred`,
        );
      } else {
        assert.equal(
          entry.inert,
          false,
          `${entry.key} is inert, but §3 gives it a v1 reader and the re-cut does not name it`,
        );
      }
    }
  });
});

describe('fix round 1 — the registry rulings (DECISIONS 60, 62; Fable L4)', () => {
  const entry = (key: string) => {
    const found = SETTINGS_REGISTRY.find((e) => e.key === key);
    assert.ok(found !== undefined, key);
    return found;
  };

  test('D60: pay.refund_any_role_limit_cents is roles class — no money-only role edits it', () => {
    assert.equal(entry('pay.refund_any_role_limit_cents').class, 'roles');
    assert.equal(mayEditClass('owner-shanthi', 'roles'), true);
    assert.equal(mayEditClass('trainer', 'roles'), false);
    assert.equal(mayEditClass('office', 'roles'), false);
  });

  test('D62: eval.reeval_after_months_unseen is nullable (null switches the clock off, EVAL-53) and stays inert', () => {
    const reeval = entry('eval.reeval_after_months_unseen');
    assert.deepEqual(reeval.value, { type: 'integer', min: 1, nullable: true });
    assert.notEqual(reeval.inert, false);
  });

  test("L4: notif.quiet_hours_bypass_types is the wire's QuietHoursClass set, not free text", () => {
    const bypass = entry('notif.quiet_hours_bypass_types');
    assert.equal(bypass.value.type, 'enum-list');
    const values = bypass.value.type === 'enum-list' ? [...bypass.value.values].sort() : [];
    assert.deepEqual(values, [...NOTIFICATION_TYPES, 'closure', 'staff-reply'].sort());
  });
});

describe('fix round 2 — the role map fails closed (DECISIONS 71, adversary r2 L4)', () => {
  test('a role the map does not hold edits nothing, and asking never throws', () => {
    for (const role of ['manager', 'owner', '', 'constructor', '__proto__']) {
      for (const cls of ['ops', 'money', 'price', 'roles', null] as const) {
        assert.equal(mayEditClass(role as StaffRole, cls), false, `${role} ${cls}`);
      }
    }
  });
});
