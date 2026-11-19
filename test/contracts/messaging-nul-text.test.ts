import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, describe, test } from 'node:test';
import { sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  SKIP_WHEN_NO_DB,
  makeLogCapture,
  plantFamily,
  registerFixtureHooks,
  removeFamilies,
  type LogCapture,
} from './_harness.js';
import {
  ownerApp,
  ownerSend,
  removeSchoolThreads,
  staffApp,
  staffReply,
  staffStart,
  startThread,
} from './_messaging.js';
import { makeR2Stub } from './_r2Stub.js';

/**
 * A1 (the Fable pass-1 audit's H1): a NUL byte (U+0000), which Postgres will not store in `text`,
 * in any string a messaging verb writes to a `text` column is refused at the schema, before any
 * database call: 400 `bad_request` on the owner verbs and on `POST /staff/threads`, and the staff
 * reply's own 422 `invalid_payload` (its schema's failures are 422 by the contract,
 * `PostStaffThreadsMessagesRequest`'s "Status asymmetry"). Never Postgres' 22021, a 500 that pages,
 * and nothing is stored. A lone surrogate is not refused.
 */

registerFixtureHooks();
afterEach(async () => {
  await removeSchoolThreads();
});
after(removeFamilies);

function pagerLines(capture: LogCapture): Array<Record<string, unknown>> {
  return capture.lines.filter(
    (l) => typeof l['level'] === 'number' && (l['level'] as number) >= 50,
  );
}

async function messageCount(): Promise<number> {
  const { rows } = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM messages`);
  return rows[0]?.n ?? 0;
}

const NUL = 'a\u0000b';

describe('A1: a NUL byte in a messaging text field', () => {
  test(
    'POST /threads: in text or subtopic, 400, nothing stored, nothing paged',
    SKIP_WHEN_NO_DB,
    async () => {
      const capture = makeLogCapture();
      const app = ownerApp(undefined, makeR2Stub(), capture);
      const before = await messageCount();
      for (const body of [
        { category: 'sessions', text: NUL },
        { category: 'sessions', text: 'hi', subtopic: NUL },
      ]) {
        const res = await startThread(app, body);
        assert.equal(res.statusCode, 400, `${JSON.stringify(body)}: ${res.body}`);
        assert.equal(res.json().error.code, 'bad_request');
      }
      assert.equal(await messageCount(), before);
      assert.deepEqual(pagerLines(capture), []);
    },
  );

  test(
    'POST /threads/:id/messages: 400, nothing stored, nothing paged',
    SKIP_WHEN_NO_DB,
    async () => {
      const capture = makeLogCapture();
      const before = await messageCount();
      const res = await ownerSend(
        ownerApp(undefined, makeR2Stub(), capture),
        FIXTURE_IDS.thread1Id,
        { text: NUL },
      );
      assert.equal(res.statusCode, 400, res.body);
      assert.equal(res.json().error.code, 'bad_request');
      assert.equal(await messageCount(), before);
      assert.deepEqual(pagerLines(capture), []);
    },
  );

  test(
    'POST /staff/threads/:id/messages: its 422, nothing stored, nothing paged',
    SKIP_WHEN_NO_DB,
    async () => {
      const capture = makeLogCapture();
      const before = await messageCount();
      const res = await staffReply(
        staffApp(undefined, makeR2Stub(), undefined, capture),
        FIXTURE_IDS.thread1Id,
        {
          text: NUL,
        },
      );
      assert.equal(res.statusCode, 422, res.body);
      assert.equal(res.json().error.code, 'invalid_payload');
      assert.equal(await messageCount(), before);
      assert.deepEqual(pagerLines(capture), []);
    },
  );

  test('POST /staff/threads: 400, nothing stored, nothing paged', SKIP_WHEN_NO_DB, async () => {
    const family = await plantFamily();
    const capture = makeLogCapture();
    const before = await messageCount();
    const res = await staffStart(staffApp(undefined, makeR2Stub(), undefined, capture), {
      owner_id: family.ownerId,
      category: 'other',
      text: NUL,
    });
    assert.equal(res.statusCode, 400, res.body);
    assert.equal(res.json().error.code, 'bad_request');
    assert.equal(await messageCount(), before);
    assert.deepEqual(pagerLines(capture), []);
  });

  test('a lone surrogate is not a NUL: it is stored', SKIP_WHEN_NO_DB, async () => {
    const res = await startThread(ownerApp(), {
      category: 'other',
      text: `half a pair \ud83d`,
      client_message_id: randomUUID(),
    });
    assert.equal(res.statusCode, 201, res.body);
  });
});
