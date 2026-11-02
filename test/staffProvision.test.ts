import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import pg from 'pg';
import { makeAuthenticate, registerAuth } from '../src/auth/plugin.js';
import { resolvePrincipal } from '../src/auth/mirror.js';
import {
  checkProjectRefs,
  parseRoster,
  runExpire,
  runLink,
  runRehire,
  runRoster,
  staffClauseViolations,
  type AdminClient,
  type AdminUser,
  type RosterEntry,
} from '../src/auth/staffProvision.js';

/**
 * `npm run staff:provision` — the only writer of person `staff` rows (design
 * §2.1:1969-2045; P02 item 6). Red-first against a FAKE admin client (no
 * Supabase project is touched) and the real test database (the rows, the
 * audit trail, the responders and the sign-in path are real).
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_URL = process.env.DATABASE_URL;
const NO_DB = DB_URL === undefined ? { skip: 'DATABASE_URL not set' } : { skip: false as const };
const PORTAL = 'https://portal.fetchd.invalid';

// ── the fake admin client ────────────────────────────────────────────────────

interface Call {
  kind: 'createUser' | 'updateUserById' | 'generateRecoveryLink';
  args: unknown;
}

class FakeAdmin implements AdminClient {
  readonly users = new Map<string, AdminUser>();
  readonly calls: Call[] = [];
  readonly listed: number[] = [];

  /** `perPage` is the SERVER's page size: the client asks for more and must
   *  read until an empty page. */
  constructor(private readonly perPage = 2) {}

  seed(user: Partial<AdminUser> & { email: string }): AdminUser {
    const full: AdminUser = {
      id: randomUUID(),
      created_at: '2026-10-01T12:00:00Z',
      email_confirmed_at: null,
      last_sign_in_at: null,
      app_metadata: { provider: 'email', providers: ['email'] },
      identities: [{ provider: 'email' }],
      banned_until: null,
      ...user,
    };
    this.users.set(full.id, full);
    return full;
  }

  byEmail(email: string): AdminUser | undefined {
    return [...this.users.values()].find((u) => u.email === email.toLowerCase());
  }

  writes(): Call[] {
    return this.calls.filter((c) => c.kind !== 'generateRecoveryLink');
  }

  links(): Call[] {
    return this.calls.filter((c) => c.kind === 'generateRecoveryLink');
  }

  /** The fake's sign-in: a banned user, or one with no user, is refused. */
  canSignIn(email: string): boolean {
    const user = this.byEmail(email);
    return user !== undefined && (user.banned_until ?? null) === null;
  }

  async listUsers(page: number): Promise<AdminUser[]> {
    this.listed.push(page);
    const all = [...this.users.values()];
    return all.slice((page - 1) * this.perPage, page * this.perPage);
  }

  async createUser(args: {
    email: string;
    email_confirm: true;
    app_metadata: { app_role: string };
  }): Promise<AdminUser> {
    this.calls.push({ kind: 'createUser', args });
    return this.seed({
      email: args.email.toLowerCase(),
      email_confirmed_at: '2026-11-02T12:00:00Z',
      app_metadata: { provider: 'email', providers: ['email'], ...args.app_metadata },
    });
  }

  async updateUserById(
    id: string,
    args: { app_metadata?: Record<string, unknown>; ban_duration?: string },
  ): Promise<AdminUser> {
    this.calls.push({ kind: 'updateUserById', args: { id, ...args } });
    const user = this.users.get(id);
    if (user === undefined) throw new Error(`no user ${id}`);
    if (args.app_metadata !== undefined) {
      const merged = { ...user.app_metadata };
      for (const [key, value] of Object.entries(args.app_metadata)) {
        if (value === null) delete merged[key];
        else merged[key] = value;
      }
      user.app_metadata = merged;
    }
    if (args.ban_duration !== undefined) {
      user.banned_until = args.ban_duration === 'none' ? null : '2126-01-01T00:00:00Z';
    }
    return user;
  }

  async generateRecoveryLink(email: string, redirectTo: string): Promise<{ action_link: string }> {
    this.calls.push({ kind: 'generateRecoveryLink', args: { email, redirectTo } });
    return {
      action_link: `https://auth.invalid/verify?token=${randomUUID()}&redirect_to=${redirectTo}`,
    };
  }
}

// ── the database ─────────────────────────────────────────────────────────────

let client: pg.Client;

async function staffRows(uids: string[]) {
  const { rows } = await client.query<{
    supabase_uid: string;
    name: string;
    role: string;
    home_locations: string[];
    expired_at: string | null;
    id: string;
  }>(
    `SELECT id, supabase_uid::text, name, role::text, home_locations, expired_at
       FROM staff WHERE supabase_uid = ANY($1::uuid[]) ORDER BY name`,
    [uids],
  );
  return rows;
}

async function responders(): Promise<{ def: string | null; backup: string | null }> {
  const { rows } = await client.query<{ def: string | null; backup: string | null }>(
    'SELECT school_default_responder_staff_id AS def, school_backup_responder_staff_id AS backup FROM messaging_settings',
  );
  return rows[0] as { def: string | null; backup: string | null };
}

async function auditCount(): Promise<number> {
  const { rows } = await client.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM audit_log WHERE table_name IN ('staff', 'messaging_settings')",
  );
  return rows[0]?.n ?? -1;
}

const created: string[] = [];

