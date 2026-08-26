-- =============================================================================
-- production-scheduler.sql — Day-20. PRODUCTION ONLY. Run BY HAND, ONCE.
-- =============================================================================
--
-- WHAT THIS IS. `POST /workers/tick` is the scheduler entry point: it runs the
-- 12-phase tick (`src/workers/scheduler.ts`) that sends scheduled
-- notifications, rolls memberships, resolves unknown charge outcomes,
-- reconciles uncaptured group-class holds, retries duplicate refunds,
-- auto-charges invoices, builds media derivatives, warns on expiring credits
-- and cards, flags alumni attendance, chases overdue invoices, and sweeps
-- idempotency keys. NOTHING CALLS IT ON A CADENCE UNTIL THIS FILE IS RUN. On
-- 2026-08-24 Allison confirmed that pg_cron and pg_net are NOT installed in the
-- production Supabase project, which means production has never ticked once.
--
-- (Phase count of record: TWELVE, one field each on `SchedulerTickResult`
-- (`scheduler.ts:169-182`) — eleven per-phase result objects plus
-- `idempotencyKeysSwept`, which the worker's own doc numbers as phase 9. Two
-- other counts were in circulation and are wrong: the Day-20 design §1 said 9
-- (it counted the top-level numbers and missed 3a / 3a-bis / 3a-ter) and
-- `PORTAL-ENDPOINT-MAP.md` said 7. Both corrected 2026-08-25, D20-A3 §L5.)
--
-- WHY IT IS NOT IN schema.sql. The Day-16 lock (`.claude/backend/
-- IMPLEMENTATION.md`, Day-16 "Production scheduler trigger") stands: the cron
-- extension must never become a prerequisite of the contract-test schema
-- load. `schema.sql` describes the DATABASE; this file describes ONE
-- DEPLOYMENT of it.
--
-- ORDER IS LOAD-BEARING. Run this LAST:
--   1. `SENTRY_DSN` set in Railway FIRST — against the still-running old build,
--      which ignores a variable it does not know. The new build REFUSES TO BOOT
--      without it (`src/env.ts`), so setting it after the deploy means four
--      crash-boots and a failed deploy (`railway.json` retries 3 times);
--   2. THEN deploy the merged main, and see the boot smoke on your phone;
--   3. THEN this file.
-- The first ticks that ever fire in production must fire with paging already
-- working — a tick moves money, and an unheard alarm is the defect Day-20
-- exists to close.
--
-- HOW TO RUN. Supabase Dashboard → SQL Editor, as the project owner, ONE
-- statement block at a time, replacing <PRODUCTION_API_URL> in §3. The Vault
-- secret in §2 is created through the DASHBOARD UI, never here.
--
-- WHAT WAS ACTUALLY EXECUTED, AND WHERE (D20-A3 §A3.0.3, correcting D20-A2
-- §A2.5.1, which claimed this was unprovable and was wrong):
--   Every statement in §1–§4 was dry-run verbatim inside a ROLLED-BACK
--   transaction against a REAL Supabase Postgres 17.6 (pg_net 0.20.3
--   installed, pg_cron 1.6.4 available) as the NON-SUPERUSER `postgres` role —
--   the same role the Dashboard SQL editor runs as. Both `CREATE EXTENSION`s,
--   the `vault.decrypted_secrets` SELECT, the `cron.job_run_details` DELETE,
--   and `cron.schedule`'s upsert-by-name all succeeded. A doc that overstates
--   its own blindness is the same instrument failure as one that overstates
--   its confidence.
--   What that does NOT establish: that HER hosted project grants the same
--   things. Hosted grants can differ from the local image, which is why the
--   runbook keeps an explicit permission pre-flight before trusting the
--   scheduled versions.
--   Re-executed 2026-08-25 (D20-A4 §A4.4.3) against the same real Postgres:
--   §3's guard, in its shipped form, over all three edit shapes — untouched
--   placeholder RAISES, double-click-substituted (angle brackets surviving)
--   RAISES, correctly substituted schedules. The guard it replaced was SILENT
--   on the middle one.
--
-- =============================================================================
-- §1. Extensions
-- =============================================================================
--
-- pg_cron: the in-database scheduler (a `cron.job` table + a background
-- worker). pg_net: async HTTP from inside Postgres (a queue table + a
-- background worker that performs the request and writes the response to
-- `net._http_response`).
--
-- Both are also installable from Dashboard → Database → Extensions. Doing it
-- in SQL as well is deliberate: this file is the RECORD of what production
-- runs, and a click in a dashboard leaves no record. `IF NOT EXISTS` makes
-- either order safe.
--
-- Note: on Supabase, pg_cron installs into the `cron` schema and is only
-- available on the project's primary database.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- =============================================================================
-- §2. The scheduler secret — Supabase Vault, NOT a GUC
-- =============================================================================
--
-- The tick route authenticates a constant-time bearer compare against
-- `SCHEDULER_WEBHOOK_SECRET` (`src/routes/workersTick.ts`). The cron job
-- therefore needs that secret at send time.
--
-- ALLISON DOES THIS PART IN THE DASHBOARD, NOT IN THIS EDITOR:
--
--   Dashboard → Project Settings → Vault → "Add new secret"
--     Name:   scheduler_webhook_secret
--     Secret: <the exact value of Railway's SCHEDULER_WEBHOOK_SECRET>
--
-- The two values MUST be byte-identical; if they drift — or if the secret does
-- not exist at all, since `'Bearer ' || NULL` is NULL and sends a null header
-- that looks identical — every tick returns 401 and nothing runs (see §5's
-- monitoring queries).
--
-- WHY NOT the Day-16 sketch's `current_setting('app.scheduler_secret')`:
-- setting a GUC means `ALTER DATABASE ... SET app.scheduler_secret = '<plain
-- text>'`, which stores the plaintext in `pg_db_role_setting`, echoes it into
-- query history, and can land in logs. Vault keeps it encrypted at rest and
-- decrypts only for the reader of `vault.decrypted_secrets`. Creating the
-- secret through the UI rather than through SQL is the same reasoning applied
-- one level up: a `SELECT vault.create_secret('<plaintext>')` typed into the
-- SQL editor puts the plaintext in the editor's own history.
--
-- Confirm it exists (this SELECT never prints the secret itself). It reads
-- `vault.decrypted_secrets` — the VIEW the job actually reads, whose grant is
-- the one that matters. `vault.secrets` is a different object and the two can
-- differ (D20-A3 §L2):
--
--   SELECT name, created_at FROM vault.decrypted_secrets
--   WHERE name = 'scheduler_webhook_secret';

