import type { FastifyInstance } from 'fastify';
import { env } from '../env.js';
import { pagerHealth, type PagerHealth } from '../lib/observability.js';
import {
  readParkedTotal,
  readQueueOk,
  readSchedulerHeartbeat,
  SCHEDULER_HEARTBEAT_KEY,
  SCHEDULER_QUEUE_OK_KEY,
  SCHEDULER_QUEUE_OK_TTL_S,
  type HeartbeatReading,
  type ParkedTotalReading,
} from '../lib/schedulerHeartbeat.js';

/**
 * `GET /health/watchdog` `[public]` — **did the scheduler tick, and is the
 * pager alive?** (Day-20, D20-A2 §A2.3, extended by §A3.2.2 and §A3.4.3.)
 *
 * Allison's finding on 2026-08-24 was not "the cron is missing"; it was
 * *"production ticks have NEVER fired and nobody knew."* A cron that can stop
 * silently fixes the instance and leaves the class. Every way the tick can stop
 * — secret drift (the 401 never reaches the app), a changed Railway URL (a 404
 * the process never sees), a deactivated `cron.job` row, a dropped extension, a
 * paused project — produces zero alarms, because the alarm channel lives inside
 * a process nothing is calling. One level out, the same shape: after boot,
 * every transport failure is a stderr line read by nobody, and the boot smoke
 * proves the channel once, at setup, and never again.
 *
 * So this endpoint answers both, to an EXTERNAL monitor (5-minute interval,
 * free tier, alerting where Sentry alerts). That monitor is outside both this
 * process and Sentry, which makes it the one instrument that survives either
 * dying — the answer to "how would I find out this happened again?"
 *
 * **It deliberately does NOT ride `GET /health`.** `railway.json` points its
 * deploy healthcheck at `/health`; folding staleness in would make every fresh
 * deploy — which by definition has no recent tick — fail its own healthcheck
 * and roll itself back. Separate endpoint, separate status code, no
 * interaction. That is the trap that makes the obvious version of this fix
 * worse than nothing.
 *
 * Public and unauthenticated like `/health`, so a monitor needs no secret. The
 * body is a timestamp and a handful of counters — no ids, no money, no PII.
 * Listed in DATA-CONTRACT beside `/health`; `wire.ts` is NOT involved (no
 * client generates this, there is no wire shape).
 */

/**
 * Ten missed minutely ticks. Long enough to ride out a redeploy or a slow tick,
 * short enough that a dead scheduler is caught within one monitor interval of
 * the threshold rather than the next morning.
 */
export const SCHEDULER_STALE_AFTER_MS = 10 * 60 * 1000;

/**
 * Consecutive failed sends that make the pager itself the incident. One
 * transient blip is not an outage; three in a row with nothing succeeding in
 * between means alarms are being written to stderr and nowhere else.
 */
export const MAX_CONSECUTIVE_TRANSPORT_FAILURES = 3;

/**
 * Drops inside one `DROP_WINDOW_MS` (one hour) that make suppression itself the
 * incident (D20-A4 §A4.4.1). Reporting `dropped_alarms` and returning 200 was
 * reporting a number to an instrument that cannot read numbers: the only
 * consumer of this endpoint is a free uptime monitor watching a STATUS CODE, so
 * 75 dropped alarms read as `status=ok`.
 *
 * Why 200 and not 10. Under de-duplication a SINGLE persistent condition
 * alarming every minute legitimately drops about seven events per ten-minute
 * window — roughly 42 an hour — and that is the mechanism working exactly as
 * designed, not an outage. A threshold near that floor would 503 whenever one
 * worker had a bad hour, which would train the monitor's reader to ignore it,
 * which is worse than not having it. 200/hour is about five such conditions
 * running simultaneously, or one genuine flood; either is worth a look, and
 * neither is routine.
 */
export const MAX_RECENT_DROPPED_ALARMS = 200;

