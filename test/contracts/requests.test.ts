import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, test } from 'node:test';
import { registerRequestsRoute } from '../../src/routes/requests.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  loadSnapshot,
  makeContractApp,
  registerFixtureHooks,
  registerRequestServicesOn,
} from './_harness.js';
import { waitForBlockedBackends } from './_poolFixture.js';
import * as rs from './_requestServices.js';

registerFixtureHooks();

test(
  'GET /requests returns both fixture requests, newest-submitted first (R1 multi-dog + R8 structured focus on the wire)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerRequestsRoute(app, { authenticate });

    const res = await app.inject({ method: 'GET', url: '/requests' });
    if (res.statusCode !== 200) {
      throw new Error(`/requests returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('requests-list'));
  },
);

test(
  'GET /requests?status=submitted filters down to the submitted fixture request',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerRequestsRoute(app, { authenticate });

    const res = await app.inject({ method: 'GET', url: '/requests?status=submitted' });
    if (res.statusCode !== 200) {
      throw new Error(`/requests?status=submitted returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('requests-submitted'));
  },
);

test(
  'GET /requests?status=converted filters down to the converted fixture request (with approved_at + converted_booking_id, NO notes, focus emits {})',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerRequestsRoute(app, { authenticate });

    const res = await app.inject({ method: 'GET', url: '/requests?status=converted' });
    if (res.statusCode !== 200) {
      throw new Error(`/requests?status=converted returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('requests-converted'));
  },
);

test(
  'GET /requests?status=cancelled returns an empty array (no cancelled requests in fixture)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerRequestsRoute(app, { authenticate });

    const res = await app.inject({ method: 'GET', url: '/requests?status=cancelled' });
    if (res.statusCode !== 200) {
      throw new Error(`/requests?status=cancelled returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), []);
  },
);

test(
  'GET /requests/:id (submitted private-lesson, multi-dog) emits every optional key',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerRequestsRoute(app, { authenticate });

    const res = await app.inject({
      method: 'GET',
      url: `/requests/${FIXTURE_IDS.pendingRequest1Id}`,
    });
    if (res.statusCode !== 200) {
      throw new Error(`/requests/:id returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('request-1'));
  },
);

test(
  'GET /requests/:id (converted board-and-train, single-dog) emits length_weeks + approval keys + omits notes + emits focus:{}',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerRequestsRoute(app, { authenticate });

    const res = await app.inject({
      method: 'GET',
      url: `/requests/${FIXTURE_IDS.pendingRequest2Id}`,
    });
    if (res.statusCode !== 200) {
      throw new Error(`/requests/:id returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('request-2'));
  },
);

test(
  'GET /requests/:id for a non-existent request returns 404 not_found',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerRequestsRoute(app, { authenticate });

    const res = await app.inject({
      method: 'GET',
      url: '/requests/00000000-0000-4000-8000-000000000000',
    });
    assert.equal(res.statusCode, 404);
    const body = res.json() as { error?: { code?: string } };
    assert.equal(body.error?.code, 'not_found');
  },
);

