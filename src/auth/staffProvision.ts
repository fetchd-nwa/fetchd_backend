import type pg from 'pg';
import { z } from 'zod';
import type { StaffRole } from '../contracts/wire.js';
import { withActorOn } from '../db/actorOn.js';
import { resolveTarget } from '../db/migrate.js';
import { staffRole } from '../db/schema/schema.js';
import { LOCATION_DISPLAY } from '../lib/locations.js';
import { pgEnumTuple } from '../lib/pgEnumTuple.js';
import type { AdminClient, AdminUser } from './adminClient.js';

export type { AdminClient, AdminUser } from './adminClient.js';

/**
 * `npm run staff:provision` — the ONLY writer of person `staff` rows (design
 * §2.1:1969-2045; STAFF-U02, STAFF-U03; P02 item 6). The auth webhook never
 * writes one (ACCT-U05); M8.03 will insert the one system row. The CLI is
 * `scripts/staff-provision.ts`; everything it decides lives here, so it is
 * typechecked and tested against a fake admin client.
 *
 * Nothing here loads `src/env.ts`: the script reads three variables
 * (`DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`), and its imports
 * — this module, `adminClient.ts`, `db/actorOn.ts`, `db/migrate.ts`, the Drizzle
 * enum, `lib/locations.ts` — load no server configuration.
 *
 * **A roster run** (`runRoster`):
 *   - *Pass 1, before any write.* The whole roster is validated — a known
 *     role, one entry per email, a non-empty set of home campuses with no slug
 *     twice (DECISIONS 75) and every slug a `locations` row, both responders
 *     or neither. Then every roster email is looked up among the auth users.
 *     A name holding a control character (NUL, ESC…) is refused here, not at
 *     the INSERT after every `createUser`. A user whose uid has an EXPIRED
 *     staff row is skipped and printed ("expired: use --rehire") before any
 *     other check: a roster run never
 *     adopts, re-roles or un-expires a leaver. Any other existing user is
 *     adopted only if `app_metadata.app_role` is set (only the admin API
 *     writes it) and no live `owners` row holds the uid; otherwise the run
 *     exits 1 having written nothing for anyone, printing the uid, created_at,
 *     email_confirmed_at, last_sign_in_at and identity providers. A roster
 *     role that differs from the adopted user's `app_role` (or from her staff
 *     row's role) is a role change: printed, and applied only with `--yes`.
 *     A run whose role changes would leave no live `owner` row is refused
 *     unless `--last-owner` is passed (DECISIONS 77, 82(b)); the count is
 *     taken again inside the write transaction, the owner rows locked `FOR
 *     UPDATE`, so two concurrent runs cannot each demote one of two owners.
 *   - *Pass 2.* Auth first — `createUser({email, email_confirm: true,
 *     app_metadata: {app_role}})` for each new staffer (`app_metadata` carries
 *     `app_role` only: name and campuses live on the row, read from `GET
 *     /me`, never copied into the token), the confirmed role changes — then
 *     ONE transaction as `system:staff-provision`: each row upserted by
 *     `supabase_uid`, touching neither `expired_at` nor an unchanged row (so a
 *     re-run writes no audit row), and each EMPTY messaging-responder slot
 *     filled by staff id from the roster — one already set is never touched,
 *     and a slot whose named staffer was skipped, or already holds the other
 *     slot, is printed as left empty (DECISIONS 76, 82(c)): one staffer never
 *     fills both. Last, a set-password link
 *     (`generateLink` recovery → `<portal>/set-password`) only for users this
 *     run created, each printed once, to be handed over in person; an adopted
 *     user's link is `--link`'s alone, so a re-run never voids one already
 *     handed over.
 *
 * **`--link <email>`** re-mints one link for a live staffer. **`--expire
 * <email>`** prints its plan and, with `--yes` (DECISIONS 77), sets
 * `expired_at` (sign-in refuses at once: the mirror reads it), empties a
 * responder slot that names her (printed: a roster re-run fills it), bans the
 * auth user and removes `app_role` from her `app_metadata`, so the preflight's
 * roster clause never counts a leaver. It refuses the last live `owner` row
 * unless `--last-owner` is passed too, decided under the roster's owner-row lock
 * (DECISIONS 82(b)). **`--rehire <email>`** is the one way
 * back: `app_role` from the roster, the ban lifted and `expired_at` cleared
 * together, under one printed confirmation (`--yes`), her campuses checked
 * against `locations` as a roster run checks them (DECISIONS 79).
 */

const ACTOR = 'system:staff-provision';

/** GoTrue takes a Go duration; ~100 years is "until --rehire lifts it". */
const BAN_UNTIL_REHIRED = '876000h';

