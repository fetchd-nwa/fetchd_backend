import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../env.js';
import { ApiError } from '../lib/errors.js';

/**
 * Standard Webhooks signature verification (the scheme Supabase Auth Hooks
 * emit). Three headers — `webhook-id`, `webhook-timestamp` (unix seconds),
 * `webhook-signature` (space-delimited `v1,<base64>` list, multiple for key
 * rotation). Signed content is `${id}.${timestamp}.${rawBody}` — the raw body
 * bytes, never a re-serialized JSON (whitespace would change the HMAC).
 *
 * Two attacks are closed here, deliberately:
 * - **Tamper:** HMAC-SHA256 over id+timestamp+body, timing-safe compared.
 * - **Replay:** a stale `webhook-timestamp` (outside ±5 min) is rejected even
 *   if its signature is valid.
 *
 * Isolated on purpose: if Supabase is wired as a Database Webhook (static
 * header secret) instead of an auth hook, this is the only file that changes.
 */
const TOLERANCE_SECONDS = 300;

function signingKey(secret: string): Buffer {
  // `whsec_<base64>` is the Standard Webhooks secret form; the key is the
  // base64-decoded tail. A bare secret is taken as raw bytes.
  const body = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  return Buffer.from(body, 'base64');
}

export interface WebhookSignatureHeaders {
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
}

/**
 * Factory so the secret + clock are injectable: prod binds the env secret and
 * the real clock; tests bind a known secret and a fixed `now` to exercise the
 * replay window without sleeping.
 */
export function makeVerifyWebhook(
  secret: string,
  now: () => number = Date.now,
): (headers: WebhookSignatureHeaders, rawBody: string) => void {
  const key = signingKey(secret);

  return (headers, rawBody) => {
    const { id, timestamp, signature } = headers;
    if (!id || !timestamp || !signature) {
      throw new ApiError('unauthenticated', 'missing webhook signature headers');
    }

    const ts = Number(timestamp);
    if (!Number.isFinite(ts)) {
      throw new ApiError('unauthenticated', 'malformed webhook timestamp');
    }
    if (Math.abs(Math.floor(now() / 1000) - ts) > TOLERANCE_SECONDS) {
      throw new ApiError('unauthenticated', 'webhook timestamp outside tolerance (replay?)');
    }

    const expected = Buffer.from(
      createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`).digest('base64'),
    );
    const matches = signature.split(' ').some((part) => {
      const [version, sig] = part.split(',');
      if (version !== 'v1' || !sig) return false;
      const provided = Buffer.from(sig);
      return provided.length === expected.length && timingSafeEqual(provided, expected);
    });
    if (!matches) {
      throw new ApiError('unauthenticated', 'webhook signature mismatch');
    }
  };
}

/** Production verifier — bound to the env secret + real clock. */
export const verifyWebhook = makeVerifyWebhook(env.SUPABASE_AUTH_WEBHOOK_SECRET);
