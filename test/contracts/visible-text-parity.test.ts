import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { visibleOrNull } from '../../src/db/visibleText.js';
import { INVISIBLE_CODE_POINTS, isNonBlank } from '../../src/lib/signupFields.js';
import { SKIP_WHEN_NO_DB } from './_harness.js';

/**
 * P05 fix round 1, BF1: the sign-up map's "visible character" class is read by
 * two engines — `isNonBlank` in JavaScript (`MeWire`, `PATCH /me`, the Stripe
 * customer name) and `db/visibleText.ts` in Postgres (`StaffOwnerWire`, its
 * sort, `StaffDogWire.owner_name`). They must agree on every character, or one
 * stored name reads two ways again. Postgres's own `\S` does not agree with
 * JavaScript's (NBSP, the zero-width characters), which is why the class is
 * explicit.
 */
test(
  'BF1: JavaScript and Postgres read the one character class alike — every listed code point and both neighbours of every range',
  SKIP_WHEN_NO_DB,
  async () => {
    const points = new Set<number>();
    for (const [from, to] of INVISIBLE_CODE_POINTS) {
      for (let cp = from; cp <= to; cp++) points.add(cp);
      if (from > 1) points.add(from - 1);
      points.add(to + 1);
    }
    for (const visible of ['a', 'Z', 'é', '中', '0', '-', '~', '\u00e9', '\u{1f415}']) {
      points.add(visible.codePointAt(0) as number);
    }
    const chars = [...points].sort((a, b) => a - b).map((cp) => String.fromCodePoint(cp));
    const rows = await db.execute<{ i: string; visible: boolean }>(
      sql`SELECT i, ${visibleOrNull(sql`c`)} IS NOT NULL AS visible
            FROM jsonb_array_elements_text(${JSON.stringify(chars)}::jsonb) WITH ORDINALITY AS t(c, i)`,
    );
    assert.equal(rows.rows.length, chars.length, 'Postgres saw every character');
    const disagree = rows.rows
      .filter((r) => r.visible !== isNonBlank(chars[Number(r.i) - 1] as string))
      .map((r) => `U+${(chars[Number(r.i) - 1] as string).codePointAt(0)?.toString(16)}`);
    assert.deepEqual(disagree, [], 'JavaScript and Postgres disagree on these');
    // Not vacuous: the listed points are blank in both, the samples visible.
    const blank = chars.filter((c) => !isNonBlank(c)).length;
    assert.ok(blank > 500 && blank < chars.length, `${blank} of ${chars.length} blank`);
  },
);
