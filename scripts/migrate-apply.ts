/**
 * `npm run migrate:apply -- <step.sql> --url <DATABASE_URL> --project <ref>`
 * (design §4 preamble; S01) — apply ONE step file to ONE database and log it.
 *
 *   --url <DATABASE_URL>   the target, explicitly. This script never imports
 *                          `src/env.ts` and reads no `.env` file, so it can only
 *                          touch the database you name on the command line.
 *                          Parsed once; a query string or fragment is refused,
 *                          and the client is built from the parsed host, port,
 *                          user, password and database — so it connects to the
 *                          database the project check read (DECISIONS 64).
 *   --project <ref>        must equal the Supabase project the URL points at
 *                          (`db.<ref>.supabase.co`, or `postgres.<ref>` on the
 *                          pooler), or `local` for localhost. A mismatch exits 1
 *                          before connecting.
 *   --redis-url <url>      required only for a step whose header declares
 *                          `-- migrate: invalidate-class-catalog`; refused up
 *                          front without it.
 *   --ca <path>            the CA for a non-local database (default:
 *                          certs/supabase-ca.crt). A non-local connection is
 *                          always verified TLS: nothing in the URL can turn
 *                          it off, because the URL may carry no parameters.
 *   --applied-by <name>    recorded in migrations_applied (default: OS user).
 *   --skip-census <table>  waive the step's `census-empty <table>` gate (M1.19's
 *                          on `staff`). Refused unless `--project local`: dev
 *                          takes M1.19's cast on its seeded roster, while
 *                          production and the rehearsal's production-shaped
 *                          copy must meet the gate (design.md:2122-2128).
 *                          Comma-separate several tables.
 *
 * A step's leading comment lines (before its first line of SQL) are for its
 * directives and its description. They are directive-only for one family of
 * words: a line there that opens with `migrate`/`migration`, `census-empty`,
 * `no-transaction` or `invalidate-class-catalog` in any spelling but the exact
 * `-- migrate: <directive>` is refused, on purpose, as a possible misspelt
 * directive ("-- Migration notes: …" included). Put that prose below the first
 * line of SQL, or start it with another word (`src/db/migrate.ts`).
 *
 * Note the `--` after the script name: without it npm keeps `--url` and
 * `--project` for itself and passes only their values, so the script refuses
 * a call whose flags npm swallowed rather than guess which value was which.
 *
 * Everything the runner decides — the header, the transaction-control refusal,
 * the one-transaction apply with the log row last, the actor — lives in
 * `src/db/migrate.ts`, whose header comment is the runner's documentation.
 *
 * Exit codes: 0 applied (and the cache cleared, if declared); 1 refused or
 * failed (the message says whether anything committed); 2 bad usage.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Redis } from 'ioredis';
import pg from 'pg';
import { applyStep, checkProject, clientConfig, parseStep } from '../src/db/migrate.js';
import { unlinkMatching } from '../src/lib/redisPattern.js';

interface Args {
  stepPath: string;
  url: string;
  project: string;
  redisUrl?: string;
  ca: string;
  appliedBy: string;
  skipCensus: string[];
}

function usage(message: string): never {
  process.stderr.write(
    `migrate:apply: ${message}\n` +
      'usage: npm run migrate:apply -- <step.sql> --url <DATABASE_URL> --project <ref> ' +
      '[--redis-url <url>] [--ca <path>] [--applied-by <name>] [--skip-census <table>]\n',
  );
  process.exit(2);
}

function parseArgs(argv: readonly string[]): Args {
  // npm consumes `--url x` / `--project y` when they are not after `--`, sets
  // npm_config_url / npm_config_project, and passes the bare values on.
  if (process.env.npm_config_url !== undefined || process.env.npm_config_project !== undefined) {
    usage(
      'npm swallowed the flags — put `--` after the script name: npm run migrate:apply -- <step.sql> --url … --project …',
    );
  }
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg.startsWith('--')) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) usage(`${arg} needs a value`);
      flags.set(arg.slice(2), value);
      i += 1;
    } else {
      positional.push(arg);
    }
  }
  const known = new Set(['url', 'project', 'redis-url', 'ca', 'applied-by', 'skip-census']);
  for (const name of flags.keys()) if (!known.has(name)) usage(`unknown flag --${name}`);
  if (positional.length !== 1) usage('exactly one step file is applied per run');
  const url = flags.get('url');
  const project = flags.get('project');
  if (url === undefined) usage('--url is required');
  if (project === undefined) usage('--project is required');
  const redisUrl = flags.get('redis-url');
  const skipCensus = (flags.get('skip-census') ?? '')
    .split(',')
    .map((table) => table.trim())
    .filter((table) => table.length > 0);
  if (skipCensus.length > 0 && project !== 'local') {
    usage(
      `--skip-census is refused for project '${project}': only --project local (dev) may waive a ` +
        'census gate; production and the rehearsal meet it (design.md:2122-2128)',
    );
  }
  return {
    stepPath: positional[0] as string,
    url,
    project,
    ...(redisUrl === undefined ? {} : { redisUrl }),
    ca: flags.get('ca') ?? fileURLToPath(new URL('../certs/supabase-ca.crt', import.meta.url)),
    appliedBy: flags.get('applied-by') ?? os.userInfo().username,
    skipCensus,
  };
}

function fail(message: string): never {
  process.stderr.write(`migrate:apply: ${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const checked = checkProject(args.url, args.project);
  if (!checked.ok) fail(checked.reason);
  const { target } = checked;

  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(args.stepPath);
  } catch (err) {
    fail(`cannot read ${args.stepPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = parseStep(path.basename(args.stepPath), bytes);
  if (!parsed.ok) fail(parsed.reason);
  const { step } = parsed;

  const ca = target.project === 'local' ? undefined : fs.readFileSync(args.ca, 'utf8');
  const client = new pg.Client(clientConfig(target, ca));

  const redis =
    args.redisUrl === undefined
      ? undefined
      : new Redis(args.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });

  process.stdout.write(
    `migrate:apply ${step.stepId} (${step.fileName})\n` +
      `  project  ${args.project}\n` +
      `  sha256   ${step.sha256}\n` +
      `  header   ${step.directives.size === 0 ? '(none)' : [...step.directives].join(', ')}\n` +
      step.censusEmpty
        .map((table) =>
          args.skipCensus.includes(table)
            ? `  census   SKIPPED: ${table} (--skip-census, project local)\n`
            : `  census   ${table} must be empty, or nothing runs\n`,
        )
        .join(''),
  );

  await client.connect();
  try {
    const result = await applyStep(client, step, {
      appliedBy: args.appliedBy,
      skipCensus: args.skipCensus,
      ...(redis === undefined
        ? {}
        : { invalidateCache: (pattern: string) => unlinkMatching(redis, pattern) }),
    });
    if (!result.ok) fail(result.reason);
    process.stdout.write(
      `  applied  ${result.stepId}, logged in migrations_applied` +
        (result.cacheCleared ? '; groupclasses:* cleared' : '') +
        '\n',
    );
  } finally {
    await client.end();
    redis?.disconnect();
  }
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err));
});
