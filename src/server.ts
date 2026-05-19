import Fastify, { type FastifyInstance } from 'fastify';
import { env } from './env.js';
import { registerHealthRoute } from './routes/health.js';

/**
 * Builds the Fastify app and registers routes. Kept separate from the boot
 * entrypoint (`index.ts`) so it can be constructed without listening — the
 * shape contract tests on Day 4 will use `app.inject()` against this factory.
 */
export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: { level: env.LOG_LEVEL },
    disableRequestLogging: false,
  });

  registerHealthRoute(app);

  return app;
}
