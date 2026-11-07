import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { InjectOptions } from 'fastify';
import { bypassHeaderEnabled } from '../../src/env.js';
import { CURRICULUM_PROGRAMS } from '../../src/lib/alumni.js';
import { buildApp } from '../../src/server.js';
import { FIXTURE_IDS } from './_fixture.js';
import { SKIP_WHEN_NO_DB, registerFixtureHooks } from './_harness.js';

/**
 * The other half of the id pin (DECISIONS 132(b)). `test/routeIdSpelling.test.ts` fails
 * on any `.uuid` in `src/routes/` or `src/lib/` outside `uuidId()`, so it cannot see an
 * id that never says `.uuid`: a bare `z.string()`, or a param nothing parses. This asks
 * the running app instead. It sends a non-uuid in each path param of every route on the
 * real `buildApp()`, as an owner and as staff, through the real auth guard, and each
 * answer must be that param's uuid refusal or a 403.
 *
 * The walk is Fastify's own route table, so a new route is covered the moment it is
 * registered, with no list to add it to. A param is a uuid unless `NOT_UUID_PARAMS`
 * names it on that exact path, so a new param is checked by default, and a stale entry
 * fails. A route file's literal path missing from the table fails too.
 *
 * Nothing here can write: a parse refuses before a route reads anything, and a route
 * that does not parse reaches only the fixture's database on :5433 (`_dbGuard.ts`).
 *
 * This reads an answer, not a schema, so whatever refuses in uuid's words passes here
 * without lowercasing. What still passes both halves, each run in
 * `units/P14/evidence/backend/fix1/`:
 *   - a hand `.regex` that refuses in uuid's words: it parses and does not lowercase;
 *   - a destructured `uuid` (`const { uuid } = z.string()`): no access the pin reads;
 *   - a bare `z.string()` id in a body or a query: this fires path params only.
 */

registerFixtureHooks();

const ROUTES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'routes');
const NOT_A_UUID = 'not-a-uuid';
const OWNER = `owner:${FIXTURE_IDS.ownerId}`;
// The staff role every role gate passes (STAFF-09), so a gate cannot stand in for a parse.
const STAFF = `staff:${FIXTURE_IDS.staffShanthiId}:owner`;

/** The path params that are not uuids. Each route parses its own: an enum, a date, a key. */
const NOT_UUID_PARAMS: Readonly<Record<string, readonly string[]>> = {
  // The two enum paths (`staffSettings.ts`): `SETTINGS_DOMAINS` and `LOCATIONS`.
  '/staff/settings/:domain': ['domain'],
  '/staff/settings/:domain/:location': ['domain', 'location'],

  '/staff/day-capacity/:location/:date': ['location', 'date'],
  '/staff/cancel-window/:category': ['category'],
  '/staff/dogs/:dogId/completed-programs/:program': ['program'],
  '/credit-packages/:key/purchase': ['key'],
  '/staff/credit-packages/:key': ['key'],
  '/group-classes/:key': ['key'],
  '/group-classes/:key/cohorts': ['key'],
  '/device-tokens/:token': ['token'],
};

/** What fills a `NOT_UUID_PARAMS` param on a path that also holds a uuid. */
const SAMPLE_VALUES: Readonly<Record<string, string>> = { program: CURRICULUM_PROGRAMS[0] };

const app = buildApp();
after(async () => {
  await app.close();
});

type RouteMethod = NonNullable<InjectOptions['method']>;

interface Route {
  path: string;
  methods: RouteMethod[];
}

/**
 * `printRoutes` is a radix tree, so a line can be part of a word (`/me`, then
 * `mberships`) and a path is every ancestor's text joined. A line this cannot read
 * fails, so a new tree format is a red test and not a shorter walk.
 */
async function routeTable(): Promise<Route[]> {
  await app.ready();
  const ancestors: string[] = [];
  const routes: Route[] = [];
  for (const line of app.printRoutes({ commonPrefix: false }).split('\n')) {
    if (line.trim() === '') continue;
    const read = /^([│ ]*)[├└]── (\S+)(?: \(([^)]*)\))?$/.exec(line);
    assert.ok(read !== null, `a route-table line this walk cannot read: ${JSON.stringify(line)}`);
    const depth = (read[1] ?? '').length / 4;
    ancestors.length = depth;
    ancestors[depth] = read[2] ?? '';
    if (read[3] !== undefined) {
      routes.push({ path: ancestors.join(''), methods: read[3].split(', ') as RouteMethod[] });
    }
  }
  return routes;
}