/**
 * Sends the pager ATTEMPTED and lost inside one `DROP_WINDOW_MS`, consecutive
 * or not, that make delivery itself the incident (D20-A5.3 — §A3.4.3 as it was
 * originally ruled). Deliberately not folded into
 * {@link MAX_RECENT_DROPPED_ALARMS}: the two counters mean opposite things. A
 * suppression is the mechanism WORKING — an identical page already went out —
 * which is why that threshold sits at 200. Every one of THESE is a page that
 * reached nobody, so the honest threshold is small.
 *
 * Three, the same count as {@link MAX_CONSECUTIVE_TRANSPORT_FAILURES}, because
 * the hole this closes is the pager that FLAPS rather than dies: any success
 * resets the consecutive counter, so a transport rejecting every other send
 * destroyed 30 of 60 pages while this endpoint answered `200` with
 * `reasons: []` (executed, round 3). Both checks stay live and neither is
 * redundant — this one sees non-consecutive loss, the other sees a streak with
 * successes absent rather than merely outnumbered. Since D20-A7.2 they share
 * the same hour: the consecutive counter now ages out on the same window roll,
 * because it was the only 503 reason with no clearing path and one blip latched
 * it red indefinitely. Named cost of that: neither check sees a streak that
 * STRADDLES an hour boundary any more — the earlier version of this paragraph
 * claimed the consecutive one did, and after A7.2 that would be false.
 */
export const MAX_RECENT_TRANSPORT_FAILURES = 3;

/**
 * Alarms shed at `MAX_IN_FLIGHT` inside one `DROP_WINDOW_MS` (D20-A7.1). These
 * are counted by {@link MAX_RECENT_DROPPED_ALARMS} as well, and that is exactly
 * why they need their own reason: that threshold is 200 because the drops it
 * mostly sees are DE-DUPLICATIONS, where an identical page already went out and
 * the drop is the mechanism working. A drop at the in-flight ceiling is the
 * opposite — a first-ever event, possibly the first LOST HOLD of the day,
 * withheld because the transport was slow. Round 4 executed it: 256 unsettled
 * sends, one shed money alarm, `GET /health/watchdog` answering `200 ok`,
 * `reasons: []`, with the breaker nowhere near its ceiling. That falsified
 * §A4.1.5's own words — a drop at the ceiling "counts and trips the watchdog
 * like any other drop". It counted. It did not trip.
 *
 * **ONE, and A7.1 asked for three — the deviation is deliberate and is flagged
 * to Allison rather than buried.** A7.1 says "threshold 3, mirroring
 * `MAX_RECENT_TRANSPORT_FAILURES`" and, in the same breath, that its red-first
 * instrument (`scratchpad/attack-r4-d20/p11-green.ts`) "must go 503". Executed,
 * those two clauses cannot both hold: p11 fills the ceiling with 256 unsettled
 * sends and then sheds **exactly one** money alarm, so at a threshold of 3 it
 * answers `200 ok` with `reasons: []` — measured, with `dropped_at_ceiling_
 * recent: 1` sitting in the body. That is the identical failure one gate over:
 * a real drop recorded in a counter no threshold can see. A7.1's own words for
 * it are "one drop trips nothing", named as THE defect.
 *
 * On the merits, 1 is also the right number here, which is why it was safe to
 * resolve the contradiction this way rather than stop. The 3-and-200 thresholds
 * both exist to keep a COMMON, benign event from training the monitor's reader
 * to ignore the endpoint: transport blips flap, and de-duplication drops are
 * the mechanism working. A drop here is neither. A7.1 measured that reaching
 * 256 concurrent needs ~51 alarms/s against a 5s-degraded ingest, "which this
 * system does not produce today", so there is no routine traffic to desensitise
 * anyone — and the single event this fires on is a first-ever page, possibly
 * the first LOST HOLD of the day, withheld having never been sent. That is a
 * literal violation of §A4.1's invariant, and one is worth a 503.
 */
export const MAX_RECENT_CEILING_DROPS = 1;

/**
 * How far a heartbeat may sit in the FUTURE before it is treated as a fault
 * rather than as noise. The writer and the reader are the same process family
 * on one clock, so a real negative reading means the clock moved — but an NTP
 * step of a second or two should not flap the alarm the uptime monitor watches.
 */
export const CLOCK_SKEW_TOLERANCE_MS = 2_000;

