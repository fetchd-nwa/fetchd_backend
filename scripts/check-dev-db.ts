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
 */
import { SEED } from './seed-ids.js';
import { db } from '../src/db/client.js';
import { env } from '../src/env.js';

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

async function main(): Promise<void> {
  console.log(`db:dev:check — ${env.DATABASE_URL.replace(/:[^:@]*@/, ':***@')}`);

  const entries = Object.entries(SEED).filter(
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
    const rows = await db.execute(`SELECT 1 FROM ${table} WHERE id = '${id}' LIMIT 1`);
    checked += 1;
    if (rows.rows.length === 0) missing.push({ key, id, table });
  }

  if (unmapped.size > 0) {
    console.error(
      `\n✗ seed-dev grew an id family this check doesn't know about:\n` +
        [...unmapped].map((u) => `    · ${u}`).join('\n') +
        `\n  Add it to TABLE_BY_KEY_PREFIX. Refusing to report a pass that skipped rows.`,
    );
    process.exit(1);
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
    process.exit(1);
  }

  console.log(`✓ fresh — all ${checked} seeded rows present across ${Object.keys(TABLE_BY_KEY_PREFIX).length} tables.`);
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error('db:dev:check failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
