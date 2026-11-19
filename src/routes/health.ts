import type { FastifyInstance } from 'fastify';
import { pingDb, pool } from '../db/pool.js';
import { pingRedis } from '../redis.js';

type CheckState = 'ok' | 'down';

/** Whether the schema carries what this code needs (brief LR1; CR23: exactly two values). */
type SchemaState = 'ok' | 'behind';

interface HealthBody {
  status: 'ok' | 'degraded';
  time: string;
  uptime_s: number;
  checks: { db: CheckState; redis: CheckState; schema: SchemaState };
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
 * Does the database carry rs3 (O-MSG-LIVE; brief LR1, which replaces A2 OM4 and
 * DECISIONS 598(1))? Read from the schema itself, never from `migrations_applied`:
 * a database born from `schema.sql` (the suite's, a fresh dev load, production's
 * first day) has an empty ledger, and a later unit's step makes it non-empty
 * without M5.30, so the ledger answers wrongly both ways. `message_pushes` implies
 * M5.26–M5.29 (the Opus seat); `device_tokens_live_token_uidx` is M5.30's LAST
 * object (the Fable seat), so both present means the whole group is applied.
 * The index is read from the catalog, not by name alone (p2a fix 1, the audit's
 * N1): it must be UNIQUE and partial on `expired_at IS NULL`, the shape that keeps
 * one live row per token; an index of that name in any other shape is `behind`.
 * Anything else, a failed read included, is `behind`: never `ok` on an unknown.
 */
async function probeSchema(): Promise<SchemaState> {
  try {
    const { rows } = await pool.query<{ ready: boolean }>(
      `SELECT to_regclass('public.message_pushes') IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM pg_index i
             WHERE i.indexrelid = to_regclass('public.device_tokens_live_token_uidx')
               AND i.indisunique
               AND pg_get_expr(i.indpred, i.indrelid) = '(expired_at IS NULL)'
          ) AS ready`,
    );
    return rows[0]?.ready === true ? 'ok' : 'behind';
  } catch {
    return 'behind';
  }
}

/**
 * `GET /health` `[public]` — unauthenticated liveness + dependency probe.
 *
 * The wire shape is NOT frozen in DATA-CONTRACT (it lists the endpoint only),
 * so this shape is a Day-1 design choice, not a contract amendment. 200 when
 * Postgres and Redis both answer AND the schema carries rs3 (`checks.schema:
 * 'ok'`); 503 (`degraded`) otherwise, so an uptime monitor / load balancer can
 * depend on the status code alone. Railway's healthcheck reads this route
 * (`railway.json` `healthcheckPath`), so new code on an old schema never takes
 * traffic: the old deployment stays live until rs3 is applied (brief LR1, LR4).
 */
export function registerHealthRoute(app: FastifyInstance): void {
  app.get('/health', async (_request, reply) => {
    const [db, redis, schema] = await Promise.all([
      probe(pingDb),
      probe(pingRedis),
      probeSchema(),
    ]);
    const isHealthy = db === 'ok' && redis === 'ok' && schema === 'ok';

    const body: HealthBody = {
      status: isHealthy ? 'ok' : 'degraded',
      time: new Date().toISOString(),
      uptime_s: Math.round(process.uptime()),
      checks: { db, redis, schema },
    };

    return reply.code(isHealthy ? 200 : 503).send(body);
  });
}
