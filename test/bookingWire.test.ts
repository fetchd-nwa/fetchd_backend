import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  toBookingWire,
  type BookingRowForWire,
  type BookingDogIds,
} from '../src/lib/bookingWire.js';

// Pure unit coverage for the Day-19d group-class additions to the booking
// wire: `cohort_id` (the FE's grouping key) + `group_class_name` (the card
// title). No DB — the helper is pure.

const DOG_IDS: BookingDogIds = { lead: 'dog-1', additional: [] };

function row(overrides: Partial<BookingRowForWire> = {}): BookingRowForWire {
  return {
    id: 'b-1',
    category: 'group-class',
    status: 'upcoming',
    scheduledAt: '2026-06-07T15:00:00.000Z',
    durationMinutes: 50,
    notes: null,
    sessionReportId: null,
    location: 'fayetteville',
    cancelledAt: null,
    cancelForfeited: false,
    cohortId: 'cohort-1',
    ...overrides,
  };
}

test('toBookingWire emits cohort_id + group_class_name for a group-class booking', () => {
  const wire = toBookingWire(row(), DOG_IDS, 'Rachel', 'Manners 1');
  assert.equal(wire.cohort_id, 'cohort-1');
  assert.equal(wire.group_class_name, 'Manners 1');
  assert.equal(wire.category, 'group-class');
});

test('toBookingWire omits both fields for a non-cohort booking', () => {
  const wire = toBookingWire(
    row({ category: 'day-school', cohortId: null }),
    DOG_IDS,
    null,
    undefined,
  );
  assert.equal('cohort_id' in wire, false);
  assert.equal('group_class_name' in wire, false);
});

test('toBookingWire omits group_class_name when the name is empty/absent', () => {
  // cohort_id present but the class-name resolve found nothing → no title field.
  const wire = toBookingWire(row(), DOG_IDS, null, undefined);
  assert.equal(wire.cohort_id, 'cohort-1');
  assert.equal('group_class_name' in wire, false);
});