interface WatchdogBody {
  status: 'ok' | 'down';
  time: string;
  /** ISO instant of the last tick that reached the completion log line. */
  last_tick_at: string | null;
  /** Seconds since that tick; `null` when there has never been one. Negative
   *  when the recorded instant is in the FUTURE, which is itself a reason. */
  staleness_s: number | null;
  stale_after_s: number;
  pager: PagerHealth;
  /** Scheduled notifications PARKED right now, as the last tick published it;
   *  `null` when no tick has published one or the value cannot be read. */
  parked_total: number | null;
  /** ISO instant of the last tick whose phase 1 DELIVERED — ran to the end and
   *  did not take the systemic branch (A2.1). `null` when no tick has published
   *  one or the value cannot be read. */
  queue_ok_at: string | null;
  /** Empty on 200. On 503, every reason, so the alert says what broke. */
  reasons: string[];
}

export function registerHealthWatchdogRoute(app: FastifyInstance): void {
  app.get('/health/watchdog', async (_request, reply) => {
    const now = new Date();
    const pager = pagerHealth();
    const reasons: string[] = [];

    // Never rejects and never hangs since §A5.2 — "I cannot see" comes back as
    // a reading of its own rather than as an exception the route has to guess
    // the meaning of, or (against a reachable-but-silent Redis) as no answer at
    // all. A watchdog that answers 200 when it cannot see is the instrument
    // failure this endpoint exists to prevent; one that answers nothing is
    // worse, because the monitor cannot tell it from a slow network.
    //
    // The standing parked-row signal (A1.6) is read beside it, under the same
    // contract, and the two are raced TOGETHER rather than one after the other:
    // each carries its own 1s deadline, so awaiting them in sequence would make
    // a wedged Redis cost this endpoint two of them instead of one. Neither can
    // reject, so `Promise.all` cannot either.
    // The queue-freshness key (A2.1) joins the same race for the same reason:
    // each read carries its own 1s deadline, so a THIRD sequential await would
    // cost a wedged Redis three deadlines instead of one. None of them can
    // reject, so `Promise.all` cannot either.
    const [reading, parkedReading, queueOkReading]: [
      HeartbeatReading,
      ParkedTotalReading,
      HeartbeatReading,
    ] = await Promise.all([readSchedulerHeartbeat(), readParkedTotal(), readQueueOk()]);

    const lastTickAt = reading.kind === 'recorded' ? reading.at : null;
    const stalenessMs = lastTickAt === null ? null : now.getTime() - lastTickAt.getTime();

    // True exactly when the chain below adds NO reason: the scheduler is
    // ticking, recently, on a clock this endpoint can reason about. It gates
    // the queue-freshness check (A3.1, A3.3), and it is set in that chain's
    // final `else` rather than recomputed from the readings, so a heartbeat
    // fault branch added here later gates the queue check for free.
    let schedulerIsTicking = false;

    if (reading.kind === 'unreadable') {
      reasons.push(
        `scheduler heartbeat is UNREADABLE (${SCHEDULER_HEARTBEAT_KEY}): ${reading.reason} — ` +
          `whether the scheduler is alive cannot be judged from here`,
      );
    } else if (reading.kind === 'absent') {
      // Absent, not merely old: the key's TTL is 24h, so "no key" means either
      // the scheduler has never run in this deployment or it has been silent
      // for a day. Both are the reported condition, and the first one IS
      // Allison's finding.
      reasons.push('no scheduler tick has been recorded');
    } else if (reading.kind === 'unparseable') {
      // §A4.5 L3. Its own reason, because "never recorded" would send the
      // reader to pg_cron for a fault that lives in this key.
      reasons.push(
        `scheduler heartbeat value is unparseable (corrupt key ` +
          `${SCHEDULER_HEARTBEAT_KEY}): ${JSON.stringify(reading.raw.slice(0, 64))}`,
      );
    } else if (stalenessMs !== null && stalenessMs < -CLOCK_SKEW_TOLERANCE_MS) {
      // §A4.4.4. `staleness > threshold` is false for every negative number, so
      // a forward clock jump used to answer 200 and buy a DEAD scheduler
      // exactly that much silence, while reporting a negative age on the way.
      reasons.push(
        `scheduler heartbeat is dated ${Math.round(-stalenessMs / 1000)}s in the FUTURE — ` +
          `clock skew; staleness cannot be judged and a stopped scheduler would read healthy`,
      );
    } else if (stalenessMs !== null && stalenessMs > SCHEDULER_STALE_AFTER_MS) {
      reasons.push(
        `last scheduler tick was ${Math.round(stalenessMs / 1000)}s ago ` +
          `(threshold ${SCHEDULER_STALE_AFTER_MS / 1000}s)`,
      );
    } else {
      // Recorded, on this clock, inside the threshold. The tick is running.
      schedulerIsTicking = true;
    }

    if (parkedReading.kind === 'recorded' && parkedReading.n > 0) {
      // A parked row is a notification that will NEVER be delivered until a
      // human un-parks or cancels it — a reminder nobody gets, or an owner who
      // is never told their card failed. Its only other notice was ONE
      // fire-and-forget page, which the pager itself documents can be shed or
      // lost; this reason stands until the count goes back to zero. Allison's
      // decision 4, ruled YES: a parked notification makes the monitor red.
      reasons.push(
        `parked scheduled notifications: ${parkedReading.n} — a human must un-park or cancel ` +
          `them (see scripts/db in the umbrella)`,
      );
    }
    // `absent`, `unparseable` and `unreadable` deliberately add NO reason —
    // this one signal fails OPEN, and the honest justification is narrower than
    // the one that stood here until A2.3.
    //
    // Absent is the normal state before a deployment's first tick publishes a
    // count. Unparseable and unreadable are Redis faults, and the reason NOT to
    // add a second 503 line for them is that this endpoint would have to say
    // "there are parked rows" about rows it cannot see — the false sentence
    // §A4.5 L3 exists to prevent — while "the parked count is unreadable" is
    // not itself an availability condition.
    //
    // What that costs, named rather than implied, because the sentence here
    // used to claim the heartbeat read "one branch up already reports it" and
    // that is only true when BOTH reads fail: these are different keys read by
    // different functions, so a FRESH heartbeat beside a corrupt or unreadable
    // parked key answers 200 with `reasons: []`, and this file's own test pins
    // exactly that. A standing parked-row alarm can therefore be silently lost
    // to a corrupt key. That is A1.6's ruling as ruled; the queue-freshness
    // check below is an independent signal and does not cover it either.

    // ── the queue-freshness signal (A2.1, repaired by A3.1 / A3.2 / A3.3) ───
    //
    // Everything below is gated on `schedulerIsTicking`, and an ABSENT key is
    // a reason. Both of those are round-3 repairs, and each closes a way this
    // endpoint said something FALSE:
    //
    // **A3.1 — it must not fail OPEN.** This key is written by ONE caller and
    // only when phase 1 DELIVERED, under a 24h TTL. Raise its reason only when
    // the reading is `recorded` and the signal deletes itself: a continuing
    // outage refreshes nothing, the TTL runs monotonically to zero, and the
    // monitor goes GREEN — emailing "UP / resolved" over an outage that is
    // still running. A Redis restart mid-outage does it immediately, because
    // this is the one key of the three a broken queue never rewrites. The
    // analogy to `scheduler:parked_total` that used to stand here was FALSE:
    // that key is rewritten by every tick that can COUNT, so its absence means
    // "nobody has published one"; this key is written only on HEALTH, so its
    // absence means "nothing healthy has happened since it last expired".
    // Opposite meanings.
    //
    // **A3.2 — a clock stepped forward must not read as fresh.** The heartbeat
    // has had a skew branch since §A4.4.4 and this key did not, justified by a
    // comment pointing at the heartbeat's. That cannot cover it: the heartbeat
    // is rewritten on the FAILING path and this key is not. A clock stepped an
    // hour forward at 06:59 lets the 07:00 tick stamp both keys 08:00; NTP
    // corrects at 07:01; the 07:02 tick rewrites the heartbeat (fresh, silent)
    // and, phase 1 having broken, leaves this key at 08:00 — which
    // `staleness > threshold` reads as healthy for every negative number.
    // Seventy minutes of green over a dead queue. Fixed HERE, in the reader,
    // rather than by clamping the write: the writer has only the skewed clock
    // to clamp against, so it cannot tell a stepped clock from a correct one.
    //
    // **A3.3 — a STOPPED scheduler must not be told to read a phase alarm.**
    // When no tick runs at all (the 2026-08-24 fault: a rotated
    // `SCHEDULER_WEBHOOK_SECRET`, every `net.http_post` 401s) this key ages out
    // beside the heartbeat, and the queue sentence fired saying "every claimed
    // row is failing, or phase 1 is throwing (see the phase alarm)" — with no
    // phase alarm, because nothing is running. Whoever was paged went looking
    // for a log line that cannot exist. The status code is unchanged by the
    // gate in every case: whenever it suppresses this reason the heartbeat's
    // own reason is already carrying the 503.
    //
    // **The whole table, so every cell can be checked for a TRUE sentence.**
    // Pinned cell by cell in `test/contracts/healthWatchdog.test.ts`.
    //
    //                    | q fresh | q stale  | q future | q absent | q corrupt
    //   ---------------- | ------- | -------- | -------- | -------- | ---------
    //   hb fresh         | 200     | 503 q    | 503 q    | 503 q    | 503 q
    //   hb stale         | 503 hb  | 503 hb   | 503 hb   | 503 hb   | 503 hb
    //   hb future        | 503 hb  | 503 hb   | 503 hb   | 503 hb   | 503 hb
    //   hb absent        | 503 hb  | 503 hb   | 503 hb   | 503 hb   | 503 hb
    //   hb corrupt       | 503 hb  | 503 hb   | 503 hb   | 503 hb   | 503 hb
    //   hb unreadable    | 503 hb  | 503 hb   | 503 hb   | 503 hb   | 503 hb
    //
    // Row by row, in words:
    // - **hb fresh** — the tick is running, so the queue key is the only thing
    //   that can say whether phase 1 is moving, and it is believed: fresh is
    //   health; stale and absent are both "not delivering" (with different
    //   sentences, because only one of them can state a duration); future is
    //   clock skew on the key this endpoint is judging. Corrupt is a reason
    //   too, in its own sentence (A4 (iii)): the same fact is true of a corrupt
    //   key as of a missing one — while the scheduler ticks there is NO valid
    //   delivery instant — and the fail-OPEN arm that used to stand here let a
    //   single corrupt key silently delete a standing queue alarm.
    // - **every other row** — the heartbeat has already said the true thing,
    //   and it is the more fundamental one. Nothing is ticking (or the clock or
    //   the key cannot be trusted), so no claim about the QUEUE is available:
    //   "the queue has not delivered" would be true only vacuously, and its
    //   second clause would be false. One fault, one sentence. The signal is
    //   not lost — the moment the scheduler ticks again, a queue that is still
    //   broken raises its own reason on the next read.
    //
    // `unreadable` is a row rather than a cell pair because both keys are read
    // by one client in one `Promise.all` against one deadline: a Redis that
    // cannot be read is unreadable for BOTH, so the mixed cells do not occur.
    if (schedulerIsTicking) {
      if (queueOkReading.kind === 'recorded') {
        const queueStalenessMs = now.getTime() - queueOkReading.at.getTime();
        if (queueStalenessMs < -CLOCK_SKEW_TOLERANCE_MS) {
          // A3.2. The heartbeat's own §A4.4.4 branch, applied to this key and
          // with the same tolerance: one process family, one clock, so a real
          // negative reading means the clock moved — but a two-second NTP step
          // must not flap the alarm an uptime monitor watches.
          reasons.push(
            `scheduled-notification queue freshness (${SCHEDULER_QUEUE_OK_KEY}) is dated ` +
              `${Math.round(-queueStalenessMs / 1000)}s in the FUTURE — clock skew; queue ` +
              `staleness cannot be judged and a STOPPED queue would read healthy`,
          );
        } else if (queueStalenessMs > SCHEDULER_STALE_AFTER_MS) {
          // A2.1, ruled by Allison 2026-09-03: a queue that is not delivering
          // turns the monitor red after about ten minutes. The SAME constant as
          // heartbeat staleness on purpose — the system has one "too long", not
          // two, and a second threshold is a second number for a human to
          // remember under pressure.
          //
          // This is the state the heartbeat CANNOT see: the tick is running and
          // stamping itself every minute, and it is phase 1 that stopped. Both
          // ways it stops are covered, which is why the reason names both — the
          // systemic branch (every claimed row failing, nothing parked, nothing
          // recorded) and a throw at the phase boundary (which since 2026-09-03
          // is a 200, deliberately, so the money phases behind it still run).
          // Both of those DO leave a phase alarm, which is what makes the
          // second clause true here and false on a stopped scheduler (A3.3).
          reasons.push(
            `scheduled-notification queue has not delivered for ` +
              `${Math.round(queueStalenessMs / 1000)}s — every claimed row is failing, or phase 1 ` +
              `is throwing (see the phase alarm)`,
          );
        }
      } else if (queueOkReading.kind === 'absent') {
        // A3.1. The tick is running and NOTHING has published a delivering
        // phase 1 for as long as this key can remember. Its own sentence
        // rather than the staleness one, because there is no instant to
        // subtract: reporting a duration this system never measured is the
        // §A4.5 L3 fault, one key over.
        //
        // Named cost, since it is fail-CLOSED: on a brand-new Redis the very
        // first tick writes the heartbeat a beat before this key, so a monitor
        // that polls inside that window sees one spurious 503 and clears on
        // its next 5-minute pass. That direction is the correct one for a
        // watchdog, and the fresh-DEPLOY case — the one this branch used to be
        // excused by — is unaffected: before its first tick the heartbeat is
        // absent too, and its own branch carries the 503 with the right words.
        reasons.push(
          `scheduled-notification queue has not delivered at all: ${SCHEDULER_QUEUE_OK_KEY} is ` +
            `ABSENT while the scheduler is ticking — nothing has published a delivering phase 1 ` +
            `within the key's ${SCHEDULER_QUEUE_OK_TTL_S / 3600}h TTL; every claimed row is ` +
            `failing, or phase 1 is throwing (see the phase alarm)`,
        );
      } else if (queueOkReading.kind === 'unparseable') {
        // A4 (iii), and it REVERSES the arm that stood here: `unparseable`
        // used to add no reason, so this signal failed OPEN and a single
        // corrupt key could silently delete a standing queue alarm while the
        // heartbeat read fresh. That is A3.1's fault one state over — the same
        // fact is true of a corrupt key as of a missing one: while the
        // scheduler is ticking, NOTHING says phase 1 delivered.
        //
        // Its OWN sentence, not the ABSENT one and not a duration. "ABSENT" is
        // false of a key that is present, and there is no instant to subtract,
        // so stating a staleness would report a duration this system never
        // measured — the §A4.5 L3 fault the heartbeat's own corruption branch
        // exists to avoid.
        //
        // **The cost is BOUNDED, and that is what makes fail-CLOSED right
        // here.** `recordQueueOk` is an unconditional `SETEX`
        // (`schedulerHeartbeat.ts`), fired by `POST /workers/tick` on every
        // tick whose phase 1 DELIVERED (`workersTick.ts`, inside
        // `if (result.scheduledNotifications.queueOk)`). So over a HEALTHY
        // queue a corrupt value is overwritten within one tick: the false 503
        // costs at most one tick plus one monitor interval, and clears with no
        // human in the loop. Over a BROKEN queue nothing rewrites it and the
        // red stands — which is the point. Both halves are pinned in
        // `test/contracts/healthWatchdog.test.ts`.
        //
        // `unreadable` is deliberately NOT changed: for this key it means
        // Redis did not answer, and the heartbeat — read by the same client in
        // the same `Promise.all` against the same deadline — is `unreadable`
        // at the same moment, so `schedulerIsTicking` is false and the
        // heartbeat's own reason already carries the 503. The mixed cell does
        // not occur. The PARKED key's corrupt arm is unchanged too (A1.6 /
        // A2.3): its reasoning is different — "there are parked rows" about
        // rows it cannot see is a FALSE sentence, where "there is no valid
        // delivery instant" about a corrupt instant is a true one.
        reasons.push(
          `scheduled-notification queue key is UNPARSEABLE (corrupt key ` +
            `${SCHEDULER_QUEUE_OK_KEY}): ${JSON.stringify(queueOkReading.raw.slice(0, 64))} — ` +
            `while the scheduler is ticking there is no valid delivery instant to judge; either ` +
            `the queue is not delivering (every claimed row is failing, or phase 1 is throwing — ` +
            `see the phase alarm) or the key was overwritten; a delivering tick rewrites it ` +
            `within one tick`,
        );
      }
      // `unreadable` still adds no reason, for the reason stated in the branch
      // above: it cannot occur beside a `schedulerIsTicking` heartbeat, because
      // one unreadable Redis makes both readings unreadable at once.
    }

    if (env.NODE_ENV === 'production' && !pager.installed) {
      // §A3.2.2: with no transport, `consecutive_transport_failures` stays 0
      // forever, so the counters alone would report a healthy pager on a
      // process that has none. `buildApp()` already refuses to start such a
      // process; this is the reading that stays true if that is ever loosened.
      reasons.push('no pager installed in production');
    }
    if (pager.consecutive_transport_failures >= MAX_CONSECUTIVE_TRANSPORT_FAILURES) {
      reasons.push(
        `pager has failed ${pager.consecutive_transport_failures} consecutive sends ` +
          `(threshold ${MAX_CONSECUTIVE_TRANSPORT_FAILURES})`,
      );
    }
    if (pager.transport_failures_recent >= MAX_RECENT_TRANSPORT_FAILURES) {
      // §A3.4.3 as originally ruled, landed in §A5.3. The counter above resets
      // on any success, so a FLAPPING pager — every other send rejected — kept
      // it at 1 while half the pages went nowhere: 30 of 60 destroyed, `200`,
      // `reasons: []`. Each of these is an alarm no human ever saw.
      reasons.push(
        `pager LOST ${pager.transport_failures_recent} alarms to failed delivery in the last ` +
          `${pager.drop_window_s / 60} minutes (threshold ${MAX_RECENT_TRANSPORT_FAILURES}) — ` +
          `not consecutive, so the failure streak keeps clearing; the log remains the record`,
      );
    }
    if (pager.dropped_at_ceiling_recent >= MAX_RECENT_CEILING_DROPS) {
      // §A7.1. Checked SEPARATELY from the aggregate below and before it: these
      // drops are a subset of that number, but at a threshold of 200 a handful
      // of them move nothing, and a handful of them is a first-ever money alarm
      // reaching nobody. Named in its own sentence so the alert says the pager
      // was SATURATED rather than that it de-duplicated.
      reasons.push(
        `pager shed ${pager.dropped_at_ceiling_recent} alarms at the in-flight ceiling in the ` +
          `last ${pager.drop_window_s / 60} minutes (threshold ${MAX_RECENT_CEILING_DROPS}) — ` +
          `these were NEVER sent, not de-duplicated: the transport was saturated and the ` +
          `pager withheld events it had never delivered; the log remains the record`,
      );
    }
    if (pager.dropped_alarms_recent >= MAX_RECENT_DROPPED_ALARMS) {
      reasons.push(
        `pager dropped ${pager.dropped_alarms_recent} alarms in the last ` +
          `${pager.drop_window_s / 60} minutes (threshold ${MAX_RECENT_DROPPED_ALARMS}) — ` +
          `the log remains the record for every one of them`,
      );
    }
    if (pager.catastrophic_ceiling_tripped_at !== null) {
      // §A4.1.4: a circuit breaker, not a budget. At that volume something is
      // badly wrong, and "the alarms went quiet" must never read as healthy.
      reasons.push(
        `pager circuit breaker tripped at ${pager.catastrophic_ceiling_tripped_at} — ` +
          `error-level events are being shed until the hour rolls`,
      );
    }

    const body: WatchdogBody = {
      status: reasons.length === 0 ? 'ok' : 'down',
      time: now.toISOString(),
      last_tick_at: lastTickAt === null ? null : lastTickAt.toISOString(),
      staleness_s: stalenessMs === null ? null : Math.round(stalenessMs / 1000),
      stale_after_s: SCHEDULER_STALE_AFTER_MS / 1000,
      pager,
      parked_total: parkedReading.kind === 'recorded' ? parkedReading.n : null,
      queue_ok_at: queueOkReading.kind === 'recorded' ? queueOkReading.at.toISOString() : null,
      reasons,
    };
    return reply.code(reasons.length === 0 ? 200 : 503).send(body);
  });
}
