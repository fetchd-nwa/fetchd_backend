import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Equal, Expect } from '../contracts/typeAsserts.js';
import {
  requireStaffRole,
  resolveAuthHook,
  requirePrincipal,
  type AuthRouteOptions,
} from '../auth/plugin.js';
import type {
  GetStaffOwnersBookingsQuery,
  GetStaffOwnersBookingsResponse,
  GetStaffOwnersInvoicesResponse,
  GetStaffOwnersPaymentMethodsResponse,
  GetStaffOwnersPaymentsResponse,
  GetStaffOwnersResponse,
} from '../contracts/wire.js';
import { bookingsRepository } from '../db/repositories/bookingsRepository.js';
import { ownersRepository } from '../db/repositories/ownersRepository.js';
import { paymentMethodsRepository } from '../db/repositories/paymentMethodsRepository.js';
import { staffBillingRepository } from '../db/repositories/staffBillingRepository.js';
import { ApiError } from '../lib/errors.js';
import { requireStaff } from '../lib/principalNarrows.js';
import { isValidCalendarDate } from '../lib/chicagoDate.js';
import { callerMayRefund, staffPaymentHistory, toStaffInvoiceWires } from '../lib/staffBilling.js';
import { wireManyBookings } from '../lib/wireManyBookings.js';
import { uuidId } from '../lib/uuidId.js';
import { parseOrThrow } from '../lib/zodIssues.js';
import { toPaymentMethodWire } from './paymentMethods.js';

/**
 * The staff reads of one family (P03, wire 2.0.0):
 *
 *   GET /staff/owners                      any staff role — the owner picker
 *                                          (`StaffOwnerWire`; §1.1:718-719)
 *   GET /staff/owners/:id/invoices         any staff role (STAFF-U13)
 *   GET /staff/owners/:id/payments         owner and manager (STAFF-U13)
 *   GET /staff/owners/:id/payment-methods  owner and manager (STAFF-U13)
 *   GET /staff/owners/:id/bookings?from=   any staff role — the profile's *Bookings*
 *                                          (6.0.0-lg5.2; CXL-U04, D8, s17); the wire
 *                                          spells the param `:ownerId`, the same segment
 *                                          the siblings call `:id`
 *
 * (`GET /staff/invoices/:id` is in `staffInvoices.ts`.)
 * An owner (family) principal is 403 `forbidden` on every one. A malformed
 * `:id` is 400 `bad_request`; an id naming no `owners` row is 404 `not_found`;
 * an expired family resolves, because invoices, charges and refunds are
 * retained financial records. On the two owner-and-manager routes the role
 * guard runs as a preHandler, so a trainer's 403 comes before `:id` is parsed
 * or looked up and says nothing about the family (wire contract notes J8).
 * The owner picker has no money field; the history and the cards are what a
 * trainer may not see (04- item 128).
 */

const ownerParamSchema = z.object({ id: uuidId('id must be a UUID') }).strict();

/** `GetStaffOwnersBookingsQuery`: `from` required, a real Chicago calendar day; any other
 *  key is 400 (strict). Pinned to the wire below. */
const ownerBookingsQuerySchema = z
  .object({
    from: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD')
      .refine(isValidCalendarDate, 'not a real calendar date'),
  })
  .strict();

export type GetStaffOwnersBookingsQueryConformance = Expect<
  Equal<z.input<typeof ownerBookingsQuerySchema>, GetStaffOwnersBookingsQuery>
>;

/** The profile's reads, on an injectable clock: `can_cancel` is the cancels' own. */
export interface StaffOwnersRouteOptions extends AuthRouteOptions {
  now?: () => Date;
}

async function ownerIdOf(params: unknown): Promise<string> {
  const { id } = parseOrThrow(ownerParamSchema, params, 'path');
  if (!(await ownersRepository.exists(id))) throw new ApiError('not_found', 'no such owner');
  return id;
}

export function registerStaffOwnersRoute(
  app: FastifyInstance,
  opts: StaffOwnersRouteOptions = {},
): void {
  const authHook = resolveAuthHook(opts);
  const nowFactory = opts.now ?? ((): Date => new Date());
  const ownerOrManager = requireStaffRole('owner', 'manager');

  app.get(
    '/staff/owners',
    { preHandler: [authHook] },
    async (request): Promise<GetStaffOwnersResponse> => {
      requireStaff(requirePrincipal(request), 'read the owner list');
      return ownersRepository.findLiveForStaff();
    },
  );

  // The profile's *Bookings*: every live day-school and day-care session of the family from
  // `from` on, soonest first, each a staff read (`can_cancel` and `dog_shares[].can_cancel`
  // the staff cancels' own, the owner's one-dog switch ignored), on this route's clock.
  // `:id` is lowercased at the parse, before the lookup. No `Idempotency-Key`: a read.
  app.get(
    '/staff/owners/:id/bookings',
    { preHandler: [authHook] },
    async (request): Promise<GetStaffOwnersBookingsResponse> => {
      const principal = requirePrincipal(request);
      requireStaff(principal, "read a family's bookings");
      const ownerId = await ownerIdOf(request.params);
      const { from } = parseOrThrow(ownerBookingsQuerySchema, request.query, 'query');
      const rows = await bookingsRepository.findOwnerDaySessionsFrom(ownerId, from);
      return wireManyBookings(rows, { now: nowFactory(), viewer: 'staff' });
    },
  );

  app.get(
    '/staff/owners/:id/invoices',
    { preHandler: [authHook] },
    async (request): Promise<GetStaffOwnersInvoicesResponse> => {
      const principal = requirePrincipal(request);
      requireStaff(principal, "read a family's invoices");
      const ownerId = await ownerIdOf(request.params);
      const [rows, refundMoney] = await Promise.all([
        staffBillingRepository.invoicesByOwner(ownerId),
        callerMayRefund(principal.role),
      ]);
      return toStaffInvoiceWires(rows, refundMoney);
    },
  );

  app.get(
    '/staff/owners/:id/payments',
    { preHandler: [authHook, ownerOrManager] },
    async (request): Promise<GetStaffOwnersPaymentsResponse> => {
      return staffPaymentHistory(await ownerIdOf(request.params));
    },
  );

  app.get(
    '/staff/owners/:id/payment-methods',
    { preHandler: [authHook, ownerOrManager] },
    async (request): Promise<GetStaffOwnersPaymentMethodsResponse> => {
      const rows = await paymentMethodsRepository.findLiveByOwner(await ownerIdOf(request.params));
      return rows.map(toPaymentMethodWire);
    },
  );
}
