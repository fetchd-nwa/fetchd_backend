import cors from '@fastify/cors';
import type { FastifyInstance } from 'fastify';

/**
 * CORS for the staff portal (S01; design §2.10, design.md:4674-4677;
 * DECISIONS 49 — §2.10's grant, not §2.1's "credentials on").
 *
 * The portal runs on its own origin and sends its Supabase bearer in the
 * `Authorization` header, plus `Idempotency-Key` on every mutation, so every
 * call it makes is preflighted. This answers those preflights for the
 * allow-listed origins only, and echoes the one matching origin (never `*`).
 *
 * No `credentials` flag: the bearer is a header, not a cookie, so nothing the
 * portal sends needs `Access-Control-Allow-Credentials`, and off is the
 * narrower grant. The mobile app is not a browser and is unaffected.
 */
export const CORS_METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] as const;
export const CORS_ALLOWED_HEADERS = ['Authorization', 'Idempotency-Key', 'Content-Type'] as const;

export function registerCors(app: FastifyInstance, allowedOrigins: readonly string[]): void {
  void app.register(cors, {
    // An empty list allows no cross-origin caller at all (`env.PORTAL_ORIGIN` unset).
    origin: allowedOrigins.length === 0 ? false : [...allowedOrigins],
    methods: [...CORS_METHODS],
    allowedHeaders: [...CORS_ALLOWED_HEADERS],
    credentials: false,
  });
}
