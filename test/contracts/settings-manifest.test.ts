import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { Principal } from '../../src/auth/principal.js';
import {
  LOCATIONS,
  type GetStaffSettingsManifestResponse,
  type PaymentSettingWire,
  type SettingsManifestEntryWire,
} from '../../src/contracts/wire.js';
import { SETTINGS_REGISTRY } from '../../src/lib/settingsRegistry.js';
import {
  SETTINGS_TARGETS,
  patchableFields,
  registerStaffSettingsRoute,
} from '../../src/routes/staffSettings.js';
import {
  FIXTURE_MANAGER_PRINCIPAL,
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_OWNER_ROLE_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';

/**
 * `GET /staff/settings/manifest` `[staff]` (wire 2.0.0; build DECISIONS 85):
 * every registry key, with `editable` computed for the caller. Its one promise
 * is that `editable` is the PATCH's own answer: for every key and every role,
 * `editable` is true exactly when a PATCH of that key alone, with a valid
 * value, is NOT refused 403 `refused_keys` or 422 `setting_inert`. That is
 * proven here against the real routes, key by key, role by role. The valid
 * value is the key's current value (read from its domain GET), so a 200
 * writes the value it found and changes nothing but the audit pair.
 */

registerFixtureHooks();

const ROLES: ReadonlyArray<[string, Principal]> = [
  ['owner', FIXTURE_OWNER_ROLE_PRINCIPAL],
  ['manager', FIXTURE_MANAGER_PRINCIPAL],
  ['trainer', FIXTURE_STAFF_PRINCIPAL],
];

function appAs(principal: Principal): FastifyInstance {
  const { app, authenticate } = makeContractApp(principal);
  registerStaffSettingsRoute(app, { authenticate });
  return app;
}

/** The settings path a `read` names: the bare path, or the first campus. */
function pathOf(entry: SettingsManifestEntryWire): string {
  const tier = entry.read?.tier ?? 'global';
  return tier === 'campus'
    ? `/staff/settings/${entry.domain}/${LOCATIONS[0]}`
    : `/staff/settings/${entry.domain}`;
}

/** The current value of `field` on a domain GET, in PATCH body form. */
function currentValue(domain: string, body: unknown, field: string): unknown {
  if (domain !== 'pay') return (body as Record<string, unknown>)[field];
  const rows = (body as PaymentSettingWire[]).filter((r) => r.key === field);
  assert.ok(rows.length > 0, `pay has no ${field} row`);
  // The one per-scope key's body is a scope → value map; every other key has one global row.
  return rows.length === 1 && rows[0]?.scope === 'global'
    ? rows[0].value
    : Object.fromEntries(rows.map((r) => [r.scope, r.value]));
}

test(
  'any staff role reads the manifest; an owner (family) principal is 403; PATCH /staff/settings/manifest is 400',
  SKIP_WHEN_NO_DB,
  async () => {
    for (const [, principal] of ROLES) {
      const res = await appAs(principal).inject({ method: 'GET', url: '/staff/settings/manifest' });
      assert.equal(res.statusCode, 200, res.body);
      const { entries } = res.json<GetStaffSettingsManifestResponse>();
      assert.deepEqual(
        entries.map((e) => e.key),
        SETTINGS_REGISTRY.map((e) => e.key),
      );
    }
    const owner = await appAs(FIXTURE_OWNER_PRINCIPAL).inject({
      method: 'GET',
      url: '/staff/settings/manifest',
    });
    assert.equal(owner.statusCode, 403, owner.body);
    const patch = await appAs(FIXTURE_OWNER_ROLE_PRINCIPAL).inject({
      method: 'PATCH',
      url: '/staff/settings/manifest',
      headers: { 'idempotency-key': randomUUID(), 'content-type': 'application/json' },
      payload: JSON.stringify({ x: 1 }),
    });
    assert.equal(patch.statusCode, 400, patch.body);
  },
);

test(
  'every PATCH body key is exactly one `here` entry of the manifest, and no other entry has a field',
  SKIP_WHEN_NO_DB,
  async () => {
    const res = await appAs(FIXTURE_STAFF_PRINCIPAL).inject({
      method: 'GET',
      url: '/staff/settings/manifest',
    });
    assert.equal(res.statusCode, 200, res.body);
    const { entries } = res.json<GetStaffSettingsManifestResponse>();
    const here = entries
      .filter((e) => e.editor.kind === 'here')
      .map((e) => `${pathOf(e)} ${e.read?.field}`)
      .sort();
    const bodies = SETTINGS_TARGETS.flatMap((t) =>
      patchableFields(t).map(
        (f) =>
          `${t.location === null ? `/staff/settings/${t.domain}` : `/staff/settings/${t.domain}/${t.location}`} ${f}`,
      ),
    ).sort();
    assert.deepEqual(here, bodies);
  },
);

test(
  'editable agrees with the PATCH, for every key and every role: true iff a PATCH of the key alone is not refused 403 or 422 setting_inert',
  SKIP_WHEN_NO_DB,
  async () => {
    let patched = 0;
    for (const [role, principal] of ROLES) {
      const app = appAs(principal);
      const manifest = await app.inject({ method: 'GET', url: '/staff/settings/manifest' });
      assert.equal(manifest.statusCode, 200, manifest.body);
      const { entries } = manifest.json<GetStaffSettingsManifestResponse>();
      assert.equal(entries.length, SETTINGS_REGISTRY.length);
      const reads = new Map<string, unknown>();
      for (const entry of entries) {
        const where = `${entry.key} for the ${role}`;
        if (entry.editor.kind !== 'here') {
          // No PATCH body names this key: it is edited through another key or another route.
          assert.equal(entry.editable, false, where);
          continue;
        }
        const field = (entry.read as { field: string }).field;
        const path = pathOf(entry);
        if (!reads.has(path)) {
          const got = await app.inject({ method: 'GET', url: path });
          assert.equal(got.statusCode, 200, `${path}: ${got.body}`);
          reads.set(path, got.json());
        }
        const value = currentValue(entry.domain, reads.get(path), field);
        const res = await app.inject({
          method: 'PATCH',
          url: path,
          headers: { 'idempotency-key': randomUUID(), 'content-type': 'application/json' },
          payload: JSON.stringify({ [field]: value }),
        });
        patched += 1;
        const code =
          res.statusCode === 200 ? 'ok' : res.json<{ error: { code: string } }>().error.code;
        const refused =
          (res.statusCode === 403 && code === 'forbidden') ||
          (res.statusCode === 422 && code === 'setting_inert');
        assert.ok(
          res.statusCode === 200 || refused,
          `${where}: the current value was not a valid PATCH (${res.statusCode} ${res.body})`,
        );
        assert.equal(
          entry.editable,
          !refused,
          `${where}: editable ${entry.editable}, PATCH ${res.statusCode} ${code}`,
        );
      }
    }
    assert.ok(patched >= 3 * 100, `only ${patched} PATCHes ran`);
  },
);

// P03 fix 1, item 11 (Opus L5; DECISIONS 93): the served note says what is
// true — `POST /staff/rates` accepts an evaluation rate from the owner or a
// manager (design.md:2089-2090; DECISIONS 74 X6) — never "no route accepts it".
test(
  "eval.price_cents's served note is true: POST /staff/rates edits it, owner and manager",
  SKIP_WHEN_NO_DB,
  async () => {
    const res = await appAs(FIXTURE_STAFF_PRINCIPAL).inject({
      method: 'GET',
      url: '/staff/settings/manifest',
    });
    assert.equal(res.statusCode, 200, res.body);
    const entry = res
      .json<GetStaffSettingsManifestResponse>()
      .entries.find((e) => e.key === 'eval.price_cents');
    assert.ok(entry !== undefined);
    assert.equal(entry.editor.kind, 'elsewhere');
    const note = entry.editor.kind === 'elsewhere' ? entry.editor.note : '';
    assert.match(note, /POST \/staff\/rates/);
    assert.match(note, /owner and manager/);
    assert.match(note, /seed/);
    assert.doesNotMatch(note, /no route accepts/);
    assert.equal(entry.editable, false, 'a price stays read-only in the settings editor');
  },
);