function paramsOf(path: string): string[] {
  return [...path.matchAll(/:(\w+)/g)].map((match) => match[1] ?? '');
}

/** Every literal path a route file registers: a second reading of the table's contents. */
function literalPaths(): string[] {
  return readdirSync(ROUTES_DIR, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts'))
    .flatMap((file) => {
      const source = readFileSync(join(ROUTES_DIR, file), 'utf8');
      const registered = source.matchAll(
        /\.(?:get|post|put|patch|delete)(?:<[^>]*>)?\(\s*'(\/[^']*)'/g,
      );
      return [...registered].map((match) => match[1] ?? '');
    });
}

/** The two shapes a route's refusal takes: `id: <words>`, or a raw ZodError's JSON. */
function isUuidRefusal(param: string, statusCode: number, message: string): boolean {
  if (statusCode !== 400 || !/uuid/i.test(message)) return false;
  return (
    new RegExp(`\\b${param}: `).test(message) ||
    message.replace(/\s+/g, '').includes(`"path":["${param}"]`)
  );
}

/** `path` with a non-uuid in `param` and a valid value in every other param. */
function urlWithBad(path: string, param: string): string {
  return path.replace(/:(\w+)/g, (_, name: string) =>
    name === param ? NOT_A_UUID : (SAMPLE_VALUES[name] ?? FIXTURE_IDS.dog1Id),
  );
}

test(
  'the walk holds every route: the table reads whole and matches the route files',
  SKIP_WHEN_NO_DB,
  async () => {
    const routes = await routeTable();
    const paths = new Set(routes.map((route) => route.path));

    // A walk that read nothing would pass everything below.
    assert.ok(paths.has('/dogs/:id/bookings'), `the walk read: ${[...paths].join(' ')}`);

    const notRoutes = routes
      .filter((route) => paramsOf(route.path).length > 0)
      .flatMap((route) =>
        route.methods
          .filter((method) => !app.hasRoute({ method, url: route.path }))
          .map((method) => `${method} ${route.path}`),
      );
    assert.deepEqual(notRoutes, [], 'the walk rebuilt a path Fastify does not hold');

    const unwalked = [...new Set(literalPaths())].filter((path) => !paths.has(path));
    assert.deepEqual(unwalked, [], 'a route file registers a path missing from the walk');

    const stale = Object.entries(NOT_UUID_PARAMS).flatMap(([path, params]) =>
      params
        .filter((param) => !paramsOf(path).includes(param) || !paths.has(path))
        .map((param) => `${path} :${param}`),
    );
    assert.deepEqual(stale, [], 'NOT_UUID_PARAMS names a param the table no longer holds');
  },
);

test(
  'every path param is refused by its uuid parse unless it is named as not a uuid',
  SKIP_WHEN_NO_DB,
  async (t) => {
    assert.equal(bypassHeaderEnabled, true, 'this drives the real guard through X-Dev-Principal');
    const routes = await routeTable();

    const checked: string[] = [];
    const failures: string[] = [];
    for (const { path, methods } of routes) {
      const uuidParams = paramsOf(path).filter((name) => !NOT_UUID_PARAMS[path]?.includes(name));
      for (const method of methods.filter((m) => m !== 'HEAD' && m !== 'OPTIONS')) {
        for (const param of uuidParams) {
          const site = `${method} ${path} :${param}`;
          checked.push(site);
          let refused = false;
          for (const principal of [OWNER, STAFF]) {
            const res = await app.inject({
              method,
              url: urlWithBad(path, param),
              headers: { 'x-dev-principal': principal, 'idempotency-key': `id-param-${site}` },
              ...(method === 'GET' || method === 'DELETE' ? {} : { payload: {} }),
            });
            const message = (res.json() as { error?: { message?: string } }).error?.message ?? '';
            const isRefusal = isUuidRefusal(param, res.statusCode, message);
            refused ||= isRefusal;
            if (!isRefusal && res.statusCode !== 403) {
              failures.push(`${site} as ${principal.split(':')[0]}: ${res.statusCode} ${message}`);
            }
          }
          if (!refused) failures.push(`${site}: no principal drew its uuid refusal`);
        }
      }
    }

    t.diagnostic(`${checked.length} uuid path params checked across ${routes.length} table paths`);
    assert.ok(checked.includes('GET /dogs/:id/bookings :id'), `checked: ${checked.join('\n')}`);
    assert.deepEqual(failures, [], `${failures.length} of ${checked.length} params not refused`);
  },
);
