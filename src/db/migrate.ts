import { createHash } from 'node:crypto';
import { parse as parseConnectionString } from 'pg-connection-string';
import type pg from 'pg';

/**
 * The migration runner's core (design §4 preamble, design.md:6077-6092; S01).
 * The CLI is `scripts/migrate-apply.ts`; this module holds everything it
 * decides, so the decisions are typechecked and tested without a shell.
 *
 * **What a step is.** One committed file `migrations/<group>/<step_id>_<slug>.sql`
 * (`M1.07_day_program_settings.sql` → step `M1.07`). The runner sends its exact
 * bytes — the bytes it hashed — so the database that received a step and the
 * log row that records it agree on what was sent.
 *
 * **How it is applied.** In one transaction, in this order:
 *
 *     BEGIN;
 *     SELECT set_config('app.actor', 'system:migrate-<step_id>', true);
 *     <the file's bytes>;
 *     INSERT INTO migrations_applied (step_id, applied_by, sql_sha256) VALUES (…);
 *     COMMIT;
 *
 * The log row is the step's LAST statement, so a step is logged if and only if
 * all of it committed. `app.actor` is transaction-local, so every audit row the
 * step writes names the step and nothing after it inherits the actor. (A step
 * pasted into the SQL editor sets no actor, and its audit rows would record
 * NULL, which STAFF-74 forbids: steps go through this runner, never the editor.)
 *
 * **The header.** A step's leading comment lines may carry directives, one per
 * line, exactly `-- migrate: <directive>`:
 *
 *   - `-- migrate: no-transaction` — for `ALTER TYPE … ADD VALUE` and anything
 *     else that must commit on its own. The bytes run bare (Postgres runs a
 *     multi-statement string as one implicit transaction unless the file
 *     issues its own `BEGIN`/`COMMIT`, which only this header permits), with
 *     the actor set for the session, and the log row is written afterwards in
 *     a second transaction. A failure part-way is NOT rolled back by the
 *     runner — that is what the header means — so a no-transaction step should
 *     be one statement, or explicitly bracketed by its author.
 *   - `-- migrate: invalidate-class-catalog` — after the step commits, clear
 *     the class catalog's cache (`groupclasses:*`, `lib/cache.ts`), the one
 *     Redis key family the runner ever touches. For a seed step that changes a
 *     class price (question 27 (a): a price change is a seed step after
 *     Shanthi's notice). No LG1 step declares it.
 *
 * An unknown directive, or a `-- migrate:` line below the header, is refused:
 * a misspelt `no-transaction` must not silently run in a transaction, and a
 * misspelt cache clear must not silently leave stale class prices.
 *
 * **What is refused before anything runs.** A file name without a step id; a
 * file that is not UTF-8; a file containing transaction control (`BEGIN`,
 * `START TRANSACTION`, `COMMIT`, `ROLLBACK`, or a statement that is `END` or
 * `ABORT`) outside a function body, comment or string, unless its header is
 * `no-transaction` — a `COMMIT` inside a step would end the runner's
 * transaction and let the rest run, and the log row land, in autocommit; a
 * step already in `migrations_applied`; a cache-clearing step with no Redis to
 * clear; and (the CLI's check) a `--project` that does not match the URL.
 */

export type StepDirective = 'no-transaction' | 'invalidate-class-catalog';

const DIRECTIVES: ReadonlySet<string> = new Set<StepDirective>([
  'no-transaction',
  'invalidate-class-catalog',
]);

/** The class catalog's cache family (`lib/cache.ts`), cleared by the directive. */
export const CLASS_CATALOG_CACHE_PATTERN = 'groupclasses:*';

export interface StepFile {
  stepId: string;
  fileName: string;
  /** The exact bytes read from disk — what is hashed and what is sent. */
  bytes: Buffer;
  sql: string;
  sha256: string;
  directives: ReadonlySet<StepDirective>;
}

export type Refusal = { ok: false; reason: string };
export type Parsed<T> = { ok: true } & T;

