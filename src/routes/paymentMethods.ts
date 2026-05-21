import type { FastifyInstance } from 'fastify';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import {
  paymentMethodsRepository,
  type PaymentMethodRow,
} from '../db/repositories/paymentMethodsRepository.js';

/**
 * `GET /payment-methods` `[auth]` — owner's stored cards (DATA-CONTRACT §C
 * payments + §B PaymentMethod). Owner-scoped through `payment_methods.
 * owner_id`; staff principals get an empty list (staff have no cards-of-
 * record in this surface — Day-9 mutations are owner-only too).
 *
 * Wire shape is the flat 7-key row from the FE's
 * `paymentMethodRepository.ts` Raw type. No wire helper needed at one
 * call site with no optional keys; promote to `lib/paymentMethodWire.ts`
 * if Day-9 mutations need to emit the same shape (rule-of-two).
 */

export interface PaymentMethodWire {
  id: string;
  brand: string;
  last4: string;
  exp_month: number;
  exp_year: number;
  cardholder_name: string;
  is_default: boolean;
}

export function registerPaymentMethodsRoute(
  app: FastifyInstance,
  opts: AuthRouteOptions = {},
): void {
  const authHook = resolveAuthHook(opts);

  app.get(
    '/payment-methods',
    { preHandler: [authHook] },
    async (request): Promise<PaymentMethodWire[]> => {
      const principal = requirePrincipal(request);
      if (principal.kind !== 'owner') return [];
      const rows = await paymentMethodsRepository.findLiveByOwner(principal.ownerId);
      return rows.map(toPaymentMethodWire);
    },
  );
}

function toPaymentMethodWire(row: PaymentMethodRow): PaymentMethodWire {
  return {
    id: row.id,
    brand: row.brand,
    last4: row.last4,
    exp_month: row.expMonth,
    exp_year: row.expYear,
    cardholder_name: row.cardholderName,
    is_default: row.isDefault,
  };
}
