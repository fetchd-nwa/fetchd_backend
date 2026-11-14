/**
 * `npm run db:dev:check` — is the dev DB actually the one `seed-dev.ts` builds?
 *
 * WHY THIS EXISTS. A drifted dev database is invisible at query time. Every row
 * you ask about answers truthfully; it is the ABSENT rows that mislead, and you
 * only notice those if you already suspected them. On 2026-08-01 this DB held 2
 * of the 4 seeded dogs and none of the boarding bookings, and reading it
 * produced two confident, wrong conclusions about notification fixtures that
 * were in fact correct. The fixtures were fine. The database was old. Nothing in
 * the output distinguished those two worlds.
 *
 * So: before diagnosing ANYTHING against dev data — a "missing" row, a fixture
 * that "lies", a screen that "has no data" — run this. If it fails, the finding
 * is about the database, not the code.
 *
 * HOW IT STAYS HONEST. It walks the `SEED` manifest in `seed-dev.ts` rather than
 * a hand-written list, so an id added there is covered here for free. Ids are
 * mapped to tables by their uuid prefix (the seed gives each entity family a
 * distinctive one), and an UNRECOGNISED prefix is a hard failure rather than a
 * skip — a check that silently stops covering things is worse than no check.
 *
 * STRUCTURE FIRST (P21 B-2; DECISIONS 264(c), 265(c)). Rows alone read "fresh" on a
 * database with every seeded row and an old schema: on 2026-11-12 dev lacked
 * `checkin_events` and still held P20's dropped attendance columns, and this check said
 * "fresh, 55 rows". So before any row it compares the tables, columns and enum labels
 * `schema.sql` creates, parsed from the file at run time, with the database's catalog,
 * both ways (`scripts/schema-structure.ts`). A structural difference is STALE and ends
 * the check: reseeding cannot fix it, and a stale schema's rows are not worth reading.
 *
 * IT ONLY READS, AND ONLY A LOCAL DATABASE. Every statement runs in one
 * `BEGIN TRANSACTION READ ONLY`, rolled back: catalog SELECTs and row SELECTs, no temp
 * table, no write of any kind. `.env` holds the production URL and only `.env.local`
 * shadows it, so a DATABASE_URL whose host is not localhost / 127.0.0.1 / ::1 (or a
 * production or staging NODE_ENV) is refused before a connection opens, as `seed-dev`
 * refuses. The first line names host, port and database, never credentials.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { PoolClient } from 'pg';
import { SEED } from './seed-ids.js';
import {
  parseSchemaStructure,
  readDatabaseStructure,
  structureDifferences,
} from './schema-structure.js';
import { env } from '../src/env.js';

const SCHEMA_SQL = fileURLToPath(new URL('../.claude/backend/schema.sql', import.meta.url));
const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Manifest KEY-name prefix → the table that id lives in.
 *
 * Keyed by name, not by uuid prefix: `seed-dev` reuses the `e0e70000` uuid
 * family for both `eventYappyHookId` and `rsvpJordanYappyId`, which live in
 * different tables. The first cut of this check mapped by uuid and reported the
 * RSVP as a missing event — a false "stale database" from the very tool written
 * to stop false "stale database" conclusions. Names disambiguate; uuids don't.
 *
 * Longest match wins, so `paymentMethod` beats nothing and `rsvp` never gets
 * swallowed by `request`.
 */
const TABLE_BY_KEY_PREFIX: Readonly<Record<string, string>> = {
  staff: 'staff',
  owner: 'owners',
  dog: 'dogs',
  booking: 'bookings',
  thread: 'threads',
  msg: 'messages',
  paymentMethod: 'payment_methods',
  invoice: 'invoices',
  ann: 'announcements',
  cohort: 'cohorts',
  charge: 'charges',
  order: 'orders',
  lot: 'credit_ledger',
  request: 'pending_requests',
  event: 'events',
  rsvp: 'event_rsvps',
};

/** The table for a manifest key, by longest matching name prefix. */
function tableForKey(key: string): string | undefined {
  const match = Object.keys(TABLE_BY_KEY_PREFIX)
    .filter((prefix) => key.startsWith(prefix))
    .sort((a, b) => b.length - a.length)[0];
  return match === undefined ? undefined : TABLE_BY_KEY_PREFIX[match];
}

interface Missing {
  key: string;
  id: string;
  table: string;
}

