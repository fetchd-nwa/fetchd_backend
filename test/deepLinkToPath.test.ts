import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  deepLinkToPath,
  INVOICE_DEEP_LINK_REASONS,
  type NotificationDeepLink,
} from '../src/contracts/wire.js';

/**
 * Unit coverage for `deepLinkToPath` — THE deep-link path grammar (contract
 * 1.4.0). Pure function, no DB: every producer computes its persisted
 * `deep_link_path` through here, so these expected strings ARE the wire
 * contract the FE route table must match. One assertion per `kind` (all 9),
 * plus the entity-specific arms that branch on params: `report` (fail-loud on a
 * missing dogId), `invoice` (embeds the id), and `membership` (send-time routing
 * — dogId present ⇒ the dog page with `?highlight=<membershipId>`, absent ⇒ the
 * account overview).
 */

// One resolvable case per NotificationDeepLinkKind arm.

test('deepLinkToPath: booking → /bookings/:id', () => {
  assert.equal(deepLinkToPath({ kind: 'booking', id: 'bk-123' }), '/bookings/bk-123');
});

test('deepLinkToPath: report → /report-card/:dogId?reportId=:id (params.dogId supplied)', () => {
  const link: NotificationDeepLink = {
    kind: 'report',
    id: 'rep-9',
    params: { dogId: 'dog-7' },
  };
  assert.equal(deepLinkToPath(link), '/report-card/dog-7?reportId=rep-9');
});

test('deepLinkToPath: thread → /chat/:id', () => {
  assert.equal(deepLinkToPath({ kind: 'thread', id: 't-1' }), '/chat/t-1');
});

test('deepLinkToPath: invoice → /account/invoices?invoiceId=:id (the specific invoice)', () => {
  assert.equal(
    deepLinkToPath({ kind: 'invoice', id: 'inv-1' }),
    '/account/invoices?invoiceId=inv-1',
  );
});

test('deepLinkToPath: dog-profile → /dog-profile/:id', () => {
  assert.equal(deepLinkToPath({ kind: 'dog-profile', id: 'dog-7' }), '/dog-profile/dog-7');
});

test('deepLinkToPath: dog-manage → /dog-manage/:id', () => {
  assert.equal(deepLinkToPath({ kind: 'dog-manage', id: 'dog-7' }), '/dog-manage/dog-7');
});

test('deepLinkToPath: credits → /account/credits, the owner\'s screen, with no id', () => {
  assert.equal(deepLinkToPath({ kind: 'credits' }), '/account/credits');
});

test('deepLinkToPath: announcement → /announcement/:id', () => {
  assert.equal(deepLinkToPath({ kind: 'announcement', id: 'ann-3' }), '/announcement/ann-3');
});

// Credits are the owner's since 5.0.0-lg4.2, so the arm names no dog: a booking-time
// dog id cannot reach this path, and it is a route of its own.
test('deepLinkToPath: credits is no longer a dog-profile route', () => {
  assert.equal(deepLinkToPath({ kind: 'credits' }).startsWith('/dog-profile/'), false);
});

// report's params contract: a missing OR empty dogId fails LOUD at emit time
// rather than persisting a broken /report-card/undefined?... path.

test('deepLinkToPath: report without params throws (fails loud at emit time)', () => {
  assert.throws(
    () => deepLinkToPath({ kind: 'report', id: 'rep-9' }),
    /report link requires params\.dogId/,
  );
});

test('deepLinkToPath: report with params but no dogId key throws', () => {
  assert.throws(
    () => deepLinkToPath({ kind: 'report', id: 'rep-9', params: { reportId: 'x' } }),
    /report link requires params\.dogId/,
  );
});

test('deepLinkToPath: report with empty-string dogId throws', () => {
  assert.throws(
    () => deepLinkToPath({ kind: 'report', id: 'rep-9', params: { dogId: '' } }),
    /report link requires params\.dogId/,
  );
});

// ── invoice `params.reason` (wire 1.9.0) ─────────────────────────────────────
//
// The framing a payment notification carries to the settle sheet it opens.
// Three properties matter and each is pinned separately:
//   1. every member emits, so a producer can't ship a reason the client drops;
//   2. an INVALID value throws at emit (the `report` arm's fail-loud rule) —
//      persisting a path the parser will reject is worse than failing here;
//   3. OMITTED is byte-identical to the pre-1.9.0 path, which is what makes
//      every historical row and every non-payment producer untouched.

test('deepLinkToPath: invoice with reason=payment-failed → &reason= appended', () => {
  assert.equal(
    deepLinkToPath({ kind: 'invoice', id: 'inv-1', params: { reason: 'payment-failed' } }),
    '/account/invoices?invoiceId=inv-1&reason=payment-failed',
  );
});

test('deepLinkToPath: invoice with reason=payment-due → &reason= appended', () => {
  assert.equal(
    deepLinkToPath({ kind: 'invoice', id: 'inv-1', params: { reason: 'payment-due' } }),
    '/account/invoices?invoiceId=inv-1&reason=payment-due',
  );
});

test('deepLinkToPath: every INVOICE_DEEP_LINK_REASONS member emits its own path', () => {
  // Derived from the exported tuple rather than re-listed, so a member added to
  // the contract without an emitted path fails HERE.
  for (const reason of INVOICE_DEEP_LINK_REASONS) {
    assert.equal(
      deepLinkToPath({ kind: 'invoice', id: 'inv-1', params: { reason } }),
      `/account/invoices?invoiceId=inv-1&reason=${reason}`,
    );
  }
});

test('deepLinkToPath: invoice with an INVALID reason throws at emit time', () => {
  assert.throws(
    () => deepLinkToPath({ kind: 'invoice', id: 'inv-1', params: { reason: 'ledger' } }),
    /invoice link reason must be one of/,
    "the client's local 'ledger' default is not a wire value",
  );
  assert.throws(
    () => deepLinkToPath({ kind: 'invoice', id: 'inv-1', params: { reason: '' } }),
    /invoice link reason must be one of/,
  );
});

test('deepLinkToPath: invoice with params but no reason key is byte-identical to the legacy path', () => {
  // A non-payment producer that passes OTHER params must not start emitting a
  // query param — this is the backward-compat guarantee for historical rows.
  assert.equal(
    deepLinkToPath({ kind: 'invoice', id: 'inv-1', params: { dogId: 'dog-7' } }),
    deepLinkToPath({ kind: 'invoice', id: 'inv-1' }),
  );
  assert.equal(
    deepLinkToPath({ kind: 'invoice', id: 'inv-1' }),
    '/account/invoices?invoiceId=inv-1',
  );
});
