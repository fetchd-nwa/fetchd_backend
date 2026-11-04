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

/**
 * P12 item 0 (P05 Opus r2 nice 2). The test above walks whatever the class
 * lists, so a range the class leaves out passes it. This one names the three
 * Default_Ignorable ranges the class missed, and the visible code point on
 * each side of them, so dropping a range goes red in both engines.
 */
test(
  'P12 item 0: U+FFF0-FFF8, U+1BCA0-1BCA3 and U+E0080-E0FFF are blank in JavaScript and Postgres, and their outer neighbours are not',
  SKIP_WHEN_NO_DB,
  async () => {
    const blank = [0xfff0, 0xfff8, 0x1bca0, 0x1bca3, 0xe0080, 0xe00ff, 0xe01f0, 0xe0fff];
    const visible = [0xffef, 0x1bc9f, 0x1bca4, 0xe1000];
    const chars = [...blank, ...visible].map((cp) => String.fromCodePoint(cp));
    const rows = await db.execute<{ i: string; visible: boolean }>(
      sql`SELECT i, ${visibleOrNull(sql`c`)} IS NOT NULL AS visible
            FROM jsonb_array_elements_text(${JSON.stringify(chars)}::jsonb) WITH ORDINALITY AS t(c, i)`,
    );
    assert.equal(rows.rows.length, chars.length, 'Postgres saw every character');
    const show = (cp: number): string => `U+${cp.toString(16).toUpperCase()}`;
    const inSql = new Map(rows.rows.map((r) => [Number(r.i) - 1, r.visible]));
    assert.deepEqual(
      blank.filter((cp) => isNonBlank(String.fromCodePoint(cp))).map(show),
      [],
      'JavaScript reads these blanks as text',
    );
    assert.deepEqual(
      blank.filter((_, i) => inSql.get(i) === true).map(show),
      [],
      'Postgres reads these blanks as text',
    );
    assert.deepEqual(
      visible.filter((cp) => !isNonBlank(String.fromCodePoint(cp))).map(show),
      [],
      'JavaScript reads these visible characters as blank',
    );
    assert.deepEqual(
      visible.filter((_, i) => inSql.get(blank.length + i) === false).map(show),
      [],
      'Postgres reads these visible characters as blank',
    );
  },
);