const STAFF_ROLES = pgEnumTuple(staffRole);

export interface RosterEntry {
  email: string;
  name: string;
  role: StaffRole;
  home_locations: string[];
  /** Which messaging responder this staffer is, if either (§3.13: Amber the
   *  default, Shanthi the backup). */
  responder?: 'default' | 'backup';
}

export interface Deps {
  admin: AdminClient;
  /** A connection the caller owns; the script's own `pg` client. */
  db: pg.ClientBase;
  out: (line: string) => void;
}

type Outcome<T> = { ok: true } & T;
type Refused = { ok: false; reason: string };

// ── the roster ───────────────────────────────────────────────────────────────

/** The C0 control set (U+0000–U+001F), as the settings PATCH refuses it
 *  (DECISIONS 66, 71): Postgres refuses NUL in text — at the INSERT, after
 *  every `createUser` has run — and ESC and the rest would reach the
 *  operator's terminal and the wire. Also DEL, the C1 set (U+009B is CSI to
 *  some terminals) and the bidi overrides and isolates (U+202A–E, U+2066–9),
 *  which reorder what the operator reads (adversary r2 N4). */
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

const entrySchema = z
  .object({
    email: z
      .string()
      .trim()
      .email()
      .transform((email) => email.toLowerCase()),
    name: z
      .string()
      .trim()
      .min(1)
      .refine(
        (name) => !CONTROL_CHARACTER.test(name),
        'must not hold a control or bidi character (NUL, ESC, CR, LF, DEL, C1, U+202E…)',
      ),
    role: z.enum(STAFF_ROLES),
    home_locations: z.array(z.string().trim().min(1)),
    responder: z.enum(['default', 'backup']).optional(),
  })
  .strict();

/**
 * The roster file's content → entries, or every reason it is refused. Pure;
 * the slugs are checked against `locations` by the run itself.
 */
export function parseRoster(json: unknown): Outcome<{ roster: RosterEntry[] }> | Refused {
  const parsed = z.array(entrySchema).min(1).safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(roster)'}: ${issue.message}`)
      .join('; ');
    return { ok: false, reason: `the roster is not a non-empty list of staffers: ${issues}` };
  }
  const roster: RosterEntry[] = parsed.data;
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const entry of roster) {
    if (seen.has(entry.email)) problems.push(`${entry.email} is on the roster twice`);
    seen.add(entry.email);
    if (entry.home_locations.length === 0) {
      problems.push(`${entry.email}: no home campus (home_locations is never empty)`);
    }
    if (new Set(entry.home_locations).size !== entry.home_locations.length) {
      problems.push(`${entry.email}: a home campus is named twice (DECISIONS 75)`);
    }
  }
  for (const responder of ['default', 'backup'] as const) {
    const named = roster.filter((e) => e.responder === responder);
    if (named.length > 1) problems.push(`${named.length} staffers are the ${responder} responder`);
  }
  const responders = roster.filter((e) => e.responder !== undefined).length;
  if (responders === 1)
    problems.push('name both messaging responders (default and backup) or neither');
  return problems.length === 0 ? { ok: true, roster } : { ok: false, reason: problems.join('; ') };
}

// ── the project-ref check ────────────────────────────────────────────────────

const LOCALHOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function parsedUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function supabaseRefOf(url: URL): string | null {
  const host = url.hostname.toLowerCase();
  if (LOCALHOSTS.has(host)) return 'local';
  return /^([a-z0-9]+)\.supabase\.co$/.exec(host)?.[1] ?? null;
}

/**
 * `--project`, the ref in `SUPABASE_URL`'s host and the ref in `DATABASE_URL`
 * (`db.<ref>.supabase.co`, or user `postgres.<ref>` on the pooler; `local` for
 * localhost) must be equal, or the run stops before any call, naming both refs
 * (design §2.1:1980-1983). A `DATABASE_URL` the migration runner refuses (the
 * 6543 transaction pooler, a query string…) is refused with the runner's own
 * reason. `SUPABASE_URL` is https unless its host is loopback: every admin
 * call carries the service-role key (DECISIONS 80).
 */
