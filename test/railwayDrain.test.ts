import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * LR10-a (brief LR10; design A2 FM2; Fable's contract read N6): Railway's drain, the time from
 * SIGTERM to SIGKILL, lives in `railway.json` as `deploy.drainingSeconds`, at least 15 s: the
 * push's 10 s abort plus 5 s, above the API's own 12 s shutdown bound
 * (`src/realtime/shutdown.ts`). No `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` variable is used.
 *
 * Its type is the one `railway.schema.json` (which `railway.json` names in `$schema`) gives it:
 * `deploy.drainingSeconds: anyOf [{type: number, minimum: 0}, {type: null}]` (read 2026-11-19
 * from https://railway.com/railway.schema.json). The docs' example writes `"10"`, a string; the
 * schema does not take one, so this pins a number.
 *
 * What no test can prove: that Railway honours it (the device check sends a reply during a
 * restart; production's smoke is the runbook's §11.5).
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface RailwayConfig {
  $schema?: unknown;
  deploy?: { drainingSeconds?: unknown };
}

const config = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'railway.json'), 'utf-8'),
) as RailwayConfig;

test('railway.json names the schema whose type this test pins', () => {
  assert.equal(config.$schema, 'https://railway.com/railway.schema.json');
});

test('railway.json sets deploy.drainingSeconds, as a number, of at least 15', () => {
  const value = config.deploy?.drainingSeconds;
  assert.equal(typeof value, 'number', `deploy.drainingSeconds is ${JSON.stringify(value)}`);
  assert.ok((value as number) >= 15, `deploy.drainingSeconds is ${String(value)}, under 15`);
});
