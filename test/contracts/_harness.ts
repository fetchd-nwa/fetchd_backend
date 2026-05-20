import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type preHandlerHookHandler } from 'fastify';
import { registerAuth } from '../../src/auth/plugin.js';
import type { Principal } from '../../src/auth/principal.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Build a Fastify app with the live `registerAuth` error mapper but a stubbed
 * `authenticate` that pins `request.principal` to the fixture identity. The
 * contract tests exercise the real request → handler → response path against
 * the live DB; the only thing stubbed is the JWKS verifier (its job is
 * confirmed end-to-end in `auth.test.ts` already).
 *
 * Wire shape under test:
 *   const { app, authenticate } = makeContractApp(principal);
 *   registerDogsRoute(app, { authenticate, now: FIXTURE_NOW });
 *   const res = await app.inject({ method: 'GET', url: '/dogs' });
 */
export interface ContractApp {
  app: FastifyInstance;
  authenticate: preHandlerHookHandler;
}

export function makeContractApp(principal: Principal): ContractApp {
  // Logger on so unhandled errors surface on stderr — the default `Fastify()`
  // silently swallows them and the test only sees a 500. Disable noisy
  // request-log lines; we want errors only.
  const app = Fastify({ logger: { level: 'error' } });
  registerAuth(app);
  const authenticate: preHandlerHookHandler = async (request) => {
    request.principal = principal;
  };
  return { app, authenticate };
}

/**
 * Load a snapshot JSON file from `test/contracts/snapshots/<name>.json`. The
 * snapshot is the frozen wire shape; `deepStrictEqual` against the inject()
 * response body is the regression net (DATA-CONTRACT §B's "byte-match"
 * intent — semantically equivalent JSON, not literal byte equality, since
 * JSON consumers ignore object-key order).
 */
export function loadSnapshot(name: string): unknown {
  const file = path.join(__dirname, 'snapshots', `${name}.json`);
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}