test(
  'GET /requests as a staff principal returns an empty list (owner-only resource)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
    registerRequestsRoute(app, { authenticate });

    const res = await app.inject({ method: 'GET', url: '/requests' });
    if (res.statusCode !== 200) {
      throw new Error(`/requests (staff) returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), []);
  },
);

test(
  'GET /requests/:id as a staff principal returns 404 not_found (no id enumeration)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
    registerRequestsRoute(app, { authenticate });

    const res = await app.inject({
      method: 'GET',
      url: `/requests/${FIXTURE_IDS.pendingRequest1Id}`,
    });
    assert.equal(res.statusCode, 404);
    const body = res.json() as { error?: { code?: string } };
    assert.equal(body.error?.code, 'not_found');
  },
);

test(
  'GET /requests?status=<invalid enum value> returns 400 bad_request',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerRequestsRoute(app, { authenticate });

    const res = await app.inject({ method: 'GET', url: '/requests?status=draft' });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { error?: { code?: string } };
    assert.equal(body.error?.code, 'bad_request');
  },
);

test('GET /requests/<malformed id> returns 400 bad_request', SKIP_WHEN_NO_DB, async () => {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerRequestsRoute(app, { authenticate });

  const res = await app.inject({ method: 'GET', url: '/requests/not-a-uuid' });
  assert.equal(res.statusCode, 400);
  const body = res.json() as { error?: { code?: string } };
  assert.equal(body.error?.code, 'bad_request');
});

// ── P49 (wire 9.0.0; design request-services-v1 §2.2 A4) ────────────────────
//
// A Board & Train is the two-week program, the one with a price, so `length_weeks` is 2
// (Zod still bounds 1..12: 3 is 422, 13 is 400). On a lesson or a Board & Train,
// `focus.staff_preference` is 'any' or a live staff id with a price (lesson) or Board &
// Train eligibility, as GET /trainers lists them; omitted or cleared means "anyone".

describe('P49: what a lesson or a Board & Train request may say', () => {
  registerRequestServicesOn();
  afterEach(rs.clearRequestServiceRows);

  const BT = {
    category: 'board-and-train',
    lead_dog_id: FIXTURE_IDS.dog1Id,
    preferred_dates: [rs.BT_STARTS[0]],
    length_weeks: 2,
  };
  const LESSON = {
    category: 'private-lesson',
    lead_dog_id: FIXTURE_IDS.dog1Id,
    additional_dog_ids: [FIXTURE_IDS.dog2Id],
    preferred_dates: [...rs.LESSON_TIMES],
  };
  const send = (payload: Record<string, unknown>) => rs.post(rs.ownerApp(), '/requests', payload);
  const edit = (id: string, payload: Record<string, unknown>) =>
    rs.ownerApp().inject({
      method: 'PATCH',
      url: `/requests/${id}`,
      headers: { 'idempotency-key': `p49-edit-${randomUUID()}` },
      payload,
    });
  const invalid = (res: { statusCode: number; body: string }) => {
    assert.equal(res.statusCode, 422, res.body);
    assert.equal(rs.errorCode(res), 'invalid_payload', res.body);
  };

  test('a Board & Train for 2 weeks → 201; 3 → 422; 13 → 400 (POST)', SKIP_WHEN_NO_DB, async () => {
    invalid(await send({ ...BT, length_weeks: 3 }));
    const zod = await send({ ...BT, length_weeks: 13 });
    assert.equal(zod.statusCode, 400, zod.body);
    const ok = await send(BT);
    assert.equal(ok.statusCode, 201, ok.body);
  });

  test('PATCH: a Board & Train to 3 weeks → 422, to null → 422, to 2 → 200', SKIP_WHEN_NO_DB, async () => {
    const id = await rs.plantRequest({ category: 'board-and-train' });
    invalid(await edit(id, { length_weeks: 3 }));
    invalid(await edit(id, { length_weeks: null }));
    const ok = await edit(id, { length_weeks: 2 });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal((await rs.requestRow(id))?.lengthWeeks, 2);
  });

  // Opus b1 F8: the edit keeps POST's rules for its category (wire.ts, PatchRequestsRequest),
  // so a lesson or a boarding request takes no length; clearing one (null) stays allowed.
  test('PATCH: length_weeks on a lesson or a boarding request → 422 in words, and nothing is stored', SKIP_WHEN_NO_DB, async () => {
    for (const category of ['private-lesson', 'boarding'] as const) {
      const id = await rs.plantRequest({ category });
      const res = await edit(id, { length_weeks: 2 });
      invalid(res);
      assert.equal(
        rs.errorMessage(res),
        `length_weeks is only valid for board-and-train requests, not ${category}`,
      );
      assert.equal((await rs.requestRow(id))?.lengthWeeks, null);
      const cleared = await edit(id, { length_weeks: null });
      assert.equal(cleared.statusCode, 200, cleared.body);
    }
  });

  test('a slug preference → 422 on POST (a lesson and a Board & Train)', SKIP_WHEN_NO_DB, async () => {
    invalid(await send({ ...LESSON, focus: { staff_preference: 'rachel' } }));
    invalid(await send({ ...BT, focus: { staff_preference: 'rachel' } }));
  });

  test('a slug preference → 422 on PATCH', SKIP_WHEN_NO_DB, async () => {
    const lesson = await rs.plantRequest({ category: 'private-lesson' });
    invalid(await edit(lesson, { focus: { staff_preference: 'rachel' } }));
    const bt = await rs.plantRequest({ category: 'board-and-train' });
    invalid(await edit(bt, { focus: { staff_preference: 'rachel' } }));
  });

  test(
    'a lesson names a priced trainer; a Board & Train an eligible one; an unpriced, ineligible, expired or unknown id → 422',
    SKIP_WHEN_NO_DB,
    async () => {
      invalid(await send({ ...LESSON, focus: { staff_preference: FIXTURE_IDS.staffDonavanId } }));
      invalid(await send({ ...BT, focus: { staff_preference: FIXTURE_IDS.staffAmberId } }));
      invalid(await send({ ...LESSON, focus: { staff_preference: randomUUID() } }));
      await rs.withStaff(FIXTURE_IDS.staffShanthiId, { expiredAt: '2026-05-18T12:00:00.000Z' }, async () => {
        invalid(await send({ ...LESSON, focus: { staff_preference: FIXTURE_IDS.staffShanthiId } }));
      });
      await rs.withStaff(FIXTURE_IDS.staffRachelId, { boardTrainEligible: false }, async () => {
        invalid(await send({ ...BT, focus: { staff_preference: FIXTURE_IDS.staffRachelId } }));
      });

      const lesson = await send({ ...LESSON, focus: { staff_preference: FIXTURE_IDS.staffRachelId } });
      assert.equal(lesson.statusCode, 201, lesson.body);
      const bt = await send({ ...BT, focus: { staff_preference: FIXTURE_IDS.staffShanthiId.toUpperCase() } });
      assert.equal(bt.statusCode, 201, bt.body);
      assert.equal(
        (bt.json() as { focus: { staff_preference?: string } }).focus.staff_preference,
        FIXTURE_IDS.staffShanthiId,
        'a staff id is stored as the staff row spells it',
      );
    },
  );

  test("'any', an omitted preference and a cleared one all mean anyone", SKIP_WHEN_NO_DB, async () => {
    const any = await send({ ...LESSON, focus: { staff_preference: 'any' } });
    assert.equal(any.statusCode, 201, any.body);
    const none = await send(LESSON);
    assert.equal(none.statusCode, 201, none.body);
    const id = await rs.plantRequest({
      category: 'board-and-train',
      staffPreference: FIXTURE_IDS.staffRachelId,
    });
    const cleared = await edit(id, { focus: null });
    assert.equal(cleared.statusCode, 200, cleared.body);
    const emptied = await edit(id, { focus: { staff_preference: '' } });
    assert.equal(emptied.statusCode, 200, emptied.body);
    assert.equal((await rs.requestRow(id))?.staffPreference, null);
  });

  test(
    "her edit racing a staff approve takes the request's row lock: it waits, then loses with 409, and edits nothing (Fable r2 M1)",
    SKIP_WHEN_NO_DB,
    async () => {
      const id = await rs.plantRequest({ category: 'private-lesson' });
      // The approve, held mid-transaction on another connection: it has locked the row and
      // converted it, and has not committed.
      const held = await rs.holdRequestLock(
        id,
        "UPDATE pending_requests SET status = 'converted' WHERE id = $1",
      );
      const answers: Promise<{ statusCode: number; body: string }>[] = [];
      try {
        answers.push(edit(id, { notes: { joint: 'written after the approve' } }));
        await waitForBlockedBackends(1);
        await held.release();
        const res = await (answers[0] as Promise<{ statusCode: number; body: string }>);
        assert.equal(res.statusCode, 409, res.body);
        assert.equal(rs.errorCode(res), 'conflict');
      } finally {
        await held.release();
        await Promise.allSettled(answers);
      }
      const row = await rs.requestRow(id);
      assert.equal(row?.status, 'converted');
      assert.equal(row?.notesJoint, null, 'the edit landed on an approved request');
    },
  );

  test('boarding keeps its free-text preference', SKIP_WHEN_NO_DB, async () => {
    const res = await send({
      category: 'boarding',
      lead_dog_id: FIXTURE_IDS.dog1Id,
      preferred_dates: [rs.BT_STARTS[0]],
      focus: { staff_preference: 'rachel' },
    });
    assert.equal(res.statusCode, 201, res.body);
  });
});
