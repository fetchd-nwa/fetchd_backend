import Fastify, { type FastifyInstance } from 'fastify';
import { env } from './env.js';
import { registerAuth } from './auth/plugin.js';
import { registerAuthWebhook } from './routes/authWebhook.js';
import { registerAgreementsRoute } from './routes/agreements.js';
import { registerAvailabilityRoute } from './routes/availability.js';
import { registerBookingsRoute } from './routes/bookings.js';
import { registerCreditPackagesRoute } from './routes/creditPackages.js';
import { registerCreditsRoute } from './routes/credits.js';
import { registerDogsRoute } from './routes/dogs.js';
import { registerEventsRoute } from './routes/events.js';
import { registerGroupClassesRoute } from './routes/groupClasses.js';
import { registerHealthRoute } from './routes/health.js';
import { registerMeRoute } from './routes/me.js';
import { registerRatesRoute } from './routes/rates.js';
import { registerReportsRoute } from './routes/reports.js';
import { registerRequestsRoute } from './routes/requests.js';
import { registerRequiredVaccinesRoute } from './routes/requiredVaccines.js';
import { registerThreadsRoute } from './routes/threads.js';
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
  registerAvailabilityRoute(app); // [auth] — catalog (owner + staff)
  registerCreditsRoute(app); // [auth] — owner-only (per-dog)
  registerCreditPackagesRoute(app); // [auth] — catalog (owner + staff)
  registerRatesRoute(app); // [auth] — catalog (owner + staff)
  registerRequestsRoute(app); // [auth] — owner-only
  registerGroupClassesRoute(app); // [auth] — catalogs (owner+staff); eligibility owner-only
  registerReportsRoute(app); // [auth] — owner-only (scoped via dog FK)
  registerThreadsRoute(app); // [auth] — owner-only
  registerEventsRoute(app); // [auth] — catalog reads (owner+staff); rsvps owner-only

  return app;
}
