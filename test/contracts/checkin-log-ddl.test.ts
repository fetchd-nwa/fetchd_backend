import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, test } from 'node:test';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { pool } from '../../src/db/pool.js';
import { bookings, creditLedger } from '../../src/db/schema/schema.js';
import { createBookableDog, removeDogs } from './_dayFixture.js';
import { FIXTURE_IDS } from './_fixture.js';
import { SKIP_WHEN_NO_DB, registerFixtureHooks } from './_harness.js';
import { clearPlantedPools, plantLot } from './_poolFixture.js';
import { createSession, removeSessions } from './_checkinFixture.js';

/**
 * M5.01's and M5.10's own red-first (design §4 M5.01, §2.4:2976-2977): the check-in log
 * is append-only at the database, so a direct DELETE, UPDATE or TRUNCATE is refused,
 * while the cascade a test's teardown (and an account deletion) relies on still passes;
 * and a `settlement-return` must name the debit it reverses.
 */

registerFixtureHooks();
const dogs: string[] = [];
const sessions: string[] = [];
afterEach(async () => {
  await removeSessions(sessions.splice(0));
  await clearPlantedPools();
});
after(async () => {
  await removeDogs(dogs);
});

async function loggedSession(): Promise<{ bookingId: string; dogId: string; eventId: string }> {
  const dogId = await createBookableDog(dogs);
  const { bookingId } = await createSession({
    dogIds: [dogId],
    date: '2026-10-13',
    ledger: sessions,
  });
  const eventId = randomUUID();
  await db.execute(sql`
    INSERT INTO checkin_events (id, booking_id, dog_id, kind, at, by_staff_id)
    VALUES (${eventId}, ${bookingId}, ${dogId}, 'check-in', now(), ${FIXTURE_IDS.staffDonavanId})`);
  return { bookingId, dogId, eventId };
}

async function eventExists(eventId: string): Promise<boolean> {
  const { rows } = await db.execute(sql`SELECT 1 FROM checkin_events WHERE id = ${eventId}`);
  return rows.length === 1;
}

test('M5.01: a direct DELETE of a check-in event is refused', SKIP_WHEN_NO_DB, async () => {
  const { eventId } = await loggedSession();
  await assert.rejects(
    db.execute(sql`DELETE FROM checkin_events WHERE id = ${eventId}`),
    /append-only/,
  );
  assert.equal(await eventExists(eventId), true);
});

test('M5.01: a direct UPDATE of a check-in event is refused', SKIP_WHEN_NO_DB, async () => {
  const { eventId } = await loggedSession();
  await assert.rejects(
    db.execute(sql`UPDATE checkin_events SET note = 'edited' WHERE id = ${eventId}`),
    /append-only/,
  );
  const { rows } = await db.execute(sql`SELECT note FROM checkin_events WHERE id = ${eventId}`);
  assert.equal((rows[0] as { note: string | null }).note, null);
});

