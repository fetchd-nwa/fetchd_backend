import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, test } from 'node:test';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { db } from '../../src/db/client.js';
import { registerAvailabilityRoute } from '../../src/routes/availability.js';
import { registerBookingsRoute } from '../../src/routes/bookings.js';
import { createBookableDog, removeDogs } from './_dayFixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  makeLogCapture,
  registerFixtureHooks,
  type LogCapture,
} from './_harness.js';
import { clearPlantedPools, plantLot } from './_poolFixture.js';
import { at } from './_checkinFixture.js';
import { makeStripeStub } from './_stripeStub.js';

/**
 * STAFF-U45 (P21 B-9; design §2.7:4159-4162): "a test that a missing settings row fails
 * loudly". The six fallbacks the design names are gone (the last, `FREE_CANCEL_HOURS_BEFORE`,
 * with M5.08), and a search for their names proves only those spellings, so the proof is
 * the readers': for the two STAFF-U45 settings that live on a settings row and have a v1
 * reader, `day.booking_horizon_months` (the global `day_program_settings` row) and
 * `day.daily_capacity_dogs` (each campus row), delete the row and every reader answers 500
 * and logs an error naming the missing row, never a number from code. (A lot's expiry
 * follows its catalog row, `cred.package_expiry_months`: `package-expiry-stamp.test.ts`,
 * "CRED-U08: a purchase after an expiry_months edit stamps the edited months".)
 *
 * Each case deletes the real row on the test database and puts back its exact bytes,
 * `to_jsonb` in and `jsonb_populate_record` out, in a `finally`.
 */

registerFixtureHooks();
const createdDogs: string[] = [];
after(async () => {
  await clearPlantedPools();
  await removeDogs(createdDogs);
});

const NOW = at('2026-11-17', '19:00');

function appWith(capture: LogCapture): FastifyInstance {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL, capture);
  registerBookingsRoute(app, { authenticate, now: () => NOW, stripe: makeStripeStub() });
  registerAvailabilityRoute(app, { authenticate });
  return app;
}

async function withoutRow(where: ReturnType<typeof sql>, body: () => Promise<void>): Promise<void> {
  const { rows } = await db.execute(sql`SELECT to_jsonb(s) AS row FROM day_program_settings s WHERE ${where}`);
  assert.equal(rows.length, 1, 'the seeded row to remove');
  const saved = JSON.stringify((rows[0] as { row: unknown }).row);
  await db.execute(sql`DELETE FROM day_program_settings WHERE ${where}`);
  try {
    await body();
  } finally {
    await db.execute(sql`
      INSERT INTO day_program_settings
      SELECT * FROM jsonb_populate_record(NULL::day_program_settings, ${saved}::jsonb)`);
  }
}

function assertLoud(
  res: { statusCode: number; body: string },
  capture: LogCapture,
  names: RegExp,
  reader: string,
): void {
  assert.equal(res.statusCode, 500, `${reader}: ${res.body}`);
  const logged = capture.lines.filter(
    (l) => l.level === 50 && names.test(JSON.stringify(l.err ?? l)),
  );
  assert.ok(logged.length > 0, `${reader}: no error log names the missing row`);
}

describe('a missing day_program_settings row fails loudly at every reader', () => {
  test(
    'the global row (day.booking_horizon_months) gone: POST /bookings and GET /availability each 500, naming it',
    SKIP_WHEN_NO_DB,
    async () => {
      const dogId = await createBookableDog(createdDogs);
      await plantLot({ credits: 1, expiresAt: at('2030-01-01', '12:00') });
      await withoutRow(sql`location IS NULL`, async () => {
        const capture = makeLogCapture();
        const app = appWith(capture);
        const booked = await app.inject({
          method: 'POST',
          url: '/bookings',
          headers: { 'idempotency-key': `loud-${randomUUID()}` },
          payload: {
            category: 'day-school',
            lead_dog_id: dogId,
            dates: ['2026-11-18'],
            location: 'bentonville',
            payment: { kind: 'credits' },
          },
        });
        assertLoud(booked, capture, /day_program_settings \(global row\)/, 'POST /bookings');
        const calendar = await app.inject({
          method: 'GET',
          url: '/availability?location=bentonville&from=2026-11-18&to=2026-11-20',
        });
        assertLoud(calendar, capture, /day_program_settings \(global row\)/, 'GET /availability');
      });
    },
  );

  test(
    "Bentonville's row (day.daily_capacity_dogs) gone: POST /bookings and GET /availability each 500, naming it",
    SKIP_WHEN_NO_DB,
    async () => {
      const dogId = await createBookableDog(createdDogs);
      await plantLot({ credits: 1, expiresAt: at('2030-01-01', '12:00') });
      await withoutRow(sql`location = 'bentonville'`, async () => {
        const capture = makeLogCapture();
        const app = appWith(capture);
        const booked = await app.inject({
          method: 'POST',
          url: '/bookings',
          headers: { 'idempotency-key': `loud-${randomUUID()}` },
          payload: {
            category: 'day-school',
            lead_dog_id: dogId,
            dates: ['2026-11-18'],
            location: 'bentonville',
            payment: { kind: 'credits' },
          },
        });
        assertLoud(booked, capture, /day_program_settings \(bentonville\)|day_program_settings has no row for bentonville/, 'POST /bookings');
        const calendar = await app.inject({
          method: 'GET',
          url: '/availability?location=bentonville&from=2026-11-18&to=2026-11-20',
        });
        assertLoud(calendar, capture, /day_program_settings \(bentonville\)|day_program_settings has no row for bentonville/, 'GET /availability');
      });
    },
  );
});
