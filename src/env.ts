import 'dotenv/config';
import { z } from 'zod';

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

  // Redis — server-side cache + rate limit + sessions.
  REDIS_URL: z.string().url(),

  // Supabase Auth — JWKS verify (Day-0 lock #2). Reserved; wired Day 2.
  SUPABASE_JWKS_URL: z.string().url(),
  SUPABASE_JWT_AUD: z.string().min(1),
  SUPABASE_JWT_ISS: z.string().url(),

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