test('M5.01: TRUNCATE of the check-in log is refused', SKIP_WHEN_NO_DB, async () => {
  const { eventId } = await loggedSession();
  const client = await pool.connect();
  try {
    // Since M5.10's event link (P20 fix 1) `credit_ledger` references the log, so a plain
    // TRUNCATE is refused by Postgres (0A000) before any trigger runs; with CASCADE, which
    // would take the ledger with it, M5.01's statement trigger is what refuses it.
    await client.query('BEGIN');
    await assert.rejects(client.query('TRUNCATE checkin_events'), (err: unknown) => {
      assert.equal((err as { code?: string }).code, '0A000', String(err));
      return true;
    });
    await client.query('ROLLBACK');
    await client.query('BEGIN');
    await assert.rejects(client.query('TRUNCATE checkin_events CASCADE'), /append-only/);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
  assert.equal(await eventExists(eventId), true);
});

test(
  'M5.01: the teardown passes — deleting the booking cascades through its dogs to the log',
  SKIP_WHEN_NO_DB,
  async () => {
    const { bookingId, eventId } = await loggedSession();
    await db.delete(bookings).where(eq(bookings.id, bookingId));
    assert.equal(await eventExists(eventId), false);
  },
);

test(
  '§2.4: a settlement-return with no reverses_entry_id is refused (23514)',
  SKIP_WHEN_NO_DB,
  async () => {
    const lotId = await plantLot({ credits: 1, expiresAt: '2027-06-01T05:00:00Z' });
    await assert.rejects(
      db.insert(creditLedger).values({
        ownerId: FIXTURE_IDS.ownerId,
        location: 'bentonville',
        mode: 'school',
        tier: 'regular',
        delta: 1,
        reason: 'settlement-return',
        lotId,
      }),
      (err: unknown) => {
        const code =
          (err as { code?: string; cause?: { code?: string } }).code ??
          (err as { cause?: { code?: string } }).cause?.code;
        assert.equal(code, '23514', String(err));
        return true;
      },
    );
  },
);

/**
 * P20 fix 1, F1 (designs/p20-event-ledger-link.md §3, §4 T5; §9 (f)): the ledger row names
 * the check-in event that wrote it, `credit_ledger.checkin_event_id`, amended into M5.10.
 * The database holds that a linked row is a debit or a return on a share (the CHECK, whose
 * `IS NOT NULL` closes MATCH SIMPLE's hole), on the event's own booking and dog (the
 * composite FK), one row per event (the partial unique index), and that a linked share's
 * events cannot be deleted under it (NO ACTION through the `booking_dogs` cascade).
 */

function sqlstate(err: unknown): string | undefined {
  return (err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code;
}

function constraintOf(err: unknown): string | undefined {
  return (
    (err as { constraint?: string }).constraint ??
    (err as { cause?: { constraint?: string } }).cause?.constraint
  );
}

async function refusedWith(
  statement: Promise<unknown>,
  code: string,
  constraint: string,
): Promise<void> {
  await assert.rejects(statement, (err: unknown) => {
    assert.equal(sqlstate(err), code, String(err));
    assert.equal(constraintOf(err), constraint, String(err));
    return true;
  });
}

/** Waffles (lead) and Lola on one day, each debited, and one check-in event each. */
async function twoDogShare() {
  const waffles = await createBookableDog(dogs);
  const lola = await createBookableDog(dogs);
  const lotId = await plantLot({ credits: 4, expiresAt: '2027-06-01T05:00:00Z' });
  const { bookingId, debitIds } = await createSession({
    dogIds: [waffles, lola],
    date: '2026-10-13',
    lotId,
    ledger: sessions,
  });
  const event = async (dogId: string): Promise<string> => {
    const id = randomUUID();
    await db.execute(sql`
      INSERT INTO checkin_events (id, booking_id, dog_id, kind, at, by_staff_id)
      VALUES (${id}, ${bookingId}, ${dogId}, 'check-out', now(), ${FIXTURE_IDS.staffDonavanId})`);
    return id;
  };
  return {
    bookingId,
    lotId,
    waffles,
    lola,
    wafflesDebit: debitIds.get(waffles)!,
    wafflesEvent: await event(waffles),
    lolaEvent: await event(lola),
  };
}

/** A return on the share, reversing `debit`, naming `checkinEventId`. */
function linkedReturn(args: {
  bookingId: string;
  dogId: string | null;
  lotId: string;
  debit: string;
  checkinEventId: string;
}) {
  return db.execute(sql`
    INSERT INTO credit_ledger
      (owner_id, dog_id, location, mode, tier, delta, reason, booking_id, lot_id,
       reverses_entry_id, checkin_event_id)
    VALUES (${FIXTURE_IDS.ownerId}, ${args.dogId}, 'bentonville', 'school', 'regular', 1,
            'settlement-return', ${args.bookingId}, ${args.lotId}, ${args.debit},
            ${args.checkinEventId})`);
}

test(
  'T5: a linked purchase, and a linked row with no dog, are refused by the CHECK (23514)',
  SKIP_WHEN_NO_DB,
  async () => {
    const s = await twoDogShare();
    await refusedWith(
      db.execute(sql`
        INSERT INTO credit_ledger
          (owner_id, dog_id, location, mode, tier, delta, reason, expires_at, booking_id,
           checkin_event_id)
        VALUES (${FIXTURE_IDS.ownerId}, ${s.waffles}, 'bentonville', 'school', 'regular', 1,
                'purchase', '2027-06-01T05:00:00Z', ${s.bookingId}, ${s.wafflesEvent})`),
      '23514',
      'credit_ledger_checkin_event_check',
    );
    // A row naming no event at all, its dog NULL: MATCH SIMPLE would skip the FK, so only
    // the CHECK's `dog_id IS NOT NULL` refuses it.
    await refusedWith(
      linkedReturn({
        bookingId: s.bookingId,
        dogId: null,
        lotId: s.lotId,
        debit: s.wafflesDebit,
        checkinEventId: randomUUID(),
      }),
      '23514',
      'credit_ledger_checkin_event_check',
    );
  },
);

test(
  "T5: Lola's event on Waffles's return is refused by the composite FK (23503), before any row names it",
  SKIP_WHEN_NO_DB,
  async () => {
    const s = await twoDogShare();
    await refusedWith(
      linkedReturn({
        bookingId: s.bookingId,
        dogId: s.waffles,
        lotId: s.lotId,
        debit: s.wafflesDebit,
        checkinEventId: s.lolaEvent,
      }),
      '23503',
      'credit_ledger_checkin_event_fkey',
    );
    // Control: Waffles's own event.
    await linkedReturn({
      bookingId: s.bookingId,
      dogId: s.waffles,
      lotId: s.lotId,
      debit: s.wafflesDebit,
      checkinEventId: s.wafflesEvent,
    });
  },
);

test(
  'T5: a second row naming one event is refused by the partial unique index (23505)',
  SKIP_WHEN_NO_DB,
  async () => {
    const s = await twoDogShare();
    await linkedReturn({
      bookingId: s.bookingId,
      dogId: s.waffles,
      lotId: s.lotId,
      debit: s.wafflesDebit,
      checkinEventId: s.wafflesEvent,
    });
    await refusedWith(
      db.execute(sql`
        INSERT INTO credit_ledger
          (owner_id, dog_id, location, mode, tier, delta, reason, booking_id, lot_id,
           checkin_event_id)
        VALUES (${FIXTURE_IDS.ownerId}, ${s.waffles}, 'bentonville', 'school', 'regular', -1,
                'booking-debit', ${s.bookingId}, ${s.lotId}, ${s.wafflesEvent})`),
      '23505',
      'credit_ledger_checkin_event_uidx',
    );
  },
);

test(
  "T5: deleting a linked share's booking_dogs row is refused (23503, NO ACTION through the cascade); an unlinked share's still goes",
  SKIP_WHEN_NO_DB,
  async () => {
    const s = await twoDogShare();
    await linkedReturn({
      bookingId: s.bookingId,
      dogId: s.waffles,
      lotId: s.lotId,
      debit: s.wafflesDebit,
      checkinEventId: s.wafflesEvent,
    });
    await refusedWith(
      db.execute(sql`
        DELETE FROM booking_dogs WHERE booking_id = ${s.bookingId} AND dog_id = ${s.waffles}`),
      '23503',
      'credit_ledger_checkin_event_fkey',
    );
    assert.equal(await eventExists(s.wafflesEvent), true);
    await db.execute(sql`
      DELETE FROM booking_dogs WHERE booking_id = ${s.bookingId} AND dog_id = ${s.lola}`);
    assert.equal(await eventExists(s.lolaEvent), false, "Lola's share, linked to nothing, goes");
  },
);