/** `M1.07_day_program_settings.sql` → `M1.07`; the minor is at least two digits. */
const STEP_FILE_NAME = /^(M\d+\.\d{2,})_[a-z0-9][a-z0-9_-]*\.sql$/;

/**
 * Parse one step file: its id, its header, its hash, and the refusals that
 * need nothing but the file. Pure — the caller reads the bytes.
 */
export function parseStep(fileName: string, bytes: Buffer): Parsed<{ step: StepFile }> | Refusal {
  const name = STEP_FILE_NAME.exec(fileName);
  if (name === null || name[1] === undefined) {
    return {
      ok: false,
      reason: `'${fileName}' is not a step file name: expected <step_id>_<slug>.sql, e.g. M1.07_day_program_settings.sql`,
    };
  }
  // A BOM would be hashed but not sent (the decoder strips it), so the log's
  // sha256 would describe bytes the database never received.
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { ok: false, reason: `${fileName} starts with a UTF-8 BOM: save it without one` };
  }
  let sql: string;
  try {
    sql = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { ok: false, reason: `${fileName} is not valid UTF-8` };
  }
  const header = parseHeader(sql);
  if (!header.ok) return { ok: false, reason: `${fileName}: ${header.reason}` };

  if (!header.directives.has('no-transaction')) {
    const hits = findTransactionControl(sql);
    if (hits.length > 0) {
      const where = hits.map((hit) => `line ${hit.line}: ${hit.statement}`).join('; ');
      return {
        ok: false,
        reason:
          `${fileName} contains transaction control (${where}). The runner opens and commits the ` +
          "step's one transaction; a step that must commit on its own says so in its header " +
          'with `-- migrate: no-transaction`.',
      };
    }
  }

  return {
    ok: true,
    step: {
      stepId: name[1],
      fileName,
      bytes,
      sql,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      directives: header.directives,
    },
  };
}

const DIRECTIVE_LINE = /^--\s*migrate:\s*(.*?)\s*$/;

function parseHeader(sql: string): Parsed<{ directives: ReadonlySet<StepDirective> }> | Refusal {
  const directives = new Set<StepDirective>();
  const lines = sql.split(/\r?\n/);
  let inHeader = true;
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (inHeader && line !== '' && !line.startsWith('--')) inHeader = false;
    const directive = DIRECTIVE_LINE.exec(line);
    if (directive === null) continue;
    if (!inHeader) {
      return {
        ok: false,
        reason: `line ${index + 1}: a '-- migrate:' directive belongs in the header (the leading comment lines), not below it`,
      };
    }
    const value = directive[1] ?? '';
    if (!DIRECTIVES.has(value)) {
      return {
        ok: false,
        reason: `line ${index + 1}: unknown directive '-- migrate: ${value}' (known: ${[...DIRECTIVES].join(', ')})`,
      };
    }
    directives.add(value as StepDirective);
  }
  return { ok: true, directives };
}

export interface TransactionControl {
  line: number;
  statement: string;
}

/**
 * Every transaction-control statement in `sql` that Postgres would execute as
 * one: the words BEGIN, COMMIT and ROLLBACK and the phrases START TRANSACTION
 * and PREPARE TRANSACTION anywhere in the SQL proper, and every statement that
 * BEGINS with `END` or `ABORT` (their synonyms, in any spelling — `END WORK
 * AND NO CHAIN`, `ABORT TRANSACTION AND CHAIN`; no other top-level statement
 * starts with either word, and `CASE … END` never starts one). Comments,
 * string literals, quoted identifiers and dollar-quoted bodies (function and
 * `DO` bodies, whose `BEGIN … END` is PL/pgSQL, not a transaction) are
 * skipped; an identifier is read whole, `$` included, so `a$$tag$` is one
 * identifier and opens no quote (DECISIONS 64).
 *
 * The parser is the first line. The second is at run time: `applyStep` reads
 * `txid_current()` before and after the step's bytes and refuses to log a step
 * whose transaction changed underneath it.
 *
 * Conservative by design: `BEGIN ATOMIC` or `ON COMMIT DROP` outside a dollar
 * quote is flagged too. A false refusal costs a rewrite; a missed `COMMIT`
 * costs a half-applied step logged as whole.
 */