export function checkProjectRefs(
  supabaseUrl: string,
  databaseUrl: string,
  project: string,
): Outcome<object> | Refused {
  const url = parsedUrl(supabaseUrl);
  if (
    url !== null &&
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && LOCALHOSTS.has(url.hostname.toLowerCase()))
  ) {
    return {
      ok: false,
      reason:
        `SUPABASE_URL is ${url.protocol}//${url.host}: it must be https (only a loopback host may ` +
        'use http), because every admin call sends the service-role key. Nothing was called.',
    };
  }
  const target = resolveTarget(databaseUrl);
  if (!target.ok) {
    return { ok: false, reason: `DATABASE_URL is refused: ${target.reason}. Nothing was called.` };
  }
  const supabase = url === null ? null : supabaseRefOf(url);
  if (supabase !== null && supabase === target.project && target.project === project) {
    return { ok: true };
  }
  return {
    ok: false,
    reason:
      `--project is '${project}', SUPABASE_URL points at '${supabase ?? 'an unrecognised host'}' and ` +
      `DATABASE_URL at '${target.project}'. All three must name one project. Nothing was called.`,
  };
}

// ── shared reads ─────────────────────────────────────────────────────────────

/** Every auth user — the admin listing, page by page, until an EMPTY page (a
 *  short page is not the end: GoTrue may cap per_page). */
async function allUsers(admin: AdminClient): Promise<AdminUser[]> {
  const users: AdminUser[] = [];
  for (let page = 1; ; page += 1) {
    const batch = await admin.listUsers(page);
    if (batch.length === 0) return users;
    users.push(...batch);
    if (page >= 10_000) throw new Error('the admin user listing did not end after 10,000 pages');
  }
}

/** A user's email, lower-cased; `null` for a phone-only user, who has none. */
function emailOf(user: AdminUser): string | null {
  return typeof user.email === 'string' && user.email !== '' ? user.email.toLowerCase() : null;
}

/** Every auth user with an email, by lower-cased email. A phone-only user
 *  cannot be a roster entry (the roster is keyed by email), so is not listed. */
async function usersByEmail(admin: AdminClient): Promise<Map<string, AdminUser>> {
  const users = new Map<string, AdminUser>();
  for (const user of await allUsers(admin)) {
    const email = emailOf(user);
    if (email !== null) users.set(email, user);
  }
  return users;
}

interface StaffRow {
  id: string;
  name: string;
  role: string;
  home_locations: string[];
  expired_at: string | null;
}

async function staffRowOf(db: pg.ClientBase, uid: string): Promise<StaffRow | undefined> {
  const { rows } = await db.query<StaffRow>(
    `SELECT id, name, role::text AS role, home_locations, expired_at::text AS expired_at
       FROM staff WHERE supabase_uid = $1`,
    [uid],
  );
  return rows[0];
}

/**
 * The uids of the live `owner` staff rows. Inside a write transaction pass
 * `lock`: the rows are taken `FOR UPDATE`, so a second run that would also
 * take an owner away waits here until the first commits, then reads what it
 * committed (DECISIONS 77, 82(b)) — two concurrent runs cannot both pass.
 */
async function liveOwnerUids(db: pg.ClientBase, lock: boolean): Promise<Set<string>> {
  const { rows } = await db.query<{ uid: string }>(
    `SELECT supabase_uid::text AS uid FROM staff WHERE role = 'owner' AND expired_at IS NULL` +
      (lock ? ' FOR UPDATE' : ''),
  );
  return new Set(rows.map((r) => r.uid));
}

/**
 * The emails of the live owners a roster run demotes, if the run leaves no
 * live owner row; [] otherwise (DECISIONS 77, 82(b)). A run that demotes no
 * one is never refused, and one that makes another owner while demoting the
 * last leaves one. `uidOf` is the planned user's uid (none yet for a user the
 * run will create).
 */
function lastOwnerDemotions(
  owners: ReadonlySet<string>,
  planned: readonly Planned[],
  uidOf: (plan: Planned) => string | undefined,
): string[] {
  const after = new Set(owners);
  const demoted: string[] = [];
  for (const plan of planned) {
    const uid = uidOf(plan);
    if (plan.entry.role === 'owner') after.add(uid ?? `new:${plan.entry.email}`);
    else if (uid !== undefined && owners.has(uid)) {
      after.delete(uid);
      demoted.push(plan.entry.email);
    }
  }
  return demoted.length > 0 && after.size === 0 ? demoted : [];
}

/** The locked count's refusal, inside the transaction: a concurrent run took
 *  an owner away after pass 1 passed. */
class LastOwnerRaced extends Error {}

function lastOwnerRefusal(emails: readonly string[]): string {
  return (
    `refused: ${emails.join(', ')} ${emails.length === 1 ? 'is the last live owner' : 'are the last live owners'} — ` +
    'no one would be left to edit the role lists. If that is meant, pass --last-owner as well.'
  );
}

