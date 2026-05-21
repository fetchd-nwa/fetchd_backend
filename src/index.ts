import { bypassHeaderEnabled, env, envSources } from './env.js';
import { buildApp } from './server.js';
import { closeDb } from './db/pool.js';
import { closeRedis } from './redis.js';

/**
 * Boot entrypoint. Importing `env` runs the Zod env contract first — a missing
 * or malformed var has already failed the process before we get here. Then the
 * server binds; SIGINT/SIGTERM drain the HTTP server and close the pool +
 * Redis so a redeploy/restart never leaks connections.
 */
const app = buildApp();

logBootEnvBanner();

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  try {
    await app.close();
    await closeDb();
    closeRedis();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'error during shutdown');
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
  process.exit(1);
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
