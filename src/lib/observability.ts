import { randomUUID } from 'node:crypto';
import { env } from '../env.js';

/**
 * **The pager.** The single place this API knows how to tell a HUMAN that
 * something went wrong — Day-20.
 *
 * Why it exists: on 2026-08-24 the money alarms were proven to print
 * (`test/contracts/workers-tick-alarms.test.ts`) and to reach nobody. A
 * SURPLUS REFUND returned 12000c to an owner and the only artifact was a line
 * in a log stream no one watches. F′ Option 1 (`designs/money-residue.md`)
 * says the alarm IS the remedy — "record, and a person is told" — which is
 * only true if a person is actually told.
 *
 * Two rules this module never breaks:
 *
 *   1. **Observability never takes down the observed system.** Every entry
 *      point here is fire-and-forget and swallows its own failures onto
 *      stderr. A Sentry outage cannot slow a request, fail a tick, or break
 *      logging. {@link captureAlarm} does not throw. Ever.
 *   2. **The log is the record; Sentry is the pager.** Nothing here replaces
 *      a pino line. The tap in {@link alarmForwardingHooks} runs BESIDE
 *      `method.apply` — never instead of it — so the round-6 compile-guarded
 *      alarm channel (the REQUIRED `log` field on `WorkersTickOpts.runTick`,
 *      `routes/workersTick.ts`) is untouched and every alarm still lands in
 *      Railway's log exactly as it did before.
 *
 * **Seam shape — a lazily initialised module singleton, nearer `redis.ts` than
 * `expoPush.ts`** (corrected by D20-A3 §A3.4.5; the first version of this
 * paragraph claimed the `expoPush.ts` / `r2.ts` shape and was half-true).
 * Those modules export `interface + defaultXClient` and inject **per call
 * site**: no init step, no mutable module state. This one is a mutable `let`
 * plus an imperative {@link initObservability} — a genuinely different shape,
 * and one whose own failure mode (init never called ⇒ silent no-op) is what
 * §A3.2 caught. Why it is still the right shape here: alarms are raised from
 * FOUR layers — routes, workers, the `mutation.ts` seam, and process crash
 * handlers — and threading a transport through all four would mean editing
 * every one of them, including the money workers that closed CLEAN. What
 * carries over from the locked pattern is the part that matters for
 * substitution: `AlarmTransport` is an interface, the default impl is one
 * function, and tests inject a stub.
 *
 * The omission-is-a-no-op hazard that shape creates is closed, not tolerated:
 * {@link isPagerInstalled} lets `buildApp()` REFUSE to build a production app
 * with no pager, `GET /health/watchdog` reports the same fact to an external
 * monitor, and a subprocess test boots the real entrypoint against a local
 * ingest listener and asserts an envelope arrives.
 *
 * The default impl is a hand-rolled Sentry envelope POST rather than
 * `@sentry/node` on purpose — the SDK v8+ auto-instruments HTTP via
 * OpenTelemetry, i.e. monkey-patches every request path of a system whose
 * money paths just closed CLEAN, and "the SDK doesn't interfere" is not
 * something our gate can prove. Swapping in the SDK later is replacing the
 * default transport in this one file; no caller changes.
 */

/** One page-worthy event. The alarm sentence, plus whatever names the money. */
export interface AlarmEvent {
  /** The alarm sentence, verbatim — the same text the log line carries. */
  message: string;
  level: 'error' | 'fatal';
  /** Where it came from: `'pino'` | `'withMutation'` | `'process'` | `'boot-smoke'`. */
  logger: string;
  /** The pino merge object / call-site context. Ids, amounts, the error. */
  extra?: Record<string, unknown>;
}

/**
 * The one outbound surface. `send` MAY reject — {@link captureAlarm} is the
 * only caller and it absorbs the rejection onto stderr.
 */
export interface AlarmTransport {
  send(event: AlarmEvent): Promise<void>;
}

/**
 * The pino `hooks` object {@link alarmForwardingHooks} hands to Fastify.
 *
 * Typed structurally rather than imported from `pino`: pino is a transitive
 * dependency (via Fastify), and this repo does not import phantom deps. The
 * shape is pinned against the INSTALLED runtime (pino 10.3.1), where
 * `logMethod(args, method, level)` receives the numeric level and is inherited
 * by child loggers — `request.log` is a child, which is why every worker alarm
 * riding the request logger forwards without touching a single worker file.
 */
export interface AlarmForwardingHooks {
  logMethod(
    this: unknown,
    args: [unknown, ...unknown[]],
    method: (...args: never[]) => void,
    level: number,
  ): void;
}

/** pino numeric levels. 50 = error, 60 = fatal; anything ≥ 50 pages. */
const PINO_ERROR_LEVEL = 50;
const PINO_FATAL_LEVEL = 60;

/** Abort a single envelope POST after this long. Sentry down ≠ we are down. */
const SEND_TIMEOUT_MS = 5_000;

/** Default drain window in {@link flushObservability} (shutdown). */
const DEFAULT_FLUSH_TIMEOUT_MS = 2_000;

/**
 * The crash path's own, much shorter drain (D20-A3 §L4). A process with an
 * uncaught exception keeps SERVING for however long we defer its exit — Node's
 * default is immediate — so the window between "we know this process is broken"
 * and "it stops answering requests" is a liability, not a feature. 500 ms is
 * enough for one already-open POST to a reachable ingest host and short enough
 * that nothing meaningful is served from a corrupt process.
 */
const CRASH_FLUSH_TIMEOUT_MS = 500;

// ---- suppression is DE-DUPLICATION ONLY (D20-A4 §A4.1) ----------------------
//
// **The invariant, and it has to fit in one sentence — that is the test of
// whether it is right: the pager never withholds an event unless it has
// already sent an identical one recently.** No scarcity gate may starve a
// first-ever alarm.
//
// Two earlier rulings put a scarcity gate here instead — D20-A2 §A2.1b (one
// global token bucket) and D20-A3 §A3.4.2 (per-`logger + message` buckets
// under a global ceiling) — and BOTH dropped money alarms, because both
// reasoned about which events could "afford" a budget. What the attack round
// executed at the sources, rather than taking on report:
//
//   · `captureReconciler.ts:649`'s LOST HOLD sentence is a CONSTANT. The
//     `chargeId`, `dogId`, `ownerId` and `amountCents` live in the merge
//     object at `:641-648`. So N distinct lost holds were ONE fingerprint
//     sharing one 5-token bucket: **12 distinct lost holds → 5 paged, 7
//     permanently unpaged** — permanently, because `:636-637` adds the charge
//     to `ALARMED_CHARGE_IDS` BEFORE the log call and regardless of delivery,
//     so there is never a second attempt.
//   · `duplicateRefundRetry.ts:583` templates counts INTO its sentence, so the
//     NOISY source minted a FRESH fingerprint every tick — the exact opposite
//     of the assumption the per-fingerprint scheme rested on. Two fresh
//     fingerprints per minutely tick permanently starve a ceiling that refills
//     1/minute, after which a first-ever LOST HOLD is dropped and so is the
//     `uncaughtException` page.
//
// So the mechanism is replaced, not tuned. What is left is de-duplication:
// hold back the fourth copy of something already sent three times in the last
// ten minutes, and nothing else. A first-ever event of any fingerprint always
// goes out.
//
// "Already sent" is read literally (D20-A5.3): the allowance is spent when the
// transport CONFIRMS a delivery, not when the event is admitted. Counting at
// admission meant three rejected sends burned the whole allowance and the
// fourth copy of an alarm that had never reached a human was withheld —
// suppression standing in for something that never happened.