async function holdsLiveOwnerRow(db: pg.ClientBase, uid: string): Promise<boolean> {
  const { rows } = await db.query(
    'SELECT 1 FROM owners WHERE supabase_uid = $1 AND expired_at IS NULL',
    [uid],
  );
  return rows.length > 0;
}

function appRoleOf(user: AdminUser): string | undefined {
  const role = user.app_metadata?.app_role;
  return typeof role === 'string' && role.length > 0 ? role : undefined;
}

/** What a refusal prints about an auth user, so a person can decide. */
function describe(user: AdminUser): string {
  const providers = [...new Set(user.identities.map((i) => i.provider))].join(', ') || 'none';
  return (
    `uid ${user.id}, created_at ${user.created_at}, ` +
    `email_confirmed_at ${user.email_confirmed_at ?? 'never'}, ` +
    `last_sign_in_at ${user.last_sign_in_at ?? 'never'}, providers ${providers}`
  );
}

/** A set of slugs in one order, so a re-run compares equal and writes nothing. */
function canonical(homes: readonly string[]): string[] {
  return [...homes].sort();
}

/**
 * Every home campus must be a `locations` row (design §2.1:1940-1943) and a
 * key of `LOCATION_DISPLAY`, the static map `GET /me` renders labels from — on
 * every write path, the roster run and `--rehire` alike (DECISIONS 79, 82(d)).
 * A `locations` row added before its label would otherwise be written here and
 * 500 that staffer's every `/me`. Returns the refusal, or `null`.
 */
async function unknownHomes(
  db: pg.ClientBase,
  entries: readonly RosterEntry[],
): Promise<string | null> {
  const { rows } = await db.query<{ slug: string }>('SELECT slug FROM locations');
  const slugs = new Set(rows.map((r) => r.slug));
  const named = (keep: (slug: string) => boolean) =>
    entries.flatMap((e) => e.home_locations.filter(keep).map((s) => `${e.email}: '${s}'`));
  const unknown = named((s) => !slugs.has(s));
  const unlabelled = named((s) => slugs.has(s) && !Object.hasOwn(LOCATION_DISPLAY, s));
  const problems = [
    unknown.length === 0
      ? null
      : `home campus not in locations (${[...slugs].join(', ')}): ${unknown.join('; ')}`,
    unlabelled.length === 0
      ? null
      : 'home campus is a locations row with no display label yet, so GET /me could not ' +
        `render it (add it to LOCATION_DISPLAY in src/lib/locations.ts first): ${unlabelled.join('; ')}`,
  ].filter((p) => p !== null);
  return problems.length === 0 ? null : problems.join('; ');
}

// ── a roster run ─────────────────────────────────────────────────────────────

type Planned =
  | { kind: 'create'; entry: RosterEntry }
  | {
      kind: 'adopt';
      entry: RosterEntry;
      user: AdminUser;
      /** `app_role` (and the row's role) → the roster's, if they differ. */
      roleChange: { from: string; to: StaffRole } | null;
    };

