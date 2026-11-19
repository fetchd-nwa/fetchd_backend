import assert from 'node:assert/strict';
import { test } from 'node:test';
import { alumniRecordedAt } from '../src/lib/alumni.js';

/**
 * `alumniRecordedAt` (`src/lib/alumni.ts`, her #33's `DogWire.alumni_at`) picks the latest
 * `completed_at` by comparing instants, never the Postgres text. The route tests in
 * `test/contracts/dogs-alumni-at.test.ts` cannot tell the two apart: the pool's session is
 * UTC, so every row reads back ending `+00`, and text order is then instant order.
 *
 * The text differs in a non-UTC session in Chicago's fall-back hour, when 01:00-01:59 happens
 * twice. Review r1 Opus N1, probe P3, kept as-is. It lives here, not in the contracts file,
 * because that file needs a database to load: `src/db/client.js` refuses to boot without
 * DATABASE_URL, and with it `registerFixtureHooks` flushes Redis and seeds the database
 * before any test runs.
 */

test('compared as instants, not text: the fall-back hour in a Chicago-offset text', () => {
  // 01:30-05 is 06:30Z; 01:10-06 is 07:10Z, later, though its text sorts first.
  const rows = [
    { program: 'foundation', completedAt: '2026-01-05 09:00:00-06' },
    { program: 'advanced', completedAt: '2026-02-03 09:00:00-06' },
    { program: 'loose-leash', completedAt: '2026-03-20 10:00:00-05' },
    { program: 'house-manners', completedAt: '2026-11-01 01:30:00-05' },
    { program: 'cgc', completedAt: '2026-11-01 01:10:00-06' },
  ];
  assert.equal(alumniRecordedAt(true, rows), '2026-11-01 01:10:00-06');
});