export function findTransactionControl(sql: string): TransactionControl[] {
  const code = blankNonCode(sql);
  const hits: TransactionControl[] = [];
  const lineAt = (offset: number) => code.slice(0, offset).split('\n').length;

  for (const match of code.matchAll(
    /\b(begin|commit|rollback|start\s+transaction|prepare\s+transaction)\b/gi,
  )) {
    hits.push({
      line: lineAt(match.index ?? 0),
      statement: match[0].replace(/\s+/g, ' ').toUpperCase(),
    });
  }
  let offset = 0;
  for (const statement of code.split(';')) {
    const leading = /^\s*/.exec(statement)?.[0].length ?? 0;
    const words = statement.trim().split(/\s+/);
    const first = (words[0] ?? '').toLowerCase();
    if (first === 'end' || first === 'abort') {
      hits.push({ line: lineAt(offset + leading), statement: words.join(' ').toUpperCase() });
    }
    offset += statement.length + 1;
  }
  return hits.sort((a, b) => a.line - b.line);
}

const IDENTIFIER_START = /[A-Za-z_\u0080-\uffff]/;
const IDENTIFIER = /^[A-Za-z_\u0080-\uffff][A-Za-z0-9_$\u0080-\uffff]*/;

/**
 * `sql` with every comment, string literal, quoted identifier and dollar-quoted
 * body replaced by spaces (newlines kept, so offsets and line numbers hold).
 */
function blankNonCode(sql: string): string {
  const out = sql.split('');
  const blank = (from: number, to: number) => {
    for (let i = from; i < to; i += 1) if (out[i] !== '\n') out[i] = ' ';
  };
  let i = 0;
  let lastWord = '';
  let lastWordEnd = -1;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === '-' && next === '-') {
      // Postgres ends a `--` comment at CR as well as LF (scan.l: [^\n\r]).
      const end = /[\r\n]/.exec(sql.slice(i));
      const stop = end === null ? sql.length : i + end.index;
      blank(i, stop);
      i = stop;
    } else if (ch === '/' && next === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < sql.length && depth > 0) {
        if (sql[j] === '/' && sql[j + 1] === '*') {
          depth += 1;
          j += 2;
        } else if (sql[j] === '*' && sql[j + 1] === '/') {
          depth -= 1;
          j += 2;
        } else {
          j += 1;
        }
      }
      blank(i, j);
      i = j;
    } else if (ch === "'") {
      // E'…' strings take backslash escapes; every string takes '' as a quote.
      // An escape string is the token `e`/`E` ALONE right before the quote:
      // `x$e'…'` and `née'…'` are identifiers followed by standard strings.
      const escapes = lastWordEnd === i && (lastWord === 'e' || lastWord === 'E');
      let j = i + 1;
      while (j < sql.length) {
        if (escapes && sql[j] === '\\') {
          j += 2;
        } else if (sql[j] === "'" && sql[j + 1] === "'") {
          j += 2;
        } else if (sql[j] === "'") {
          j += 1;
          break;
        } else {
          j += 1;
        }
      }
      blank(i, j);
      i = j;
    } else if (ch === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === '"' && sql[j + 1] === '"') j += 2;
        else if (sql[j] === '"') {
          j += 1;
          break;
        } else j += 1;
      }
      blank(i, j);
      i = j;
    } else if (IDENTIFIER_START.test(ch ?? '')) {
      // An identifier or keyword, read whole: a `$` inside one is part of it.
      // (`E'…'` is decided above from the token this records.)
      const word = IDENTIFIER.exec(sql.slice(i))?.[0] ?? (ch as string);
      i += word.length;
      lastWord = word;
      lastWordEnd = i;
    } else if (ch === '$') {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tag === null) {
        i += 1; // `$1` — a parameter, not a quote
        continue;
      }
      const close = sql.indexOf(tag[0], i + tag[0].length);
      const stop = close === -1 ? sql.length : close + tag[0].length;
      blank(i, stop);
      i = stop;
    } else {
      i += 1;
    }
  }
  return out.join('');
}