export async function runRoster(
  deps: Deps,
  rosterInput: readonly RosterEntry[],
  options: { portalOrigin: string; confirm: boolean; lastOwner?: boolean },
): Promise<number> {
  const { admin, db, out } = deps;
  const parsed = parseRoster(rosterInput);
  if (!parsed.ok) {
    out(`refused: ${parsed.reason}. Nothing was written.`);
    return 1;
  }
  const roster = parsed.roster;

  // ── pass 1: everything that can refuse, before any write ──
  const homes = await unknownHomes(db, roster);
  if (homes !== null) {
    out(`refused: ${homes}. Nothing was written.`);
    return 1;
  }

  const users = await usersByEmail(admin);
  const planned: Planned[] = [];
  const refusals: string[] = [];
  for (const entry of roster) {
    const user = users.get(entry.email);
    if (user === undefined) {
      planned.push({ kind: 'create', entry });
      continue;
    }
    const row = await staffRowOf(db, user.id);
    if (row !== undefined && row.expired_at !== null) {
      out(`${entry.email}: expired: use --rehire ${entry.email} (skipped; nothing changed)`);
      continue;
    }
    if (await holdsLiveOwnerRow(db, user.id)) {
      refusals.push(`${entry.email} belongs to a family (a live owners row): ${describe(user)}`);
      continue;
    }
    const appRole = appRoleOf(user);
    if (appRole === undefined) {
      refusals.push(
        `${entry.email} is an auth user with no app_role — a sign-up, not a staffer: ${describe(user)}`,
      );
      continue;
    }
    // The token's role first; failing that, a row that drifted from it.
    const from = appRole !== entry.role ? appRole : row?.role;
    planned.push({
      kind: 'adopt',
      entry,
      user,
      roleChange: from !== undefined && from !== entry.role ? { from, to: entry.role } : null,
    });
  }
  if (refusals.length > 0) {
    for (const refusal of refusals) out(`refused: ${refusal}`);
    out('Nothing was written for anyone: resolve each user above by hand, then re-run.');
    return 1;
  }

  const roleChanges = planned.filter(
    (p): p is Extract<Planned, { kind: 'adopt' }> => p.kind === 'adopt' && p.roleChange !== null,
  );
  for (const change of roleChanges) {
    const { from, to } = change.roleChange as { from: string; to: StaffRole };
    out(`${change.entry.email}: role ${from} → ${to} (app_metadata and the staff row together)`);
  }
  // A role change must not take away the one role that edits the role lists
  // (DECISIONS 77, 82(b)). Read here so a refusal writes nothing; read again,
  // locked, inside the transaction below, where it is decided.
  const adoptedUid = (plan: Planned) => (plan.kind === 'adopt' ? plan.user.id : undefined);
  if (options.lastOwner !== true) {
    const taken = lastOwnerDemotions(await liveOwnerUids(db, false), planned, adoptedUid);
    if (taken.length > 0) {
      out(`${lastOwnerRefusal(taken)} Nothing was written.`);
      return 1;
    }
  }
  if (roleChanges.length > 0 && !options.confirm) {
    out('Role changes need confirmation: re-run with --yes to apply them. Nothing was written.');
    return 1;
  }

  // ── pass 2: auth, then one transaction, then the links ──
  const uidByEmail = new Map<string, string>();
  const createdEmails: string[] = [];
  const reroled: string[] = [];
  // Pass 2 is not one transaction across Supabase and Postgres. If it stops
  // part-way, say exactly what this run already did, so the next step is
  // obvious: a re-run ADOPTS every user created here (each carries app_role),
  // finds a role already changed in auth but not on the row (a role change
  // again, so --yes) and writes the missing rows, but mints them no link —
  // that is --link's.
  const stoppedPartWay = (stage: string, err: unknown): never => {
    out(
      `FAILED ${stage}: ${err instanceof Error ? err.message : String(err)}. ` +
        (createdEmails.length === 0
          ? 'No auth user was created by this run.'
          : `Auth users created by this run: ${createdEmails.join(', ')}. Re-run the roster ` +
            '(it adopts them and writes their rows), then mint each one a link with --link.') +
        (reroled.length === 0
          ? ''
          : err instanceof LastOwnerRaced
            ? // Bringing the row to the new role is what was just refused.
              ` app_role already changed by this run, her staff row not: ${reroled.join(', ')}. ` +
              'To put app_role back, re-run the roster naming her old role, with --yes.'
            : ` app_role already changed by this run, her staff row not yet: ${reroled.join(', ')}. ` +
              'Re-run the roster with --yes to bring each row to it.'),
    );
    throw err;
  };
  for (const plan of planned) {
    if (plan.kind === 'create') {
      const user = await admin
        .createUser({
          email: plan.entry.email,
          email_confirm: true,
          app_metadata: { app_role: plan.entry.role },
        })
        .catch((err: unknown) => stoppedPartWay(`creating ${plan.entry.email}`, err));
      uidByEmail.set(plan.entry.email, user.id);
      createdEmails.push(plan.entry.email);
      out(`${plan.entry.email}: auth user created (${plan.entry.role})`);
    } else {
      uidByEmail.set(plan.entry.email, plan.user.id);
      const from = appRoleOf(plan.user);
      if (from !== plan.entry.role) {
        await admin
          .updateUserById(plan.user.id, { app_metadata: { app_role: plan.entry.role } })
          .catch((err: unknown) => stoppedPartWay(`re-roling ${plan.entry.email}`, err));
        reroled.push(`${plan.entry.email} (${from} → ${plan.entry.role})`);
      }
    }
  }

  const rows = withActorOn(db, ACTOR, async (tx) => {
    // The owner rows are locked before anything is written: a concurrent run
    // that also demotes an owner waits here, then counts what this one left.
    if (options.lastOwner !== true) {
      const taken = lastOwnerDemotions(await liveOwnerUids(tx, true), planned, (plan) =>
        uidByEmail.get(plan.entry.email),
      );
      if (taken.length > 0) {
        throw new LastOwnerRaced(`${lastOwnerRefusal(taken)} Another run took an owner away first`);
      }
    }
    for (const plan of planned) {
      const { entry } = plan;
      const written = await tx.query(
        `INSERT INTO staff (supabase_uid, name, role, home_locations, expired_at)
         VALUES ($1, $2, $3::staff_role, $4::text[], NULL)
         ON CONFLICT (supabase_uid) DO UPDATE
            SET name = EXCLUDED.name, role = EXCLUDED.role, home_locations = EXCLUDED.home_locations
          WHERE staff.expired_at IS NULL
            AND (staff.name, staff.role, staff.home_locations)
                IS DISTINCT FROM (EXCLUDED.name, EXCLUDED.role, EXCLUDED.home_locations)`,
        [uidByEmail.get(entry.email), entry.name, entry.role, canonical(entry.home_locations)],
      );
      out(`${entry.email}: staff row ${written.rowCount === 0 ? 'unchanged' : 'written'}`);
    }
    // Each EMPTY responder slot is filled from the roster; one already set is
    // never touched (DECISIONS 76). Both keys are inert to PATCH until
    // MSG-U27, so after --expire empties a slot this is the way to fill it.
    const defaultEntry = roster.find((e) => e.responder === 'default');
    const backupEntry = roster.find((e) => e.responder === 'backup');
    if (defaultEntry !== undefined && backupEntry !== undefined) {
      const {
        rows: [held],
      } = await tx.query<{ def: string | null; backup: string | null }>(
        `SELECT school_default_responder_staff_id AS def, school_backup_responder_staff_id AS backup
           FROM messaging_settings FOR UPDATE`,
      );
      if (held === undefined) throw new Error('messaging_settings has no row: apply M1.11');
      const slots = [
        { slot: 'default', entry: defaultEntry, held: held.def },
        { slot: 'backup', entry: backupEntry, held: held.backup },
      ];
      if (slots.every((s) => s.held !== null)) {
        out('responders: already set, left as they are');
      } else {
        // A named staffer skipped in pass 1 (expired) has no uid here.
        const named = slots.map((s) =>
          s.held === null ? (uidByEmail.get(s.entry.email) ?? null) : null,
        );
        // One staffer never fills both slots (DECISIONS 82(c)): a fill naming
        // whoever already holds the other slot — a roster that swaps default
        // and backup — is left empty, since the held slot is never touched.
        const holdsOther: boolean[] = [];
        for (const [i, uid] of named.entries()) {
          const other = slots[1 - i]?.held ?? null;
          const found =
            uid === null || other === null
              ? undefined
              : (
                  await tx.query<{ id: string }>('SELECT id FROM staff WHERE supabase_uid = $1', [
                    uid,
                  ])
                ).rows[0];
          holdsOther.push(found !== undefined && found.id === other);
        }
        const fill = named.map((uid, i) => (holdsOther[i] === true ? null : uid));
        if (fill.some((uid) => uid !== null)) {
          await tx.query(
            `UPDATE messaging_settings
                SET school_default_responder_staff_id = COALESCE(school_default_responder_staff_id,
                      (SELECT id FROM staff WHERE supabase_uid = $1)),
                    school_backup_responder_staff_id = COALESCE(school_backup_responder_staff_id,
                      (SELECT id FROM staff WHERE supabase_uid = $2)),
                    updated_at = now()
              WHERE school_default_responder_staff_id IS NULL
                 OR school_backup_responder_staff_id IS NULL`,
            fill,
          );
        }
        slots.forEach((s, i) => {
          if (s.held !== null) out(`responders: ${s.slot} already set, left as it is`);
          else if (holdsOther[i] === true) {
            out(
              `responders: ${s.slot} left EMPTY — ${s.entry.email} already holds the ` +
                `${slots[1 - i]?.slot} slot, and one staffer never fills both (moving a set ` +
                "slot waits for MSG-U27's editor)",
            );
          } else if (fill[i] !== null) out(`responders: ${s.slot} ${s.entry.email}`);
          else {
            out(
              `responders: ${s.slot} left EMPTY — ${s.entry.email} was skipped above, so this ` +
                'run names no one (rehire her, or name another and re-run the roster)',
            );
          }
        });
      }
    }
  });
  await rows.catch((err: unknown) =>
    stoppedPartWay('writing the staff rows (rolled back: no row was written)', err),
  );

  // After the commit: a failure here leaves the rows written and some links
  // unminted, which a re-run never mints (it adopts). Name the rest for --link.
  const linked: string[] = [];
  for (const email of createdEmails) {
    const { action_link } = await admin
      .generateRecoveryLink(email, `${options.portalOrigin}/set-password`)
      .catch((err: unknown): never => {
        const rest = createdEmails.filter((e) => !linked.includes(e));
        out(
          `FAILED minting ${email}'s set-password link: ${err instanceof Error ? err.message : String(err)}. ` +
            'The staff rows are written' +
            (linked.length === 0 ? '' : `, and links were printed above for ${linked.join(', ')}`) +
            `. Mint the rest one at a time with --link: ${rest.join(', ')}.`,
        );
        throw err;
      });
    linked.push(email);
    out(`${email}: set-password link (printed once — hand it over in person): ${action_link}`);
  }
  out(`done: ${createdEmails.length} created, ${planned.length - createdEmails.length} adopted.`);
  return 0;
}