async function cleanup(): Promise<void> {
  await client.query(
    'UPDATE messaging_settings SET school_default_responder_staff_id = NULL, school_backup_responder_staff_id = NULL',
  );
  const uids = [...new Set(created)];
  await client.query('DELETE FROM staff WHERE supabase_uid = ANY($1::uuid[])', [uids]);
  await client.query('DELETE FROM owners WHERE supabase_uid = ANY($1::uuid[])', [uids]);
}

function emailFor(label: string): string {
  return `${label}-${randomUUID().slice(0, 8)}@nwa-staff.invalid`;
}

function entry(over: Partial<RosterEntry> & { email: string }): RosterEntry {
  return { name: 'Staffer', role: 'trainer', home_locations: ['fayetteville'], ...over };
}

function capture(): { out: (line: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { out: (line) => void lines.push(line), lines };
}

function track(admin: FakeAdmin): void {
  for (const id of admin.users.keys()) created.push(id);
}

describe('staff:provision — against a fake admin client and the test database', NO_DB, () => {
  before(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    await client.query(
      'UPDATE messaging_settings SET school_default_responder_staff_id = NULL, school_backup_responder_staff_id = NULL',
    );
  });

  // Each test starts from no provisioned staff and no responders: the staff
  // clauses read the whole table, as the preflight will.
  afterEach(cleanup);

  after(async () => {
    await cleanup();
    await client.end();
  });

  test('a roster email held by a user with no app_role → exit 1, zero auth writes, zero staff rows, the user described', async () => {
    const admin = new FakeAdmin();
    const signedUp = admin.seed({
      email: emailFor('signed-up'),
      email_confirmed_at: '2026-10-02T09:00:00Z',
      last_sign_in_at: '2026-10-03T09:00:00Z',
      identities: [{ provider: 'email' }, { provider: 'google' }],
    });
    const fresh = emailFor('fresh');
    const { out, lines } = capture();
    const code = await runRoster(
      { admin, db: client, out },
      [entry({ email: fresh, role: 'manager' }), entry({ email: signedUp.email })],
      { portalOrigin: PORTAL, confirm: true },
    );
    track(admin);
    assert.equal(code, 1);
    assert.deepEqual(admin.calls, [], 'an auth call was made');
    assert.deepEqual(await staffRows([...admin.users.keys()]), []);
    const text = lines.join('\n');
    for (const fact of [
      signedUp.id,
      '2026-10-01T12:00:00Z',
      '2026-10-02T09:00:00Z',
      '2026-10-03T09:00:00Z',
      'google',
    ]) {
      assert.ok(text.includes(fact), `the refusal does not print ${fact}:\n${text}`);
    }
  });

  test('a uid that holds an owners row → exit 1, nothing written for anyone', async () => {
    const admin = new FakeAdmin();
    const family = admin.seed({
      email: emailFor('family'),
      app_metadata: { provider: 'email', app_role: 'trainer' },
    });
    created.push(family.id);
    await client.query(
      "INSERT INTO owners (supabase_uid, name, email, phone, location) VALUES ($1, 'Family', $2, '555', 'fayetteville')",
      [family.id, family.email],
    );
    const { out } = capture();
    const code = await runRoster(
      { admin, db: client, out },
      [entry({ email: emailFor('other') }), entry({ email: family.email })],
      { portalOrigin: PORTAL, confirm: true },
    );
    track(admin);
    assert.equal(code, 1);
    assert.deepEqual(admin.calls, []);
    assert.deepEqual(await staffRows([...admin.users.keys()]), []);
  });

  test('a staffer with no home_locations, an unknown slug or a repeated slug (DECISIONS 75) → refused before createUser', async () => {
    for (const homes of [[], ['springdale'], ['bentonville', 'bentonville']]) {
      const admin = new FakeAdmin();
      const { out, lines } = capture();
      const parsed = parseRoster([
        { email: emailFor('ok'), name: 'Ok', role: 'trainer', home_locations: ['fayetteville'] },
        { email: emailFor('bad'), name: 'Bad', role: 'trainer', home_locations: homes },
      ]);
      const code = parsed.ok
        ? await runRoster({ admin, db: client, out }, parsed.roster, {
            portalOrigin: PORTAL,
            confirm: true,
          })
        : 1;
      assert.equal(code, 1, `${JSON.stringify(homes)} was accepted`);
      assert.deepEqual(admin.calls, [], `${JSON.stringify(homes)}: an auth call was made`);
      if (parsed.ok) assert.ok(lines.join('\n').length > 0, 'refused in silence');
    }
  });

  test('the roster itself is refused when it repeats an email, names an unknown role, or two default responders', () => {
    const a = emailFor('a');
    for (const roster of [
      [
        { email: a, name: 'A', role: 'trainer', home_locations: ['fayetteville'] },
        { email: a.toUpperCase(), name: 'A2', role: 'trainer', home_locations: ['fayetteville'] },
      ],
      [{ email: a, name: 'A', role: 'office', home_locations: ['fayetteville'] }],
      [{ email: a, name: 'A', role: 'owner-shanthi', home_locations: ['fayetteville'] }],
      [
        {
          email: a,
          name: 'A',
          role: 'manager',
          home_locations: ['bentonville'],
          responder: 'default',
        },
        {
          email: emailFor('b'),
          name: 'B',
          role: 'owner',
          home_locations: ['fayetteville'],
          responder: 'default',
        },
      ],
      [],
    ]) {
      assert.equal(parseRoster(roster).ok, false, JSON.stringify(roster));
    }
  });

  test('a first run creates each user with app_metadata {app_role} alone, writes the rows and the responders, and prints one link per created user', async () => {
    const admin = new FakeAdmin();
    const amber = emailFor('amber');
    const shanthi = emailFor('shanthi');
    const fed = emailFor('fed');
    const roster = [
      entry({
        email: amber,
        name: 'Amber',
        role: 'manager',
        home_locations: ['bentonville'],
        responder: 'default',
      }),
      entry({
        email: shanthi,
        name: 'Shanthi',
        role: 'owner',
        home_locations: ['bentonville', 'fayetteville'],
        responder: 'backup',
      }),
      entry({ email: fed, name: 'Fed', role: 'trainer', home_locations: ['bentonville'] }),
    ];
    const { out, lines } = capture();
    const code = await runRoster({ admin, db: client, out }, roster, {
      portalOrigin: PORTAL,
      confirm: false,
    });
    track(admin);
    assert.equal(code, 0, lines.join('\n'));
    const creates = admin.calls.filter((c) => c.kind === 'createUser');
    assert.equal(creates.length, 3);
    for (const c of creates) {
      const args = c.args as { email_confirm: boolean; app_metadata: Record<string, unknown> };
      assert.equal(args.email_confirm, true);
      assert.deepEqual(
        Object.keys(args.app_metadata),
        ['app_role'],
        'name or campus copied into the token',
      );
    }
    const rows = await staffRows([...admin.users.keys()]);
    assert.deepEqual(
      rows.map((r) => [r.name, r.role, r.home_locations, r.expired_at]),
      [
        ['Amber', 'manager', ['bentonville'], null],
        ['Fed', 'trainer', ['bentonville'], null],
        ['Shanthi', 'owner', ['bentonville', 'fayetteville'], null],
      ],
    );
    const byName = new Map(rows.map((r) => [r.name, r.id]));
    assert.deepEqual(await responders(), {
      def: byName.get('Amber'),
      backup: byName.get('Shanthi'),
    });
    const links = admin.links();
    assert.equal(links.length, 3);
    for (const l of links) {
      assert.equal((l.args as { redirectTo: string }).redirectTo, `${PORTAL}/set-password`);
    }
    assert.equal(
      lines.filter((l) => l.includes('https://auth.invalid/verify')).length,
      3,
      'each link printed once',
    );

    // A SECOND run changes nothing: no auth write, no link, no audit row, the
    // responders as they are.
    const auditBefore = await auditCount();
    const second = capture();
    const again = await runRoster({ admin, db: client, out: second.out }, roster, {
      portalOrigin: PORTAL,
      confirm: false,
    });
    assert.equal(again, 0, second.lines.join('\n'));
    assert.equal(admin.writes().length, 3, 'the second run wrote to auth');
    assert.equal(admin.links().length, 3, 'the second run minted a link');
    assert.equal(await auditCount(), auditBefore, 'the second run wrote a row');
    assert.deepEqual(await responders(), {
      def: byName.get('Amber'),
      backup: byName.get('Shanthi'),
    });
  });

  test('responders already set are left as they are', async () => {
    const admin = new FakeAdmin();
    const first = emailFor('first');
    const { out } = capture();
    assert.equal(
      await runRoster(
        { admin, db: client, out },
        [
          entry({ email: first, responder: 'default' }),
          entry({ email: emailFor('second'), responder: 'backup' }),
        ],
        { portalOrigin: PORTAL, confirm: false },
      ),
      0,
    );
    track(admin);
    const set = await responders();
    assert.notEqual(set.def, null);
    const admin2 = new FakeAdmin();
    assert.equal(
      await runRoster(
        { admin: admin2, db: client, out },
        [
          entry({ email: emailFor('third'), responder: 'default' }),
          entry({ email: emailFor('fourth'), responder: 'backup' }),
        ],
        { portalOrigin: PORTAL, confirm: false },
      ),
      0,
    );
    track(admin2);
    assert.deepEqual(await responders(), set);
  });

  test('a roster role change → printed and refused without --yes; with it, app_metadata and the row change together', async () => {
    const admin = new FakeAdmin();
    const rachel = emailFor('rachel');
    const { out, lines } = capture();
    assert.equal(
      await runRoster(
        { admin, db: client, out },
        [entry({ email: rachel, name: 'Rachel', role: 'trainer' })],
        { portalOrigin: PORTAL, confirm: false },
      ),
      0,
    );
    track(admin);
    const uid = (admin.byEmail(rachel) as AdminUser).id;
    const writes = admin.writes().length;

    const promoted = [entry({ email: rachel, name: 'Rachel', role: 'manager' })];
    const refused = await runRoster({ admin, db: client, out }, promoted, {
      portalOrigin: PORTAL,
      confirm: false,
    });
    assert.equal(refused, 1);
    assert.equal(admin.writes().length, writes, 'an unconfirmed role change wrote to auth');
    assert.equal((await staffRows([uid]))[0]?.role, 'trainer');
    assert.ok(
      lines.some((l) => /trainer → manager/.test(l)),
      lines.join('\n'),
    );

    const applied = await runRoster({ admin, db: client, out }, promoted, {
      portalOrigin: PORTAL,
      confirm: true,
    });
    assert.equal(applied, 0);
    assert.equal(admin.byEmail(rachel)?.app_metadata.app_role, 'manager');
    assert.equal((await staffRows([uid]))[0]?.role, 'manager');
    assert.equal(admin.links().length, 1, 'an adopted user got a new link (only --link mints one)');
  });

  test('--expire → expired_at set, the user banned, app_role removed, responders reset; sign-in 403 not_provisioned; the staff clauses green after it', async () => {
    const admin = new FakeAdmin();
    const amber = emailFor('amber-x');
    const keep = emailFor('keep');
    const roster = [
      entry({ email: amber, name: 'Amber', role: 'manager', responder: 'default' }),
      entry({ email: keep, name: 'Keep', role: 'owner', responder: 'backup' }),
    ];
    const { out, lines } = capture();
    assert.equal(
      await runRoster({ admin, db: client, out }, roster, { portalOrigin: PORTAL, confirm: false }),
      0,
    );
    track(admin);
    const uid = (admin.byEmail(amber) as AdminUser).id;

    const app = Fastify();
    registerAuth(app);
    app.get(
      '/whoami',
      {
        preHandler: [
          makeAuthenticate({ verify: async () => ({ sub: uid }), resolve: resolvePrincipal }),
        ],
      },
      async (r) => r.principal,
    );
    const bearer = { authorization: 'Bearer stub' };
    assert.equal(
      (await app.inject({ method: 'GET', url: '/whoami', headers: bearer })).statusCode,
      200,
    );

    assert.equal(
      await runExpire({ admin, db: client, out }, amber, { confirm: true }),
      0,
      lines.join('\n'),
    );
    const [row] = await staffRows([uid]);
    assert.notEqual(row?.expired_at, null);
    assert.equal(admin.canSignIn(amber), false, 'not banned');
    assert.equal('app_role' in (admin.byEmail(amber) as AdminUser).app_metadata, false);
    const after = await responders();
    assert.equal(after.def, null, 'the responder naming her was not reset');
    assert.notEqual(after.backup, null, 'an unrelated responder was reset');
    assert.ok(
      lines.some((l) => /responder/i.test(l)),
      'the reset was not printed',
    );

    const signIn = await app.inject({ method: 'GET', url: '/whoami', headers: bearer });
    assert.equal(signIn.statusCode, 403);
    assert.equal(signIn.json().error.code, 'not_provisioned');

    const remaining = roster.filter((r) => r.email !== amber);
    assert.deepEqual(await staffClauseViolations({ admin, db: client }, remaining), []);
  });

  test('an expired staffer left in the roster → skipped and printed, still expired, no auth write', async () => {
    const admin = new FakeAdmin();
    const leaver = emailFor('leaver');
    const { out, lines } = capture();
    const roster = [entry({ email: leaver, name: 'Leaver' })];
    assert.equal(
      await runRoster({ admin, db: client, out }, roster, { portalOrigin: PORTAL, confirm: false }),
      0,
    );
    track(admin);
    assert.equal(await runExpire({ admin, db: client, out }, leaver, { confirm: true }), 0);
    const writes = admin.writes().length;
    const uid = (admin.byEmail(leaver) as AdminUser).id;

    const code = await runRoster({ admin, db: client, out }, roster, {
      portalOrigin: PORTAL,
      confirm: true,
    });
    assert.equal(code, 0);
    assert.equal(admin.writes().length, writes);
    assert.notEqual((await staffRows([uid]))[0]?.expired_at, null);
    assert.ok(
      lines.some((l) => /expired: use --rehire/.test(l)),
      lines.join('\n'),
    );
  });

  test('--rehire → expired_at NULL, the ban lifted and app_role restored together; the fake then accepts a sign-in', async () => {
    const admin = new FakeAdmin();
    const back = emailFor('back');
    const { out, lines } = capture();
    const roster = [
      entry({ email: back, name: 'Back', role: 'trainer', home_locations: ['bentonville'] }),
    ];
    assert.equal(
      await runRoster({ admin, db: client, out }, roster, { portalOrigin: PORTAL, confirm: false }),
      0,
    );
    track(admin);
    assert.equal(await runExpire({ admin, db: client, out }, back, { confirm: true }), 0);
    const uid = (admin.byEmail(back) as AdminUser).id;

    assert.equal(
      await runRehire({ admin, db: client, out }, back, roster, { confirm: false }),
      1,
      'rehire ran unconfirmed',
    );
    assert.notEqual((await staffRows([uid]))[0]?.expired_at, null);

    assert.equal(
      await runRehire({ admin, db: client, out }, back, roster, { confirm: true }),
      0,
      lines.join('\n'),
    );
    assert.equal((await staffRows([uid]))[0]?.expired_at, null);
    assert.equal(admin.byEmail(back)?.app_metadata.app_role, 'trainer');
    assert.equal(admin.canSignIn(back), true);
  });

  test('--link re-mints one link for a live staffer, and refuses an email that is not one', async () => {
    const admin = new FakeAdmin();
    const staffer = emailFor('lost-link');
    const { out, lines } = capture();
    assert.equal(
      await runRoster({ admin, db: client, out }, [entry({ email: staffer })], {
        portalOrigin: PORTAL,
        confirm: false,
      }),
      0,
    );
    track(admin);
    const links = admin.links().length;
    assert.equal(await runLink({ admin, db: client, out }, staffer, { portalOrigin: PORTAL }), 0);
    assert.equal(admin.links().length, links + 1);
    assert.ok(lines.at(-1)?.includes('https://auth.invalid/verify'), lines.join('\n'));
    const stranger = admin.seed({ email: emailFor('stranger') });
    track(admin);
    assert.equal(
      await runLink({ admin, db: client, out }, stranger.email, { portalOrigin: PORTAL }),
      1,
    );
    assert.equal(admin.links().length, links + 1);
  });

  test('a server that returns fewer users per page than asked still has every page read (stop on an empty page)', async () => {
    // GoTrue may cap per_page below what the client asks for (200): a short
    // page is NOT the last page. This "server" returns 1 user per page.
    const admin = new FakeAdmin(1);
    for (let i = 0; i < 2; i += 1) admin.seed({ email: emailFor(`filler${i}`) });
    const target = admin.seed({ email: emailFor('capped'), app_metadata: { app_role: 'trainer' } });
    const { out } = capture();
    assert.equal(
      await runRoster({ admin, db: client, out }, [entry({ email: target.email })], {
        portalOrigin: PORTAL,
        confirm: false,
      }),
      0,
    );
    track(admin);
    assert.equal(
      admin.writes().length,
      0,
      'the user on page 3 was not found, so it was created again',
    );
    assert.equal((await staffRows([target.id])).length, 1);
    assert.deepEqual(admin.listed.slice(-2), [3, 4], 'the listing did not end on an empty page');
  });

  test('a run that stops part-way says what exists and what to do next (re-run adopts; --link mints)', async () => {
    class FailsSecondCreate extends FakeAdmin {
      private creates = 0;
      override async createUser(args: {
        email: string;
        email_confirm: true;
        app_metadata: { app_role: string };
      }): Promise<AdminUser> {
        this.creates += 1;
        if (this.creates === 2) throw new Error('GoTrue 500');
        return super.createUser(args);
      }
    }
    const admin = new FailsSecondCreate();
    const first = emailFor('made-it');
    const { out, lines } = capture();
    await assert.rejects(
      runRoster(
        { admin, db: client, out },
        [entry({ email: first }), entry({ email: emailFor('did-not') })],
        { portalOrigin: PORTAL, confirm: false },
      ),
      /GoTrue 500/,
    );
    track(admin);
    const failure = lines.find((l) => l.startsWith('FAILED'));
    assert.ok(failure !== undefined, lines.join('\n'));
    assert.ok(failure.includes(first), failure);
    assert.match(failure, /--link/);
    assert.deepEqual(await staffRows([...admin.users.keys()]), [], 'a row was written');
    assert.equal(admin.links().length, 0);
  });

  // ── P02 fix round 1 ──

  test('--rehire with a home campus not in locations ("rogers", or the label "Bentonville") → exit 1, no auth call, the row untouched (DECISIONS 79)', async () => {
    const admin = new FakeAdmin();
    const back = emailFor('typo');
    const { out, lines } = capture();
    const roster = [entry({ email: back, name: 'Typo', home_locations: ['bentonville'] })];
    assert.equal(
      await runRoster({ admin, db: client, out }, roster, { portalOrigin: PORTAL, confirm: false }),
      0,
    );
    track(admin);
    assert.equal(await runExpire({ admin, db: client, out }, back, { confirm: true }), 0);
    const uid = (admin.byEmail(back) as AdminUser).id;
    const writes = admin.writes().length;
    for (const slug of ['rogers', 'Bentonville']) {
      const code = await runRehire(
        { admin, db: client, out },
        back,
        [entry({ email: back, name: 'Typo', home_locations: [slug] })],
        { confirm: true },
      );
      assert.equal(code, 1, `${slug} was accepted`);
      assert.equal(admin.writes().length, writes, `${slug}: an auth call was made`);
      const [row] = await staffRows([uid]);
      assert.notEqual(row?.expired_at, null, `${slug}: she was un-expired`);
      assert.deepEqual(row?.home_locations, ['bentonville'], `${slug}: written to the row`);
      assert.ok(
        lines.some((l) => l.startsWith('refused') && l.includes(`'${slug}'`)),
        lines.join('\n'),
      );
    }
  });

  test('--expire of the default responder empties that slot; a roster re-run fills it from the roster and never overwrites the backup (DECISIONS 76)', async () => {
    const admin = new FakeAdmin();
    const amber = emailFor('amber-r');
    const shanthi = emailFor('shanthi-r');
    const rachel = emailFor('rachel-r');
    const fed = emailFor('fed-r');
    const { out, lines } = capture();
    const first = [
      entry({ email: amber, name: 'Amber', role: 'manager', responder: 'default' }),
      entry({ email: shanthi, name: 'Shanthi', role: 'owner', responder: 'backup' }),
    ];
    assert.equal(
      await runRoster({ admin, db: client, out }, first, { portalOrigin: PORTAL, confirm: false }),
      0,
    );
    track(admin);
    const before = await responders();
    assert.notEqual(before.backup, null);

    assert.equal(await runExpire({ admin, db: client, out }, amber, { confirm: true }), 0);
    assert.deepEqual(await responders(), { def: null, backup: before.backup });

    // The same roster again: Amber is expired, so she is skipped and the
    // default slot stays empty.
    const stale = capture();
    assert.equal(
      await runRoster({ admin, db: client, out: stale.out }, first, {
        portalOrigin: PORTAL,
        confirm: false,
      }),
      0,
      stale.lines.join('\n'),
    );
    assert.deepEqual(await responders(), { def: null, backup: before.backup });

    // A replacement: Rachel fills the empty default; the roster's other backup
    // (Fed) does NOT displace Shanthi, already set.
    const second = capture();
    const replaced = [
      entry({ email: rachel, name: 'Rachel', role: 'manager', responder: 'default' }),
      entry({ email: fed, name: 'Fed', role: 'trainer', responder: 'backup' }),
      entry({ email: shanthi, name: 'Shanthi', role: 'owner' }),
    ];
    assert.equal(
      await runRoster({ admin, db: client, out: second.out }, replaced, {
        portalOrigin: PORTAL,
        confirm: false,
      }),
      0,
      second.lines.join('\n'),
    );
    track(admin);
    const [rachelRow] = await staffRows([(admin.byEmail(rachel) as AdminUser).id]);
    assert.deepEqual(await responders(), { def: rachelRow?.id, backup: before.backup });

    // What each step said. --expire points at the way back; the skipped
    // responder's empty slot is said, not left in silence (adversary L4a);
    // "already set" is never said while a slot is empty (Fable L5).
    assert.ok(
      lines.some((l) => /re-run the roster to name a new one/.test(l)),
      lines.join('\n'),
    );
    assert.ok(
      stale.lines.some((l) => /default/.test(l) && /empty/i.test(l) && l.includes(amber)),
      stale.lines.join('\n'),
    );
    for (const run of [stale.lines, second.lines]) {
      assert.ok(!run.some((l) => /already set, left as they are/.test(l)), run.join('\n'));
    }
    assert.ok(
      second.lines.some((l) => /backup/.test(l) && /already set/.test(l)),
      second.lines.join('\n'),
    );
  });

  test('--expire names only the slot she held, read from the values before the reset (adversary L4c)', async () => {
    const admin = new FakeAdmin();
    const first = emailFor('slot-default');
    const second = emailFor('slot-backup');
    const { out } = capture();
    assert.equal(
      await runRoster(
        { admin, db: client, out },
        [
          entry({ email: first, responder: 'default' }),
          entry({ email: second, role: 'owner', responder: 'backup' }),
        ],
        { portalOrigin: PORTAL, confirm: false },
      ),
      0,
    );
    track(admin);
    assert.equal(await runExpire({ admin, db: client, out }, first, { confirm: true }), 0);
    const { out: out2, lines } = capture();
    assert.equal(
      await runExpire({ admin, db: client, out: out2 }, second, { confirm: true, lastOwner: true }),
      0,
    );
    const said = lines.find((l) => /messaging responder/.test(l));
    assert.ok(said !== undefined, lines.join('\n'));
    assert.match(said, /was the backup/);
    assert.doesNotMatch(said, /default/);
  });

  test('--expire without --yes prints the plan, exits 1, writes nothing and makes no admin call (DECISIONS 77)', async () => {
    const admin = new FakeAdmin();
    const fed = emailFor('fed-plan');
    const { out } = capture();
    assert.equal(
      await runRoster({ admin, db: client, out }, [entry({ email: fed, name: 'Fed' })], {
        portalOrigin: PORTAL,
        confirm: false,
      }),
      0,
    );
    track(admin);
    const uid = (admin.byEmail(fed) as AdminUser).id;
    const calls = admin.calls.length;
    const auditBefore = await auditCount();
    const plan = capture();
    assert.equal(await runExpire({ admin, db: client, out: plan.out }, fed, { confirm: false }), 1);
    assert.equal(admin.calls.length, calls, 'an admin call was made');
    assert.equal((await staffRows([uid]))[0]?.expired_at, null, 'the row was expired');
    assert.equal(await auditCount(), auditBefore, 'a row was written');
    assert.equal(admin.canSignIn(fed), true);
    assert.ok(
      plan.lines.some((l) => l.includes(fed) && l.includes('Fed')),
      `no plan naming her: ${plan.lines.join('\n')}`,
    );
    assert.ok(
      plan.lines.some((l) => /--yes/.test(l)),
      plan.lines.join('\n'),
    );
  });

  test('--expire refuses the last live owner-role row unless --last-owner is passed (DECISIONS 77)', async () => {
    const admin = new FakeAdmin();
    const shanthi = emailFor('last-owner');
    const other = emailFor('other-owner');
    const { out, lines } = capture();
    assert.equal(
      await runRoster(
        { admin, db: client, out },
        [
          entry({ email: shanthi, name: 'Shanthi', role: 'owner' }),
          entry({ email: other, name: 'Other', role: 'owner' }),
        ],
        { portalOrigin: PORTAL, confirm: false },
      ),
      0,
    );
    track(admin);
    // Two live owners: one may go.
    assert.equal(await runExpire({ admin, db: client, out }, other, { confirm: true }), 0);
    const { rows } = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM staff WHERE role = 'owner' AND expired_at IS NULL",
    );
    assert.equal(rows[0]?.n, 1, 'precondition: Shanthi is the one live owner row in the table');

    const uid = (admin.byEmail(shanthi) as AdminUser).id;
    const calls = admin.calls.length;
    assert.equal(await runExpire({ admin, db: client, out }, shanthi, { confirm: true }), 1);
    assert.equal(admin.calls.length, calls, 'an admin call was made');
    assert.equal((await staffRows([uid]))[0]?.expired_at, null, 'the last owner was expired');
    assert.ok(
      lines.some((l) => /last live owner/.test(l) && /--last-owner/.test(l)),
      lines.join('\n'),
    );

    assert.equal(
      await runExpire({ admin, db: client, out }, shanthi, { confirm: true, lastOwner: true }),
      0,
      lines.join('\n'),
    );
    assert.notEqual((await staffRows([uid]))[0]?.expired_at, null);
  });

  test('a name holding a NUL or another control character is refused in pass 1, before any createUser (adversary L3c)', async () => {
    for (const name of ['A\u0000B', 'A\u001b[31mB']) {
      const admin = new FakeAdmin();
      const { out, lines } = capture();
      const code = await runRoster(
        { admin, db: client, out },
        [entry({ email: emailFor('fine'), name: 'Fine' }), entry({ email: emailFor('nul'), name })],
        { portalOrigin: PORTAL, confirm: false },
      ).catch((err: unknown) => `threw: ${err instanceof Error ? err.message : String(err)}`);
      track(admin);
      assert.equal(code, 1, `${JSON.stringify(name)}: ${String(code)}\n${lines.join('\n')}`);
      assert.deepEqual(admin.calls, [], `${JSON.stringify(name)}: an auth call was made`);
      assert.equal(parseRoster([entry({ email: emailFor('p'), name })]).ok, false);
    }
  });

  test('a role change applied in auth, then a failing staff transaction: the report names the re-role already done (adversary L3a)', async () => {
    const admin = new FakeAdmin();
    const fed = emailFor('fed-rerole');
    const { out } = capture();
    assert.equal(
      await runRoster({ admin, db: client, out }, [entry({ email: fed, role: 'trainer' })], {
        portalOrigin: PORTAL,
        confirm: false,
      }),
      0,
    );
    track(admin);
    const uid = (admin.byEmail(fed) as AdminUser).id;
    const failing = {
      query: (text: string, params?: unknown[]) =>
        /INSERT INTO staff/.test(text)
          ? Promise.reject(new Error('simulated staff INSERT failure'))
          : client.query(text, params),
    } as unknown as pg.ClientBase;
    const report = capture();
    await assert.rejects(
      runRoster({ admin, db: failing, out: report.out }, [entry({ email: fed, role: 'owner' })], {
        portalOrigin: PORTAL,
        confirm: true,
      }),
      /simulated staff INSERT failure/,
    );
    assert.equal(admin.byEmail(fed)?.app_metadata.app_role, 'owner', 'precondition: re-roled');
    assert.equal((await staffRows([uid]))[0]?.role, 'trainer', 'precondition: rolled back');
    const failure = report.lines.find((l) => l.startsWith('FAILED'));
    assert.ok(failure !== undefined, report.lines.join('\n'));
    assert.ok(failure.includes(fed), `the re-role is not named: ${failure}`);
    assert.match(failure, /owner/);
    assert.match(failure, /--yes/);
  });

  test('a set-password link that fails after the commit: the report says the rows are written and lists the rest for --link (adversary L3b, Fable N3)', async () => {
    class FailsSecondLink extends FakeAdmin {
      private minted = 0;
      override async generateRecoveryLink(
        email: string,
        redirectTo: string,
      ): Promise<{ action_link: string }> {
        this.minted += 1;
        if (this.minted === 2) throw new Error('GoTrue 502');
        return super.generateRecoveryLink(email, redirectTo);
      }
    }
    const admin = new FailsSecondLink();
    const [a, b, c] = ['link-a', 'link-b', 'link-c'].map(emailFor) as [string, string, string];
    const { out, lines } = capture();
    await assert.rejects(
      runRoster(
        { admin, db: client, out },
        [entry({ email: a }), entry({ email: b }), entry({ email: c })],
        { portalOrigin: PORTAL, confirm: false },
      ),
      /GoTrue 502/,
    );
    track(admin);
    assert.equal((await staffRows([...admin.users.keys()])).length, 3, 'precondition: committed');
    const failure = lines.find((l) => l.startsWith('FAILED'));
    assert.ok(failure !== undefined, lines.join('\n'));
    assert.match(failure, /--link/);
    assert.match(failure, /written/);
    assert.ok(failure.includes(b) && failure.includes(c), `the rest are not listed: ${failure}`);
    assert.ok(
      !failure.slice(failure.indexOf('--link')).includes(a),
      `the link already printed is listed again: ${failure}`,
    );
  });

  test('a phone-only auth user (email null) is skipped by the lookup, not a TypeError; with app_role it is a staff-clause violation (Fable N2)', async () => {
    const admin = new FakeAdmin();
    admin.seed({ email: null as unknown as string, identities: [{ provider: 'phone' }] });
    const staffer = emailFor('beside-phone');
    const roster = [entry({ email: staffer })];
    const { out, lines } = capture();
    const code = await runRoster({ admin, db: client, out }, roster, {
      portalOrigin: PORTAL,
      confirm: false,
    }).catch((err: unknown) => `threw: ${err instanceof Error ? err.message : String(err)}`);
    track(admin);
    assert.equal(code, 0, `${String(code)}\n${lines.join('\n')}`);
    assert.deepEqual(await staffClauseViolations({ admin, db: client }, roster), []);
    const holder = admin.seed({
      email: null as unknown as string,
      app_metadata: { app_role: 'trainer' },
      identities: [{ provider: 'phone' }],
    });
    const violations = await staffClauseViolations({ admin, db: client }, roster);
    assert.equal(violations.length, 1, violations.join('\n'));
    assert.ok(violations[0]?.includes(holder.id), violations.join('\n'));
  });

  test('users are found across pages of the admin listing', async () => {
    const admin = new FakeAdmin(1);
    for (let i = 0; i < 3; i += 1) admin.seed({ email: emailFor(`filler${i}`) });
    const target = admin.seed({ email: emailFor('paged'), app_metadata: { app_role: 'trainer' } });
    const { out } = capture();
    assert.equal(
      await runRoster({ admin, db: client, out }, [entry({ email: target.email })], {
        portalOrigin: PORTAL,
        confirm: false,
      }),
      0,
    );
    track(admin);
    assert.ok(admin.listed.length >= 4, `only pages ${admin.listed.join(',')} were read`);
    assert.equal(admin.writes().length, 0, 'the paged user was not adopted');
    assert.equal((await staffRows([target.id])).length, 1);
  });
});

