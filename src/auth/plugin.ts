import type {
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler,
} from 'fastify';
import Stripe from 'stripe';
import type { Principal, StaffRole } from './principal.js';
import { bypassHeaderEnabled } from '../env.js';
import { ApiError, toErrorEnvelope } from '../lib/errors.js';
import { verifyAccessToken, type VerifiedToken } from './jwks.js';
import { resolvePrincipal } from './mirror.js';
import { staffRole } from '../db/schema/schema.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the `authenticate` preHandler; `null` on `[public]` routes. */
    principal: Principal | null;
  }
}

const BEARER_PREFIX = 'Bearer ';

function extractBearer(request: FastifyRequest): string {
  const header = request.headers.authorization;
  if (!header || !header.startsWith(BEARER_PREFIX)) {
    throw new ApiError('unauthenticated', 'missing or malformed Authorization header');
  }
  const token = header.slice(BEARER_PREFIX.length).trim();
  if (token.length === 0) {
    throw new ApiError('unauthenticated', 'empty bearer token');
  }
  return token;
}

// ---- Day-7a `X-Dev-Principal` bypass --------------------------------------
//
// Dev/test escape hatch from the JWT-setup tax: `curl -H 'X-Dev-Principal:
// owner:<uuid>'` constructs a Principal directly, no Supabase round-trip.
// Two layers guard it from leaking into prod:
//   1. `env.bypassHeaderEnabled` — false by default in staging/prod, hard-
//      forced false when NODE_ENV=production (see `env.ts:resolveBypassHeader
//      Enabled`).
//   2. `makeAuthenticate` closes over the resolved flag at module load, so
//      `request.headers['x-dev-principal']` is *only ever inspected* when (1)
//      says yes.
//
// Header shape: `owner:<uuid>` | `staff:<uuid>:<role>` where <role> is a
// `staff_role` enum value. UUID is the mirror-row id (not the supabase uid)
// — same shape as `actorOf(principal)` so the audit_log gets a familiar
// actor string. `supabaseUid` is the literal `'dev-bypass'` (never read for
// reads, but the Principal field is required).
const DEV_PRINCIPAL_HEADER = 'x-dev-principal' as const;
const DEV_BYPASS_SUPABASE_UID = 'dev-bypass';
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const DEV_OWNER_RE = new RegExp(`^owner:(${UUID_RE.source})$`, 'i');
const DEV_STAFF_RE = new RegExp(`^staff:(${UUID_RE.source}):([a-z-]+)$`, 'i');

function parseDevPrincipal(headerValue: string): Principal {
  const ownerMatch = DEV_OWNER_RE.exec(headerValue);
  if (ownerMatch) {
    return { kind: 'owner', ownerId: ownerMatch[1]!, supabaseUid: DEV_BYPASS_SUPABASE_UID };
  }
  const staffMatch = DEV_STAFF_RE.exec(headerValue);
  if (staffMatch) {
    const role = staffMatch[2]! as StaffRole;
    if (!(staffRole.enumValues as readonly string[]).includes(role)) {
      throw new ApiError(
        'bad_request',
        `X-Dev-Principal: invalid staff role '${role}' (allowed: ${staffRole.enumValues.join('|')})`,
      );
    }
    return { kind: 'staff', staffId: staffMatch[1]!, role, supabaseUid: DEV_BYPASS_SUPABASE_UID };
  }
  throw new ApiError(
    'bad_request',
    `X-Dev-Principal: expected 'owner:<uuid>' or 'staff:<uuid>:<role>'`,
  );
}

interface AuthDeps {
  verify: (token: string) => Promise<VerifiedToken>;
  resolve: (supabaseUid: string) => Promise<Principal | null>;
  /**
   * Day-7a addition: when true, `X-Dev-Principal: owner:<uuid>` (or
   * `staff:<uuid>:<role>`) constructs the Principal directly and skips the
   * JWT verify+resolve path. Default false. Tests inject explicitly; the
   * real `authenticate` reads `bypassHeaderEnabled` from `env.ts`.
   */
  bypassEnabled?: boolean;
}

/**
 * `[auth]` guard. Verify the bearer JWT, resolve it to a live mirror row,
 * attach the principal. A verified-but-unprovisioned token is a deliberate
 * 403 `not_provisioned` (invite-only model, Day 2b owns creation) — distinct
 * from a 401 for a bad/absent token.
 *
 * Factory-injected deps keep the route guards testable without a live Supabase
 * project or DB (the dependency rule: the guard knows the *shape* of verify +
 * resolve, not their concrete implementations).
 */
export function makeAuthenticate(deps: AuthDeps): preHandlerHookHandler {
  const bypassEnabled = deps.bypassEnabled ?? false;
  return async function authenticate(request: FastifyRequest): Promise<void> {
    if (bypassEnabled) {
      const headerValue = request.headers[DEV_PRINCIPAL_HEADER];
      if (typeof headerValue === 'string' && headerValue.length > 0) {
        request.principal = parseDevPrincipal(headerValue);
        return;
      }
    }
    const token = extractBearer(request);
    const { sub } = await deps.verify(token);
    const principal = await deps.resolve(sub);
    if (!principal) {
      throw new ApiError(
        'not_provisioned',
        'authenticated, but no account is provisioned for this user',
      );
    }
    request.principal = principal;
  };
}

/** Production `[auth]` guard, bound to the real verifier + mirror resolver. */
export const authenticate = makeAuthenticate({
  verify: verifyAccessToken,
  resolve: resolvePrincipal,
  bypassEnabled: bypassHeaderEnabled,
});

