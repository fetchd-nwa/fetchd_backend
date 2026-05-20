import Fastify, { type FastifyInstance } from 'fastify';
import { env } from './env.js';
import { registerAuth } from './auth/plugin.js';
import { registerAuthWebhook } from './routes/authWebhook.js';
import { registerAgreementsRoute } from './routes/agreements.js';
import { registerBookingsRoute } from './routes/bookings.js';
import { registerDogsRoute } from './routes/dogs.js';
import { registerHealthRoute } from './routes/health.js';
import { registerMeRoute } from './routes/me.js';
import { registerRequiredVaccinesRoute } from './routes/requiredVaccines.js';
import { registerVetsRoute } from './routes/vets.js';

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

  // Auth first: it decorates `request.principal` and installs the one
  // ApiError→HTTP mapper every route relies on.
  registerAuth(app);
  registerHealthRoute(app); // [public] — no auth guard
  registerAuthWebhook(app); // [public, signed] — own raw-body scope
  registerMeRoute(app); // [auth]
  registerDogsRoute(app); // [auth]
  registerVetsRoute(app); // [auth]
  registerRequiredVaccinesRoute(app); // [auth]
  registerAgreementsRoute(app); // [auth]
  registerBookingsRoute(app); // [auth]

  return app;
}
