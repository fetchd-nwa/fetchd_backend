import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { FIXTURE_VACCINE_EXPIRIES } from './_fixture.js';

/**
 * Deliberately wall-clock-dependent — that is its entire purpose. The DDL
 * trigger `assert_vaccines_current` (schema.sql) compares
 * `dog_vaccines.expires_at` to REAL `now()`, which no injected clock reaches,
 * so fixture vaccine dates rot against the actual calendar. When they do,
 * `seedFixture`'s first gated booking insert throws in every suite's before
 * hook (2026-08-19: 830 of 1087 tests red, one root cause). This trips 180
 * days ahead, on a green branch, with the repair in the message.
 */
const HEADROOM_DAYS = 180;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

describe('fixture rot tripwire — vaccine expiries vs the real calendar', () => {
  for (const [name, expiresAt] of Object.entries(FIXTURE_VACCINE_EXPIRIES)) {
    it(`fixture ${name} expiry keeps >=${HEADROOM_DAYS} days of wall-clock headroom`, () => {
      const daysLeft = Math.floor((Date.parse(expiresAt) - Date.now()) / MS_PER_DAY);
      assert.ok(
        daysLeft >= HEADROOM_DAYS,
        `FIXTURE_VACCINE_EXPIRIES.${name} = ${expiresAt} has only ${daysLeft} days of ` +
          'wall-clock headroom. The DDL trigger assert_vaccines_current (schema.sql) reads ' +
          'REAL now(), so once this date passes, every gated booking insert in seedFixture ' +
          'fails at the hook and most of the suite goes red as one root cause. Repair: push ' +
          'the date far future in _fixture.ts AND update the pinned strings in ' +
          'snapshots/dogs.json + snapshots/dog-by-id.json in the same edit.',
      );
    });
  }
});

/**
 * Second tripwire — an injected `now` literal in a DB-backed credit-expiry test.
 *
 * Same disease as the vaccine dates above, different organ. A credit test's injected
 * `now` reaches the route; `lot_is_live` and `lot_pays_date` read Postgres' own clock,
 * and no injected clock reaches them. So a test that pins `now` to a literal and seeds a
 * lot at `literal + N days` fixes that lot's expiry on the CALENDAR while the floor keeps
 * advancing. The day the real clock passes it, the lot dies, and the test fails one of
 * two ways:
 *
 *   - an `enqueued === 1` assertion goes RED and stays red — the 2026-09-28
 *     bomb defused in step 0.2-a;
 *   - a `scanned === 0` assertion goes on PASSING for the wrong reason (killed
 *     by the floor, not excluded by the window) and can never go red again.
 *     The second is worse: it is silent.
 *
 * So this reads the file's SOURCE TEXT and rejects any `const now = new
 * Date('...')`. A literal that genuinely never reaches Postgres — pure date
 * math, no row, no `now()` — opts out with `// pure-fn: no DB` on the same line, so the
 * exemption is visible where it is claimed instead of in a list up here.
 *
 * Honest limits, so nobody reads more into a green than it carries: the match
 * is TEXTUAL and exact (`const now = new Date('`). A differently-named binding
 * (`const t0 = ...`), a computed literal, or a date built any other way walks
 * straight past it, and it sees only the file named below. The tree-wide
 * check is step 0.2-c, which runs the whole suite under a shifted clock and
 * needs no pattern at all.
 */
const GUARDED_FILES = ['credit-expiry-lots.test.ts'] as const;

/** A pinned injected clock. Deliberately textual: this guards source, not runtime. */
const LITERAL_ANCHOR = "const now = new Date('";

/** Same-line opt-out for a literal that never reaches Postgres. */
const PURE_FN_MARKER = '// pure-fn: no DB';

// Resolve against THIS file, never the cwd — the runner is invoked from the
// repo root, from `test/`, and from a git worktree, and a cwd-relative path
// would read nothing (or the wrong tree) in at least one of those.
const CONTRACTS_DIR = path.dirname(fileURLToPath(import.meta.url));

describe(
  'fixture rot tripwire — injected-clock literals in the credit-expiry tests ' +
    '(guards THIS FILE only, not the tree; the tree-wide check is step 0.2-c, ' +
    'which runs the whole suite under a shifted clock)',
  () => {
    for (const file of GUARDED_FILES) {
      it(`${file} pins no DB-backed \`now\` to a date literal`, () => {
        const abs = path.join(CONTRACTS_DIR, file);
        assert.ok(
          fs.existsSync(abs),
          `${abs} does not exist. This tripwire guards a path that has moved or been ` +
            'renamed, so it is currently guarding nothing. Update GUARDED_FILES in ' +
            'fixture-rot.test.ts to the new path rather than deleting the entry.',
        );

        const violations = fs
          .readFileSync(abs, 'utf8')
          .split('\n')
          .map((text, i) => ({ line: i + 1, text }))
          .filter((l) => l.text.includes(LITERAL_ANCHOR) && !l.text.includes(PURE_FN_MARKER));

        assert.deepEqual(
          violations.map((v) => `${file}:${v.line}`),
          [],
          `${file} pins an injected \`now\` to a date literal at:\n` +
            violations.map((v) => `    ${file}:${v.line}  ${v.text.trim()}`).join('\n') +
            '\n\n  MECHANISM: `lot_is_live` and `lot_pays_date` read Postgres\' own clock, ' +
            'which no injected clock reaches. Pin `now` and seed a lot at `now + N days` and ' +
            'that expiry is fixed on the calendar while the floor advances; the day the real ' +
            'clock passes it the lot dies.\n' +
            '  REPAIR: anchor on `const now = new Date();` and keep every offset relative to ' +
            'it — the assertions do not change, only the anchor does.\n' +
            '  EXEMPTION: if the literal never reaches Postgres (pure window math, no row, no ' +
            `\`now()\`), put \`${PURE_FN_MARKER}\` on the same line.`,
        );
      });
    }
  },
);