/**
 * How many IDENTICAL events may page inside one {@link DEDUPE_WINDOW_MS}.
 * Three rather than one: a repeat that survives a redeploy or straddles two
 * windows is worth seeing, and the cost of two extra events is two events.
 */
export const IDENTICAL_ALLOWANCE = 3;

/** How long "recently" is. Ten minutes ≈ ten minutely ticks of one condition. */
export const DEDUPE_WINDOW_MS = 10 * 60_000;

/**
 * Keys excluded from the fingerprint because they change on every request and
 * would therefore make every event unique, defeating de-duplication entirely.
 * `reqId` is pino's per-request child binding (D20-A1 put it in `extra` so a
 * page can be correlated to its Railway line) — ambient context, never
 * identity. Everything else in `extra` IS identity and is compared as it came.
 */
const NON_IDENTIFYING_EXTRA_KEYS: ReadonlySet<string> = new Set(['reqId']);

/**
 * **The circuit breaker that replaced the budget.** Not a quota: it sits far
 * above any legitimate volume this system can produce, so tripping it means
 * something is badly wrong — which is itself the thing Allison needs to hear
 * about, so it emits one notice and becomes a `GET /health/watchdog` 503
 * condition rather than quietly rationing. A breaker trips loudly and is
 * noticed; a budget drains silently and drops a money alarm. That difference
 * is the whole of §A4.1.4.
 */
export const CATASTROPHIC_HOURLY_CEILING = 1000;

/** The breaker's window. Fixed, not sliding — one counter, one reset. */
const CATASTROPHIC_WINDOW_MS = 60 * 60_000;

/**
 * How many distinct fingerprints keep a de-duplication window. Alarm text can
 * embed ids (`log.error(err)` fingerprints on `err.message`), so an unbounded
 * map keyed by it is the unbounded-growth defect §A2.6 closed one field over.
 *
 * **Eviction can only ever cause MORE sending, never less** — which is what
 * keeps the bound from resurrecting the dropped-money-alarm defect (§A4.1's
 * explicit requirement). Evicting a fingerprint's window means its next event
 * is treated as first-ever and PAGES, and a new fingerprint is always
 * admitted, because eviction is total whenever the map is non-empty. There is
 * no state of this table that can withhold an alarm. The old scheme's
 * equivalent path did the opposite: `bucketFor` returned `null` when the map
 * was full, and the event fell through to a global bucket that could refuse it.
 *
 * The cost of that direction, named: a flood of genuinely-unique fingerprints
 * evicts continuously and de-duplicates nothing, so every event pages. That is
 * bounded by {@link CATASTROPHIC_HOURLY_CEILING} and by nothing else, which is
 * the correct place for it to be bounded — loudly, once, with a watchdog 503.
 */
const MAX_TRACKED_FINGERPRINTS = 256;

/**
 * Concurrent sends — a true bound on memory, not a budget on alarms. Executed
 * by the attack lane: 50,000 unsettled sends grew the heap by 21 MB with
 * nothing to stop it. Raised from 32 (§A4.1.5): with the scarcity gate gone
 * this can actually bind, and what it would bind on could be a money alarm. At
 * 256 concurrent unsettled envelope POSTs the system is in a state she must
 * hear about, so a drop here is counted and reported to the watchdog like any
 * other. `level: 'fatal'` passes it regardless — see {@link captureAlarm}.
 */
export const MAX_IN_FLIGHT = 256;

/**
 * The window `dropped_alarms_recent` counts over — what "sustained" means when
 * `GET /health/watchdog` decides whether drops are an incident (§A4.4.1). Also
 * the stderr rate limit: one line per window, never one per dropped event.
 */
export const DROP_WINDOW_MS = 60 * 60_000;

/** One fingerprint's de-duplication state for the window it is inside. */
interface DedupeWindow {
  startedMs: number;
  /**
   * Identical events **actually delivered** in this window (D20-A5.3, round 3's
   * finding E). Counted on the transport's success path, never on admission:
   * the invariant says the pager may withhold only what it *has already sent*,
   * and counting at admission let three REJECTED sends burn the whole allowance,
   * so the fourth copy of an alarm none of which ever reached a human was
   * withheld. Capped by {@link IDENTICAL_ALLOWANCE}.
   *
   * Named consequence, accepted: sends that have not settled yet have not
   * counted, so a burst of identical alarms inside one transport round trip is
   * admitted in full rather than de-duplicated. That is more sending, never
   * less, which is the direction §A4.1 chose on purpose — and it is bounded by
   * {@link MAX_IN_FLIGHT} and {@link CATASTROPHIC_HOURLY_CEILING}, both of which
   * count their drops and reach the watchdog. The alternative (count on
   * admission, refund on failure) keeps burst suppression but withholds a copy
   * during the window where nothing is known to have been delivered, which is
   * the literal invariant violation this fix exists to remove.
   */
  delivered: number;
  /** Identical events withheld in this window. Reported when the window rolls. */
  suppressed: number;
  /** The last thing withheld, so the notice can name what it hid. */
  sample: { logger: string; message: string } | null;
}

/**
 * The active pager. `null` means NO PAGER CONFIGURED — dev, test, and any
 * environment with `SENTRY_DSN` unset. In that state {@link captureAlarm}
 * returns immediately and this module produces zero network traffic, which is
 * pinned by test rather than asserted here.
 *
 * Module-scoped singleton, like `redis.ts`'s client: alarms are raised from
 * routes, workers, the mutation seam, and process handlers, and threading a
 * transport through all four would mean editing every one of them — including
 * the money workers that closed CLEAN and stay closed.
 */
let transport: AlarmTransport | null = null;

/** Guards against double-installing the crash handlers on a re-init. */
let processHandlersInstalled = false;

/**
 * Sends that have been started and not yet settled. `flushObservability`
 * awaits these so a shutdown or a crash doesn't drop the alarm that explains
 * it — the single most important alarm the process will ever raise.
 */
const inFlight = new Set<Promise<void>>();

/** Per-fingerprint dedupe windows, bounded by {@link MAX_TRACKED_FINGERPRINTS}. */
const dedupeWindows = new Map<string, DedupeWindow>();

