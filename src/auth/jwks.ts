import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { env } from '../env.js';
import { ApiError } from '../lib/errors.js';

/**
 * Supabase signs access tokens with an asymmetric key (Day-0 lock #2: JWKS,
 * never a shared HS secret). We verify signature + `exp`/`nbf` + `iss` + `aud`
 * against Supabase's published JWKS.
 *
 * `algorithms` is pinned to the asymmetric set and **must never include HS\***:
 * with a JWKS, accepting HS256 is the classic algorithm-confusion attack — an
 * attacker signs `alg:HS256` using the *public* key bytes as the HMAC secret.
 * Pinning the allow-list shuts that off at the door.
 */
const ALLOWED_ALGS = ['RS256', 'ES256', 'EdDSA'] as const;

export interface VerifiedToken {
  /** Supabase Auth user id — the key into the `owners`/`staff` mirror rows. */
  sub: string;
}

/**
 * Factory so the verifier's key source is injectable: prod binds the remote
 * JWKS; tests bind a local key set (no live Supabase project needed). The
 * remote set caches keys in-memory with rotation + a refresh cooldown — that
 * *is* the Day-0 "keys cached" requirement, no hand-rolled cache.
 */
export function makeVerifyAccessToken(
  getKey: JWTVerifyGetKey,
): (token: string) => Promise<VerifiedToken> {
  return async (token) => {
    let sub: string | undefined;
    try {
      const { payload } = await jwtVerify(token, getKey, {
        issuer: env.SUPABASE_JWT_ISS,
        audience: env.SUPABASE_JWT_AUD,
        algorithms: [...ALLOWED_ALGS],
      });
      sub = payload.sub;
    } catch (err) {
      // Every jose failure mode (expired, bad signature, no matching key,
      // iss/aud mismatch) collapses to one client-facing category: the token
      // is not acceptable. The specific cause stays in the message for logs,
      // never leaks to the caller.
      const detail = err instanceof Error ? err.message : 'unknown';
      throw new ApiError('unauthenticated', `token verification failed: ${detail}`);
    }

    if (typeof sub !== 'string' || sub.length === 0) {
      throw new ApiError('unauthenticated', 'token has no subject');
    }
    return { sub };
  };
}

/** Production verifier — bound to Supabase's remote, self-caching JWKS. */
export const verifyAccessToken = makeVerifyAccessToken(
  createRemoteJWKSet(new URL(env.SUPABASE_JWKS_URL)),
);
