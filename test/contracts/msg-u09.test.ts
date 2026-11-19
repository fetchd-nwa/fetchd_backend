import assert from 'node:assert/strict';
import { after, afterEach, describe, test } from 'node:test';
import { sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { buildApp } from '../../src/server.js';
import { FIXTURE_IDS } from './_fixture.js';
import { SKIP_WHEN_NO_DB, readSchoolAccount, registerFixtureHooks } from './_harness.js';
import { getJson, ownerApp, ownerSend, removeSchoolThreads, startThread } from './_messaging.js';

/**
 * MSG-U09 (S45; design §2.9:4554, as signed: "MSG-U09 shrinks to S"): an owner's message
 * reaches the staff who answer for it.
 *   · Its addressee-routing arms are GREEN at pass 1: a message in a trainer-addressed thread
 *     stays that trainer's; a family's start addresses the SCHOOL, whatever the default
 *     responder (Amber) and backup (Shanthi) keys hold or the out switch says — the
 *     responder keys are stored and preflight-checked but read by nothing in v1.
 *   · Its bell arm is pass 1's ONE EXPECTED RED (plan.json P45 `pass_plan`, edge MSG-U09 →
 *     NOTIF-U33): an owner's message in a school thread lands on the staff portal bell's
 *     unread count, `GET /staff/notifications/summary`, which is S46's (backend pass 2). It
 *     runs on the real `buildApp()` and the dev principal, so it goes green wherever pass 2
 *     registers that route.
 */

registerFixtureHooks();
afterEach(() => removeSchoolThreads());
after(async () => {
  await db.execute(sql`
    UPDATE messaging_settings
       SET school_default_responder_staff_id = NULL, school_backup_responder_staff_id = NULL,
           school_default_responder_out = false`);
});

async function setResponders(out: boolean): Promise<void> {
  await db.execute(sql`
    UPDATE messaging_settings
       SET school_default_responder_staff_id = ${FIXTURE_IDS.staffAmberId},
           school_backup_responder_staff_id = ${FIXTURE_IDS.staffShanthiId},
           school_default_responder_out = ${out}`);
}

describe('MSG-U09: an owner’s message reaches the staff who answer for it', () => {
  test(
    'MSG-U09 (trainer arm): an owner’s message in a trainer-addressed thread stays that trainer’s',
    SKIP_WHEN_NO_DB,
    async () => {
      const app = ownerApp();
      const res = await ownerSend(app, FIXTURE_IDS.thread1Id, { text: 'For Donavan only' });
      assert.equal(res.statusCode, 201, res.body);
      const thread = await getJson<{ participant: { id: string; is_school?: true } }>(
        app,
        `/threads/${FIXTURE_IDS.thread1Id}`,
      );
      assert.equal(thread.participant.id, FIXTURE_IDS.staffDonavanId);
      assert.equal('is_school' in thread.participant, false);
      await db.execute(
        sql`DELETE FROM messages WHERE thread_id = ${FIXTURE_IDS.thread1Id} AND text = 'For Donavan only'`,
      );
    },
  );

  test(
    'MSG-U09 (default responder arm): with Amber the default responder, a start addresses the school, not her',
    SKIP_WHEN_NO_DB,
    async () => {
      const school = await readSchoolAccount();
      await setResponders(false);
      const res = await startThread(ownerApp(), { category: 'sessions', text: 'Who answers?' });
      assert.equal(res.statusCode, 201, res.body);
      const { thread } = res.json() as {
        thread: { participant: { id: string; is_school?: true } };
      };
      assert.equal(thread.participant.id, school.id);
      assert.equal(thread.participant.is_school, true);
    },
  );

  test(
    'MSG-U09 (backup arm): with the default responder out and Shanthi the backup, a start still addresses the school',
    SKIP_WHEN_NO_DB,
    async () => {
      const school = await readSchoolAccount();
      await setResponders(true);
      const res = await startThread(ownerApp(), { category: 'billing', text: 'Anyone in?' });
      assert.equal(res.statusCode, 201, res.body);
      const { thread } = res.json() as { thread: { participant: { id: string } } };
      assert.equal(thread.participant.id, school.id);
    },
  );

  test(
    'MSG-U09 (expected red until pass 2): an owner’s message in a school thread lands on the staff portal bell’s unread count (NOTIF-U33)',
    SKIP_WHEN_NO_DB,
    async () => {
      const res = await startThread(ownerApp(), { category: 'other', text: 'Ring the bell' });
      assert.equal(res.statusCode, 201, res.body);
      const app = buildApp();
      try {
        // Amber, a manager: a school thread is addressed to every owner- and manager-role
        // staffer (question 72). The fixture family is at Fayetteville.
        const bell = await app.inject({
          method: 'GET',
          url: '/staff/notifications/summary',
          headers: { 'x-dev-principal': `staff:${FIXTURE_IDS.staffAmberId}:manager` },
        });
        assert.equal(bell.statusCode, 200, bell.body);
        const body = bell.json() as {
          by_location: Record<string, { unread_client_threads: number; pending_requests: number }>;
        };
        assert.equal(body.by_location['fayetteville']?.unread_client_threads, 1);
        assert.equal(body.by_location['bentonville']?.unread_client_threads, 0);
      } finally {
        await app.close();
      }
    },
  );
});
