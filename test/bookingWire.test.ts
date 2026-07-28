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
    cancelDeadlineAt: null,
    cancelledBy: null,
    cancelReason: null,
    cohortId: 'cohort-1',
    ...overrides,
  };
}

test('toBookingWire emits cancelled_by + cancel_reason only on a cancelled booking (R5)', () => {
  const owner = toBookingWire(
    row({ status: 'cancelled', cancelledAt: '2026-07-10 15:00:00+00', cancelledBy: 'owner' }),
    DOG_IDS,
    null,
    undefined,
  );
  assert.equal(owner.cancelled_by, 'owner');
  assert.equal('cancel_reason' in owner, false);

  const staff = toBookingWire(
    row({
      status: 'cancelled',
      cancelledAt: '2026-07-10 15:00:00+00',
      cancelledBy: 'staff',
      cancelReason: 'Trainer out sick',
    }),
    DOG_IDS,
    null,
    undefined,
  );
  assert.equal(staff.cancelled_by, 'staff');
  assert.equal(staff.cancel_reason, 'Trainer out sick');

  // Not cancelled → neither field emits even if the columns somehow carry values.
  const live = toBookingWire(row({ cancelledBy: 'owner', cancelReason: 'x' }), DOG_IDS, null, undefined);
  assert.equal('cancelled_by' in live, false);
  assert.equal('cancel_reason' in live, false);
});

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

test('toBookingWire emits cancel_deadline_at as ISO when set, omits it when null', () => {
  const withDeadline = toBookingWire(
    row({ cancelDeadlineAt: '2026-07-10 15:00:00+00' }),
    DOG_IDS,
    null,
    undefined,
  );
  assert.equal(withDeadline.cancel_deadline_at, '2026-07-10T15:00:00.000Z');

  const withoutDeadline = toBookingWire(row({ cancelDeadlineAt: null }), DOG_IDS, null, undefined);
  assert.equal('cancel_deadline_at' in withoutDeadline, false);
});