// ── The target: one parse, one check, one client ────────────────────────────

/**
 * The database a `--url` names, parsed ONCE with `pg-connection-string` (the
 * parser `pg` itself uses), and the Supabase project it belongs to. The
 * project check and the client are both built from these fields, so the
 * runner connects to exactly what it checked (DECISIONS 64; adversary M2: a
 * query parameter like `?host=` or `?ssl=0` overrides the URL's own host, user
 * and TLS inside `pg`).
 */
export interface Target {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  /** `db.<ref>.supabase.co`, or user `postgres.<ref>` on a `*.pooler.supabase.com`
   *  host (`staff:provision`'s rule, design §2.1); `local` for localhost. */
  project: string;
}

/** Supavisor's transaction-mode port (DECISIONS 70). */
const TRANSACTION_POOLER_PORT = 6543;

const LOCALHOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function resolveTarget(databaseUrl: string): Parsed<Target> | Refusal {
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
    return { ok: false, reason: '--url must be a postgres:// or postgresql:// URL' };
  }
  // The runner needs no parameter, and every one of them can override what is
  // checked below — so none is accepted (a literal ? or # in a password is
  // percent-encoded in a well-formed URL).
  if (/[?#]/.test(databaseUrl)) {
    return {
      ok: false,
      reason:
        '--url carries a query or fragment; the runner accepts none (pass host, user and database in the URL itself)',
    };
  }
  let parsed: ReturnType<typeof parseConnectionString>;
  try {
    parsed = parseConnectionString(databaseUrl);
  } catch {
    return { ok: false, reason: '--url is not a URL the Postgres driver can read' };
  }
  const host = (parsed.host ?? '').toLowerCase();
  const user = parsed.user ?? '';
  const database = parsed.database ?? '';
  const port =
    parsed.port === undefined || parsed.port === null || parsed.port === ''
      ? 5432
      : Number(parsed.port);
  if (host === '' || user === '' || database === '' || !Number.isInteger(port)) {
    return { ok: false, reason: '--url must name a host, a user and a database' };
  }
  const project = projectOf(host, user);
  if (project === null) {
    return {
      ok: false,
      reason:
        'cannot tell which project the --url points at (expected db.<ref>.supabase.co, ' +
        "postgres.<ref>@…pooler.supabase.com, or localhost for project 'local')",
    };
  }
  if (port === TRANSACTION_POOLER_PORT) {
    // Through Supabase's transaction pooler, statements outside one
    // transaction may each land on a different server: a no-transaction step
    // would lose its session's app.actor (STAFF-74) and leave it set on a
    // pooled backend (DECISIONS 70).
    const direct = project === 'local' ? 'localhost:5432' : `db.${project}.supabase.co:5432`;
    return {
      ok: false,
      reason:
        `port ${TRANSACTION_POOLER_PORT} is Supabase's transaction pooler, which the runner never uses — ` +
        `connect directly: postgres://postgres:<password>@${direct}/postgres (DECISIONS 70)`,
    };
  }
  return { ok: true, host, port, user, password: parsed.password ?? '', database, project };
}

function projectOf(host: string, user: string): string | null {
  if (LOCALHOSTS.has(host)) return 'local';
  const direct = /^db\.([a-z0-9]+)\.supabase\.co$/.exec(host);
  if (direct?.[1] !== undefined) return direct[1];
  if (host.endsWith('.pooler.supabase.com')) {
    const pooler = /^postgres\.([a-z0-9]+)$/.exec(user);
    if (pooler?.[1] !== undefined) return pooler[1];
  }
  return null;
}

/** The project a `DATABASE_URL` points at, or `null` (see `resolveTarget`). */
export function projectRefOf(databaseUrl: string): string | null {
  const target = resolveTarget(databaseUrl);
  return target.ok ? target.project : null;
}

