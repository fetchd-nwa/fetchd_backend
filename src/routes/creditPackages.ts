import type { FastifyInstance } from 'fastify';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import { creditPackagesRepository } from '../db/repositories/creditPackagesRepository.js';
import type { bookingMode } from '../db/schema/schema.js';

type BookingMode = (typeof bookingMode.enumValues)[number];

/**
 * `GET /credit-packages` `[auth]` — the active catalog of purchasable
 * credit packs (DATA-CONTRACT §B CreditPackage Δ 2026-05-20).
 *
 * Catalog endpoint: both owner and staff principals get the same data
 * (rates + packages are reference data, not user data). Retirement is
 * `active = false` on the row — never DELETE; the wire filter is
 * server-side so retired packs never surface even if a stale client
 * caches one.
 */

export interface CreditPackageWire {
  key: string;
  mode: BookingMode;
  credits: number;
  price_cents: number;
  label: string;
  is_popular: boolean;
}

export function registerCreditPackagesRoute(
  app: FastifyInstance,
  opts: AuthRouteOptions = {},
): void {
  const authHook = resolveAuthHook(opts);

  app.get(
    '/credit-packages',
    { preHandler: [authHook] },
    async (request): Promise<CreditPackageWire[]> => {
      requirePrincipal(request); // any authenticated principal; catalog is shared
      return creditPackagesRepository.findActive();
    },
  );
}