/** The circuit breaker's fixed window: when it opened, and what it has sent. */
let catastrophicWindowStartedMs = Date.now();
let catastrophicSent = 0;
/** Non-null while the breaker is OPEN. A watchdog 503 condition. */
let catastrophicTrippedAt: string | null = null;

/**
 * The current {@link DROP_WINDOW_MS} window: when it opened, and the two ways a
 * page is lost inside it — chosen (suppressed, at a ceiling) and attempted
 * (handed to the transport and rejected). One window, two counters, because
 * they answer different questions and the watchdog judges them separately.
 */
let dropWindowStartedMs = Date.now();
let droppedInWindow = 0;
let transportFailuresInWindow = 0;

/**
 * Pager health, read by `GET /health/watchdog` (D20-A2 §A2.3, §A3.4.3). Every
 * way a page can be LOST is counted here, because the alternative — the one
 * this cycle inherited — is a raw `process.stderr.write` that bypasses pino
 * and pages nobody about the page it just lost.
 */
export interface PagerHealth {
  /** False ⇒ `captureAlarm` is a no-op. In production that is a hard fault. */
  installed: boolean;
  /** Reset to 0 by any successful send. ≥ 3 is the watchdog's 503 threshold. */
  consecutive_transport_failures: number;
  /**
   * Sends attempted and LOST inside the current {@link DROP_WINDOW_MS},
   * consecutive or not (D20-A5.3). The counter above is reset by any success,
   * which is why a pager that fails every OTHER send reported perfect health
   * while destroying half the pages handed to it. Every one of these is an
   * alarm that reached nobody, so the watchdog 503s on
   * {@link MAX_RECENT_TRANSPORT_FAILURES} of them.
   */
  transport_failures_recent: number;
  last_failure_at: string | null;
  /** Cumulative drops since init: de-duplicated, at-ceiling, or breaker-shed. */
  dropped_alarms: number;
  /**
   * Drops inside the current {@link DROP_WINDOW_MS}. This is the one the
   * watchdog judges (§A4.4.1): under de-duplication a drop is rare and
   * meaningful, so SUSTAINED drops are an incident — but a cumulative counter
   * that only ever climbs would latch the 503 forever after one storm.
   */
  dropped_alarms_recent: number;
  drop_window_s: number;
  last_drop_at: string | null;
  /**
   * Non-null while {@link CATASTROPHIC_HOURLY_CEILING} is tripped. A watchdog
   * 503 condition on its own: at that volume something is badly wrong and the
   * pager is shedding, so "the alarms went quiet" must not read as healthy.
   */
  catastrophic_ceiling_tripped_at: string | null;
  in_flight: number;
}

let consecutiveTransportFailures = 0;
let lastFailureAt: string | null = null;
let droppedAlarms = 0;
let lastDropAt: string | null = null;

/**
 * Is a pager actually installed on this process? (D20-A3 §A3.2.)
 *
 * `initObservability()` was a bare statement in `index.ts` — a file no test can
 * reach (proven: a transitive import walk over 107 test entry files found
 * `src/index.ts` reachable from none of them). Deleting it left a process with
 * `SENTRY_DSN` set, `env.ts`'s production guard satisfied, a clean `/health`,
 * and zero envelopes: round 6's `?? NOOP_LOG` defect one layer up. Round 6
 * closed its version by making the omission a COMPILE error; `buildApp()`'s
 * signature is called from ~100 test sites, so widening it is a worse trade —
 * this is the boot-failure equivalent, called by `server.ts` and reported by
 * `GET /health/watchdog`.
 */
export function isPagerInstalled(): boolean {
  return transport !== null;
}

/**
 * A snapshot for the watchdog. Cheap, allocation-only, never throws, and
 * deliberately does not MUTATE the windows it reads — a health check that
 * advanced the pager's own state would make the reading depend on how often it
 * was read. Both windows are therefore aged here rather than reset.
 */
export function pagerHealth(): PagerHealth {
  const nowMs = Date.now();
  const windowExpired = nowMs - dropWindowStartedMs >= DROP_WINDOW_MS;
  return {
    installed: transport !== null,
    consecutive_transport_failures: consecutiveTransportFailures,
    transport_failures_recent: windowExpired ? 0 : transportFailuresInWindow,
    last_failure_at: lastFailureAt,
    dropped_alarms: droppedAlarms,
    dropped_alarms_recent: windowExpired ? 0 : droppedInWindow,
    drop_window_s: DROP_WINDOW_MS / 1000,
    last_drop_at: lastDropAt,
    catastrophic_ceiling_tripped_at:
      nowMs - catastrophicWindowStartedMs >= CATASTROPHIC_WINDOW_MS ? null : catastrophicTrippedAt,
    in_flight: inFlight.size,
  };
}

export interface InitObservabilityOptions {
  /**
   * Override the pager. Tests inject a recording stub; production passes
   * nothing and gets the DSN-derived transport (or none at all).
   */
  transport?: AlarmTransport;
  /**
   * Install the `uncaughtException` / `unhandledRejection` handlers. Default
   * true — `index.ts` owns the process and wants them. Tests inject a
   * transport WITHOUT claiming the process: a handler that calls
   * `process.exit(1)` inside a test runner would truncate node:test's own
   * report of the very crash it is reporting on.
   */
  installProcessHandlers?: boolean;
}

/**
 * Install the pager. Called once from `index.ts` BEFORE `buildApp()`, so the
 * hook the server installs has somewhere to forward to from the first request.
 *
 * A malformed `SENTRY_DSN` throws out of here and kills the boot rather than
 * degrading to no-pager. That is deliberate and matches `env.ts`'s "there is
 * no half-booted server": a production process that believes it is paging and
 * is not is the exact `?? NOOP_LOG` failure this cycle exists to close.
 */
export function initObservability(opts: InitObservabilityOptions = {}): void {
  transport =
    opts.transport ?? (env.SENTRY_DSN !== undefined ? createSentryTransport(env.SENTRY_DSN) : null);

  // A fresh pager starts with fresh windows and fresh health. Production calls
  // this once; tests call it per case, and a dedupe window that leaked across
  // cases would make one test's storm silence the next test's assertion.
  const nowMs = Date.now();
  dedupeWindows.clear();
  catastrophicWindowStartedMs = nowMs;
  catastrophicSent = 0;
  catastrophicTrippedAt = null;
  dropWindowStartedMs = nowMs;
  droppedInWindow = 0;
  transportFailuresInWindow = 0;
  // Sends started against the PREVIOUS transport are orphaned by definition —
  // nothing will flush them anywhere useful, and leaving them in the set would
  // hold the in-flight ceiling closed against the new pager. (Their own
  // `finally` deletes from an already-empty set: harmless.)
  inFlight.clear();
  consecutiveTransportFailures = 0;
  lastFailureAt = null;
  droppedAlarms = 0;
  lastDropAt = null;

  // No pager ⇒ nothing to flush on a crash, and a handler that only
  // re-implements Node's default crash is a strictly worse crash path than
  // Node's. Install only when there is something to say and someone to hear.
  if (transport !== null && (opts.installProcessHandlers ?? true)) {
    installProcessHandlers();
  }
}

