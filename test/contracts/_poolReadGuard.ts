import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PoolClient } from 'pg';
import { pool } from '../../src/db/pool.js';

/**
 * **No transaction body reads on the pool** — a test-only guard (O-POOLFIX fix 2; r2 Fable M1 = Opus L3, both seats'
 * instrument kept as a test).
 *
 * A transaction body that reads on the pool-bound `db` instead of its `tx` needs a second slot while its own is held;
 * ten of them at once deadlocked the pool (executed: twelve parallel `DELETE /events/:id/rsvp`). `tx.ts` now keeps one
 * slot that no transaction may take, so such a read can no longer deadlock, but it still reads outside its
 * transaction's snapshot and locks and still costs a second connection. Every contract test file that calls
 * `registerFixtureHooks()` installs this guard, so a test that drives a route whose transaction reads on the pool
 * FAILS, naming the statement and the route that opened the transaction: the next such read is caught when it is
 * written, not when it wedges production.
 *
 * How it decides, by execution rather than by search:
 *   - It wraps the pool's `connect`. A promise-form checkout made by `src/db/tx.ts` is a transaction: the guard reads
 *     the synchronous stack of that checkout (it starts in the transaction's first tick, before any await, whenever a
 *     transaction slot is free) to find who OPENED it — the first frame outside `node_modules`, `src/db/tx.ts`,
 *     `src/db/mutation.ts` and this file — and marks the transaction's async context with that opener until its
 *     client is released.
 *   - A pool checkout (a `pool.query`, or another `pool.connect`) made while the current async context is inside a
 *     transaction that `src/` opened, or whose opener the stack cannot show (a transaction that had to wait for a
 *     slot starts its checkout after an await, so its stack is cut: such a transaction is held to the src rule), is
 *     a violation. A transaction a TEST opened is exempt: tests hold their own transactions to stage races and
 *     locks, and a route they drive from inside one runs in that context.
 *   - `afterEach` fails the test that recorded one, and `after` fails the file for one recorded in a hook.
 *
 * What it cannot see: a route no test drives, and a test file that does not call `registerFixtureHooks()`.
 */

type Opener = 'src' | 'test' | 'unknown';

interface Held {
  opener: Opener;
  /** The opener's frames, for the failure message. */
  openedAt: string;
  holding: boolean;
}

export interface PoolReadViolation {
  /** `pool.query` (a read or write on the pool) or `pool.connect` (a checkout, e.g. a transaction inside a transaction). */
  kind: 'pool.query' | 'pool.connect';
  sql: string | null;
  opener: Opener;
  openedAt: string;
  at: string;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC_DIR = path.join(REPO_ROOT, 'src') + path.sep;
const TEST_DIR = path.join(REPO_ROOT, 'test') + path.sep;
const THIS_FILE = fileURLToPath(import.meta.url);
/** The transaction wrappers themselves: never the opener. */
const WRAPPERS = new Set([
  path.join(REPO_ROOT, 'src', 'db', 'tx.ts'),
  path.join(REPO_ROOT, 'src', 'db', 'mutation.ts'),
]);
const TX_MODULE = path.join(REPO_ROOT, 'src', 'db', 'tx.ts');

const held = new AsyncLocalStorage<Held>();
const violations: PoolReadViolation[] = [];
const seen = { srcTransactions: 0, testTransactions: 0, unknownTransactions: 0 };
let paused = 0;
let installed = false;
/** The statement a `pool.query` is about to check a client out for (pg-pool calls `connect(cb)` synchronously). */
let pendingSql: string | null = null;

/**
 * Pool reads that are known and named, allowed until they move onto their `tx`. Each entry is a statement's start as
 * drizzle renders it. Empty means every pool read inside a src transaction fails the test.
 *
 * Empty since fix 2's second commit, which moved four of the five reads the round-2 seats found (events, staff names,
 * class prereqs, profile-image media) onto their transaction's `tx`; the fifth (message attachments, the staff reply's
 * wire) left the transaction when 9.2.0 built that wire after commit. Add an entry only with a named reason and a
 * ruling: a read here is a second connection per transaction and reads outside its snapshot.
 */
const KNOWN_POOL_READS_IN_TRANSACTIONS: ReadonlyArray<{ sql: RegExp; where: string }> = [];

interface Frame {
  fn: string;
  file: string | null;
  line: string;
}

function framesOf(stack: string): Frame[] {
  const out: Frame[] = [];
  for (const raw of stack.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('at ')) continue;
    const body = line.slice(3).replace(/^async /, '');
    const paren = /^(.*?) \((.*)\)$/.exec(body);
    const fn = paren ? paren[1]! : '<anonymous>';
    let loc = paren ? paren[2]! : body;
    if (loc.startsWith('file://'))
      loc = fileURLToPath(loc.replace(/:\d+:\d+$/, '')) + (/:\d+:\d+$/.exec(loc)?.[0] ?? '');
    const at = /^(.*?):(\d+):\d+$/.exec(loc);
    out.push({ fn, file: at?.[1] ?? null, line: at?.[2] ?? '' });
  }
  return out;
}

function isOwnOrLibrary(file: string | null): boolean {
  return (
    file === null ||
    file === THIS_FILE ||
    file.startsWith('node:') ||
    file.includes(`${path.sep}node_modules${path.sep}`)
  );
}

