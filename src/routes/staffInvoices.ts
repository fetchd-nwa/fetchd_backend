import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import type { StaffInvoiceWire } from '../contracts/wire.js';
import { staffBillingRepository } from '../db/repositories/staffBillingRepository.js';
import { requireStaff } from '../lib/principalNarrows.js';
import { ApiError } from '../lib/errors.js';
import { callerMayRefund, toStaffInvoiceWires } from '../lib/staffBilling.js';
import { uuidId } from '../lib/uuidId.js';
import { parseOrThrow } from '../lib/zodIssues.js';

/**
 * `GET /staff/invoices/:id` `[staff]` (P03, STAFF-U13, wire 2.0.0) — one
 * invoice as staff read it (`StaffInvoiceWire`), any staff role: `payments`
 * only for a caller with `refund_money`. A malformed id is 400, an unknown one
 * 404, an owner principal 403.
 *
 * No route answers the bare `/staff/invoices` until P24 (CASH-U03): the parked
 * worklist it used to serve left with the auto-charge lane at wire 5.0.0-lg4.1.
 */

const invoiceParamSchema = z.object({ id: uuidId('id must be a UUID') }).strict();

export function registerStaffInvoicesRoute(
  app: FastifyInstance,
  opts: AuthRouteOptions = {},
): void {
  const authHook = resolveAuthHook(opts);

  app.get(
    '/staff/invoices/:id',
    { preHandler: [authHook] },
    async (request): Promise<StaffInvoiceWire> => {
      const principal = requirePrincipal(request);
      requireStaff(principal, 'read an invoice');
      const { id } = parseOrThrow(invoiceParamSchema, request.params, 'path');
      const [row, refundMoney] = await Promise.all([
        staffBillingRepository.invoiceById(id),
        callerMayRefund(principal.role),
      ]);
      if (row === undefined) throw new ApiError('not_found', 'no such invoice');
      const [wire] = await toStaffInvoiceWires([row], refundMoney);
      if (wire === undefined) throw new Error('toStaffInvoiceWires returned no row for one');
      return wire;
    },
  );
}