// ── the project-ref check and the env boundary ───────────────────────────────

describe('staff:provision — the project-ref check and the env boundary', () => {
  test('the three refs must agree: SUPABASE_URL, DATABASE_URL and --project', () => {
    const ok = checkProjectRefs(
      'https://abcdefghijklmnop.supabase.co',
      'postgresql://postgres:pw@db.abcdefghijklmnop.supabase.co:5432/postgres',
      'abcdefghijklmnop',
    );
    assert.equal(ok.ok, true);
    const pooler = checkProjectRefs(
      'https://abcdefghijklmnop.supabase.co',
      'postgresql://postgres.abcdefghijklmnop:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres',
      'abcdefghijklmnop',
    );
    assert.equal(pooler.ok, true);
    const local = checkProjectRefs(
      'http://127.0.0.1:54321',
      'postgres://postgres:pw@localhost:5432/postgres',
      'local',
    );
    assert.equal(local.ok, true);
    for (const [supabaseUrl, databaseUrl, project] of [
      [
        'https://aaaaaaaaaaaaaaaa.supabase.co',
        'postgresql://postgres:pw@db.bbbbbbbbbbbbbbbb.supabase.co:5432/postgres',
        'aaaaaaaaaaaaaaaa',
      ],
      [
        'https://aaaaaaaaaaaaaaaa.supabase.co',
        'postgresql://postgres:pw@db.aaaaaaaaaaaaaaaa.supabase.co:5432/postgres',
        'bbbbbbbbbbbbbbbb',
      ],
      [
        'https://aaaaaaaaaaaaaaaa.supabase.co',
        'postgres://postgres:pw@localhost:5432/postgres',
        'aaaaaaaaaaaaaaaa',
      ],
    ]) {
      const refused = checkProjectRefs(
        supabaseUrl as string,
        databaseUrl as string,
        project as string,
      );
      assert.equal(refused.ok, false, `${supabaseUrl} ${databaseUrl} ${project}`);
    }
  });

  test('an http:// SUPABASE_URL is refused unless its host is loopback: the service-role key never travels in cleartext (DECISIONS 80)', () => {
    const cleartext = checkProjectRefs(
      'http://abcdefghijklmnop.supabase.co',
      'postgresql://postgres:pw@db.abcdefghijklmnop.supabase.co:5432/postgres',
      'abcdefghijklmnop',
    );
    assert.equal(cleartext.ok, false);
    assert.match(cleartext.ok ? '' : cleartext.reason, /https/);
    for (const local of [
      'http://localhost:54321',
      'http://127.0.0.1:54321',
      'http://[::1]:54321',
    ]) {
      const ok = checkProjectRefs(local, 'postgres://postgres:pw@localhost:5432/postgres', 'local');
      assert.equal(ok.ok, true, `${local}: ${ok.ok ? '' : ok.reason}`);
    }
  });

  test("a DATABASE_URL the runner refuses is refused with the runner's own reason (the 6543 pooler), not as an unrecognised host (Fable L4)", () => {
    const refused = checkProjectRefs(
      'https://abcdefghijklmnop.supabase.co',
      'postgresql://postgres.abcdefghijklmnop:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres',
      'abcdefghijklmnop',
    );
    assert.equal(refused.ok, false);
    const reason = refused.ok ? '' : refused.reason;
    assert.match(reason, /6543/);
    assert.match(reason, /transaction pooler/);
    assert.doesNotMatch(reason, /unrecognised/);
  });

  test('the CLI with ONLY the three variables: a ref mismatch exits 1 before any call, naming both refs — and src/env.ts is never loaded', () => {
    const run = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'scripts/staff-provision.ts',
        '--project',
        'aaaaaaaaaaaaaaaa',
        '--expire',
        'x@nwa-staff.invalid',
      ],
      {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
        env: {
          PATH: process.env.PATH ?? '',
          SUPABASE_URL: 'https://aaaaaaaaaaaaaaaa.supabase.co',
          // A host that resolves nowhere: reaching for it would hang or fail differently.
          DATABASE_URL: 'postgresql://postgres:pw@db.bbbbbbbbbbbbbbbb.supabase.co:5432/postgres',
          SUPABASE_SERVICE_ROLE_KEY: 'service-role-placeholder',
        },
      },
    );
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stderr, /aaaaaaaaaaaaaaaa/);
    assert.match(run.stderr, /bbbbbbbbbbbbbbbb/);
    // env.ts refuses to boot without STRIPE_SECRET_KEY and the rest: had it
    // loaded, this is the message stderr would carry.
    assert.doesNotMatch(run.stderr, /Invalid environment/);
  });

  test('the CLI refuses a run missing one of the three variables, naming it', () => {
    const run = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'scripts/staff-provision.ts',
        '--project',
        'local',
        '--expire',
        'x@nwa-staff.invalid',
      ],
      {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
        env: { PATH: process.env.PATH ?? '', SUPABASE_URL: 'http://127.0.0.1:54321' },
      },
    );
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /DATABASE_URL/);
    assert.doesNotMatch(run.stderr, /Invalid environment/);
  });
});