// ── --link, --expire, --rehire ───────────────────────────────────────────────

export async function runLink(
  deps: Deps,
  emailInput: string,
  options: { portalOrigin: string },
): Promise<number> {
  const { admin, db, out } = deps;
  const email = emailInput.trim().toLowerCase();
  const user = (await usersByEmail(admin)).get(email);
  const row = user === undefined ? undefined : await staffRowOf(db, user.id);
  if (
    user === undefined ||
    row === undefined ||
    row.expired_at !== null ||
    appRoleOf(user) === undefined
  ) {
    out(
      `refused: ${email} is not a live staffer (no auth user, no live staff row, or no app_role). No link was minted.`,
    );
    return 1;
  }
  const { action_link } = await admin.generateRecoveryLink(
    email,
    `${options.portalOrigin}/set-password`,
  );
  out(`${email}: set-password link (printed once — hand it over in person): ${action_link}`);
  return 0;
}

export async function runExpire(
  deps: Deps,
  emailInput: string,
  options: { confirm: boolean; lastOwner?: boolean },
): Promise<number> {
  const { admin, db, out } = deps;
  const email = emailInput.trim().toLowerCase();
  const user = (await usersByEmail(admin)).get(email);
  const row = user === undefined ? undefined : await staffRowOf(db, user.id);
  if (user === undefined || row === undefined) {
    out(`refused: ${email} has no auth user or no staff row. Nothing was changed.`);
    return 1;
  }
  out(
    `expire ${email} (${row.name}, ${row.role}, home ${row.home_locations.join(', ')}): ` +
      'expired_at set, a responder slot naming her emptied, the auth user banned and app_role removed',
  );
  // A typo must not take away the one role that edits the role lists (DECISIONS
  // 77): read here so the refusal comes before the confirmation, and decided
  // again, locked, inside the transaction (DECISIONS 82(b)).
  const guarded = row.expired_at === null && row.role === 'owner' && options.lastOwner !== true;
  const leavesNoOwner = async (reader: pg.ClientBase, lock: boolean): Promise<boolean> => {
    const owners = await liveOwnerUids(reader, lock);
    owners.delete(user.id);
    return owners.size === 0;
  };
  if (guarded && (await leavesNoOwner(db, false))) {
    out(`${lastOwnerRefusal([email])} Nothing was changed.`);
    return 1;
  }
  if (!options.confirm) {
    out('Expiring a staffer needs confirmation: re-run with --yes. Nothing was changed.');
    return 1;
  }
  // The row first: sign-in refuses the moment `expired_at` is set.
  const raced = await withActorOn(db, ACTOR, async (tx) => {
    if (guarded && (await leavesNoOwner(tx, true))) return true;
    if (row.expired_at === null) {
      await tx.query('UPDATE staff SET expired_at = now() WHERE id = $1', [row.id]);
      out(`${email}: staff row expired (sign-in refuses from now)`);
    } else {
      out(`${email}: staff row already expired at ${row.expired_at}`);
    }
    // Which slots name her, read BEFORE the reset (and locked until the commit).
    const {
      rows: [held],
    } = await tx.query<{ was_default: boolean; was_backup: boolean }>(
      `SELECT school_default_responder_staff_id IS NOT DISTINCT FROM $1 AS was_default,
              school_backup_responder_staff_id IS NOT DISTINCT FROM $1 AS was_backup
         FROM messaging_settings FOR UPDATE`,
      [row.id],
    );
    if (held !== undefined && (held.was_default || held.was_backup)) {
      await tx.query(
        `UPDATE messaging_settings
            SET school_default_responder_staff_id = NULLIF(school_default_responder_staff_id, $1),
                school_backup_responder_staff_id = NULLIF(school_backup_responder_staff_id, $1),
                updated_at = now()
          WHERE school_default_responder_staff_id = $1 OR school_backup_responder_staff_id = $1`,
        [row.id],
      );
      const which = [held.was_default ? 'default' : null, held.was_backup ? 'backup' : null]
        .filter((w) => w !== null)
        .join(' and ');
      out(
        `${email} was the ${which} messaging responder: that slot is now empty — ` +
          're-run the roster to name a new one',
      );
    }
    return false;
  });
  if (raced) {
    out(
      `${lastOwnerRefusal([email])} (Another run took an owner away first.) Nothing was changed.`,
    );
    return 1;
  }
  await admin.updateUserById(user.id, {
    ban_duration: BAN_UNTIL_REHIRED,
    app_metadata: { app_role: null },
  });
  out(`${email}: auth user banned and app_role removed (the current token dies at its expiry)`);
  return 0;
}

