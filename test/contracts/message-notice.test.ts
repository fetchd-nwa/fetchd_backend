import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, test } from 'node:test';
import { sql } from 'drizzle-orm';
import { db } from '../_poolBoundDb.js';
import type { ExpoPushClient, ExpoPushMessage } from '../../src/lib/expoPush.js';
import {
  countLostStaffMessagePushes,
  reportLostStaffMessagePushes,
  sendStaffMessagePush,
} from '../../src/lib/messageNotice.js';
import { drainInFlight } from '../../src/realtime/settle.js';
import { registerDeviceTokensRoute } from '../../src/routes/device-tokens.js';
import type { Principal } from '../../src/auth/principal.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_MANAGER_PRINCIPAL,
  FIXTURE_OWNER_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  makeLogCapture,
  plantFamily,
  registerFixtureHooks,
  removeFamilies,
  type LogCapture,
  type PlantedFamily,
} from './_harness.js';
import { makeExpoPushStub, type ExpoPushStub } from './_expoPushStub.js';
import {
  getJson,
  ownerApp,
  ownerSend,
  plantStaffMedia,
  removePlantedMedia,
  removePlantedStaffTraces,
  staffApp,
  staffReply,
  staffStart,
  startThread,
} from './_messaging.js';
import { makeR2Stub } from './_r2Stub.js';

/**
 * The direct push and `reach` (design messaging-live-v1 A1.2, A1 D4/D5/D8, A2 FL2–FL4, FH1,
 * FM1, FM2; brief LR5; wire 9.2.0 `NoticeReachWire`, `MessageWire.reach`,
 * `NotificationPushData.thread_id`):
 *   · each staff message (the reply, `POST /staff/threads`) writes one feed row and answers with
 *     `reach`: `push`/`device`, `feed-only`/`push-off`, `feed-only`/`no-device`, or
 *     `none`/`not-queued` when the notice itself could not be written (FL2, in a savepoint);
 *   · after commit, never awaited, ONE push per message (claimed in `message_pushes`), to every
 *     live device of the family, titled with the name her thread shows on it, its body her words
 *     cut at 140 or *Amber sent a photo*, carrying `thread_id`, `notification_id` and `badge`;
 *   · no retry; nothing un-awaited can reject (FH1); the boot count counts only lost pushes.
 */

registerFixtureHooks();

let family: PlantedFamily;
let threadId: string;
const planted: string[] = [];

before(async () => {
  if (SKIP_WHEN_NO_DB.skip !== false) return;
  family = await plantFamily('The Hendersons');
  const res = await startThread(ownerApp(family.principal), {
    category: 'sessions',
    text: 'Hello school',
  });
  assert.equal(res.statusCode, 201, res.body);
  threadId = (res.json() as { thread: { id: string } }).thread.id;
});

afterEach(async () => {
  await drainInFlight();
  await db.execute(
    sql`DELETE FROM device_tokens WHERE owner_id IN (${family.ownerId}, ${FIXTURE_IDS.ownerId})`,
  );
  await db.execute(
    sql`UPDATE owners SET push_notifications_enabled = true WHERE id = ${family.ownerId}`,
  );
  await db.execute(sql`
    DELETE FROM messages WHERE thread_id = ${threadId} AND sender_kind = 'staff'`);
  await db.execute(sql`UPDATE messages SET read_at = NULL WHERE thread_id = ${threadId}`);
  await db.execute(sql`
    DELETE FROM messages WHERE thread_id = ${FIXTURE_IDS.thread1Id}
       AND id NOT IN (${FIXTURE_IDS.message1Id}, ${FIXTURE_IDS.message2Id}, ${FIXTURE_IDS.message3Id},
                      ${FIXTURE_IDS.message4Id}, ${FIXTURE_IDS.message5Id})`);
  await db.execute(sql`UPDATE messaging_settings SET reply_signature_mode = 'staffer_first_name'`);
  await removePlantedMedia(planted.splice(0));
  // A staff-started thread and the feed rows name a fixture staffer: gone before its staff are.
  await removePlantedStaffTraces();
});
after(async () => {
  await db.execute(
    sql`DELETE FROM threads WHERE owner_id = ${FIXTURE_IDS.ownerId} AND id NOT IN (${FIXTURE_IDS.thread1Id}, ${FIXTURE_IDS.thread2Id})`,
  );
  await removeFamilies();
});

type Reach = { channel: string; why: string };
type Msg = { id: string; text: string; seq: number; reach?: Reach };

