import { env } from './env.js';
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
