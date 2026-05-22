import type { FastifyInstance } from 'fastify';
import { resolveAuthHook, type AuthRouteOptions } from '../auth/plugin.js';
import { requiredVaccinesRepository } from '../db/repositories/requiredVaccinesRepository.js';
import type { serviceCategory } from '../db/schema/schema.js';

/**
 * `GET /required-vaccines` `[auth]` — the gating-vaccine catalog the FE reads
 * to show owners which shots are missing/expired BEFORE attempting a gated
 * booking (DATA-CONTRACT §C, §H). Read-only, no principal scoping (catalog
 * is shared across all owners); `live(required_vaccines)` excludes retired
 * requirements.
 *
 * Wire per §C: `{ key, label, gates_categories: ServiceCategory[] }`. Ordered
 * by key for snapshot stability; no pagination (catalog is small — a handful
 * of rows).
 *
 * Day-9d: data access moved to `requiredVaccinesRepository.findAllLive`
 * so this file no longer reads Drizzle directly. The same repo's
 * `keyIsLive` powers the Day-9d vaccine `requirement_key` FK guard.
 */

type ServiceCategory = (typeof serviceCategory.enumValues)[number];

interface RequiredVaccineWire {
  key: string;
  label: string;
  gates_categories: ServiceCategory[];
}

export function registerRequiredVaccinesRoute(
  app: FastifyInstance,
  opts: AuthRouteOptions = {},
): void {
  const authHook = resolveAuthHook(opts);

  app.get(
    '/required-vaccines',
    { preHandler: [authHook] },
    async (): Promise<RequiredVaccineWire[]> => {
      const rows = await requiredVaccinesRepository.findAllLive();
      return rows.map((row) => ({
        key: row.key,
        label: row.label,
        gates_categories: row.gatesCategories,
      }));
    },
  );
}
