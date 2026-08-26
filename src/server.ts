import Fastify, { type FastifyInstance } from 'fastify';
import { env } from './env.js';
import { alarmForwardingHooks, isPagerInstalled } from './lib/observability.js';
import { registerAuth } from './auth/plugin.js';
import { registerAuthWebhook } from './routes/authWebhook.js';
import { registerAgreementsRoute } from './routes/agreements.js';
import { registerAnnouncementsRoute } from './routes/announcements.js';
import { registerAvailabilityRoute } from './routes/availability.js';
import { registerBookingsRoute } from './routes/bookings.js';
import { registerCreditPackagesRoute } from './routes/creditPackages.js';
import { registerCreditsRoute } from './routes/credits.js';
import { registerDogsRoute } from './routes/dogs.js';
import { registerEnrollmentsRoute } from './routes/enrollments.js';
import { registerEventsRoute } from './routes/events.js';
import { registerDeviceTokensRoute } from './routes/device-tokens.js';
import { registerGroupClassesRoute } from './routes/groupClasses.js';
import { registerHealthRoute } from './routes/health.js';
import { registerHealthWatchdogRoute } from './routes/healthWatchdog.js';
import { registerInvoicesRoute } from './routes/invoices.js';
import { registerMediaRoute } from './routes/media.js';
import { registerMembershipsRoute } from './routes/memberships.js';
import { registerMeRoute } from './routes/me.js';
import { registerNotificationsRoute } from './routes/notifications.js';
import { registerPaymentMethodsRoute } from './routes/paymentMethods.js';
import { registerRatesRoute } from './routes/rates.js';
import { registerReportsRoute } from './routes/reports.js';
import { registerRequestConfirmPaymentRoute } from './routes/requestConfirmPayment.js';
import { registerRequestsRoute } from './routes/requests.js';
import { registerRequiredVaccinesRoute } from './routes/requiredVaccines.js';
import { registerStaffAlumniRoute } from './routes/staffAlumni.js';
import { registerStaffBookingsRoute } from './routes/staffBookings.js';
import { registerStaffCancelWindowRoute } from './routes/staffCancelWindow.js';
import { registerStaffCreditExpiryRoute } from './routes/staffCreditExpiry.js';
import { registerStaffInvoicesRoute } from './routes/staffInvoices.js';
import { registerStaffMembershipsRoute } from './routes/staffMemberships.js';
import { registerStaffDogsRoute } from './routes/staffDogs.js';
import { registerStaffRatesRoute } from './routes/staffRates.js';
import { registerStaffReportsRoute } from './routes/staffReports.js';
import { registerStaffRequestsRoute } from './routes/staffRequests.js';
import { registerStaffThreadsRoute } from './routes/staffThreads.js';
import { registerStripeWebhookRoute } from './routes/stripeWebhook.js';
import { registerThreadsRoute } from './routes/threads.js';
import { registerUploadsSignRoute } from './routes/uploadsSign.js';
import { registerVetsRoute } from './routes/vets.js';
import { registerWelcomeDogsRoute } from './routes/welcomeDogs.js';
import { registerWorkersTickRoute } from './routes/workersTick.js';

/**
 * Builds the Fastify app and registers routes. Kept separate from the boot
 * entrypoint (`index.ts`) so it can be constructed without listening — the
 * shape contract tests on Day 4 will use `app.inject()` against this factory.
 */
