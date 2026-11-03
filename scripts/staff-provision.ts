/**
 * `npm run staff:provision -- --project <ref> …` — the only writer of person
 * `staff` rows (design §2.1:1969-2045; P02). Four modes:
 *
 *   --roster <file.json> --portal-origin <origin> [--yes] [--last-owner]
 *                          a roster run: create or adopt every staffer on
 *                          the roster; --yes confirms role changes;
 *                          --last-owner lets a role change demote the last
 *                          live owner
 *   --link <email> --portal-origin <origin>
 *                          re-mint one set-password link
 *   --expire <email> --yes [--last-owner]
 *                          off-board one staffer (without --yes, print the
 *                          plan and stop); --last-owner lets the last live
 *                          owner go
 *   --rehire <email> --roster <file.json> --yes
 *                          bring one back, her role from the roster
 *
 *   --project <ref>        REQUIRED: must equal the ref in SUPABASE_URL's host
 *                          and in DATABASE_URL (`local` for localhost), or the
 *                          run stops before any call, naming both
 *   --ca <path>            the CA for a non-local database (default
 *                          certs/supabase-ca.crt; always verified TLS)
 *
 * It reads three variables and nothing else — DATABASE_URL, SUPABASE_URL,
 * SUPABASE_SERVICE_ROLE_KEY — from the process environment (no .env file is
 * loaded: `.env` points at production, so the operator names the target), and
 * never imports `src/env.ts`, whose schema requires every server secret.
 * SUPABASE_URL is https unless its host is loopback (the key rides every call).
 * DATABASE_URL is parsed once, may carry no query string, and a non-local
 * database is reached over verified TLS only (the migration runner's rules).
 *
 * The roster file is a JSON list of staffers:
 *   [{ "email": "amber@…", "name": "Amber", "role": "manager",
 *      "home_locations": ["bentonville"], "responder": "default" }, …]
 * `role` is owner | manager | trainer; `home_locations` a non-empty set of
 * `locations` slugs; `responder` (optional) default | backup, both or neither.
 *
 * Exit codes: 0 done; 1 refused or failed (the output says what was written);
 * 2 bad usage.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { makeAdminClient } from '../src/auth/adminClient.js';
import {
  checkProjectRefs,
  parseRoster,
  runExpire,
  runLink,
  runRehire,
  runRoster,
  type RosterEntry,
} from '../src/auth/staffProvision.js';
import { clientConfig, resolveTarget } from '../src/db/migrate.js';

const USAGE =
  'usage: npm run staff:provision -- --project <ref> ' +
  '(--roster <file> --portal-origin <origin> [--yes] [--last-owner] | --link <email> --portal-origin <origin> | ' +
  '--expire <email> --yes [--last-owner] | --rehire <email> --roster <file> --yes) [--ca <path>]';

function usage(message: string): never {
  process.stderr.write(`staff:provision: ${message}\n${USAGE}\n`);
  process.exit(2);
}

function fail(message: string): never {
  process.stderr.write(`staff:provision: ${message}\n`);
  process.exit(1);
}

const VALUE_FLAGS = new Set([
  'project',
  'roster',
  'portal-origin',
  'link',
  'expire',
  'rehire',
  'ca',
]);

function parseArgs(argv: readonly string[]): {
  flags: Map<string, string>;
  yes: boolean;
  lastOwner: boolean;
} {
  const flags = new Map<string, string>();
  let yes = false;
  let lastOwner = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === '--yes') {
      yes = true;
      continue;
    }
    if (arg === '--last-owner') {
      lastOwner = true;
      continue;
    }
    if (!arg.startsWith('--') || !VALUE_FLAGS.has(arg.slice(2))) usage(`unknown argument '${arg}'`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) usage(`${arg} needs a value`);
    flags.set(arg.slice(2), value);
    i += 1;
  }
  return { flags, yes, lastOwner };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    usage(
      `${name} is not set (this script reads DATABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)`,
    );
  }
  return value;
}

/** `scheme://host[:port]` exactly — what the set-password redirect is built on. */
function portalOriginOf(raw: string | undefined, project: string): string {
  if (raw === undefined) usage('--portal-origin is required to mint a set-password link');
  let origin: string;
  try {
    origin = new URL(raw).origin;
  } catch {
    usage(`--portal-origin '${raw}' is not a URL`);
  }
  if (origin !== raw)
    usage(`--portal-origin '${raw}' is not an exact origin (no path, no trailing slash)`);
  if (project !== 'local' && !origin.startsWith('https:')) {
    usage(`--portal-origin must be https for project '${project}'`);
  }
  return origin;
}

function readRoster(file: string | undefined): RosterEntry[] {
  if (file === undefined) usage('--roster <file.json> is required for this mode');
  let json: unknown;
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    fail(`cannot read the roster ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = parseRoster(json);
  if (!parsed.ok) fail(`refused: ${parsed.reason}. Nothing was called.`);
  return parsed.roster;
}

async function main(): Promise<void> {
  const { flags, yes, lastOwner } = parseArgs(process.argv.slice(2));
  const databaseUrl = requiredEnv('DATABASE_URL');
  const supabaseUrl = requiredEnv('SUPABASE_URL');
  const serviceRoleKey = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');

  const project = flags.get('project');
  if (project === undefined) usage('--project <ref> is required');
  const modes = ['link', 'expire', 'rehire'].filter((m) => flags.has(m));
  if (modes.length > 1) usage(`one mode per run (got --${modes.join(' and --')})`);

  const refs = checkProjectRefs(supabaseUrl, databaseUrl, project);
  if (!refs.ok) fail(refs.reason);

  const target = resolveTarget(databaseUrl);
  if (!target.ok) fail(target.reason);
  const caPath =
    flags.get('ca') ?? fileURLToPath(new URL('../certs/supabase-ca.crt', import.meta.url));
  const ca = target.project === 'local' ? undefined : fs.readFileSync(caPath, 'utf8');

  // Everything that can be refused without a call is refused above or here.
  const mode = modes[0] ?? 'roster';
  const roster = mode === 'roster' || mode === 'rehire' ? readRoster(flags.get('roster')) : [];
  const portalOrigin =
    mode === 'roster' || mode === 'link' ? portalOriginOf(flags.get('portal-origin'), project) : '';

  const db = new pg.Client(clientConfig(target, ca));
  const admin = makeAdminClient(supabaseUrl, serviceRoleKey);
  const out = (line: string) => process.stdout.write(`${line}\n`);
  process.stdout.write(`staff:provision ${mode} — project ${project}\n`);

  await db.connect();
  let code: number;
  try {
    const deps = { admin, db, out };
    if (mode === 'link') code = await runLink(deps, flags.get('link') as string, { portalOrigin });
    else if (mode === 'expire') {
      code = await runExpire(deps, flags.get('expire') as string, { confirm: yes, lastOwner });
    } else if (mode === 'rehire') {
      code = await runRehire(deps, flags.get('rehire') as string, roster, { confirm: yes });
    } else code = await runRoster(deps, roster, { portalOrigin, confirm: yes, lastOwner });
  } finally {
    await db.end();
  }
  process.exit(code);
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err));
});