/**
 * Raise an alarm. **Fire-and-forget, and NEVER throws** — callers are the
 * money path, the request logger, and the crash handlers, none of which may
 * acquire a new failure mode by being observed.
 *
 * A transport failure (network, 4xx/5xx) writes one stderr line and is
 * otherwise swallowed. The pino/stderr line that accompanies every alarm
 * remains the durable record. A malformed DSN never reaches here — it fails
 * CLOSED at boot ({@link parseDsn}) — and a **circular `extra` is no longer a
 * failure at all**: {@link makeJsonSafeReplacer} renders the back-edge and the
 * page goes out. (This list used to name both as handled failures while a
 * circular `extra` in fact lost the page silently — D20-A2 §A2.4.1-2.)
 *
 * **Named and accepted** (§A4.1): the fourth and later copies of an event
 * already **delivered** {@link IDENTICAL_ALLOWANCE} times inside the last
 * {@link DEDUPE_WINDOW_MS} are withheld — delivered, not merely attempted, since
 * D20-A5.3. The pino line is still written — the
 * log is the record — and when the window rolls, one synthetic "pager
 * suppressed N identical alarms" event says how many and names one, so being
 * blind is itself visible. What is NOT accepted, and is why §A4.1 replaced the
 * whole mechanism, is withholding an event the pager has never sent.
 */
export function captureAlarm(event: AlarmEvent): void {
  const active = transport;
  if (active === null) return;
  try {
    // §A4.1.3 — a crash page bypasses every gate. It is at most a handful per
    // process lifetime, the process is dying, and it is (this module's own
    // words) the single most important alarm the process will ever raise;
    // there is no quota argument for rationing it. That includes the in-flight
    // ceiling: `fatal` comes only from the crash handlers below — which exit
    // within CRASH_FLUSH_TIMEOUT_MS — and from an explicit `log.fatal`, so what
    // this concedes is a handful of sends above MAX_IN_FLIGHT, against losing
    // the page that explains a dead deploy. Where §A4.1.5 keeps MAX_IN_FLIGHT a
    // true bound and §A4.1.3 says `fatal` bypasses everything, this is the
    // reading: the bound holds against the unbounded sources, and the bounded
    // one goes through.
    if (event.level === 'fatal') {
      dispatch(active, event, { bypassCeiling: true });
      return;
    }
    const nowMs = Date.now();
    if (breakerIsOpen(active, nowMs)) {
      recordDrop(event, `catastrophic ceiling (${CATASTROPHIC_HOURLY_CEILING}/hour) tripped`, nowMs);
      return;
    }
    // Records its own drop — only it knows the count standing behind it — and
    // hands back the window that a DELIVERED copy of this event must count
    // against (D20-A5.3; the allowance is spent on delivery, not on admission).
    const window = admitByDedupe(active, event, nowMs);
    if (window === null) return;
    dispatch(active, event, { dedupeWindow: window });
  } catch (err) {
    reportTransportFailure(event, err);
  }
}

/**
 * Hand one event to the transport and track it until it settles.
 *
 * The dispatch happens inside an **async wrapper** (§A4.5 L1). The previous
 * `Promise.resolve(active.send(event))` claimed in a comment to route a
 * SYNCHRONOUS throw to the rejection path and, executed, did not — the throw
 * escaped to the caller. The latent consequence was specific: a sync throw
 * raised from the suppression notice both lost the notice's count and lost the
 * real event that was about to be dispatched on the next line. An async
 * function body turns a sync throw into a rejection by construction, so both
 * failure modes now land on the one path that reports them.
 *
 * The in-flight ceiling is checked HERE rather than at the top of
 * {@link captureAlarm} (§A4.5 L2): checking once and then dispatching twice (a
 * notice, then the event) let `inFlight` reach `MAX_IN_FLIGHT + 1`, and left a
 * second, unreachable check inside the notice path that would have discarded a
 * suppression count silently if it ever ran. One check, at the one place that
 * adds to the set, is exact.
 */
function dispatch(
  active: AlarmTransport,
  event: AlarmEvent,
  opts: { bypassCeiling?: boolean; dedupeWindow?: DedupeWindow } = {},
): void {
  if (opts.bypassCeiling !== true && inFlight.size >= MAX_IN_FLIGHT) {
    recordDrop(event, `in-flight ceiling (${MAX_IN_FLIGHT}) reached`, Date.now());
    return;
  }
  countTowardBreaker(Date.now());
  const sent = (async () => active.send(event))().then(
    () => {
      // A delivered page is the only thing that clears the failure streak the
      // watchdog 503s on. Anything less would latch on one transient blip.
      consecutiveTransportFailures = 0;
      // …and the only thing that spends a copy of this fingerprint's allowance
      // (D20-A5.3). If the window was rolled or evicted meanwhile, this lands on
      // a detached object and the live window has one fewer delivery on record —
      // more sending, never less, which is the safe direction.
      if (opts.dedupeWindow !== undefined) opts.dedupeWindow.delivered += 1;
    },
    (err: unknown) => {
      reportTransportFailure(event, err);
    },
  );
  inFlight.add(sent);
  void sent.finally(() => {
    inFlight.delete(sent);
  });
}

/**
 * What makes two events "identical" (§A4.1.1). Three parts, each chosen against
 * a failure that was executed rather than imagined:
 *
 *   1. `logger` — cheap, and keeps a route's sentence distinct from a worker's.
 *   2. **The message with its digits normalised** (`\d+` → `N`).
 *      `duplicateRefundRetry.ts:583` templates a COUNT into its sentence, so the
 *      raw text minted a new fingerprint every tick and starved the old global
 *      ceiling. Normalised, that source collapses to ONE fingerprint, which is
 *      exactly what de-duplication is for.
 *   3. **`extra`'s identifying scalars, NOT normalised.** `ch_1` and `ch_2` must
 *      stay distinct: that is where `captureReconciler.ts:641-648` puts the
 *      money, and collapsing them is precisely how 7 of 12 lost holds went
 *      unpaged. Per-request keys ({@link NON_IDENTIFYING_EXTRA_KEYS}) are
 *      excluded, because a fingerprint carrying `reqId` is unique by
 *      construction and de-duplicates nothing.
 *   4. **A nested `Error`'s `name` and digit-normalised `message`** (D20-A5.1).
 *      Scalars alone were not enough, and the gap was the whole 5xx surface:
 *      `auth/plugin.ts:212` logs the CONSTANT sentence `'unhandled error'` with
 *      the only identity — the fault itself — nested under `err`. Executed by
 *      round 3: **six genuinely distinct first-ever 500s → three paged**, the
 *      other three withheld as "identical" to faults they had nothing to do
 *      with. The message is digit-normalised for the same reason the alarm
 *      sentence is (ids, counts, and ports inside an error string would mint a
 *      fresh fingerprint per occurrence); the `name` is not, because
 *      `TypeError` and `Error` are different faults.
 *
 * **The bias is deliberately toward over-uniqueness**, and this is the honest
 * statement of how far that goes: scalars split, a nested `Error` splits, and
 * every OTHER nested object is still ignored rather than hashed — two events
 * differing only inside a nested non-`Error` object still collapse. That
 * residue is named rather than claimed away. (The first version of this
 * paragraph asserted over-uniqueness in one sentence and refuted it in the
 * next, describing the `err` collapse as though it were the bias rather than an
 * exception to it.) The direction is chosen because extra quota use is
 * detectable and recoverable, and a dropped money alarm is neither.
 *
 * Composed with `JSON.stringify` over an array rather than by concatenating
 * around a separator. The separator the first version used was a literal NUL
 * byte in the source, which made this whole module read as BINARY to `grep` and
 * `file` — every search of it silently returned nothing, which is this repo's
 * "absence is never established by a search" rule with a byte behind it. JSON
 * framing is unambiguous, printable, and cannot be split by a delimiter that
 * appears in a message.
 */