export async function runRehire(
  deps: Deps,
  emailInput: string,
  rosterInput: readonly RosterEntry[],
  options: { confirm: boolean },
): Promise<number> {
  const { admin, db, out } = deps;
  const email = emailInput.trim().toLowerCase();
  const parsed = parseRoster(rosterInput);
  if (!parsed.ok) {
    out(`refused: ${parsed.reason}. Nothing was changed.`);
    return 1;
  }
  const entry = parsed.roster.find((e) => e.email === email);
  if (entry === undefined) {
    out(
      `refused: ${email} is not on the roster, which is where her role comes from. Nothing was changed.`,
    );
    return 1;
  }
  const homes = await unknownHomes(db, [entry]);
  if (homes !== null) {
    out(`refused: ${homes}. Nothing was changed.`);
    return 1;
  }
  const user = (await usersByEmail(admin)).get(email);
  const row = user === undefined ? undefined : await staffRowOf(db, user.id);
  if (user === undefined || row === undefined) {
    out(`refused: ${email} was never provisioned — run the roster instead. Nothing was changed.`);
    return 1;
  }
  if (row.expired_at === null) {
    out(`refused: ${email} is not expired. Nothing was changed.`);
    return 1;
  }
  if (await holdsLiveOwnerRow(db, user.id)) {
    out(`refused: ${email} belongs to a family (a live owners row): ${describe(user)}`);
    return 1;
  }
  out(
    `rehire ${email}: app_role ${entry.role}, the ban lifted, expired_at cleared, ` +
      `name '${entry.name}', home ${canonical(entry.home_locations).join(', ')}`,
  );
  if (!options.confirm) {
    out('A rehire needs confirmation: re-run with --yes. Nothing was changed.');
    return 1;
  }
  await admin.updateUserById(user.id, {
    app_metadata: { app_role: entry.role },
    ban_duration: 'none',
  });
  await withActorOn(db, ACTOR, (tx) =>
    tx.query(
      `UPDATE staff SET expired_at = NULL, name = $2, role = $3::staff_role, home_locations = $4::text[]
        WHERE id = $1`,
      [row.id, entry.name, entry.role, canonical(entry.home_locations)],
    ),
  );
  out(`${email}: rehired (her old set-password link, if any, is dead: mint one with --link)`);
  return 0;
}

