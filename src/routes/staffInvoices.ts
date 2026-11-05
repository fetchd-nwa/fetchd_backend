import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import type { ParkedInvoiceWire, StaffInvoiceWire } from '../contracts/wire.js';
import { invoicesRepository, type InvoiceRow } from '../db/repositories/invoicesRepository.js';
import { staffBillingRepository } from '../db/repositories/staffBillingRepository.js';
import { pgTimestampToIso } from '../lib/pgTimestamp.js';
import { requireStaff } from '../lib/principalNarrows.js';
import { ApiError } from '../lib/errors.js';
import { callerMayRefund, toStaffInvoiceWires } from '../lib/staffBilling.js';
import { uuidId } from '../lib/uuidId.js';
import { parseOrThrow } from '../lib/zodIssues.js';
import { MAX_AUTO_CHARGE_ATTEMPTS } from '../workers/invoiceAutoCharge.js';

/**
 * `GET /staff/invoices?parked` `[staff]` — the staff worklist of PARKED
 * invoices (credit-expiry Phase 3). Mirrors `staffCancelWindow` /
 * `staffCreditExpiry` (requireStaff, owner -> 403, inline wire type — NOT
 * portal-mirrored yet).
 *
 * A PARKED invoice is still `status='open'` but the auto-charge worker has
 * exhausted its retries (`auto_charge_attempts >= MAX_AUTO_CHARGE_ATTEMPTS`,
 * `next_attempt_at` now NULL). The worker auto-charges and dunns with backoff;
 * once it parks, only a human can resolve it (chase the owner for a new card,
 * void the invoice, etc). This surface is that worklist.
 *
 * `?parked` is REQUIRED today — a parked-only worklist is the single use case
 * in scope; a general invoice list isn't built. Omitting it is a 400 so the
 * contract stays honest rather than silently returning everything.
 *
 * Wire shape per row:
 *   { id, owner_id, amount_cents, status, purpose, dog_id, due_at,
 *     auto_charge_attempts }
 *
 * `GET /staff/invoices/:id` `[staff]` (P03, STAFF-U13, wire 2.0.0) — one
 * invoice as staff read it (`StaffInvoiceWire`), any staff role: `payments`
 * only for a caller with `refund_money`. A malformed id is 400, an unknown one
 * 404, an owner principal 403. A static `/staff/invoices` and a parametric
 * `/staff/invoices/:id` are distinct routes: the parked list is untouched.
 */

const invoiceParamSchema = z.object({ id: uuidId('id must be a UUID') }).strict();

const querySchema = z
  .object({
    // Flag param: present (any value, incl. empty `?parked`) = parked filter on.
    parked: z.string().optional(),
  })
  .strict();

function toWire(row: InvoiceRow): ParkedInvoiceWire {
  return {
    id: row.id,
    owner_id: row.ownerId,
    amount_cents: row.amountCents,
    status: row.status,
    purpose: row.purpose,
    dog_id: row.dogId,
    due_at: pgTimestampToIso(row.dueAt),
    auto_charge_attempts: row.autoChargeAttempts,
  };
}

export function registerStaffInvoicesRoute(
  app: FastifyInstance,
  opts: AuthRouteOptions = {},
): void {
  const authHook = resolveAuthHook(opts);

  app.get(
    '/staff/invoices',
    { preHandler: [authHook] },
    async (request): Promise<ParkedInvoiceWire[]> => {
      const principal = requirePrincipal(request);
      requireStaff(principal, 'read the parked-invoice worklist');
      const query = parseOrThrow(querySchema, request.query, 'query');
      if (query.parked === undefined) {
        // Only the parked worklist is in scope; refuse an unscoped list rather
        // than silently dumping every invoice.
        throw new ApiError('bad_request', 'the `parked` query parameter is required');
      }
      const rows = await invoicesRepository.findParked({ minAttempts: MAX_AUTO_CHARGE_ATTEMPTS });
      return rows.map(toWire);
    },
  );

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