/**
 * `[staff]` guard. Composes *after* `authenticate`
 * (`preHandler: [authenticate, requireStaff]`) — the access-control layer is
 * explicit app code, route by route. There is no RLS (BACKEND-ARCHITECTURE
 * §2.5: this middleware *is* the access-control layer).
 */
export const requireStaff: preHandlerHookHandler = async function requireStaff(
  request: FastifyRequest,
): Promise<void> {
  if (!request.principal) {
    throw new ApiError('unauthenticated', 'requireStaff used without authenticate');
  }
  if (request.principal.kind !== 'staff') {
    throw new ApiError('forbidden', 'staff role required');
  }
};

/**
 * `[staff: <roles>]` guard (STAFF-U07; design §2.1:2049-2050), beside
 * `requireStaff`: a staff principal whose role is one of `roles`. An owner
 * (family) principal, or a staff role off the list, is 403 `forbidden`.
 * Composes after `authenticate` (`preHandler: [authHook,
 * requireStaffRole('owner', 'manager')]`), so it runs before the handler parses
 * a body: a refused caller learns nothing about the body's validity.
 *
 * The role is the principal's — the mirror row's, read at sign-in. Which
 * routes take which roles is each route's declaration; what a role may do
 * among the settings is the registry's (`settingsRegistry.mayEditClass`), and
 * the verbs whose roles are data (the five `staff_settings` lists) read those
 * lists at the verb, as `GET /me`'s capabilities do.
 */
export function requireStaffRole(...roles: [StaffRole, ...StaffRole[]]): preHandlerHookHandler {
  const allowed: ReadonlySet<StaffRole> = new Set(roles);
  const needs = roles.join(' or ');
  return async function requireStaffRoleGuard(request: FastifyRequest): Promise<void> {
    if (!request.principal) {
      throw new ApiError('unauthenticated', 'requireStaffRole used without authenticate');
    }
    if (request.principal.kind !== 'staff') {
      throw new ApiError('forbidden', 'staff role required');
    }
    if (!allowed.has(request.principal.role)) {
      throw new ApiError('forbidden', `this action needs the ${needs} role`);
    }
  };
}

/**
 * Narrow `request.principal` to non-null inside an `[auth]` handler. It is a
 * programming error (not a user-reachable state) to call this on a route that
 * did not run `authenticate`; failing loud beats a null-deref three calls deep.
 */
export function requirePrincipal(request: FastifyRequest): Principal {
  if (!request.principal) {
    throw new ApiError('unauthenticated', 'route handler ran without authenticate');
  }
  return request.principal;
}

/**
 * The optional-`authenticate` injection seam every `[auth]` route registrar
 * accepts (`registerXxx(app, opts?)`). Production wires nothing and gets the
 * real JWKS-verifier preHandler; a contract test stubs in a preHandler that
 * pins `request.principal` to a fixture owner — no live Supabase needed.
 *
 * The DI shape is extracted at the third use (me + dogs), the rule-of-two
 * point. `registerAuthWebhook(app, verify)` takes a `verify` function — a body
 * verifier, not a preHandler — so it deliberately does not collapse into this
 * shape; a unified `registerRoute` wrapper would force unrelated DI seams
 * through one type and obscure the route signature.
 */
export interface AuthRouteOptions {
  authenticate?: preHandlerHookHandler;
}

export function resolveAuthHook(opts: AuthRouteOptions = {}): preHandlerHookHandler {
  return opts.authenticate ?? authenticate;
}

/**
 * Wire auth into the app: declare the `principal` request slot and route
 * every `ApiError` through one mapper. Centralizing the error→HTTP mapping
 * here (not per-route) is the cross-cutting-concern rule — the day the error
 * envelope is frozen, it changes in exactly one place.
 */
export function registerAuth(app: FastifyInstance): void {
  app.decorateRequest('principal', null);

  app.setErrorHandler((err: FastifyError, request, reply: FastifyReply) => {
    if (err instanceof ApiError) {
      if (err.status >= 500) {
        request.log.error({ err }, 'auth integrity fault');
      }
      return reply.code(err.status).send(toErrorEnvelope(err));
    }
    // Level split, mirroring the `ApiError` branch above (`:193`). `authenticate`
    // is a preHandler, so body parsing and schema validation run BEFORE auth:
    // an anonymous malformed-JSON POST raises a Fastify 400 and lands right
    // here. Logging that at error was always a small lie — a client's broken
    // request is not our fault — and became dangerous on 2026-08-25, when
    // Day-20 made level 50 mean "wake a human": 200 anonymous malformed POSTs
    // queued 200 pages in 18 ms, and Sentry's quota is consumed at ingest, so
    // draining it silently disables the SURPLUS REFUND page. 5xx is ours and
    // pages; 4xx is the client's and warns. Bodies and status codes unchanged.
    //
    // One exception, and it is not the client's. A Stripe error carries Stripe's status,
    // and a 401 or 403 from Stripe is Stripe refusing OUR key. Passed through, a bad or
    // rotated key on *Cancel order* answers 401 and the portal signs the staff member
    // out for a fault that is not hers, while nobody is told the key is dead. So it is
    // ours: a 500, which pages. Every other Stripe status passes through as it always
    // has, 429 above all, which is retryable and must not page.
    const carried = typeof err.statusCode === 'number' ? err.statusCode : 500;
    const stripeRefusedOurKey =
      err instanceof Stripe.errors.StripeError && (carried === 401 || carried === 403);
    const status = stripeRefusedOurKey ? 500 : carried;
    if (status >= 500) request.log.error({ err }, 'unhandled error');
    else request.log.warn({ err }, 'client error');
    return reply
      .code(status)
      .send({ error: { code: 'internal', message: 'Internal Server Error' } });
  });
}