// ── the preflight's staff clauses ────────────────────────────────────────────

/**
 * The staff clauses of the pilot preflight (design §2.1:1920-1924), as a
 * function P23's `scripts/pilot-preflight.ts` can call: every live person
 * staff row belongs to an auth user on a roster email, and every auth user
 * whose `app_metadata.app_role` is set is on the roster (which `--expire` keeps
 * true by removing a leaver's `app_role`). Returns each violation; [] is green.
 * (The system row, M8.03's, is not a person row and does not exist yet.)
 */
export async function staffClauseViolations(
  deps: Pick<Deps, 'admin' | 'db'>,
  rosterInput: readonly RosterEntry[],
): Promise<string[]> {
  const rosterEmails = new Set(rosterInput.map((e) => e.email.trim().toLowerCase()));
  // Every user, phone-only ones too: one of those is never on the roster.
  const users = await allUsers(deps.admin);
  const byId = new Map(users.map((u) => [u.id, u]));
  const named = (user: AdminUser) => emailOf(user) ?? `uid ${user.id} (no email)`;
  const onRoster = (user: AdminUser) => rosterEmails.has(emailOf(user) ?? '');
  const violations: string[] = [];
  const { rows } = await deps.db.query<{ id: string; uid: string }>(
    'SELECT id, supabase_uid::text AS uid FROM staff WHERE expired_at IS NULL',
  );
  for (const row of rows) {
    const user = byId.get(row.uid);
    if (user === undefined) violations.push(`live staff row ${row.id}: its uid has no auth user`);
    else if (!onRoster(user)) {
      violations.push(`live staff row ${row.id}: ${named(user)} is not on the roster`);
    }
  }
  for (const user of users) {
    if (appRoleOf(user) !== undefined && !onRoster(user)) {
      violations.push(`auth user ${named(user)} holds app_role but is not on the roster`);
    }
  }
  return violations;
}
