import { bypassHeaderEnabled, env, envSources } from './env.js';
import { buildApp } from './server.js';
import { closeDb } from './db/pool.js';
import { flushObservability, initObservability } from './lib/observability.js';
import { closeRedis } from './redis.js';

/**
 * Boot entrypoint. Importing `env` runs the Zod env contract first — a missing
 * or malformed var has already failed the process before we get here. Then the
 * server binds; SIGINT/SIGTERM drain the HTTP server and close the pool +
 * Redis so a redeploy/restart never leaks connections.
 */

// Day-20: the pager comes up BEFORE the server, so the log hook `buildApp()`
// installs has somewhere to forward to from the very first request. In
// production `env.ts` has already refused to boot without a `SENTRY_DSN`.
initObservability();

const app = buildApp();

logBootEnvBanner();

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  try {
    await app.close();
    await closeDb();
    closeRedis();
    // Drain the pager last: an alarm raised while draining (a failed
    // close, a worker still finishing) must leave the process before
    // `process.exit` discards it.
    await flushObservability();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'error during shutdown');
    await flushObservability();
    process.exit(1);
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void shutdown(signal));
}

try {
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
} catch (err) {
  app.log.error({ err }, 'failed to bind server');
  // The log hook has just queued this as an alarm; exiting without a flush
  // would drop the one page that explains why the deploy never came up.
  await flushObservability();
  process.exit(1);
}

// Day-20 paging smoke. The ONLY proof that a deployed process reaches a human
// — the real entry point, not a harness (the 2026-08-24 lesson: an alarm
// proven in tests can still be a production no-op). Allison sets
// SENTRY_BOOT_SMOKE=true, redeploys, receives the page on her phone, unsets
// it. Fires exactly once, after listen, and is a no-op with no DSN.
//
// It goes through `app.log.error`, NOT `captureAlarm` directly (D20-A3 §A3.3).
// Every real money alarm arrives via `server.ts`'s `hooks:
// alarmForwardingHooks()` → pino → captureAlarm; a smoke that skipped to the
// last hop proved transport → Sentry → phone and proved nothing about the tap,
// the `hooks:` wiring, or the effective LOG_LEVEL — the prove-the-alarm-channel
// lesson reproduced one hop out. Through the logger, a page here means
// pino → hook → captureAlarm → transport → Sentry → human, end to end.
if (env.SENTRY_BOOT_SMOKE === true) {
  app.log.error(
    { node_env: env.NODE_ENV, port: env.PORT },
    'day-20 paging smoke — unset SENTRY_BOOT_SMOKE',
  );
  app.log.info('SENTRY_BOOT_SMOKE is on — fired one smoke alarm at the pager; unset it once seen');
}

/**
 * Boot banner: shows what env layer + connection targets are actually in
 * effect on this start. Answers "which DATABASE_URL did I just load?"
 * without grepping. Secrets redacted; only host/port/db on the wire.
 */
function logBootEnvBanner(): void {
  const dbTarget = redactConnectionString(env.DATABASE_URL);
  const redisTarget = redactConnectionString(env.REDIS_URL);
  const dbTls = env.DATABASE_SSL_CA !== undefined ? 'on' : 'off';

  if (envSources.length === 0) {
    app.log.info('env: host-injected only (no .env files loaded)');
  } else {
    for (const source of envSources) {
      if (source.loaded) {
        app.log.info(`env: loaded ${source.path} (${source.keyCount} keys)`);
      } else {
        app.log.info(`env: ${source.path} not present (skipped)`);
      }
    }
  }
  app.log.info(
    { db: dbTarget, redis: redisTarget, db_tls: dbTls, node_env: env.NODE_ENV },
    'env: active config',
  );
  if (bypassHeaderEnabled) {
    app.log.warn(
      { node_env: env.NODE_ENV },
      'X-Dev-Principal bypass is ON — any request with `X-Dev-Principal: owner:<uuid>` (or staff:<uuid>:<role>) skips JWT verify. Dev-only; force-disabled in production.',
    );
  }
}

/**
 * Strip the user:password portion of a `scheme://user:pass@host:port/db`
 * URL for safe logging. Returns the original string on parse failure
 * (a malformed URL would have already failed Zod env validation, but
 * never break the boot banner on a defensive edge).
 */
function redactConnectionString(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return raw;
  }
}