function fingerprintOf(event: AlarmEvent): string {
  return JSON.stringify([
    event.logger,
    event.message.replace(/\d+/g, 'N'),
    identifyingExtra(event.extra),
  ]);
}

/**
 * `extra`'s identifying entries, sorted so key order can never split a
 * fingerprint: its scalars, and the shape of any nested `Error`.
 *
 * Each entry is framed as its own `JSON.stringify`d array rather than as
 * `key=value` (D20-A5.5 H). `key=value` around a shared separator is the same
 * class of bug as the NUL byte one line up: `{ a: 'b=c' }` and `{ 'a=b': 'c' }`
 * both render `a=b=c`, so two different events could share a fingerprint
 * because of where a delimiter happened to fall inside the data. Framing is
 * unambiguous; a two-element array is also structurally distinct from the
 * three-element one an `Error` produces.
 */
function identifyingExtra(extra: Record<string, unknown> | undefined): string[] {
  if (extra === undefined) return [];
  const parts: string[] = [];
  for (const key of Object.keys(extra).sort()) {
    if (NON_IDENTIFYING_EXTRA_KEYS.has(key)) continue;
    const value = extra[key];
    if (value instanceof Error) {
      // The 5xx path's ONLY identity (D20-A5.1). `name` raw — `TypeError` is not
      // `Error` — and the message digit-normalised, exactly as the alarm
      // sentence is, so one bug storming with a different id or port in its
      // text still collapses to one fingerprint.
      parts.push(JSON.stringify([key, value.name, value.message.replace(/\d+/g, 'N')]));
      continue;
    }
    const kind = typeof value;
    if (kind === 'string' || kind === 'number' || kind === 'boolean' || kind === 'bigint') {
      parts.push(JSON.stringify([key, String(value)]));
    }
  }
  return parts;
}

/**
 * May this event page? Returns the window a successful delivery must be counted
 * against, or `null` when an IDENTICAL event has already been DELIVERED
 * {@link IDENTICAL_ALLOWANCE} times inside the current window. A first-ever
 * fingerprint always returns a window; there is no branch here that can withhold
 * one, and that is the invariant.
 */
function admitByDedupe(
  active: AlarmTransport,
  event: AlarmEvent,
  nowMs: number,
): DedupeWindow | null {
  const fingerprint = fingerprintOf(event);
  let window = dedupeWindows.get(fingerprint);
  if (window !== undefined && nowMs - window.startedMs >= DEDUPE_WINDOW_MS) {
    // The window rolled: say what it hid before it is forgotten.
    reportRolledWindow(active, window, nowMs);
    dedupeWindows.delete(fingerprint);
    window = undefined;
  }
  if (window === undefined) {
    window = { startedMs: nowMs, delivered: 0, suppressed: 0, sample: null };
    admitFingerprint(active, fingerprint, window, nowMs);
  }
  if (window.delivered < IDENTICAL_ALLOWANCE) return window;
  window.suppressed += 1;
  window.sample = { logger: event.logger, message: event.message };
  recordDrop(
    event,
    `an identical alarm has already been DELIVERED ${IDENTICAL_ALLOWANCE}x in ` +
      `${DEDUPE_WINDOW_MS / 60_000} minutes`,
    nowMs,
  );
  return null;
}

/**
 * Track this fingerprint's window, evicting one first if the table is full.
 *
 * **A new fingerprint is ALWAYS admitted**, and that is the load-bearing
 * property: {@link evictOneWindow} is total whenever the map is non-empty, so
 * the map cannot be full-and-unevictable and there is no branch here that can
 * turn "the table is busy" into "this alarm is withheld". The old scheme's
 * equivalent path did exactly that — `bucketFor` returned `null` and the event
 * fell through to a global bucket that could refuse it.
 *
 * (A second `size >= MAX` guard stood here as belt-and-braces and was DEAD:
 * eviction always frees a slot, so it could never run. That is the same shape
 * as §A4.5 L2's dead in-flight check, and it was caught the same way — by a
 * mutant that went green because the code it mutated was unreachable.)
 */
function admitFingerprint(
  active: AlarmTransport,
  fingerprint: string,
  window: DedupeWindow,
  nowMs: number,
): void {
  if (dedupeWindows.size >= MAX_TRACKED_FINGERPRINTS) evictOneWindow(active, nowMs);
  dedupeWindows.set(fingerprint, window);
}

/**
 * Free exactly one slot: an already-rolled window if there is one (dead state —
 * the next event of that fingerprint would have rolled it anyway), otherwise the
 * oldest live one. Either way its suppressed count is REPORTED rather than
 * discarded, so eviction cannot swallow the accounting the way a silent cap
 * would.
 */
function evictOneWindow(active: AlarmTransport, nowMs: number): void {
  let oldestKey: string | null = null;
  let oldestStartedMs = Number.POSITIVE_INFINITY;
  for (const [key, window] of dedupeWindows) {
    if (nowMs - window.startedMs >= DEDUPE_WINDOW_MS) {
      dedupeWindows.delete(key);
      reportRolledWindow(active, window, nowMs);
      return;
    }
    if (window.startedMs < oldestStartedMs) {
      oldestStartedMs = window.startedMs;
      oldestKey = key;
    }
  }
  if (oldestKey === null) return;
  const evicted = dedupeWindows.get(oldestKey);
  dedupeWindows.delete(oldestKey);
  if (evicted !== undefined) reportRolledWindow(active, evicted, nowMs);
}

/**
 * Being blind must be VISIBLE. When a fingerprint's window rolls (or is
 * evicted), one synthetic event says how many identical alarms it withheld and
 * names one of them, then the count clears. It bypasses de-duplication —
 * suppressing the suppression notice is the defect it exists to prevent — but
 * not the in-flight ceiling, which {@link dispatch} owns.
 */
