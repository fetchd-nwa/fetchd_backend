import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deepLinkToPath, type NotificationDeepLink } from '../src/contracts/wire.js';

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

test('deepLinkToPath: membership without params → /account/memberships (overview)', () => {
  assert.equal(deepLinkToPath({ kind: 'membership', id: 'm-1' }), '/account/memberships');
});

test('deepLinkToPath: membership with params.dogId → /dog-subscriptions/:dogId?highlight=:id (lone ending)', () => {
  // R4 (2026-07-28): the dog page carries ?highlight=<membershipId> (link.id) so
  // the app one-shot flashes the SPECIFIC ended subscription card.
  assert.equal(
    deepLinkToPath({ kind: 'membership', id: 'm-1', params: { dogId: 'dog-7' } }),
    '/dog-subscriptions/dog-7?highlight=m-1',
  );
});

test('deepLinkToPath: dog-profile → /dog-profile/:id', () => {
  assert.equal(deepLinkToPath({ kind: 'dog-profile', id: 'dog-7' }), '/dog-profile/dog-7');
});

test('deepLinkToPath: dog-manage → /dog-manage/:id', () => {
  assert.equal(deepLinkToPath({ kind: 'dog-manage', id: 'dog-7' }), '/dog-manage/dog-7');
});

test('deepLinkToPath: credits → /dog-profile/:id?highlight=credits (the credits CARD)', () => {
  assert.equal(deepLinkToPath({ kind: 'credits', id: 'dog-7' }), '/dog-profile/dog-7?highlight=credits');
});

test('deepLinkToPath: announcement → /announcement/:id', () => {
  assert.equal(deepLinkToPath({ kind: 'announcement', id: 'ann-3' }), '/announcement/ann-3');
});

// `credits` still routes to the SAME SCREEN as `dog-profile` (decision 4) but is
// no longer byte-identical to it: since 1.5.0 it carries `?highlight=credits` so
// the credits card flashes on arrival (Allison 2026-07-29). The distinction the
// arm exists to make — "this alert is about the credits card", not "go to the
// dog" — is now visible in the path. Pins both halves: same route, different query.
test('deepLinkToPath: credits targets the dog-profile route but adds the credits highlight', () => {
  const credits = deepLinkToPath({ kind: 'credits', id: 'dog-7' });
  const dogProfile = deepLinkToPath({ kind: 'dog-profile', id: 'dog-7' });
  assert.equal(credits.split('?')[0], dogProfile);
  assert.equal(credits, `${dogProfile}?highlight=credits`);
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
