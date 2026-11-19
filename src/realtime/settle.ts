/**
 * Settling un-awaited work (brief LR5; design A2 FH1).
 *
 * `observability.ts` installs `uncaughtException` and `unhandledRejection` handlers that both end
 * in `process.exit(1)`. So one rejected promise nobody awaits — a DB blip in a push claim, a
 * failed publish — would drop every socket and every in-flight request, money routes included.
 * Everything this unit starts and does not await goes through one of the two functions here:
 *
 *   · `fireAndForget(thunk, ctx)`: run it, never wait for it.
 *   · `trackInFlight(thunk, ctx)`: the same, and shutdown waits for it (`drainInFlight`), so a
 *     deploy does not cut off a push it could still send (LR9).
 *
 * Both take a THUNK, not a promise, so a synchronous throw inside it is caught as well as a
 * rejection; no call site wraps its own. A failure is one warn line (below the pager's level-50
 * tap), never more. The in-flight set holds the CAUGHT promise, never the raw one: tracking the
 * raw promise and cleaning up with `.finally` leaks one rejection (the Opus seat's probe
 * `p4_finally.mjs`).
 */

/** The one logger method these need: pino's `warn(obj, msg)`. */
export interface WarnLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

/** What a failure is logged as: a constant sentence (`what`) and ids, never message text. */
export interface SettleContext {
  log: WarnLogger;
  what: string;
  fields?: Readonly<Record<string, string | number | boolean | null>>;
}

function start(thunk: () => unknown): Promise<unknown> {
  try {
    return Promise.resolve(thunk());
  } catch (err) {
    return Promise.reject(err);
  }
}

function warnOnce(ctx: SettleContext, err: unknown): void {
  try {
    ctx.log.warn({ ...ctx.fields, err }, `${ctx.what} failed (not retried)`);
  } catch {
    // A logger that throws must not turn a handled failure into an unhandled one.
  }
}

/** The caught form: resolves when the thunk settles, whatever it did, and never rejects. */
function caught(thunk: () => unknown, ctx: SettleContext): Promise<void> {
  return start(thunk).then(
    () => undefined,
    (err: unknown) => {
      warnOnce(ctx, err);
    },
  );
}

/** Run `thunk` without waiting for it. Neither a throw nor a rejection can escape. */
export function fireAndForget(thunk: () => unknown, ctx: SettleContext): void {
  void caught(thunk, ctx);
}

const inFlight = new Set<Promise<void>>();

/**
 * Run `thunk` without waiting for it, and keep it in the in-flight set until it settles, so
 * shutdown can wait for it (`drainInFlight`). Returns the caught promise (it never rejects).
 * Pass 2's direct push (`src/lib/messageNotice.ts`) is the first caller.
 */
export function trackInFlight(thunk: () => unknown, ctx: SettleContext): Promise<void> {
  const settled = caught(thunk, ctx);
  inFlight.add(settled);
  // `settled` never rejects, so this chain cannot leak a rejection either.
  void settled.then(() => {
    inFlight.delete(settled);
  });
  return settled;
}

/** How many tracked thunks have not settled yet. */
export function inFlightCount(): number {
  return inFlight.size;
}

/**
 * Wait until nothing tracked is in flight, including thunks tracked while this waits (a reply
 * that commits during `app.close()` and starts its push). Never rejects. It has no bound of its
 * own: shutdown bounds the whole sequence (`src/realtime/shutdown.ts`), and each push is bounded
 * by its own 10 s abort.
 */
export async function drainInFlight(): Promise<void> {
  while (inFlight.size > 0) {
    await Promise.allSettled([...inFlight]);
  }
}