function reportRolledWindow(active: AlarmTransport, window: DedupeWindow, nowMs: number): void {
  if (window.suppressed === 0) return;
  const suppressed = window.suppressed;
  const sample = window.sample;
  window.suppressed = 0;
  window.sample = null;
  dispatch(active, {
    message:
      `pager suppressed ${suppressed} identical alarms over the last ` +
      `${Math.max(1, Math.round((nowMs - window.startedMs) / 60_000))} minutes; ` +
      `the log remains the record`,
    level: 'error',
    logger: 'observability',
    extra: {
      suppressed,
      since: new Date(window.startedMs).toISOString(),
      suppressed_logger: sample?.logger ?? null,
      suppressed_message: sample?.message ?? null,
    },
  });
}

/**
 * Is the circuit breaker open? Rolls its fixed hourly window first, and emits
 * ONE notice on the transition — a breaker that trips silently is a budget with
 * extra steps, which is the thing §A4.1 deleted.
 */
function breakerIsOpen(active: AlarmTransport, nowMs: number): boolean {
  rollBreakerWindow(nowMs);
  if (catastrophicSent < CATASTROPHIC_HOURLY_CEILING) return false;
  if (catastrophicTrippedAt === null) {
    catastrophicTrippedAt = new Date(nowMs).toISOString();
    dispatch(active, {
      message:
        `pager CIRCUIT BREAKER tripped: ${CATASTROPHIC_HOURLY_CEILING} alarms in one hour, far ` +
        `above any legitimate volume — the pager is shedding error-level events until the hour ` +
        `rolls. The log remains the record, and GET /health/watchdog is now 503`,
      level: 'error',
      logger: 'observability',
      extra: { ceiling: CATASTROPHIC_HOURLY_CEILING, tripped_at: catastrophicTrippedAt },
    });
  }
  return true;
}

function rollBreakerWindow(nowMs: number): void {
  if (nowMs - catastrophicWindowStartedMs < CATASTROPHIC_WINDOW_MS) return;
  catastrophicWindowStartedMs = nowMs;
  catastrophicSent = 0;
  catastrophicTrippedAt = null;
}

/** Every actual dispatch counts toward the breaker — notices and `fatal` too. */
function countTowardBreaker(nowMs: number): void {
  rollBreakerWindow(nowMs);
  catastrophicSent += 1;
}

/**
 * Count a page we chose not to send. One stderr line per {@link DROP_WINDOW_MS}
 * window, not per event — a pager that spams stderr during a storm is its own
 * incident — and that same window is what the watchdog reads to decide whether
 * drops are SUSTAINED rather than incidental.
 */
function recordDrop(event: AlarmEvent, reason: string, nowMs: number): void {
  droppedAlarms += 1;
  lastDropAt = new Date(nowMs).toISOString();
  rollDropWindow(nowMs);
  droppedInWindow += 1;
  if (droppedInWindow === 1) {
    try {
      process.stderr.write(
        `[observability] pager suppressing alarms (${reason}); the log remains the record. ` +
          `First suppressed: ${event.level} from ${event.logger}: ${event.message}\n`,
      );
    } catch {
      // stderr is gone. There is no third channel.
    }
  }
}

/**
 * Both drop counters live in one fixed {@link DROP_WINDOW_MS} window, rolled by
 * whichever kind of loss arrives first after it expires. Fixed rather than
 * sliding: one counter, one reset, and {@link pagerHealth} reads it without
 * mutating — a health check that advanced the pager's own state would make the
 * reading depend on how often it was read.
 */
function rollDropWindow(nowMs: number): void {
  if (nowMs - dropWindowStartedMs < DROP_WINDOW_MS) return;
  dropWindowStartedMs = nowMs;
  droppedInWindow = 0;
  transportFailuresInWindow = 0;
}

/**
 * The tap. `server.ts` passes this as Fastify's `logger.hooks`, and every
 * pino call at level ≥ 50 — app logger or any child, i.e. every
 * `request.log.error` in every route and every worker alarm carried by
 * `request.log` — forwards here on its way to being logged.
 *
 * Additive, not a reroute: `method.apply(this, args)` runs unconditionally,
 * including when forwarding throws. A hook that can throw would break ALL
 * logging for every request, which is the one way this seam could hurt the
 * app; the try/catch is what makes that impossible, and a test pins it.
 */
export function alarmForwardingHooks(): AlarmForwardingHooks {
  return {
    logMethod(args, method, level) {
      try {
        if (level >= PINO_ERROR_LEVEL) {
          captureAlarm(alarmFromPinoArgs(args, level, childBindingsOf(this)));
        }
      } catch (err) {
        // Belt-and-suspenders: captureAlarm already swallows, so reaching
        // here means the ARGUMENT shaping threw. Log it and keep logging.
        process.stderr.write(
          `[observability] alarm forwarding failed (level=${level}): ${describeError(err)}\n`,
        );
      }
      // `method` is declared with `never[]` parameters so that pino's own
      // overloaded `LogFn` stays assignable to it at the `server.ts` call
      // site (contravariance). Re-widening here to actually forward the
      // arguments pino handed us, unchanged, is the whole point of the hook.
      (method as (this: unknown, ...applied: unknown[]) => void).apply(this, args);
    },
  };
}

/**
 * Await the in-flight envelope POSTs, bounded by `timeoutMs`. Called from
 * `index.ts` `shutdown()` and from the crash handlers, both immediately before
 * `process.exit` — without it, SIGTERM during a redeploy silently discards the
 * alarm that was mid-flight.
 *
 * Never rejects: `allSettled`, and the timeout wins if the network hangs.
 */
