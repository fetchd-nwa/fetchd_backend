import { config as dotenvConfig } from 'dotenv';
import { z } from 'zod';

// Env-selection (locked Day 4b, deferred from Day 1): host-injected env is
// the source of truth in staging/prod; `dotenv` is dev/test convenience only.
// Loading `.env` in staging/prod would let a stray file in a deployed
// container shadow host config — defense in depth against a real ops mistake.
// `dotenv` already won't override an existing `process.env`, but skipping the
// load entirely is the lean rule. NODE_ENV is read straight off `process.env`
// because Zod hasn't validated it yet; that's fine — this gate is too narrow
// to fail noisily, and an unset NODE_ENV (treated as dev) loads `.env`.
//
// Day 5a addition: `.env.local` layers OVER `.env`. The intended workflow —
// `.env` holds the canonical dev config (Supabase staging URL, etc.) and
// `.env.local` holds the developer's per-machine overrides (e.g., a local
// Postgres URL pointing at the docker-compose stack). `.env.local` is loaded
// FIRST, then `.env` — because `dotenv` never overrides existing process.env
// values, the first-loaded file wins per-key. Process.env (host/CLI) still
// trumps both.
interface EnvFileLoad {
  path: string;
  loaded: boolean;
  keyCount: number;
}

const envFileLoads: EnvFileLoad[] = [];
if (process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'staging') {
  const localResult = dotenvConfig({ path: '.env.local' });
  envFileLoads.push({
    path: '.env.local',
    loaded: localResult.parsed !== undefined,
    keyCount: localResult.parsed ? Object.keys(localResult.parsed).length : 0,
  });
  const envResult = dotenvConfig();
  envFileLoads.push({
    path: '.env',
    loaded: envResult.parsed !== undefined,
    keyCount: envResult.parsed ? Object.keys(envResult.parsed).length : 0,
  });
}

/**
 * Snapshot of which `.env*` files loaded at boot, in load order. Empty
 * when running in production/staging (host-injected env only). The boot
 * banner in `index.ts` logs a summary so it's obvious which config layer
 * the server actually picked up — answers the "what env am I running?"
 * question at every `npm run dev` / pod start.
 */
export const envSources: ReadonlyArray<EnvFileLoad> = envFileLoads;

/**
 * The full Day-1 environment contract. Every var is required: the contract is
 * locked once here so later days don't each re-litigate it (Stripe/R2 are
 * reserved now, exercised Day 14/17). A missing or malformed value fails the
 * process fast — there is no half-booted server. See `.env.example`.
 */