const AMBER_APP = (stub: ExpoPushClient, capture?: LogCapture) =>
  staffApp(FIXTURE_MANAGER_PRINCIPAL, makeR2Stub(), stub, capture);

async function giveToken(
  ownerId: string,
  token = `ExponentPushToken[${randomUUID()}]`,
): Promise<string> {
  await db.execute(sql`
    INSERT INTO device_tokens (owner_id, expo_push_token, platform) VALUES (${ownerId}, ${token}, 'ios')`);
  return token;
}

function sent(stub: ExpoPushStub): ExpoPushMessage[] {
  return stub.calls.flatMap((c) => c.messages);
}

/** The stub behind a real delay: Expo answers in tens of milliseconds, never in the same tick. */
function slowed(stub: ExpoPushStub, ms = 40): ExpoPushClient {
  return {
    async sendBatch(messages) {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return stub.sendBatch(messages);
    },
  };
}

/** `String.prototype.isWellFormed` (ES2024; the tree's lib is ES2022): no lone surrogate. */
function wellFormed(text: string): boolean {
  return (text as unknown as { isWellFormed(): boolean }).isWellFormed();
}

async function claimOf(
  messageId: string,
): Promise<
  | { notification_id: string | null; tickets_ok: number | null; tickets_error: number | null }
  | undefined
> {
  const { rows } = await db.execute<{
    notification_id: string | null;
    tickets_ok: number | null;
    tickets_error: number | null;
  }>(
    sql`SELECT notification_id::text, tickets_ok, tickets_error FROM message_pushes WHERE message_id = ${messageId}`,
  );
  return rows[0];
}

async function feedRowsFor(
  ownerId: string,
): Promise<Array<{ id: string; title: string; body: string }>> {
  const { rows } = await db.execute<{ id: string; title: string; body: string }>(sql`
    SELECT id::text, title, body FROM notifications
     WHERE owner_id = ${ownerId} AND type = 'message-received' ORDER BY created_at DESC, id`);
  return rows;
}

function warnLines(capture: LogCapture, msg: string): Array<Record<string, unknown>> {
  return capture.lines.filter(
    (l) => l['level'] === 40 && typeof l['msg'] === 'string' && (l['msg'] as string).includes(msg),
  );
}

function pagerLines(capture: LogCapture): Array<Record<string, unknown>> {
  return capture.lines.filter(
    (l) => typeof l['level'] === 'number' && (l['level'] as number) >= 50,
  );
}

/** Watch the process for an escape from an un-awaited path (FH1). */
function watchEscapes(): { seen: unknown[]; stop(): void } {
  const seen: unknown[] = [];
  const onRejection = (reason: unknown): void => {
    seen.push(reason);
  };
  const onException = (err: unknown): void => {
    seen.push(err);
  };
  process.on('unhandledRejection', onRejection);
  process.on('uncaughtException', onException);
  return {
    seen,
    stop() {
      process.off('unhandledRejection', onRejection);
      process.off('uncaughtException', onException);
    },
  };
}

