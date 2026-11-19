/**
 * The API's SIGTERM sequence (9.2.0; brief LR9; design A2 FM2, the Opus seat's M3), apart from
 * `index.ts` so a test can run the exact sequence the process runs.
 *
 *   1. `app.close()` starts at once. Its `preClose` (`src/realtime/server.ts`) stops upgrades,
 *      sends 1012 to every socket and `terminate()`s any still open after 1 s: Fastify 5.8.5's
 *      `app.close()` otherwise waits on a phone that never answers the close (probe
 *      `p2_close.out`).
 *   2. **Concurrently**, the in-flight set (`settle.ts`: the direct pushes) is drained with
 *      `Promise.allSettled`, so a rejecting `app.close()` never skips it and a slow one never
 *      delays it.
 *   3. When both have settled, the set is drained once more: a request `app.close()` waited for
 *      can commit and start its push after the first pass found the set empty.
 *   4. `closeDb` only after that.
 *   The whole sequence is bounded at 12 s, under Railway's 15 s drain (`railway.json`
 *   `deploy.drainingSeconds`). A tracked send never rejects (it is the caught promise), so it
 *   never reaches the error path; only a failing `app.close()` or `closeDb` is an error (exit 1).
 */

export const SHUTDOWN_BOUND_MS = 12_000;

export interface ShutdownLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface ShutdownDeps {
  closeApp(): Promise<unknown>;
  drain(): Promise<unknown>;
  closeDb(): Promise<unknown>;
  closeRedis(): unknown;
  log: ShutdownLogger;
  boundMs?: number;
}

function start(fn: () => unknown): Promise<unknown> {
  try {
    return Promise.resolve(fn());
  } catch (err) {
    return Promise.reject(err);
  }
}

/** Run the sequence; resolves to the exit code (0, or 1 when a close failed). Never rejects. */
export async function runShutdown(deps: ShutdownDeps): Promise<number> {
  const bound = deps.boundMs ?? SHUTDOWN_BOUND_MS;
  const startedAt = Date.now();
  let exitCode = 0;
  let boundTimer: NodeJS.Timeout | undefined;
  const timeLeft = (): Promise<'bound'> =>
    new Promise((resolve) => {
      boundTimer = setTimeout(
        () => resolve('bound'),
        Math.max(0, bound - (Date.now() - startedAt)),
      );
    });

  const both = Promise.allSettled([start(deps.drain), start(deps.closeApp)]);
  const first = await Promise.race([both, timeLeft()]);
  clearTimeout(boundTimer);
  if (first === 'bound') {
    deps.log.warn(
      { bound_ms: bound },
      'shutdown bound reached before the app closed and the in-flight sends settled; closing the pool anyway',
    );
  } else {
    const closed = first[1];
    if (closed.status === 'rejected') {
      exitCode = 1;
      deps.log.error({ err: closed.reason }, 'error during shutdown');
    }
    // A request `app.close()` waited for may have committed and started its push after the
    // drain above found the set empty: drain once more, inside the bound, before the pool closes.
    const late = await Promise.race([
      start(deps.drain).then(
        () => 'drained' as const,
        () => 'drained' as const,
      ),
      timeLeft(),
    ]);
    clearTimeout(boundTimer);
    if (late === 'bound') {
      deps.log.warn(
        { bound_ms: bound },
        'shutdown bound reached before the in-flight sends settled; closing the pool anyway',
      );
    }
  }

  const db = start(deps.closeDb).then(
    () => 'closed' as const,
    (err: unknown) => {
      exitCode = 1;
      deps.log.error({ err }, 'error during shutdown');
      return 'failed' as const;
    },
  );
  const dbOutcome = await Promise.race([db, timeLeft()]);
  clearTimeout(boundTimer);
  if (dbOutcome === 'bound') {
    deps.log.warn({ bound_ms: bound }, 'shutdown bound reached while closing the pool');
  }

  try {
    await Promise.race([start(deps.closeRedis), timeLeft()]);
  } catch {
    // Redis is going away with the process either way.
  }
  clearTimeout(boundTimer);
  return exitCode;
}