-- =============================================================================
-- §3. The tick job — every minute
-- =============================================================================
--
-- BEFORE RUNNING: replace <PRODUCTION_API_URL> with the Railway production
-- base URL (no trailing slash), e.g. https://fetchd-api-production.up.railway.app
-- The real URL is deliberately NOT committed here — this file lives in a repo
-- and the placeholder keeps the deployment's address out of git; the runbook
-- handed to Allison carries it.
--
-- THE JOB CANNOT BE SCHEDULED UNLESS THE URL LOOKS REAL (D20-A3 §A3.1, D20-A4
-- §A4.4.3, tightened by D20-A5.6 — "total" was overstated and is now scoped to
-- what a pattern can actually decide). Executed against a real Supabase
-- Postgres 17.6:
-- `cron.schedule` SUCCEEDS with <PRODUCTION_API_URL> still in place — pg_cron
-- never parses the command string. Every downstream checkpoint then reads GREEN
-- on a completely broken install: §5's first check shows both jobs `active = t`,
-- its second shows `succeeded` (the ENQUEUE succeeded), and its third returns
-- NULLs that the old wording told you to dismiss as "the async case".
--
-- The guard below is a POSITIVE ASSERTION — the job text must MATCH a real URL —
-- rather than a check for the placeholder's absence. The negative version was
-- defeatable by a plausible edit and that was executed, not guessed: a
-- find-and-replace-all of <PRODUCTION_API_URL> is caught, but a DOUBLE-CLICK
-- select of PRODUCTION_API_URL leaves the angle brackets behind, and
-- '<https://…>/workers/tick' schedules with the old guard SILENT. Against real
-- Supabase PG 17.6, over twelve plausible paste shapes (the sweep is executed,
-- not imagined; §A5.6 re-ran it after tightening the pattern):
--
--     form                                  negative   `[^<>']+`   this file
--     (a) un-substituted                     RAISES      RAISES      RAISES
--     (b) double-click, brackets survive     silent      RAISES      RAISES
--     (c) correctly substituted              silent      passes      passes
--     (d) trailing slash → '//workers/tick'  silent      passes      RAISES
--     (f) a space inside the host            silent      passes      RAISES
--     (i) a space before '/workers/tick'     silent      passes      RAISES
--     (g) scheme omitted                     silent      RAISES      RAISES
--     (h) uppercase scheme                   silent      RAISES      RAISES
--     (j) surrounding double quotes          silent      RAISES      RAISES
--     (k) only the COMMENT substituted       RAISES      RAISES      RAISES
--     (e) a path suffix   ('…app/api')       silent      passes      passes
--     (l) a port          ('…app:8080')      silent      passes      passes
--
-- The job text is declared ONCE and asserted before it is scheduled, so there is
-- no way to substitute the URL in one copy and not the other. The last two rows
-- are the honest limit: they are legal URLs pointing somewhere wrong, which no
-- pattern can tell from a legal URL pointing somewhere right. §5's checks and
-- the 404 recorded in `net._http_response` are the instruments for those — and
-- see the pg_net TTL note below, because that table is gone in six hours.
--
-- Job name matches the Day-16 handoff: 'scheduler-tick-every-minute'.
-- `cron.schedule` UPSERTS by name, so re-running this block after changing the
-- URL replaces the job rather than creating a second one.
--
-- timeout_milliseconds := 30000 — pg_net's per-request ceiling. A tick that
-- runs longer than 30s does NOT fail: pg_net simply stops waiting for the
-- response. See the async note below.
--
-- (`cron.schedule` returns the new jobid; wrapped in a DO block it is not
-- printed. §5's first check is what confirms the job landed.)

DO $guard$
DECLARE
  job_sql text := $job$
    SELECT net.http_post(
      url := '<PRODUCTION_API_URL>/workers/tick',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || (
          SELECT decrypted_secret
          FROM vault.decrypted_secrets
          WHERE name = 'scheduler_webhook_secret'
        ),
        'Content-Type', 'application/json'
      ),
      -- The tick is a heartbeat: the route registers no JSON parser and reads
      -- no payload. '{}' satisfies the Content-Type and nothing more.
      body := '{}'::jsonb,
      timeout_milliseconds := 30000
    );
  $job$;
