import type { FastifyInstance } from 'fastify';
import { pingDb } from '../db/pool.js';
import { pingRedis } from '../redis.js';

type CheckState = 'ok' | 'down';

interface HealthBody {
  status: 'ok' | 'degraded';
  time: string;
  uptime_s: number;
  checks: { db: CheckState; redis: CheckState };
}

async function probe(check: () => Promise<void>): Promise<CheckState> {
  try {
    await check();
    return 'ok';
  } catch {
    return 'down';
  }
}

/**
 * `GET /health` `[public]` — unauthenticated liveness + dependency probe.
 *
 * The wire shape is NOT frozen in DATA-CONTRACT (it lists the endpoint only),
 * so this shape is a Day-1 design choice, not a contract amendment. 200 when
 * Postgres and Redis both answer; 503 (`degraded`) if either is down, so an
 * uptime monitor / load balancer can depend on the status code alone.
 */
export function registerHealthRoute(app: FastifyInstance): void {
  app.get('/health', async (_request, reply) => {
    const [db, redis] = await Promise.all([probe(pingDb), probe(pingRedis)]);
    const isHealthy = db === 'ok' && redis === 'ok';

    const body: HealthBody = {
      status: isHealthy ? 'ok' : 'degraded',
      time: new Date().toISOString(),
      uptime_s: Math.round(process.uptime()),
      checks: { db, redis },
    };

    return reply.code(isHealthy ? 200 : 503).send(body);
  });
}
