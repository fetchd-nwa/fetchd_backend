import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerAnnouncementsRoute } from '../../src/routes/announcements.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  loadSnapshot,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';

registerFixtureHooks();

// --- GET /announcements (no filter) ------------------------------------

test(
  'GET /announcements byte-matches §B Announcement list — pinned first, then DESC by published_at, soft-expired row excluded',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerAnnouncementsRoute(app, { authenticate });
    const res = await app.inject({ method: 'GET', url: '/announcements' });
    if (res.statusCode !== 200) {
      throw new Error(`/announcements returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('announcements-all'));
  },
);

// Staff principals see the same catalog — not owner-scoped.
test(
  'GET /announcements as staff returns the same catalog (not owner-scoped)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
    registerAnnouncementsRoute(app, { authenticate });
    const res = await app.inject({ method: 'GET', url: '/announcements' });
    assert.equal(res.statusCode, 200);
    assert.deepStrictEqual(res.json(), loadSnapshot('announcements-all'));
  },
);

// --- GET /announcements?location=fayetteville --------------------------

test(
  'GET /announcements?location=fayetteville returns NULL-target rows + fayetteville-targeted rows (bentonville-targeted row excluded)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerAnnouncementsRoute(app, { authenticate });
    const res = await app.inject({
      method: 'GET',
      url: '/announcements?location=fayetteville',
    });
    if (res.statusCode !== 200) {
      throw new Error(
        `/announcements?location=fayetteville returned ${res.statusCode}: ${res.body}`,
      );
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('announcements-fayetteville'));
  },
);

// --- GET /announcements?location=bentonville ---------------------------

test(
  'GET /announcements?location=bentonville returns NULL-target rows + bentonville-targeted rows (fayetteville-targeted row excluded)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerAnnouncementsRoute(app, { authenticate });
    const res = await app.inject({
      method: 'GET',
      url: '/announcements?location=bentonville',
    });
    if (res.statusCode !== 200) {
      throw new Error(
        `/announcements?location=bentonville returned ${res.statusCode}: ${res.body}`,
      );
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('announcements-bentonville'));
  },
);

// --- 400 branches -------------------------------------------------------

test(
  'GET /announcements?location=Mars returns 400 (not in location_key enum)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerAnnouncementsRoute(app, { authenticate });
    const res = await app.inject({ method: 'GET', url: '/announcements?location=Mars' });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { error?: { code?: string } };
    assert.equal(body.error?.code, 'bad_request');
  },
);