const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

    // Postgres — Supabase's bundled Postgres, app-owned access (Day-0 lock #3).
    DATABASE_URL: z.string().url(),
    // Path to the CA cert that signed the Postgres server cert. Supabase's
    // direct connection uses Supabase's own CA (not in Node's trust store), so
    // this is required there for verified TLS. Optional: unset OR empty string
    // = no explicit CA (a plaintext/locally-trusted Postgres, e.g. the
    // docker-compose dev container). The empty-string branch is the lever
    // `.env.local` uses to disable TLS for local dev without editing `.env`.
    DATABASE_SSL_CA: z
      .string()
      .optional()
      .transform((v) => (v !== undefined && v.length > 0 ? v : undefined)),

    // Redis — server-side cache + rate limit + sessions.
    REDIS_URL: z.string().url(),

    // Supabase Auth — JWKS verify (Day-0 lock #2). Wired Day 2a.
    SUPABASE_JWKS_URL: z.string().url(),
    SUPABASE_JWT_AUD: z.string().min(1),
    SUPABASE_JWT_ISS: z.string().url(),
    // Standard Webhooks signing secret for the Supabase "user created" auth
    // hook (`POST /auth/webhook` [public, signed]). `whsec_<base64>` form.
    // Wired Day 2b.
    SUPABASE_AUTH_WEBHOOK_SECRET: z.string().min(1),

    // Stripe — test keys in dev/staging. Reserved; wired Day 14/15.
    STRIPE_SECRET_KEY: z.string().min(1),
    STRIPE_WEBHOOK_SECRET: z.string().min(1),

    // Day-16: signed bearer secret on `POST /workers/tick`. pg_cron + pg_net
    // POSTs from inside Postgres with this header so the scheduler endpoint
    // can't be hit by anyone else. Local dev / tests use a placeholder; rotate
    // in staging/prod via the hosting env. Constant-time compare in the route.
    SCHEDULER_WEBHOOK_SECRET: z.string().min(1),

    // Cloudflare R2 — private media. Reserved; wired Day 17.
    R2_ACCOUNT_ID: z.string().min(1),
    R2_ACCESS_KEY_ID: z.string().min(1),
    R2_SECRET_ACCESS_KEY: z.string().min(1),
    R2_BUCKET: z.string().min(1),

    // Day-7a: `X-Dev-Principal` header bypass. Lets dev/test curl any [auth]
    // route by passing a header like `owner:<uuid>` — no Supabase JWT setup
    // needed. The hard gate is in `bypassHeaderEnabled` below (forced off when
    // NODE_ENV=production regardless of this setting). The raw env var
    // defaults UNSET; the resolved boolean defaults true for dev/test.
    BYPASS_HEADER_ENABLED: z
      .enum(['true', 'false'])
      .optional()
      .transform((v) => (v === undefined ? undefined : v === 'true')),

    // Day-20: the pager. `https://<key>@<host>/<project_id>` — see
    // `lib/observability.ts`. Optional in dev/test/staging (unset = the seam is
    // a no-op and emits zero network traffic); REQUIRED in production by the
    // superRefine below.
    SENTRY_DSN: z.string().url().optional(),

    // Day-20: one-shot production proof of the whole paging channel. When
    // true, `index.ts` fires exactly one error-level alarm after listen so
    // Allison can watch a deployed process page her phone, then unset it.
    //
    // **Case-INSENSITIVE, unlike BYPASS_HEADER_ENABLED above** (D20-A4 §A4.4.2).
    // This one is a diagnostic a non-engineer types into a dashboard, and as a
    // strict enum `TRUE` or `True` meant four crash-boots and a FAILED DEPLOY
    // (`railway.json` sets `restartPolicyMaxRetries: 3`) for a capitalisation —
    // with the explanation on stderr only, landing on her in the middle of
    // production surgery. That is D20-A2 §A2.2's failure shape again: a refusal
    // that is right in principle and unrecoverable in practice. The refusal
    // message below names the accepted values so a boot that IS refused
    // explains itself from the Railway log.
    SENTRY_BOOT_SMOKE: z
      .string()
      .optional()
      .transform((v) => (v === undefined ? undefined : v.trim().toLowerCase()))
      .refine((v) => v === undefined || v === 'true' || v === 'false', {
        message:
          "must be 'true' or 'false' (case-insensitive — 'true', 'TRUE' and 'True' are all " +
          "accepted, as are 'false', 'FALSE' and 'False'), or left unset. It is the one-shot " +
          'paging smoke test: set it, redeploy, watch for the page, then unset it',
      })
      .transform((v) => (v === undefined ? undefined : v === 'true')),
  })
  // ---- Day-20 production paging guards -------------------------------------
  //
  // Both of these refuse the BOOT, not a request, because both describe a
  // process that would run happily while paging nobody — the `?? NOOP_LOG`
  // class of defect (2026-08-24) moved to the config layer. "No half-booted
  // server" already covers a missing DATABASE_URL; a missing pager in
  // production is the same kind of missing.
  .superRefine((value, ctx) => {
    if (value.NODE_ENV !== 'production') return;
    if (value.SENTRY_DSN === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SENTRY_DSN'],
        message:
          'required in production — without it the observability seam is a no-op and every ' +
          'money alarm (SURPLUS REFUND, LOST HOLD, abandoned refunds) pages nobody',
      });
    }
    if (value.LOG_LEVEL === 'fatal') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['LOG_LEVEL'],
        message:
          "'fatal' is refused in production — pino does not run the logMethod hook for calls " +
          'suppressed below the active level, so error-level alarms would never reach the ' +
          'pager. Demotion-by-config is the sibling of the demotion-by-code closed in round 6',
      });
    }
    // The sibling hole (D20-A3 §N1, executed): Fastify's per-route `logLevel`
    // demotes one route's logger independently of `LOG_LEVEL`, and
    // `app.route({ logLevel: 'fatal' })` makes the tap see nothing on that route
    // while this refusal stays satisfied. A global env guard cannot see a
    // per-route option, so this used to be a comment ending "no route in this
    // repo sets it" — an ABSENCE established by a search, which this repo has
    // ruled a search cannot establish (D20-A5.5 I). It is now closed where it
    // can be seen: `server.ts`'s `onRoute` hook refuses to build an app
    // containing such a route, so the pair of guards is total rather than one
    // guard and one claim.
  });

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    // Pre-logger boot failure: stderr + non-zero exit is the contract. The
    // Fastify logger does not exist yet at this point.
    process.stderr.write(`Invalid environment — refusing to boot:\n${issues}\n`);
    process.exit(1);
  }
  return parsed.data;
}

export const env = loadEnv();

/**
 * The resolved `X-Dev-Principal` bypass gate (Day-7a). Two layers:
 *
 *   1. `env.BYPASS_HEADER_ENABLED` — explicit env var (`'true'` / `'false'` /
 *      unset). Unset defaults to ON for `development` / `test`, OFF for
 *      `staging` / `production`.
 *   2. **Hard production override** — when `NODE_ENV === 'production'` the
 *      bypass is always OFF, regardless of (1). Belt-and-suspenders so a
 *      misconfigured prod env can never accidentally honor the header.
 *
 * Exported as a boolean so callers don't redo the logic. The `authenticate`
 * preHandler closes over this at module load via `makeAuthenticate`.
 */
function resolveBypassHeaderEnabled(): boolean {
  if (env.NODE_ENV === 'production') return false;
  if (env.BYPASS_HEADER_ENABLED !== undefined) return env.BYPASS_HEADER_ENABLED;
  return env.NODE_ENV === 'development' || env.NODE_ENV === 'test';
}

export const bypassHeaderEnabled = resolveBypassHeaderEnabled();