async function settle(): Promise<void> {
  await drainInFlight();
  // One more turn, so an escape from an UNtracked path (a mutant's) has fired by the time we look.
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe('reach: the four answers (A1 D4, A-B3)', () => {
  test('a live device: push/device, and one push to it', SKIP_WHEN_NO_DB, async () => {
    const stub = makeExpoPushStub();
    const token = await giveToken(family.ownerId);
    const res = await staffReply(AMBER_APP(stub), threadId, { text: 'We saw Biscuit today' });
    assert.equal(res.statusCode, 201, res.body);
    assert.deepEqual((res.json() as Msg).reach, { channel: 'push', why: 'device' });
    await settle();
    assert.deepEqual(
      sent(stub).map((m) => m.to),
      [token],
    );
  });

  test(
    'A-B3: push off: feed-only/push-off, no push, the claim stamped 0/0',
    SKIP_WHEN_NO_DB,
    async () => {
      const stub = makeExpoPushStub();
      await giveToken(family.ownerId);
      await db.execute(
        sql`UPDATE owners SET push_notifications_enabled = false WHERE id = ${family.ownerId}`,
      );
      const res = await staffReply(AMBER_APP(stub), threadId, { text: 'push is off' });
      assert.equal(res.statusCode, 201, res.body);
      const msg = res.json() as Msg;
      assert.deepEqual(msg.reach, { channel: 'feed-only', why: 'push-off' });
      await settle();
      assert.equal(sent(stub).length, 0);
      const claim = await claimOf(msg.id);
      assert.equal(claim?.tickets_ok, 0);
      assert.equal(claim?.tickets_error, 0);
      assert.equal(
        (await feedRowsFor(family.ownerId))[0]?.body,
        'push is off',
        'the feed row is still written',
      );
    },
  );

  test('A-B3: no live device: feed-only/no-device, no push', SKIP_WHEN_NO_DB, async () => {
    const stub = makeExpoPushStub();
    const res = await staffReply(AMBER_APP(stub), threadId, { text: 'no phone' });
    assert.equal(res.statusCode, 201, res.body);
    assert.deepEqual((res.json() as Msg).reach, { channel: 'feed-only', why: 'no-device' });
    await settle();
    assert.equal(sent(stub).length, 0);
  });

  test(
    'FL2: the feed row failing to write: 201, the message stands, none/not-queued, one warn, no push, no claim',
    SKIP_WHEN_NO_DB,
    async () => {
      const stub = makeExpoPushStub();
      await giveToken(family.ownerId);
      const capture = makeLogCapture();
      const fn = `fl2_refuse_${randomUUID().replaceAll('-', '')}`;
      await db.execute(
        sql.raw(`
        CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.owner_id = '${family.ownerId}' THEN RAISE EXCEPTION 'FL2: the feed refuses'; END IF;
          RETURN NEW;
        END $$`),
      );
      await db.execute(
        sql.raw(
          `CREATE TRIGGER ${fn} BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
        ),
      );
      let res;
      try {
        res = await staffReply(AMBER_APP(stub, capture), threadId, { text: 'the feed is down' });
      } finally {
        await db.execute(sql.raw(`DROP TRIGGER ${fn} ON notifications`));
        await db.execute(sql.raw(`DROP FUNCTION ${fn}()`));
      }
      const { rows } = await db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = ${fn}`,
      );
      assert.equal(rows[0]?.n, 0, 'the test trigger is gone');
      assert.equal(res.statusCode, 201, res.body);
      const msg = res.json() as Msg;
      assert.deepEqual(msg.reach, { channel: 'none', why: 'not-queued' });
      await settle();
      assert.equal(sent(stub).length, 0, 'no push');
      assert.equal(await claimOf(msg.id), undefined, 'no claim');
      const { rows: stored } = await db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM messages WHERE id = ${msg.id}`,
      );
      assert.equal(stored[0]?.n, 1, 'the message commits');
      assert.equal(warnLines(capture, 'staff message notice failed').length, 1);
      assert.deepEqual(pagerLines(capture), []);
    },
  );
});

describe('the push itself (A1.2, FM1, FL3)', () => {
  test(
    'FM1-a + FL3: the push carries thread_id, the feed row’s notification_id and the badge of her unread school messages',
    SKIP_WHEN_NO_DB,
    async () => {
      const stub = makeExpoPushStub();
      await giveToken(family.ownerId);
      const app = AMBER_APP(stub);
      const first = (await staffReply(app, threadId, { text: 'one' })).json() as Msg;
      await settle();
      const second = (await staffReply(app, threadId, { text: 'two' })).json() as Msg;
      await settle();
      const [p1, p2] = sent(stub);
      assert.equal(p1?.data?.['thread_id'], threadId);
      assert.equal(p1?.data?.['type'], 'message-received');
      assert.equal(p1?.data?.['deep_link_path'], `/chat/${threadId}`);
      assert.equal(p1?.badge, 1);
      assert.equal(p2?.badge, 2, 'two unread school messages now');
      const [newest, older] = await feedRowsFor(family.ownerId);
      assert.equal(p2?.data?.['notification_id'], newest?.id);
      assert.equal(p1?.data?.['notification_id'], older?.id);
      assert.equal(
        (await claimOf(second.id))?.notification_id,
        newest?.id,
        'stored on the claim (FL3)',
      );
      assert.equal((await claimOf(first.id))?.tickets_ok, 1);
    },
  );

  test(
    'the words: the title is the name her thread shows (first name, or the school’s under school_name), the body cut at 140 or “Amber sent a photo”',
    SKIP_WHEN_NO_DB,
    async () => {
      await db.execute(
        sql`UPDATE staff SET name = 'Amber Lee' WHERE id = ${FIXTURE_IDS.staffAmberId}`,
      );
      try {
        const stub = makeExpoPushStub();
        await giveToken(family.ownerId);
        const app = AMBER_APP(stub);
        const long = 'x'.repeat(150);
        assert.equal((await staffReply(app, threadId, { text: long })).statusCode, 201);
        await settle();
        const photo = await plantStaffMedia(family.ownerId);
        planted.push(photo);
        assert.equal(
          (await staffReply(app, threadId, { attachment_media_ids: [photo] })).statusCode,
          201,
        );
        await settle();
        await db.execute(sql`UPDATE messaging_settings SET reply_signature_mode = 'school_name'`);
        assert.equal(
          (await staffReply(app, threadId, { text: 'From the school' })).statusCode,
          201,
        );
        await settle();
        const pushes = sent(stub);
        assert.deepEqual(
          pushes.map((p) => [p.title, p.body]),
          [
            ['Amber', `${'x'.repeat(137)}…`],
            ['Amber', 'Amber sent a photo'],
            ['NWA School for Dogs', 'From the school'],
          ],
        );
        // The feed row keeps its title; an attachment-only reply's body is the same sentence.
        const feed = await feedRowsFor(family.ownerId);
        assert.deepEqual(
          feed.slice(0, 3).map((f) => [f.title, f.body]),
          [
            ['New message', 'From the school'],
            ['New message', 'Amber sent a photo'],
            ['New message', `${'x'.repeat(137)}…`],
          ],
        );
      } finally {
        await db.execute(
          sql`UPDATE staff SET name = 'Amber' WHERE id = ${FIXTURE_IDS.staffAmberId}`,
        );
      }
    },
  );

  test(
    'her answer 4 (M3): the badge is her unread school messages only: two unread school messages, one unread notice and one message of her own give 2, as her Messages tab counts',
    SKIP_WHEN_NO_DB,
    async () => {
      const stub = makeExpoPushStub();
      await giveToken(family.ownerId);
      const noticeId = randomUUID();
      await db.execute(sql`
        INSERT INTO notifications (id, owner_id, type, title, body)
        VALUES (${noticeId}, ${family.ownerId}, 'announcement', 'Closed Friday',
                'The school is closed on Friday.')`);
      let ownId: string | undefined;
      try {
        const own = await ownerSend(ownerApp(family.principal), threadId, { text: 'her own' });
        assert.equal(own.statusCode, 201, own.body);
        ownId = (own.json() as Msg).id;
        const app = AMBER_APP(slowed(stub));
        assert.equal((await staffReply(app, threadId, { text: 'one' })).statusCode, 201);
        await settle();
        assert.equal((await staffReply(app, threadId, { text: 'two' })).statusCode, 201);
        await settle();
        assert.deepEqual(
          sent(stub).map((p) => p.badge),
          [1, 2],
          'the badge counts her unread school messages: not the notice, not her own message',
        );
        const tab = await getJson<Array<{ unread_count: number }>>(
          ownerApp(family.principal),
          '/threads',
        );
        assert.equal(
          tab.reduce((n, t) => n + t.unread_count, 0),
          2,
          'her Messages tab counts the same 2',
        );
      } finally {
        await db.execute(sql`DELETE FROM notifications WHERE id = ${noticeId}`);
        if (ownId !== undefined) await db.execute(sql`DELETE FROM messages WHERE id = ${ownId}`);
      }
    },
  );

  test(
    'L1: the 140 cut counts code points, never UTF-16 units: no emoji is cut in half, in the push or the feed row',
    SKIP_WHEN_NO_DB,
    async () => {
      const stub = makeExpoPushStub();
      await giveToken(family.ownerId);
      const app = AMBER_APP(slowed(stub));
      const cases: Array<[text: string, body: string]> = [
        // 139 code points (142 UTF-16 units): under 140, so nothing is cut.
        [`${'x'.repeat(136)}😀😀😀`, `${'x'.repeat(136)}😀😀😀`],
        // 71 emoji: 71 code points, 142 units: nothing is cut.
        ['😀'.repeat(71), '😀'.repeat(71)],
        // 141 emoji: cut to 137 code points and the ellipsis.
        ['😀'.repeat(141), `${'😀'.repeat(137)}…`],
        // Exactly 140, then 141, plain letters.
        ['y'.repeat(140), 'y'.repeat(140)],
        ['z'.repeat(141), `${'z'.repeat(137)}…`],
      ];
      for (const [text] of cases) {
        assert.equal((await staffReply(app, threadId, { text })).statusCode, 201);
        await settle();
      }
      const bodies = sent(stub).map((p) => p.body);
      for (const body of bodies) {
        assert.ok(wellFormed(body), `a lone surrogate in the push body ${JSON.stringify(body)}`);
      }
      assert.deepEqual(
        bodies.map((b) => [...b].length),
        [139, 71, 138, 140, 138],
        'code points per push body',
      );
      assert.deepEqual(
        bodies,
        cases.map(([, body]) => body),
      );
      const feed = (await feedRowsFor(family.ownerId)).slice(0, cases.length).reverse();
      for (const row of feed) {
        assert.equal(row.body.includes('�'), false, `U+FFFD in the feed row ${row.body}`);
      }
      assert.deepEqual(
        feed.map((f) => f.body),
        cases.map(([, body]) => body),
        'the feed row holds the same words as the push',
      );
    },
  );

  test(
    'POST /staff/threads notifies the same way: reach on its 201, one push',
    SKIP_WHEN_NO_DB,
    async () => {
      const stub = makeExpoPushStub();
      await giveToken(family.ownerId);
      const res = await staffStart(AMBER_APP(stub), {
        owner_id: family.ownerId,
        category: 'billing',
        text: 'About your package',
      });
      assert.equal(res.statusCode, 201, res.body);
      assert.deepEqual((res.json() as { message: Msg }).message.reach, {
        channel: 'push',
        why: 'device',
      });
      await settle();
      assert.equal(sent(stub).length, 1);
      assert.equal(
        sent(stub)[0]?.title,
        'Amber',
        'a staff-started thread is not a school thread: her name',
      );
    },
  );
});

describe('at most once, never awaited, nothing escapes (A-B1, A-B2, A-B4, A-B5, FL4, FH1-a)', () => {
  test(
    'A-B1: a POST replayed three times with one key: one Expo message',
    SKIP_WHEN_NO_DB,
    async () => {
      const stub = makeExpoPushStub();
      await giveToken(family.ownerId);
      const app = AMBER_APP(stub);
      const key = `ab1-${randomUUID()}`;
      for (let i = 0; i < 3; i += 1) {
        const res = await staffReply(app, threadId, { text: 'once only' }, key);
        assert.equal(res.statusCode, 201, res.body);
        assert.deepEqual(
          (res.json() as Msg).reach,
          { channel: 'push', why: 'device' },
          'a key replay keeps reach',
        );
        await settle();
      }
      assert.equal(sent(stub).length, 1);
    },
  );

  test(
    'A-B1: a client_message_id repeat answers 200 without reach and sends nothing more',
    SKIP_WHEN_NO_DB,
    async () => {
      const stub = makeExpoPushStub();
      await giveToken(family.ownerId);
      const app = AMBER_APP(stub);
      const cmid = randomUUID();
      assert.equal(
        (await staffReply(app, threadId, { text: 'with an id', client_message_id: cmid }))
          .statusCode,
        201,
      );
      await settle();
      const again = await staffReply(app, threadId, {
        text: 'with an id',
        client_message_id: cmid,
      });
      assert.equal(again.statusCode, 200, again.body);
      assert.equal('reach' in (again.json() as Msg), false);
      await settle();
      assert.equal(sent(stub).length, 1);
    },
  );

  test(
    'A-B2: Expo throwing: 201, the message and its feed row, one warn, no second attempt',
    SKIP_WHEN_NO_DB,
    async () => {
      const stub = makeExpoPushStub();
      stub.throwOnNextBatch();
      await giveToken(family.ownerId);
      const capture = makeLogCapture();
      const res = await staffReply(AMBER_APP(stub, capture), threadId, { text: 'Expo is down' });
      assert.equal(res.statusCode, 201, res.body);
      await settle();
      assert.equal(stub.calls.length, 1, 'no second attempt');
      assert.equal(warnLines(capture, 'Expo failed').length, 1);
      assert.deepEqual(pagerLines(capture), []);
      const claim = await claimOf((res.json() as Msg).id);
      assert.deepEqual([claim?.tickets_ok, claim?.tickets_error], [0, 1]);
      assert.equal((await feedRowsFor(family.ownerId))[0]?.body, 'Expo is down');
    },
  );

  test('A-B2: Expo timing out (the 10 s abort): the same', SKIP_WHEN_NO_DB, async () => {
    let calls = 0;
    const aborting: ExpoPushClient = {
      async sendBatch() {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 30));
        throw new Error('expo push: aborted after 10000 ms');
      },
    };
    await giveToken(family.ownerId);
    const capture = makeLogCapture();
    const res = await staffReply(AMBER_APP(aborting, capture), threadId, { text: 'Expo stalls' });
    assert.equal(res.statusCode, 201, res.body);
    await settle();
    assert.equal(calls, 1);
    assert.equal(warnLines(capture, 'Expo failed').length, 1);
  });

  test('A-B4: the 201 does not wait for a stalled Expo', SKIP_WHEN_NO_DB, async () => {
    let release: () => void = () => undefined;
    let pending = true;
    const stalled: ExpoPushClient = {
      async sendBatch(messages) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        pending = false;
        return messages.map(() => ({ status: 'ok' as const }));
      },
    };
    await giveToken(family.ownerId);
    const reply = staffReply(AMBER_APP(stalled), threadId, { text: 'while Expo stalls' });
    const res = await Promise.race([
      reply,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 3000)),
    ]);
    try {
      assert.notEqual(res, 'timeout', 'the 201 waited for Expo');
      assert.equal((res as Awaited<typeof reply>).statusCode, 201);
      assert.equal(pending, true, 'Expo was still stalled when the 201 arrived');
    } finally {
      // Let the stalled push reach Expo, then finish.
      for (let i = 0; i < 100 && pending; i += 1) {
        release();
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await reply;
      await settle();
    }
  });

  test(
    'A-B4 on POST /staff/threads (L4): the 201 does not wait for a stalled Expo',
    SKIP_WHEN_NO_DB,
    async () => {
      let release: () => void = () => undefined;
      let pending = true;
      const stalled: ExpoPushClient = {
        async sendBatch(messages) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          pending = false;
          return messages.map(() => ({ status: 'ok' as const }));
        },
      };
      await giveToken(family.ownerId);
      const start = staffStart(AMBER_APP(stalled), {
        owner_id: family.ownerId,
        category: 'billing',
        text: 'while Expo stalls',
      });
      const res = await Promise.race([
        start,
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 3000)),
      ]);
      try {
        assert.notEqual(res, 'timeout', 'the 201 waited for Expo');
        assert.equal((res as Awaited<typeof start>).statusCode, 201);
        assert.equal(pending, true, 'Expo was still stalled when the 201 arrived');
      } finally {
        // Let the stalled push reach Expo, then finish.
        for (let i = 0; i < 100 && pending; i += 1) {
          release();
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        await start;
        await settle();
      }
    },
  );

  test(
    'M3: Expo refusing a ticket: one sendBatch, the claim 0/1, one warn, no level-50 line; a key replay sends nothing more',
    SKIP_WHEN_NO_DB,
    async () => {
      const stub = makeExpoPushStub();
      const token = await giveToken(family.ownerId);
      stub.setNextBatchTickets([
        {
          status: 'error',
          message: `"${token}" is not a registered push notification recipient`,
          details: { error: 'DeviceNotRegistered' },
        },
      ]);
      const capture = makeLogCapture();
      const app = AMBER_APP(slowed(stub), capture);
      const key = `refused-${randomUUID()}`;
      const res = await staffReply(app, threadId, { text: 'Expo refuses this one' }, key);
      assert.equal(res.statusCode, 201, res.body);
      await settle();
      const again = await staffReply(app, threadId, { text: 'Expo refuses this one' }, key);
      assert.equal(again.statusCode, 201, again.body);
      await settle();
      assert.equal(
        stub.calls.length,
        1,
        'one sendBatch: no second attempt, and the replay sends nothing',
      );
      const claim = await claimOf((res.json() as Msg).id);
      assert.deepEqual([claim?.tickets_ok, claim?.tickets_error], [0, 1]);
      assert.equal(warnLines(capture, 'Expo refused some tickets').length, 1);
      assert.deepEqual(pagerLines(capture), []);
    },
  );

  test(
    'A-B5: a family’s message pushes nothing, and sendStaffMessagePush refuses one',
    SKIP_WHEN_NO_DB,
    async () => {
      const stub = makeExpoPushStub();
      await giveToken(FIXTURE_IDS.ownerId);
      const res = await ownerSend(ownerApp(), FIXTURE_IDS.thread1Id, { text: 'from the family' });
      assert.equal(res.statusCode, 201, res.body);
      const id = (res.json() as Msg).id;
      const [feed] = await feedRowsFor(FIXTURE_IDS.ownerId);
      await sendStaffMessagePush(id, feed?.id ?? randomUUID(), {
        expoPush: stub,
        log: { warn: () => undefined },
      });
      assert.equal(sent(stub).length, 0);
    },
  );

  test(
    'FL4: two concurrent sends for one message give one Expo message',
    SKIP_WHEN_NO_DB,
    async () => {
      const quiet = makeExpoPushStub();
      await giveToken(family.ownerId);
      const res = await staffReply(AMBER_APP(quiet), threadId, { text: 'twice at once' });
      await settle();
      const msg = res.json() as Msg;
      const claim = await claimOf(msg.id);
      // Forget the route's own claim, then race two sends for the same message.
      await db.execute(sql`DELETE FROM message_pushes WHERE message_id = ${msg.id}`);
      const stub = makeExpoPushStub();
      const deps = { expoPush: stub, log: { warn: () => undefined } };
      await Promise.all([
        sendStaffMessagePush(msg.id, claim?.notification_id ?? '', deps),
        sendStaffMessagePush(msg.id, claim?.notification_id ?? '', deps),
      ]);
      assert.equal(sent(stub).length, 1);
    },
  );

  test(
    'FH1-a: the claim INSERT throwing, through the route’s tracked call site: 201, one warn, nothing escapes',
    SKIP_WHEN_NO_DB,
    async () => {
      const stub = makeExpoPushStub();
      await giveToken(family.ownerId);
      const capture = makeLogCapture();
      const fn = `fh1a_refuse_${randomUUID().replaceAll('-', '')}`;
      await db.execute(
        sql.raw(`
        CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'FH1-a: the claim refuses'; END $$`),
      );
      await db.execute(
        sql.raw(
          `CREATE TRIGGER ${fn} BEFORE INSERT ON message_pushes FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
        ),
      );
      const escapes = watchEscapes();
      try {
        const res = await staffReply(AMBER_APP(stub, capture), threadId, {
          text: 'the claim fails',
        });
        assert.equal(res.statusCode, 201, res.body);
        await settle();
      } finally {
        escapes.stop();
        await db.execute(sql.raw(`DROP TRIGGER ${fn} ON message_pushes`));
        await db.execute(sql.raw(`DROP FUNCTION ${fn}()`));
      }
      const { rows } = await db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = ${fn}`,
      );
      assert.equal(rows[0]?.n, 0, 'the test trigger is gone');
      assert.deepEqual(escapes.seen, [], 'a rejection escaped');
      assert.equal(warnLines(capture, 'staff message push failed').length, 1);
      assert.deepEqual(pagerLines(capture), []);
      assert.equal(sent(stub).length, 0);
    },
  );
});

describe('the push follows the device, not the family it was (OH1-a, LR2-b push halves)', () => {
  function tokenApp(principal: Principal) {
    const { app, authenticate } = makeContractApp(principal);
    registerDeviceTokensRoute(app, { authenticate });
    return app;
  }
  function register(principal: Principal, token: string) {
    return tokenApp(principal).inject({
      method: 'POST',
      url: '/device-tokens',
      headers: { 'idempotency-key': `tok-${randomUUID()}` },
      payload: { token, platform: 'ios' },
    });
  }

  test(
    'OH1-a: A registers T, then B registers T: a reply to A sends 0 pushes to T, a reply to B sends 1',
    SKIP_WHEN_NO_DB,
    async () => {
      const T = `ExponentPushToken[${randomUUID()}]`;
      assert.equal((await register(FIXTURE_OWNER_PRINCIPAL, T)).statusCode, 201);
      assert.equal((await register(family.principal, T)).statusCode, 201);
      const stub = makeExpoPushStub();
      const toA = await staffReply(AMBER_APP(stub), FIXTURE_IDS.thread1Id, {
        text: 'for the Fixtures',
      });
      assert.deepEqual((toA.json() as Msg).reach, { channel: 'feed-only', why: 'no-device' });
      await settle();
      assert.equal(sent(stub).filter((m) => m.to === T).length, 0);
      const toB = await staffReply(AMBER_APP(stub), threadId, { text: 'for the Hendersons' });
      assert.equal(toB.statusCode, 201, toB.body);
      await settle();
      assert.equal(sent(stub).filter((m) => m.to === T).length, 1);
    },
  );

  test(
    'LR2-b: A registers T, B DELETEs T: a reply to A sends 0 pushes to T',
    SKIP_WHEN_NO_DB,
    async () => {
      const T = `ExponentPushToken[${randomUUID()}]`;
      assert.equal((await register(FIXTURE_OWNER_PRINCIPAL, T)).statusCode, 201);
      const del = await tokenApp(family.principal).inject({
        method: 'DELETE',
        url: `/device-tokens/${encodeURIComponent(T)}`,
        headers: { 'idempotency-key': `del-${randomUUID()}` },
      });
      assert.equal(del.statusCode, 204, del.body);
      const stub = makeExpoPushStub();
      const toA = await staffReply(AMBER_APP(stub), FIXTURE_IDS.thread1Id, {
        text: 'for the Fixtures',
      });
      assert.equal(toA.statusCode, 201, toA.body);
      await settle();
      assert.equal(sent(stub).filter((m) => m.to === T).length, 0);
    },
  );
});

describe('the boot count (FM2, LR5)', () => {
  test(
    'LR5-c: a message to a family with push off leaves the boot count at 0',
    SKIP_WHEN_NO_DB,
    async () => {
      assert.equal(await countLostStaffMessagePushes(), 0, 'no lost push before');
      await db.execute(
        sql`UPDATE owners SET push_notifications_enabled = false WHERE id = ${family.ownerId}`,
      );
      const res = await staffReply(AMBER_APP(makeExpoPushStub()), threadId, {
        text: 'push is off',
      });
      await settle();
      const id = (res.json() as Msg).id;
      await db.execute(
        sql`UPDATE message_pushes SET claimed_at = now() - interval '2 minutes' WHERE message_id = ${id}`,
      );
      assert.equal(await countLostStaffMessagePushes(), 0);
    },
  );

  test(
    'FM2-b: a boot with one stale unsent claim prints 1 (a fresh one and a stamped one are not lost)',
    SKIP_WHEN_NO_DB,
    async () => {
      const app = AMBER_APP(makeExpoPushStub());
      const ids: string[] = [];
      for (const text of ['stale', 'fresh', 'stamped']) {
        const res = await staffReply(app, threadId, { text });
        ids.push((res.json() as Msg).id);
      }
      await settle();
      const [stale, fresh, stamped] = ids;
      await db.execute(sql`UPDATE message_pushes SET tickets_ok = NULL, tickets_error = NULL,
                                  claimed_at = now() - interval '2 minutes' WHERE message_id = ${stale}`);
      await db.execute(
        sql`UPDATE message_pushes SET tickets_ok = NULL, tickets_error = NULL WHERE message_id = ${fresh}`,
      );
      await db.execute(
        sql`UPDATE message_pushes SET claimed_at = now() - interval '2 minutes' WHERE message_id = ${stamped}`,
      );
      // N3: the boot count logs through a real app logger (pino, as pass 3's call after `listen`
      // hands it `app.log`), and that logger writes into the capture the asserts read.
      const capture = makeLogCapture();
      const { app: logged } = makeContractApp(FIXTURE_MANAGER_PRINCIPAL, capture);
      assert.equal(await reportLostStaffMessagePushes(logged.log), 1);
      assert.deepEqual(pagerLines(capture), [], 'nothing at the pager’s level');
      assert.deepEqual(
        capture.lines.map((l) => [l['level'], l['lostPushes'], l['msg']]),
        [[40, 1, 'boot: staff message pushes claimed over a minute ago and never sent']],
        'one line: a warn carrying the count',
      );
    },
  );

  test(
    'FH1-d: message_pushes missing: one warn, the count is 0, nothing escapes',
    SKIP_WHEN_NO_DB,
    async () => {
      const lines: Array<{ level: string; obj: Record<string, unknown>; msg: string }> = [];
      const log = {
        info: (obj: Record<string, unknown>, msg: string) =>
          lines.push({ level: 'info', obj, msg }),
        warn: (obj: Record<string, unknown>, msg: string) =>
          lines.push({ level: 'warn', obj, msg }),
      };
      const escapes = watchEscapes();
      let counted: number | undefined;
      try {
        // The rename lives only inside this transaction, which always rolls back.
        await db
          .transaction(async (tx) => {
            await tx.execute(sql`ALTER TABLE message_pushes RENAME TO message_pushes_fh1d`);
            counted = await reportLostStaffMessagePushes(log, tx);
            throw new Error('FH1-d: roll back');
          })
          .catch((err: unknown) => {
            if (!(err instanceof Error) || err.message !== 'FH1-d: roll back') throw err;
          });
        await settle();
      } finally {
        escapes.stop();
      }
      const { rows } = await db.execute<{ present: boolean }>(
        sql`SELECT to_regclass('public.message_pushes') IS NOT NULL AS present`,
      );
      assert.equal(rows[0]?.present, true, 'the table is back');
      assert.equal(counted, 0);
      assert.deepEqual(
        lines.map((l) => l.level),
        ['warn'],
      );
      assert.deepEqual(escapes.seen, []);
    },
  );
});