BEGIN
  -- POSITIVE assertion: the job text must contain a REAL url. Anything that is
  -- not `https://host/workers/tick` or `http://host/workers/tick` — the
  -- untouched placeholder, a half-substituted one that kept its angle brackets,
  -- a typo'd scheme — fails this, because the character class excludes < > and
  -- the quote. A check for the placeholder's ABSENCE could only ever catch the
  -- shapes it was written to imagine.
  --
  -- WHITESPACE and a TRAILING SLASH are excluded too (D20-A5.6). The first
  -- version of this assertion used `[^<>']+`, which admitted three paste shapes
  -- this file's own instructions tell her to avoid — `…app/` (the trailing
  -- slash, giving `//workers/tick`), `https://fetchd api…` and `…app /workers`
  -- (a space anywhere in the pasted URL). All three were executed against real
  -- Supabase PG 17.6 and all three SCHEDULED, while `:124` claimed the job
  -- "CANNOT BE SCHEDULED UNLESS THE URL IS REAL". They 404 downstream, which is
  -- detectable, but a guard that overstates its coverage is the instrument
  -- failure, not the 404. `[^<>'\s]*[^<>'\s/]` requires at least one character
  -- and forbids the last one from being a slash.
  --
  -- What it still admits, said plainly rather than claimed away: a legal URL
  -- pointing at the WRONG place — a port (`…app:8080`) or a path prefix
  -- (`…app/api`). Both are real URL shapes that no pattern can distinguish from
  -- the right one; §5's checks and the 404 in `net._http_response` are what
  -- catch those.
  --
  -- The pattern is dollar-quoted ($re$…$re$) so it needs no escaping and, more
  -- importantly, contains no <PRODUCTION_API_URL> of its own: a
  -- find-and-replace-all in the SQL editor cannot rewrite the guard along with
  -- the job and quietly disarm it.
  IF job_sql !~ $re$url\s*:=\s*'https?://[^<>'\s]*[^<>'\s/]/workers/tick'$re$ THEN
    RAISE EXCEPTION
      'the tick job URL is not a real URL — substitute <PRODUCTION_API_URL> with the Railway base URL (no angle brackets, no trailing slash) before running §3. %',
      'pg_cron accepts an unsubstituted command string and every verification query in §5 would still read green';
  END IF;
  PERFORM cron.schedule('scheduler-tick-every-minute', '* * * * *', job_sql);
END
$guard$;

-- ---- pg_net is ASYNCHRONOUS. Read the evidence accordingly. -----------------
--
-- `net.http_post` ENQUEUES a request and returns an id immediately. A
-- background worker performs it and writes the outcome to
-- `net._http_response`. Three consequences that will otherwise mislead whoever
-- reads this in an incident:
--
--   1. `cron.job_run_details.status = 'succeeded'` means THE ENQUEUE
--      succeeded. It says nothing about whether the API answered.
--   2. `timed_out = true` in `net._http_response` means THE RESPONSE WAS NOT
--      COLLECTED within 30s. It does NOT mean the tick failed — the tick is
--      already running inside the API process and will finish and commit
--      regardless of who is listening. **This applies to `timed_out`, and to
--      nothing else.** A NULL `status_code` with a NON-NULL `error_msg` is a
--      HARD failure (bad host, DNS, connection refused) — see §5.
--   3. `net._http_response` SELF-PURGES AFTER 6 HOURS (`pg_net.ttl`, confirmed
--      against the live setting). The one table that carries the diagnosis is
--      gone by the same evening, while §4 keeps seven days of the table that
--      says the least. That asymmetry is not fixable from here — it is a
--      pg_net setting, not our data — and it is the strongest argument for the
--      watchdog: `GET <PRODUCTION_API_URL>/health/watchdog` answers "is the
--      scheduler alive" without depending on a table that has already emptied.
--
-- The authority on whether a tick actually ran is the Railway log line
-- "scheduler tick complete" with its counters (`workersTick.ts`), which since
-- 2026-08-25 carries EVERY phase's counters rather than five of twelve.
-- Everything in Postgres is upstream evidence about the CALL, not the WORK.

-- =============================================================================
-- §4. Retention — purge cron run details weekly
-- =============================================================================
--
-- A minutely job writes one `cron.job_run_details` row per run: ~1,440/day,
-- ~525,600/year, forever, in the primary database. pg_cron does not prune it
-- on Supabase. Seven days is enough history to debug a scheduler incident and
-- small enough to ignore.
--
-- THE PREDICATE IS A DISJUNCTION FOR A REASON (D20-A3 §A3.0.2). Verified
-- against the live catalog: `start_time` and `end_time` are BOTH nullable with
-- no default, and a row still marked `'starting'` — or orphaned by a cron-worker
-- restart — can carry NULL in both. No timestamp predicate can be total,
-- because the table has no other timestamp column; `end_time < ...` never
-- deletes such a row and neither does `start_time < ...`. So the timestamp
-- clause is OR'ed with a watermark on `runid`, the monotonic key, which is
-- never NULL: 20,000 runs is ~14 days at 1,440 runs/day. Between them every
-- class of row eventually goes.
--
-- Sunday 08:00 UTC — chosen to sit outside the US-Central business day so a
-- long DELETE never overlaps morning traffic.

SELECT cron.schedule(
  'job-run-details-purge-weekly',
  '0 8 * * 0',
  $$
    DELETE FROM cron.job_run_details
    WHERE end_time < now() - interval '7 days'
       OR runid < (SELECT max(runid) FROM cron.job_run_details) - 20000
  $$
);

-- =============================================================================
-- §5. Verify — run these within a couple of minutes of §3
-- =============================================================================
--
-- Both jobs registered and active:
--   SELECT jobid, jobname, schedule, active FROM cron.job ORDER BY jobid;
--
-- The most recent runs succeeded (this is the ENQUEUE, per §3's note):
--   SELECT jobid, status, start_time, return_message
--   FROM cron.job_run_details ORDER BY start_time DESC LIMIT 5;
--
-- What the API actually answered — expect 200 and a SchedulerTickResult JSON
-- body of counters. `error_msg` and `timed_out` are the two columns that
-- separate "we are still waiting" from "this will never work", and without
-- them a permanently broken install is indistinguishable from a slow tick:
--   SELECT id, status_code, error_msg, timed_out, left(content::text, 200)
--   FROM net._http_response ORDER BY id DESC LIMIT 5;
--
--   200                                = the tick ran. Read the counters.
--   401                                = the Vault secret differs from
--                                        Railway's, OR does not exist (a
--                                        missing secret sends a null header,
--                                        which looks identical).
--   404                                = <PRODUCTION_API_URL> is wrong or the
--                                        deploy is not up.
--   status_code NULL + error_msg SET   = a HARD failure — DNS, bad host,
--                                        connection refused. NOT the async
--                                        case. Do not dismiss it.
--   timed_out = true                   = pg_net stopped waiting. The tick
--                                        itself is unaffected; check Railway.
--   no rows at all                     = either nothing has been enqueued, or
--                                        the 6h `pg_net.ttl` already emptied
--                                        the table (§3, note 3).
--
-- And the ground truth, in Railway's logs:
--   "scheduler tick complete" with the tick's counters, once a minute.
--
-- Plus the one instrument that survives this whole table disappearing:
--   GET <PRODUCTION_API_URL>/health/watchdog
--     → 200 with a fresh `last_tick_at`; 503 (with `reasons`) when the last
--       tick is older than 10 minutes or the pager itself is failing.

-- =============================================================================
-- §6. Rotation runbook — SCHEDULER_WEBHOOK_SECRET
-- =============================================================================
--
-- Two stores hold the same secret (Railway env + Supabase Vault) and they
-- cannot be updated atomically, so the ORDER decides what the gap costs.
-- Update Railway FIRST: the API starts rejecting the old secret the moment it
-- redeploys, so the window is "old secret rejected, new secret not yet in
-- Vault". The tick fires once a minute, so a 401 appears about once a minute —
-- but the OUTAGE lasts however long you take between the Railway redeploy and
-- the Vault edit, which is a matter of minutes, not one minute (D20-A3 §L3).
-- Do the two steps back to back. The reverse order gives a window where the
-- previous deploy is still accepting a secret you have just retired.
--
-- Those 401s page NOBODY: the tick route's 401 is an `ApiError` below 500, and
-- the error handler logs 4xx at warn by design (`auth/plugin.ts`). §5's
-- `net._http_response` query and the watchdog's staleness are the instruments
-- for this window — not the pager.
--
--   1. Generate:  openssl rand -hex 32
--   2. Railway → the API service → Variables → SCHEDULER_WEBHOOK_SECRET =
--      <new value> → redeploy, and wait for the new deploy to be healthy.
--   3. Supabase Dashboard → Vault → scheduler_webhook_secret → update to the
--      SAME value. (Dashboard, not SQL — §2.)
--   4. The next minute's tick uses it. Confirm with §5's 200 + counters.
--
-- No job edit is needed at any point: the job SQL reads the Vault secret at
-- send time, so rotating the value never touches `cron.job`.
--
-- =============================================================================
-- §7. Stopping / removing (for completeness — do not run casually)
-- =============================================================================
--
--   SELECT cron.unschedule('scheduler-tick-every-minute');
--   SELECT cron.unschedule('job-run-details-purge-weekly');
--
-- Unscheduling the tick stops ALL background money work: no invoice
-- auto-charge, no hold reconciliation, no refund retries, no credit expiry,
-- no notifications. It is an incident action, not a maintenance one.
