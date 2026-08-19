import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

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