export async function flushObservability(
  timeoutMs: number = DEFAULT_FLUSH_TIMEOUT_MS,
): Promise<void> {
  if (inFlight.size === 0) return;
  const drained = Promise.allSettled([...inFlight]).then(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => {
    // Deliberately NOT `unref()`d: an unref'd timer does not fire when nothing
    // else is keeping the loop alive, so the "bounded wait" would hang forever
    // in exactly the situation it exists for. The `finally` below clears it,
    // so it can't outlive the flush either way.
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([drained, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ---- the default transport: a hand-rolled Sentry envelope POST -------------

/** What a DSN decomposes into. Nothing else about Sentry lives outside here. */
interface ParsedDsn {
  publicKey: string;
  envelopeUrl: string;
}

/**
 * `https://<key>@<host>/<project_id>` → the ingest endpoint + the auth key.
 * Throws on anything that isn't that shape; `env.ts` only proves the value is
 * a URL, not that it is a DSN, and the difference between the two is a
 * production process that thinks it has a pager.
 *
 * **A PATH-PREFIXED DSN is refused, and that is deliberate** (D20-A4 §A4.5 N2).
 * `https://<key>@<host>/some/prefix/42` is a legal DSN for a SELF-HOSTED Sentry
 * behind a path prefix, and this function rejects it because the project id
 * must be the whole path. Correct for the sentry.io free-tier DSN this cycle
 * targets — where a path prefix means a mangled copy-paste — and the
 * fail-closed direction either way. If Fetch'd ever self-hosts, this is the
 * line that changes, with a test beside it.
 */
function parseDsn(dsn: string): ParsedDsn {
  const url = new URL(dsn);
  const publicKey = url.username;
  // Trailing slashes are the failure D20-A2 §A2.4.1 executed: `.../42/` built
  // `POST /api/42//envelope/`, which Sentry 404s — silently, forever, on a
  // process that believes it has a pager. A non-empty check is not a shape
  // check, so this asserts the SHAPE and refuses at boot: fail CLOSED.
  const projectId = url.pathname.replace(/^\/+/, '').replace(/\/+$/, '');
  if (publicKey.length === 0 || projectId.length === 0) {
    throw new Error(
      `SENTRY_DSN is not a Sentry DSN: expected https://<key>@<host>/<project_id>, ` +
        `got a URL with ${publicKey.length === 0 ? 'no key' : 'no project id'}`,
    );
  }
  if (!/^\d+$/.test(projectId)) {
    throw new Error(
      `SENTRY_DSN is not a Sentry DSN: expected https://<key>@<host>/<project_id>, ` +
        `got a non-numeric project id '${projectId}' (a Sentry project id is digits only)`,
    );
  }
  // D20-A4 §A4.5 N1, closed the rest of the way by D20-A5.4. A project id that
  // starts with a zero is not a project id: `0042` has a leading zero, and `0`
  // itself is the project id in SENTRY'S OWN EXAMPLE DSN — the value a
  // non-engineer copies out of the documentation (and, until this ruling, out of
  // this repo's `.env.example`) when they mean to paste theirs. Sentry ingest
  // 404s both, silently and forever, on a process that reports a healthy pager.
  //
  // Round 2 left `0` accepted because the runbook's boot smoke detects it — she
  // expects a page and none arrives. That is a PROCEDURE, not an instrument, and
  // §A2.4.1 already ruled this class must fail CLOSED at boot. The whole cost of
  // closing it was a non-zero placeholder in `.env.example` and two boot tests.
  if (projectId.startsWith('0')) {
    throw new Error(
      `SENTRY_DSN is not a Sentry DSN: project id '${projectId}' starts with a zero ` +
        `(a leading zero, or the '0' from Sentry's own EXAMPLE DSN). Sentry ingest 404s it ` +
        `and the drop is swallowed by design, so this fails CLOSED at boot`,
    );
  }
  return { publicKey, envelopeUrl: `${url.protocol}//${url.host}/api/${projectId}/envelope/` };
}

/**
 * The production pager: one envelope POST per event, no batching, no retry,
 * no buffer. Deliberately dumb — the decision about WHETHER an event goes out
 * is made upstream in {@link captureAlarm}, and this function's only job is to
 * put one event on the wire correctly.
 *
 * (The first version of this comment said "level-50 traffic is ~zero and
 * anything at error IS page-worthy; grouping and rate limiting are Sentry-side
 * alert-rule concerns, not code" — design §2.2's premise. D20-A2 §A2.1 proved
 * it false by execution: level-50 volume was attacker-controlled and unbounded,
 * and 200 anonymous malformed POSTs queued 200 pages in 18 ms. De-duplication
 * lives in code for that reason, and the claim is deleted rather than left to
 * contradict the module it sits in.)
 *
 * Exported (rather than kept private) because the Sentry wire format exists in
 * exactly one place in this repo — right here — so exactly one test can pin
 * it. A DSN can't be injected through `env` after module load.
 */
export function createSentryTransport(dsn: string): AlarmTransport {
  const { publicKey, envelopeUrl } = parseDsn(dsn);
  const authHeader =
    `Sentry sentry_key=${publicKey}, sentry_version=7, sentry_client=fetchd-backend/1.0` as const;

  return {
    async send(event: AlarmEvent): Promise<void> {
      const eventId = randomUUID().replace(/-/g, '');
      const payload = {
        event_id: eventId,
        timestamp: new Date().toISOString(),
        platform: 'node',
        level: event.level,
        logger: event.logger,
        message: { formatted: event.message },
        environment: env.NODE_ENV,
        // Railway injects the deployed commit; without it Sentry can't tell
        // you WHICH build paged. Absent locally, so it stays optional.
        ...(process.env.RAILWAY_GIT_COMMIT_SHA !== undefined
          ? { release: process.env.RAILWAY_GIT_COMMIT_SHA }
          : {}),
        ...(event.extra !== undefined ? { extra: event.extra } : {}),
      };
      // Envelope framing: header line, item header line, item payload line.
      // Newline-delimited JSON — NOT a JSON document.
      const envelope =
        `${JSON.stringify({ event_id: eventId })}\n` +
        `${JSON.stringify({ type: 'event' })}\n` +
        `${JSON.stringify(payload, makeJsonSafeReplacer())}\n`;

      const response = await fetch(envelopeUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-sentry-envelope',
          'X-Sentry-Auth': authHeader,
        },
        body: envelope,
        // Node 20 global fetch + AbortSignal.timeout: a hung ingest endpoint
        // must not hold a shutdown flush (or an event-loop slot) open.
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`sentry envelope: HTTP ${response.status} ${response.statusText}`);
      }
    },
  };
}

/**
 * One replacer per serialization, because the cycle guard is per-document.
 *
 * `JSON.stringify` renders an `Error` as `{}` — which would turn the `err`
 * every alarm carries into an empty object at the one moment someone is
 * reading it. Errors become `{ name, message, stack }`; bigints (Postgres
 * `bigint` columns surface as these) become strings instead of throwing.
 *
 * And a **circular `extra`** used to throw out of `stringify`, losing the page
 * entirely (D20-A2 §A2.4.2 executed it: zero requests reach ingest) while this
 * module's own doc listed it as handled. Not reachable from today's alarm
 * sites — all plain objects — but "the doc says handled, the code says the
 * page is lost" is the instrument failure, not the reachability. A `WeakSet` of
 * the ancestors on the current path renders the back-edge as `'[Circular]'` and
 * the alarm still pages.
 */
function makeJsonSafeReplacer(): (this: unknown, key: string, value: unknown) => unknown {
  // The ancestors of the value currently being serialized — the WeakSet answers
  // "is this a back-edge" in O(1), the array keeps the order the WeakSet can't.
  // `stringify` walks depth-first and calls the replacer with `this` = the
  // holder, so unwinding to the holder's own chain is what keeps a repeated
  // SIBLING (legal, and common — the same `err` under two keys) from being
  // mislabelled a cycle.
  const onPath = new WeakSet<object>();
  const path: object[] = [];
  return function jsonSafeReplacer(this: unknown, _key: string, value: unknown): unknown {
    if (value instanceof Error) {
      return { name: value.name, message: value.message, stack: value.stack };
    }
    if (typeof value === 'bigint') return value.toString();
    if (typeof value !== 'object' || value === null) return value;

    while (path.length > 0 && path[path.length - 1] !== this) {
      const popped = path.pop();
      if (popped !== undefined) onPath.delete(popped);
    }
    if (onPath.has(value)) return '[Circular]';
    onPath.add(value);
    path.push(value);
    return value;
  };
}

// ---- internals ------------------------------------------------------------

/**
 * Turn a pino call's arguments into an {@link AlarmEvent}. pino's shapes:
 * `log.error(obj, msg)`, `log.error(msg)`, `log.error(err)`, `log.error(err,
 * msg)`. The merge object becomes `extra` — that is where `chargeId`,
 * `amountCents`, `refundId`, and `reqId`'s siblings live, and an alarm
 * without them is a sentence with no money attached.
 */
function alarmFromPinoArgs(
  args: readonly unknown[],
  level: number,
  bindings: Record<string, unknown>,
): AlarmEvent {
  const alarmLevel: AlarmEvent['level'] = level >= PINO_FATAL_LEVEL ? 'fatal' : 'error';
  const first = args[0];
  const second = args[1];

  if (first instanceof Error) {
    return {
      message: typeof second === 'string' ? second : first.message,
      level: alarmLevel,
      logger: 'pino',
      extra: { ...bindings, err: first },
    };
  }
  if (typeof first === 'object' && first !== null && !Array.isArray(first)) {
    const merge = first as Record<string, unknown>;
    return {
      message: typeof second === 'string' ? second : fallbackMessage(merge),
      level: alarmLevel,
      logger: 'pino',
      // D20-A1 merge order: the call-site names the money and WINS key
      // collisions; bindings are ambient context (`reqId` chief among them).
      extra: { ...bindings, ...merge },
    };
  }
  // `log.error()` with no arguments at all used to page the literal string
  // "undefined" (D20-A2 §A2.4.4) — a Sentry issue titled `undefined`, which
  // groups every such event into one meaningless bucket. Fall back to the same
  // honest sentence `fallbackMessage` already gives a message-less merge object.
  const text =
    typeof first === 'string' ? first : first === undefined ? fallbackMessage({}) : String(first);
  const message = { message: text };
  return Object.keys(bindings).length > 0
    ? { ...message, level: alarmLevel, logger: 'pino', extra: bindings }
    : { ...message, level: alarmLevel, logger: 'pino' };
}

/**
 * The child logger's bindings, read off the hook's `this` (D20-A1). The page
 * must be correlatable to its Railway log line, and `logMethod` receives only
 * the CALL's arguments — `reqId` is a child-logger BINDING (`request.log` is
 * a child), added later at serialization, so without this read the log line
 * has the join key and the page does not. Null-safe by construction: unit
 * harnesses call the hook with `this: null`, and pino's root logger returns
 * `{}` (both proven against installed pino 10.3.1).
 */
function childBindingsOf(logger: unknown): Record<string, unknown> {
  if (logger === null || typeof logger !== 'object' || !('bindings' in logger)) return {};
  const bindings = (logger as { bindings: unknown }).bindings;
  if (typeof bindings !== 'function') return {};
  const result = (bindings as () => unknown).call(logger);
  return typeof result === 'object' && result !== null && !Array.isArray(result)
    ? (result as Record<string, unknown>)
    : {};
}

/**
 * A merge object logged with no message still has to page as SOMETHING a
 * human can read in a Sentry issue title — never an empty string, which
 * groups every such event into one meaningless issue.
 */
function fallbackMessage(extra: Record<string, unknown>): string {
  if (typeof extra['msg'] === 'string') return extra['msg'];
  const err = extra['err'];
  if (err instanceof Error) return err.message;
  return 'log event with no message';
}

/**
 * One stderr line per dropped alarm, and nothing else. Never throws.
 *
 * It also COUNTS (§A3.4.3): after boot, a transport failure used to be one
 * stderr line read by nobody — the boot smoke proves the channel once, at
 * setup, and never again. These counters are what `GET /health/watchdog`
 * reports to an external monitor, which is the only instrument that survives
 * this process or Sentry dying.
 *
 * **Both** counters, since D20-A5.3. `consecutiveTransportFailures` alone was
 * the whole of §A3.4.3's "transport failures increment a counter the watchdog
 * reports", and any single success resets it — so a pager rejecting every OTHER
 * send destroyed 30 of 60 pages while the watchdog answered `200` with
 * `reasons: []` (executed, round 3 finding C). A windowed count of losses has
 * no such reset, which is the property that makes flapping visible.
 */
function reportTransportFailure(event: AlarmEvent, err: unknown): void {
  const nowMs = Date.now();
  consecutiveTransportFailures += 1;
  rollDropWindow(nowMs);
  transportFailuresInWindow += 1;
  lastFailureAt = new Date(nowMs).toISOString();
  try {
    process.stderr.write(
      `[observability] alarm NOT delivered (${event.level} from ${event.logger}: ` +
        `${event.message}): ${describeError(err)}\n`,
    );
  } catch {
    // stderr itself is gone (closed pipe on shutdown). There is no third
    // channel; dropping here is the end of the line.
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message;
  return String(err);
}

/**
 * Crash handlers. They CAPTURE and then crash — they must not swallow.
 *
 * Node's default for both events is: print the stack, exit 1. Installing a
 * listener suppresses that default, so this reproduces it exactly — stack to
 * stderr, exit code 1 — with a best-effort flush in between so the fatal alarm
 * actually leaves the process before it dies.
 *
 * What happens next, stated correctly (D20-A3 §L4 — the first version of this
 * comment said "Railway then restarts", which is only half of it):
 * `railway.json` sets `restartPolicyType: ON_FAILURE` with
 * `restartPolicyMaxRetries: 3`, so a REPEATABLE uncaught exception ends in a
 * dead deploy after four boots, not an endless restart loop. That is the right
 * outcome — and it is exactly why the fatal alarm has to get out first: the
 * page is the only thing that will tell anyone the deploy is gone.
 *
 * The flush uses {@link CRASH_FLUSH_TIMEOUT_MS}, not the 2 s shutdown window:
 * a process with an uncaught exception is still SERVING for as long as its exit
 * is deferred, and Node's own default defers it not at all.
 */
function installProcessHandlers(): void {
  if (processHandlersInstalled) return;
  processHandlersInstalled = true;
  process.on('uncaughtException', (err: unknown) => {
    crashAfterAlarm('uncaughtException', err);
  });
  process.on('unhandledRejection', (reason: unknown) => {
    crashAfterAlarm('unhandledRejection', reason);
  });
}

function crashAfterAlarm(kind: string, reason: unknown): void {
  captureAlarm({
    message: `${kind}: ${reason instanceof Error ? reason.message : String(reason)}`,
    level: 'fatal',
    logger: 'process',
    extra: { kind, err: reason },
  });
  process.stderr.write(
    `[observability] ${kind} — process will exit 1:\n${describeError(reason)}\n`,
  );
  void flushObservability(CRASH_FLUSH_TIMEOUT_MS).finally(() => {
    process.exit(1);
  });
}