/** `host:port/database` of a URL, and whether the host is this machine. Never credentials. */
function describeTarget(rawUrl: string): { where: string; local: boolean } {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { where: '(unparseable DATABASE_URL)', local: false };
  }
  return {
    where: `${url.hostname}:${url.port || '5432'}${url.pathname}`,
    local: LOCAL_HOSTS.has(url.hostname),
  };
}

/** The check, on one read-only transaction; returns the exit code. */
async function check(client: PoolClient): Promise<number> {
  const expected = parseSchemaStructure(readFileSync(SCHEMA_SQL, 'utf8'));
  const actual = await readDatabaseStructure((text) => client.query(text));
  const differences = structureDifferences(expected, actual);
  if (differences.length > 0) {
    console.error(
      `\n✗ STALE (structure): ${differences.length} difference(s) between this database and ` +
        `.claude/backend/schema.sql (its tables, columns and enum labels).\n` +
        `  Reseeding will NOT fix this. Rebuild it from schema.sql (DROP SCHEMA public CASCADE,\n` +
        `  reload schema.sql through docker exec, then npm run db:dev:seed && npm run\n` +
        `  db:dev:seed:notifs; proved on a scratch database first; never docker compose down -v).\n` +
        `  Until then, do NOT read conclusions off this database.\n` +
        differences.map((d) => `    · ${d}`).join('\n'),
    );
    return 1;
  }

  const entries = Object.entries<unknown>(SEED).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );

  const unmapped = new Set<string>();
  const missing: Missing[] = [];
  let checked = 0;

  for (const [key, id] of entries) {
    const table = tableForKey(key);
    if (table === undefined) {
      unmapped.add(key);
      continue;
    }
    const rows = await client.query(`SELECT 1 FROM ${table} WHERE id = $1 LIMIT 1`, [id]);
    checked += 1;
    if (rows.rows.length === 0) missing.push({ key, id, table });
  }

  if (unmapped.size > 0) {
    console.error(
      `\n✗ seed-dev grew an id family this check doesn't know about:\n` +
        [...unmapped].map((u) => `    · ${u}`).join('\n') +
        `\n  Add it to TABLE_BY_KEY_PREFIX. Refusing to report a pass that skipped rows.`,
    );
    return 1;
  }

  if (missing.length > 0) {
    console.error(
      `\n✗ STALE: ${missing.length} of ${checked} seeded rows are absent.\n` +
        missing.map((m) => `    · ${m.key} → ${m.table} ${m.id}`).join('\n') +
        `\n\n  This dev DB is not what scripts/seed-dev.ts builds. Run:\n` +
        `      npm run db:dev:seed && npm run db:dev:seed:notifs\n\n` +
        `  Until then, do NOT read conclusions off this database — absent rows look\n` +
        `  exactly like genuine product bugs.`,
    );
    return 1;
  }

  // A pack with no order sits on the webhook's orderless arm (DECISIONS 179(b)): it flips,
  // grants nothing and pages. No path writes one, so a row here is a stale database.
  const orderless = await client.query(
    `SELECT count(*)::int AS count FROM charges WHERE purpose = 'package' AND order_id IS NULL`,
  );
  const orderlessCount = (orderless.rows[0] as { count: number }).count;
  if (orderlessCount > 0) {
    console.error(
      `\n✗ STALE: ${orderlessCount} package charge(s) with no order. Run: npm run db:dev:seed`,
    );
    return 1;
  }

  console.log(
    `✓ fresh — the structure matches schema.sql (${expected.tables.size} tables, ` +
      `${expected.enums.size} enums), and all ${checked} seeded rows are present across ` +
      `${Object.keys(TABLE_BY_KEY_PREFIX).length} tables.`,
  );
  return 0;
}

async function main(): Promise<number> {
  const { where, local } = describeTarget(env.DATABASE_URL);
  console.log(`db:dev:check — ${where}`);
  if (!local || env.NODE_ENV === 'production' || env.NODE_ENV === 'staging') {
    console.error(
      `REFUSING: db:dev:check reads only a local database, and DATABASE_URL points at ${where} ` +
        `(NODE_ENV ${env.NODE_ENV}). .env holds the production URL; .env.local must shadow it.`,
    );
    return 2;
  }
  // The pool is built only now, after the refusal: nothing connects to a refused URL.
  const { pool } = await import('../src/db/pool.js');
  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    return await check(client);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
    await pool.end();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error('db:dev:check failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
