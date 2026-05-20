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
if (process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'staging') {
  dotenvConfig();
}

/**
 * The full Day-1 environment contract. Every var is required: the contract is
 * locked once here so later days don't each re-litigate it (Stripe/R2 are
 * reserved now, exercised Day 14/17). A missing or malformed value fails the
 * process fast — there is no half-booted server. See `.env.example`.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Postgres — Supabase's bundled Postgres, app-owned access (Day-0 lock #3).
  DATABASE_URL: z.string().url(),
  // Path to the CA cert that signed the Postgres server cert. Supabase's
  // direct connection uses Supabase's own CA (not in Node's trust store), so
  // this is required there for verified TLS. Optional: unset = no explicit CA
  // (a plaintext/locally-trusted Postgres, e.g. a bare local dev container).
  DATABASE_SSL_CA: z.string().min(1).optional(),

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

  // Cloudflare R2 — private media. Reserved; wired Day 17.
  R2_ACCOUNT_ID: z.string().min(1),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
  R2_BUCKET: z.string().min(1),
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