/** Refuse unless `--project` names the project the URL points at. */
export function checkProject(
  databaseUrl: string,
  project: string,
): Parsed<{ target: Target }> | Refusal {
  const target = resolveTarget(databaseUrl);
  if (!target.ok) return target;
  if (target.project !== project) {
    return {
      ok: false,
      reason: `--project is '${project}' but the --url points at project '${target.project}'. Nothing was run.`,
    };
  }
  return { ok: true, target };
}

/**
 * The `pg` client config for a checked target: the parsed fields and nothing
 * else — no `connectionString`, whose parameters `pg` would re-read — with
 * `ssl` set LAST. A local target has no TLS; any other is verified TLS against
 * `ca`, which it must have.
 */
export function clientConfig(target: Target, ca: string | undefined): pg.ClientConfig {
  const fields = {
    host: target.host,
    port: target.port,
    user: target.user,
    password: target.password,
    database: target.database,
  };
  if (target.project === 'local') return { ...fields, ssl: false };
  if (ca === undefined || ca.length === 0) {
    throw new Error(`a CA is required to connect to project '${target.project}' (verified TLS)`);
  }
  return { ...fields, ssl: { ca, rejectUnauthorized: true } };
}

// ── Applying a step ──────────────────────────────────────────────────────────

export interface ApplyOptions {
  /** Who ran it — `migrations_applied.applied_by`. */
  appliedBy: string;
  /** Clears one Redis key pattern; required for an `invalidate-class-catalog` step. */
  invalidateCache?: (pattern: string) => Promise<void>;
}

export type ApplyResult =
  | { ok: true; stepId: string; sha256: string; cacheCleared: boolean }
  | {
      ok: false;
      reason: string;
      /** True when the step committed and only the post-commit cache clear failed. */
      committed: boolean;
    };

/**
 * Apply one parsed step on `client`, a connection the caller owns and keeps
 * for the whole call (the actor and the transaction live on it).
 */
