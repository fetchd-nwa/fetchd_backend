import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, test } from 'node:test';
import { sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { drainInFlight } from '../../src/realtime/settle.js';
import { FIXTURE_IDS } from './_fixture.js';
import { FIXTURE_MANAGER_PRINCIPAL, SKIP_WHEN_NO_DB, registerFixtureHooks } from './_harness.js';
import {
  ownerApp,
  ownerRead,
  ownerSend,
  removeSchoolThreads,
  staffApp,
  staffReply,
  startThread,
} from './_messaging.js';

/**
 * B15b (brief CR33; wire 9.2.0 `MessageWire.reach`: "Never on a GET, a socket frame or an owner
 * route; a conformance test pins that owner routes never emit it"). Every owner messaging route's
 * response, after a staff message whose own 201 DID carry `reach`, is searched for a `reach` key
 * at any depth: there is none.
 */

registerFixtureHooks();
afterEach(async () => {
  await drainInFlight();
  await db.execute(sql`
    DELETE FROM messages WHERE thread_id = ${FIXTURE_IDS.thread1Id}
       AND id NOT IN (${FIXTURE_IDS.message1Id}, ${FIXTURE_IDS.message2Id}, ${FIXTURE_IDS.message3Id},
                      ${FIXTURE_IDS.message4Id}, ${FIXTURE_IDS.message5Id})`);
  await db.execute(
    sql`UPDATE messages SET read_at = NULL WHERE id IN (${FIXTURE_IDS.message4Id}, ${FIXTURE_IDS.message5Id})`,
  );
  await removeSchoolThreads();
});

function reachPaths(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => reachPaths(v, `${path}[${i}]`));
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([k, v]) => [
      ...(k === 'reach' ? [`${path}.${k}`] : []),
      ...reachPaths(v, `${path}.${k}`),
    ]);
  }
  return [];
}

test(
  'B15b: no owner messaging route answers with a reach key, though the staff 201 carries one',
  SKIP_WHEN_NO_DB,
  async () => {
    const T1 = FIXTURE_IDS.thread1Id;
    const staff = await staffReply(staffApp(FIXTURE_MANAGER_PRINCIPAL), T1, {
      text: 'a staff reply with reach',
    });
    assert.equal(staff.statusCode, 201, staff.body);
    assert.deepEqual(
      reachPaths(staff.json()),
      ['$.reach'],
      'the control: the staff 201 does carry it',
    );

    const owner = ownerApp();
    const cmid = randomUUID();
    const send = await ownerSend(owner, T1, { text: 'her reply', client_message_id: cmid });
    const repeat = await ownerSend(owner, T1, { text: 'her reply', client_message_id: cmid });
    const start = await startThread(owner, { category: 'other', text: 'to the school' });
    const responses = [
      send,
      repeat,
      start,
      await owner.inject({ method: 'GET', url: '/threads' }),
      await owner.inject({ method: 'GET', url: `/threads/${T1}` }),
      await owner.inject({ method: 'GET', url: `/threads/${T1}/messages` }),
      await owner.inject({ method: 'GET', url: `/threads/${T1}/messages?after_seq=0` }),
      await ownerRead(owner, T1),
    ];
    for (const res of responses) {
      assert.ok(res.statusCode < 300, `${res.statusCode}: ${res.body}`);
      const body = res.body === '' ? null : (JSON.parse(res.body) as unknown);
      assert.deepEqual(reachPaths(body), [], `${res.body.slice(0, 120)}`);
    }
  },
);