export function buildApp(): FastifyInstance {
  // D20-A3 §A3.2: `initObservability()` in `index.ts` was a bare statement in
  // a file no test can reach — delete it and production runs with `SENTRY_DSN`
  // set, `env.ts`'s guard satisfied, `/health` green, and every money alarm
  // going nowhere. Round 6 closed that exact class by making the omission a
  // compile error; `buildApp()` is called from ~100 test sites, so this is the
  // boot-failure form instead. Production without a pager does not serve.
  if (env.NODE_ENV === 'production' && !isPagerInstalled()) {
    throw new Error(
      'refusing to build the production app: no pager is installed. ' +
        'initObservability() must run before buildApp() (see src/index.ts) — without it ' +
        'captureAlarm is a no-op and every money alarm (SURPLUS REFUND, LOST HOLD, ' +
        'abandoned refunds) reaches nobody, exactly as on 2026-08-24.',
    );
  }

  const app = Fastify({
    // Day-20: `hooks` taps the log at pino level ≥ 50 and forwards to the
    // pager (`lib/observability.ts`). Child loggers inherit it, so every
    // `request.log.error` — including the worker alarms the tick route hands
    // `request.log` — pages without any route or worker knowing this exists.
    logger: { level: env.LOG_LEVEL, hooks: alarmForwardingHooks() },
    disableRequestLogging: false,
  });

  // Auth first: it decorates `request.principal` and installs the one
  // ApiError→HTTP mapper every route relies on.
  registerAuth(app);
  registerHealthRoute(app); // [public] — no auth guard
  registerHealthWatchdogRoute(app); // [public] — Day-20 scheduler + pager watchdog; NOT /health
  registerWelcomeDogsRoute(app); // [public] — pre-login welcome gallery
  registerAuthWebhook(app); // [public, signed] — own raw-body scope
  registerStripeWebhookRoute(app); // [public, signed] — Day-15; own raw-body scope
  registerMeRoute(app); // [auth]
  registerDogsRoute(app); // [auth]
  registerVetsRoute(app); // [auth]
  registerRequiredVaccinesRoute(app); // [auth]
  registerAgreementsRoute(app); // [auth]
  registerBookingsRoute(app); // [auth]
  registerEnrollmentsRoute(app); // [auth] — group-class enrollment (owner-only)
  registerAvailabilityRoute(app); // [auth] — catalog (owner + staff)
  registerCreditsRoute(app); // [auth] — owner-only (per-dog)
  registerCreditPackagesRoute(app); // [auth] — catalog (owner + staff)
  registerRatesRoute(app); // [auth] — catalog (owner + staff)
  registerRequestsRoute(app); // [auth] — owner-only
  registerStaffRequestsRoute(app); // [staff] — Day-12 portal verb 1 (approve / deny) + Day-19 queue
  registerStaffCancelWindowRoute(app); // [staff] — Day-13 portal verb 3 (cancel-window policy)
  registerStaffCreditExpiryRoute(app); // [staff] — staff-tunable credit-expiry settings (2026-06-20)
  registerStaffAlumniRoute(app); // [staff] — §J.3 completed-programs record + alumni-flag clear
  registerStaffMembershipsRoute(app); // [staff] — §J.1 pause / resume (staff-mediated)
  registerStaffInvoicesRoute(app); // [staff] — parked-invoice worklist (credit-expiry Phase 3)
  registerStaffRatesRoute(app); // [staff] — per-location service-rate editor (2026-06-20)
  registerStaffDogsRoute(app); // [staff] — Day-19b portal dog directory (name resolution)
  registerStaffBookingsRoute(app); // [staff] — Day-19 portal verb 4 (confirm / cancel / attendance)
  registerStaffThreadsRoute(app); // [staff] — Day-19 portal verb 3 (thread queue + staff reply)
  registerStaffReportsRoute(app); // [staff] — Day-19 portal verb 2 (report authoring)
  registerGroupClassesRoute(app); // [auth] — catalogs (owner+staff); eligibility owner-only
  registerReportsRoute(app); // [auth] — owner-only (scoped via dog FK)
  registerThreadsRoute(app); // [auth] — owner-only
  registerEventsRoute(app); // [auth] — catalog reads (owner+staff); rsvps owner-only
  registerNotificationsRoute(app); // [auth] — owner-only
  registerAnnouncementsRoute(app); // [auth] — catalog (owner + staff)
  registerPaymentMethodsRoute(app); // [auth] — owner-only
  registerDeviceTokensRoute(app); // [auth] — owner-only (Day-18c push registration)
  registerInvoicesRoute(app); // [auth, $] — Day-15 invoice settlement
  registerMembershipsRoute(app); // [auth, $] — §J.1 credit-package subscriptions
  registerRequestConfirmPaymentRoute(app); // [auth, $] — Day-15 B&T conversion
  registerUploadsSignRoute(app); // [auth] — Day-17 presigned R2 PUT
  registerMediaRoute(app); // [auth] — Day-17 register/read/soft-expire media
  registerWorkersTickRoute(app); // [public, signed] — Day-16 scheduler trigger

  return app;
}