export async function applyStep(
  client: pg.ClientBase,
  step: StepFile,
  options: ApplyOptions,
): Promise<ApplyResult> {
  const actor = `system:migrate-${step.stepId}`;
  const clearsCache = step.directives.has('invalidate-class-catalog');
  if (clearsCache && options.invalidateCache === undefined) {
    return {
      ok: false,
      committed: false,
      reason: `${step.fileName} declares invalidate-class-catalog but no Redis was given to clear (--redis-url). Nothing was run.`,
    };
  }

  // Two reads, not one: a statement naming migrations_applied fails to parse
  // when the table is absent, whatever a CASE around it would have chosen.
  const present =
    (
      await client.query<{ present: boolean }>(
        "SELECT to_regclass('public.migrations_applied') IS NOT NULL AS present",
      )
    ).rows[0]?.present === true;
  if (present) {
    const logged = await client.query('SELECT 1 FROM migrations_applied WHERE step_id = $1', [
      step.stepId,
    ]);
    if (logged.rows.length > 0) {
      return {
        ok: false,
        committed: false,
        reason: `${step.stepId} is already applied (migrations_applied).`,
      };
    }
  }

  const logRow = [step.stepId, options.appliedBy, step.sha256];
  const insertLog =
    'INSERT INTO migrations_applied (step_id, applied_by, sql_sha256) VALUES ($1, $2, $3)';

  if (step.directives.has('no-transaction')) {
    // Bare: nothing to roll back to, so the log must already exist to receive
    // the row — the one step that creates it (M1.00) is transactional.
    if (!present) {
      return {
        ok: false,
        committed: false,
        reason: 'migrations_applied does not exist: apply M1.00 before a no-transaction step.',
      };
    }
    try {
      await client.query("SELECT set_config('app.actor', $1, false)", [actor]);
      await client.query(step.sql);
    } catch (err) {
      return {
        ok: false,
        committed: false,
        reason: `${step.stepId} (no-transaction) failed and was NOT rolled back by the runner — inspect the database before retrying: ${messageOf(err)}`,
      };
    } finally {
      await client.query("SELECT set_config('app.actor', '', false)").catch(() => undefined);
    }
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.actor', $1, true)", [actor]);
      await client.query(insertLog, logRow);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      return {
        ok: false,
        committed: true,
        reason: `${step.stepId} ran but its log row did not land — insert it by hand: ${messageOf(err)}`,
      };
    }
  } else {
    // When the log table is absent, the step must create it: if it does not,
    // the closing INSERT fails and the whole step rolls back with it.
    let before: string | undefined;
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.actor', $1, true)", [actor]);
      before = await currentTxid(client);
      await client.query(step.sql);
      // The step must still be inside the transaction the runner opened. A
      // commit or rollback the parser missed (DECISIONS 64) shows up as a new
      // txid here. Whatever ran after it ran OUTSIDE the runner's transaction —
      // in Postgres's implicit one, which committed unless it failed — so it
      // may have landed whatever the runner does now.
      if ((await currentTxid(client)) !== before) {
        await client.query('ROLLBACK').catch(() => undefined);
        const head = await txidStatus(client, before);
        return {
          ok: false,
          committed: true,
          reason:
            `${step.stepId} ended the runner's transaction part-way (a COMMIT or ROLLBACK inside ` +
            `the step). NOT logged. The part before that point ${describeHead(head)}; the part ` +
            "after it ran outside the runner's transaction and may have committed. Inspect the " +
            'database before anything else.',
        };
      }
      await client.query(insertLog, logRow);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      // Ask Postgres what became of the runner's transaction instead of
      // assuming: a hidden COMMIT followed by a failing statement leaves the
      // head committed even though the step "failed" (DECISIONS 71).
      const head = before === undefined ? 'aborted' : await txidStatus(client, before);
      if (head === 'unknown') {
        return {
          ok: false,
          committed: true,
          reason:
            `${step.stepId} FAILED and the runner could not learn whether its transaction (txid ` +
            `${before}) committed. NOT logged. Inspect the database before anything else: ${messageOf(err)}`,
        };
      }
      if (head === 'committed') {
        return {
          ok: false,
          committed: true,
          reason:
            `${step.stepId} FAILED after committing part of itself: its transaction (txid ${before}) ` +
            'committed before the failure, so the statements up to a COMMIT inside the step are ' +
            `applied. NOT logged. Inspect the database before anything else: ${messageOf(err)}`,
        };
      }
      return {
        ok: false,
        committed: false,
        reason: `${step.stepId} failed and was rolled back (txid ${before ?? 'never assigned'}: ${head}); nothing was applied or logged: ${messageOf(err)}`,
      };
    }
  }

  if (clearsCache && options.invalidateCache !== undefined) {
    try {
      await options.invalidateCache(CLASS_CATALOG_CACHE_PATTERN);
    } catch (err) {
      return {
        ok: false,
        committed: true,
        reason:
          `${step.stepId} COMMITTED and is logged, but clearing '${CLASS_CATALOG_CACHE_PATTERN}' failed — ` +
          `the class catalog may serve the old price until it is cleared by hand: ${messageOf(err)}`,
      };
    }
  }
  return { ok: true, stepId: step.stepId, sha256: step.sha256, cacheCleared: clearsCache };
}

type TxidStatus = 'committed' | 'aborted' | 'in progress' | 'unknown';

/** What Postgres says became of a transaction (`txid_status`, Postgres 10+). */
async function txidStatus(client: pg.ClientBase, txid: string): Promise<TxidStatus> {
  try {
    const result = await client.query<{ status: string | null }>(
      'SELECT txid_status($1::bigint) AS status',
      [txid],
    );
    const status = result.rows[0]?.status;
    return status === 'committed' || status === 'aborted' || status === 'in progress'
      ? status
      : 'unknown';
  } catch {
    return 'unknown';
  }
}

function describeHead(status: TxidStatus): string {
  switch (status) {
    case 'committed':
      return 'COMMITTED';
    case 'aborted':
      return 'was rolled back';
    case 'in progress':
      return 'is still in progress';
    case 'unknown':
      return 'is in an unknown state (Postgres could not say)';
  }
}

async function currentTxid(client: pg.ClientBase): Promise<string> {
  const result = await client.query<{ txid: string }>('SELECT txid_current()::text AS txid');
  return result.rows[0]?.txid ?? '';
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
