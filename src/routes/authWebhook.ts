import type { FastifyInstance } from 'fastify';
import { provisionFromWebhook } from '../auth/provisioning.js';
import { verifyWebhook } from '../auth/webhookSignature.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Raw request body, preserved only inside the webhook scope for HMAC. */
    rawBody?: string;
  }
}

type Verify = typeof verifyWebhook;

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * `POST /auth/webhook` `[public, signed]` — Supabase "user created" → upsert
 * the mirror row. Registered in its own encapsulated scope so the raw-body
 * content-type parser (the HMAC needs the exact received bytes, not a
 * re-serialized JSON) applies to *this route only* — `/me` and `/health`
 * keep Fastify's default JSON parsing.
 *
 * `verify` is injectable so the route is testable without the env secret.
 */
export function registerAuthWebhook(app: FastifyInstance, verify: Verify = verifyWebhook): void {
  app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
      request.rawBody = typeof body === 'string' ? body : body.toString('utf8');
      try {
        done(null, JSON.parse(request.rawBody));
      } catch {
        // Signature is checked first in the handler regardless; a body that
        // isn't JSON still gets a 400 here, before any work.
        done(new Error('invalid JSON body'), undefined);
      }
    });

    scope.post('/auth/webhook', async (request, reply) => {
      verify(
        {
          id: firstHeader(request.headers['webhook-id']),
          timestamp: firstHeader(request.headers['webhook-timestamp']),
          signature: firstHeader(request.headers['webhook-signature']),
        },
        request.rawBody ?? '',
      );
      const result = await provisionFromWebhook(request.body);
      request.log.info({ result }, 'auth webhook provisioned mirror row');
      return reply.code(200).send({ ok: true });
    });
  });
}
