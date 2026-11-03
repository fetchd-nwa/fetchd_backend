import assert from 'node:assert/strict';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { makeAdminClient } from '../src/auth/adminClient.js';

/**
 * The Supabase admin client never follows a redirect (P03 item 0a; DECISIONS
 * 82(a); adversary r2 N6). Every call carries the service-role key in
 * `apikey`, and `fetch` strips only `Authorization` on a cross-origin hop — so
 * a configured host that redirects would hand the key to whatever it points
 * at, in cleartext if that is an http:// origin (what DECISIONS 80 exists to
 * prevent). Real listeners on loopback, real `fetch`: the first answers with a
 * redirect to the second, a different origin (another port).
 */

const KEY = 'SERVICE_ROLE_KEY_SECRET';

interface Listener {
  server: Server;
  origin: string;
}

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<Listener> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, origin: `http://127.0.0.1:${port}` };
}

async function close(...listeners: Listener[]): Promise<void> {
  for (const { server } of listeners) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** A GoTrue stand-in that records each request's headers and answers 200. */
async function recordingTarget(): Promise<Listener & { received: IncomingHttpHeaders[] }> {
  const received: IncomingHttpHeaders[] = [];
  const listener = await listen((req, res) => {
    received.push(req.headers);
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ users: [], id: 'u1', app_metadata: {}, identities: [] }));
  });
  return { ...listener, received };
}

test('the harness sees a direct call: the target receives the apikey (the control for the tests below)', async () => {
  const target = await recordingTarget();
  try {
    assert.deepEqual(await makeAdminClient(target.origin, KEY).listUsers(1), []);
    assert.deepEqual(
      target.received.map((h) => h.apikey),
      [KEY],
    );
  } finally {
    await close(target);
  }
});

for (const [label, status, call] of [
  ['GET listUsers, 302', 302, (url: string) => makeAdminClient(url, KEY).listUsers(1)],
  [
    'POST createUser, 307 (the body would be re-sent)',
    307,
    (url: string) =>
      makeAdminClient(url, KEY).createUser({
        email: 'fed@nwa-staff.invalid',
        email_confirm: true,
        app_metadata: { app_role: 'trainer' },
      }),
  ],
] as const) {
  test(`a ${label} to another origin: the call rejects and the other origin receives nothing`, async () => {
    const target = await recordingTarget();
    const redirector = await listen((req, res) => {
      req.resume();
      res.writeHead(status, { location: `${target.origin}${req.url ?? '/'}` });
      res.end();
    });
    try {
      const outcome = await call(redirector.origin).then(
        () => 'resolved',
        (err: unknown) => `rejected: ${err instanceof Error ? err.message : String(err)}`,
      );
      assert.deepEqual(
        target.received.map((h) => h.apikey),
        [],
        'the redirect was followed: the other origin received the service-role key',
      );
      assert.match(outcome, /^rejected/, 'a redirected admin call must fail, not succeed');
    } finally {
      await close(redirector, target);
    }
  });
}
