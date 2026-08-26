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
        // D20-A4 §A4.2 — the comment that stood here claimed a body that isn't
        // JSON "still gets a 400 here". **It did not, and that was proven by
        // execution, not by reading**: a BARE `Error` carries no `statusCode`,
        // so `auth/plugin.ts`'s mapper computed 500 and logged at error —
        // which, since the Day-20 tap, PAGES A HUMAN. An 854-injection sweep
        // across all 178 route entries found exactly four such reachable spots:
        // this route and `/webhooks/stripe`, on malformed-JSON and empty-body,
        // worth 43,200 events/month against a 5,000/month tier from an
        // anonymous `curl`. A client's malformed JSON is not our error (D20-A2
        // §A2.1(a)'s reasoning, simply not carried here). The signature is
        // still checked first in the handler for every body that DOES parse.
        done(Object.assign(new Error('invalid JSON body'), { statusCode: 400 }), undefined);
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