/** Who opened the transaction whose checkout this stack is: the first frame past the wrappers. */
export function openerOf(stack: string): Opener {
  for (const frame of framesOf(stack)) {
    if (isOwnOrLibrary(frame.file) || WRAPPERS.has(frame.file as string)) continue;
    const file = frame.file as string;
    if (file.startsWith(SRC_DIR)) return 'src';
    if (file.startsWith(TEST_DIR)) return 'test';
    return 'unknown';
  }
  return 'unknown';
}

/** True when the stack's first frame past the pool and this file is `src/db/tx.ts`: a transaction's checkout. */
function checkedOutByTxModule(stack: string): boolean {
  const first = framesOf(stack).find((f) => !isOwnOrLibrary(f.file));
  return first?.file === TX_MODULE;
}

function shortStack(stack: string): string {
  return framesOf(stack)
    .filter((f) => f.file !== null && !isOwnOrLibrary(f.file))
    .slice(0, 6)
    .map((f) => `${f.fn} (${path.relative(REPO_ROOT, f.file as string)}:${f.line})`)
    .join(' < ');
}

function record(kind: PoolReadViolation['kind'], sql: string | null, h: Held, stack: string): void {
  if (sql !== null && KNOWN_POOL_READS_IN_TRANSACTIONS.some((k) => k.sql.test(sql))) return;
  violations.push({ kind, sql, opener: h.opener, openedAt: h.openedAt, at: shortStack(stack) });
}

function insideSrcTransaction(): Held | undefined {
  if (paused > 0) return undefined;
  const h = held.getStore();
  return h !== undefined && h.holding && h.opener !== 'test' ? h : undefined;
}

type ConnectCallback = (
  err: Error | undefined,
  client: PoolClient | undefined,
  done: (release?: unknown) => void,
) => void;

/** Idempotent. Wraps the shared pool's `connect` and `query` for this test process. */
export function installPoolReadGuard(): void {
  if (installed) return;
  installed = true;
  const target = pool as unknown as {
    connect: (cb?: ConnectCallback) => Promise<PoolClient> | void;
    query: (...args: unknown[]) => unknown;
  };
  const connect = target.connect.bind(pool);
  const query = target.query.bind(pool);

  target.query = function guardedQuery(...args: unknown[]): unknown {
    const text = args[0];
    pendingSql = String(
      typeof text === 'string' ? text : ((text as { text?: unknown } | null)?.text ?? ''),
    )
      .replace(/\s+/g, ' ')
      .slice(0, 160);
    try {
      return query(...args);
    } finally {
      pendingSql = null;
    }
  };

  target.connect = function guardedConnect(cb?: ConnectCallback): Promise<PoolClient> | void {
    const outer = insideSrcTransaction();
    if (typeof cb === 'function') {
      if (outer !== undefined)
        record('pool.query', pendingSql, outer, new Error('pool read').stack ?? '');
      return connect(cb);
    }
    const stack = new Error('checkout').stack ?? '';
    if (outer !== undefined) record('pool.connect', null, outer, stack);
    if (!checkedOutByTxModule(stack)) return connect();
    const opener = openerOf(stack);
    if (opener === 'src') seen.srcTransactions += 1;
    else if (opener === 'test') seen.testTransactions += 1;
    else seen.unknownTransactions += 1;
    const mine: Held = { opener, openedAt: shortStack(stack), holding: false };
    // The checkout runs inside `tx.ts`'s async function, so the rest of that function — the body included — runs
    // in this context. Its caller's later continuation inherits it too; `holding` is false there once released.
    held.enterWith(mine);
    return (connect() as Promise<PoolClient>).then((client) => {
      mine.holding = true;
      const release = client.release;
      client.release = function guardedRelease(err?: Error | boolean) {
        mine.holding = false;
        client.release = release;
        return release.call(client, err);
      };
      return client;
    });
  };
}

/** Throws, naming every violation recorded since the last call, and clears them. */
export function assertNoPoolReadInTransaction(scope: string): void {
  if (violations.length === 0) return;
  const found = violations.splice(0, violations.length);
  const lines = found.map(
    (v, i) =>
      `  ${i + 1}. ${v.kind}${v.sql === null ? '' : ` "${v.sql}"`}\n` +
      `     inside a transaction opened (${v.opener}) at: ${v.openedAt || '(stack cut: it waited for a slot)'}\n` +
      `     read at: ${v.at || '(no app frame)'}`,
  );
  throw new Error(
    `${found.length} pool checkout(s) inside a transaction body (${scope}): pass the transaction's tx instead ` +
      `(O-POOLFIX fix 2; test/contracts/_poolReadGuard.ts)\n${lines.join('\n')}`,
  );
}

/** What the guard has classified so far in this process: proof it is live, not vacuous. */
export function poolReadGuardSeen(): {
  srcTransactions: number;
  testTransactions: number;
  unknownTransactions: number;
} {
  return { ...seen };
}

/**
 * Runs `fn` with the guard off. Only for a test that plants a pool read inside a transaction on purpose, to prove
 * the transaction-slot bound holds for a route no test drives.
 */
export async function withPoolReadGuardPaused<T>(fn: () => Promise<T>): Promise<T> {
  paused += 1;
  try {
    return await fn();
  } finally {
    paused -= 1;
  }
}
