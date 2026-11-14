import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePrincipal, resolveAuthHook, type AuthRouteOptions } from '../auth/plugin.js';
import { actorOf } from '../auth/principal.js';
import { requireRefundRole } from '../auth/requireRefundRole.js';
import type { Equal, Expect } from '../contracts/typeAsserts.js';
import type {
  GetStaffPaymentsRefundProposalResponse,
  PostStaffRefundsRequest,
  PostStaffRefundsResolveExternalRequest,
  RefundInstrument,
  RefundResolvedOutcome,
  RefundWire,
} from '../contracts/wire.js';
import { hashRequestBody, requireIdempotencyKey, withMutation } from '../db/mutation.js';
import { creditsInvalidationPattern } from '../db/repositories/creditsRepository.js';
import { refundsRepository } from '../db/repositories/refundsRepository.js';
import { ApiError } from '../lib/errors.js';
import { firePendingRefundPostCommit, type PendingStripeRefund } from '../lib/pendingRefund.js';
import { requireStaff } from '../lib/principalNarrows.js';
import {
  mintStaffRefund,
  refundProposal,
  refundWireOf,
  retryStaffRefund,
} from '../lib/staffRefunds.js';
import { defaultStripeClient, type StripeClient } from '../lib/stripe.js';
import { uuidId } from '../lib/uuidId.js';
import { parseOrThrow } from '../lib/zodIssues.js';

/**
 * The staff refund routes (P22, wire 6.0.0 § refunds; design §1.1:1094-1133,
 * §2.7:4163-4334; PAY-U24, PAY-U25, PAY-U27, PAY-U28, CRED-U18):
 *
 *   GET  /staff/payments/:id/refund-proposal   refund_money's rule
 *   POST /staff/refunds                        the list, or the any-role limit
 *   POST /staff/refunds/:id/retry              the list (Retry to card; bodyless)
 *   POST /staff/refunds/:id/resolve-external   the list (Returned)
 *
 * The order of answers (P22 brief): 401 → a family principal's 403 `forbidden` → a
 * malformed param, body or key 400 → 403 `refund_role_required` → lookups (404) → state
 * (409) → money (422). The POST's gate and every later refusal run inside `withMutation`,
 * after the claim, so a replay returns its stored body whatever has changed since (128(a)),
 * and a refusal leaves no claim, so the portal's same key can carry a corrected amount
 * (153). The claim's hash covers the caller (Fable L2): another staffer sending the same
 * key and body is 422 `idempotency_mismatch`, never handed the first staffer's 201.
 *
 * No staff refund sends the family a notice (design §2.9, :4324-4325): staff tell them.
 */

const paymentParamSchema = z.object({ id: uuidId('id must be a UUID') });

/** D14: `RefundInstrument` is a text CHECK, not a pgEnum, so its tuple is pinned here. */
const REFUND_INSTRUMENTS = ['original_card', 'cash', 'check'] as const;
export type RefundInstrumentConformance = Expect<
  Equal<(typeof REFUND_INSTRUMENTS)[number], RefundInstrument>
>;

/** `reason` is the hand edit's note bound, 1..500 (D11): it goes into the removal's note. */
const reasonSchema = z.string().min(1).max(500);

const refundBodySchema = z
  .object({
    payment_id: uuidId('payment_id must be a UUID'),
    amount_cents: z.number().int().positive(),
    instrument: z.enum(REFUND_INSTRUMENTS),
    reason: reasonSchema,
    credits_to_remove: z.number().int().nonnegative().optional(),
    enrollment_id: uuidId('enrollment_id must be a UUID').optional(),
  })
  .strict();

const refundParamSchema = z.object({ id: uuidId('id must be a UUID') });

/** Retry is BODYLESS: nothing, or an empty object, and never a field. */
const retryBodySchema = z.union([z.undefined(), z.null(), z.object({}).strict()]);

/** D14: `RefundResolvedOutcome` is a text CHECK, pinned here like the instrument. */
const RESOLVED_OUTCOMES = ['returned', 'withdrawn'] as const;
export type RefundResolvedOutcomeConformance = Expect<
  Equal<(typeof RESOLVED_OUTCOMES)[number], RefundResolvedOutcome>
>;

/** `note` is the human's evidence, 1..500 (D11), with a visible character in it. */
const noteSchema = z
  .string()
  .min(1)
  .max(500)
  .refine((note) => note.trim().length > 0, 'note must say something');

const resolveBodySchema = z
  .object({
    note: noteSchema,
    outcome: z.enum(RESOLVED_OUTCOMES).optional(),
    instrument: z.enum(['cash', 'check']).optional(),
  })
  .strict()
  // D10: nothing crossed the desk on a withdrawn close.
  .refine((body) => !(body.outcome === 'withdrawn' && body.instrument !== undefined), {
    message: 'instrument is recorded only when the money was returned',
    path: ['instrument'],
  });

export type PostStaffRefundsResolveExternalBodyConformance = Expect<
  Equal<z.input<typeof resolveBodySchema>, PostStaffRefundsResolveExternalRequest>
>;

/** Zod ↔ wire pins (design §5.1.3, `z.input`). */
export type PostStaffRefundsBodyConformance = Expect<
  Equal<z.input<typeof refundBodySchema>, PostStaffRefundsRequest>
>;

export interface StaffRefundsRouteOptions extends AuthRouteOptions {
  /** Stripe seam: the refund's create fires after commit. */
  stripe?: StripeClient;
  /** Injectable clock: "today" for the proposal's days booked ahead. */
  now?: () => Date;
}

export function registerStaffRefundsRoute(
  app: FastifyInstance,
  opts: StaffRefundsRouteOptions = {},
): void {
  const authHook = resolveAuthHook(opts);
  const stripe = opts.stripe ?? defaultStripeClient;
  const nowFactory = opts.now ?? ((): Date => new Date());

  app.get(
    '/staff/payments/:id/refund-proposal',
    { preHandler: [authHook] },
    async (request): Promise<GetStaffPaymentsRefundProposalResponse> => {
      const principal = requirePrincipal(request);
      requireStaff(principal, 'read a refund proposal');
      const { id } = parseOrThrow(paymentParamSchema, request.params, 'path');
      await requireRefundRole(principal.role, { kind: 'proposal' });
      return refundProposal({ paymentId: id, now: nowFactory() });
    },
  );

  app.post(
    '/staff/refunds',
    { preHandler: [authHook] },
    async (request, reply): Promise<RefundWire> => {
      const principal = requirePrincipal(request);
      requireStaff(principal, 'refund money');
      const body = parseOrThrow(refundBodySchema, request.body, 'body');
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
      let pending: PendingStripeRefund | undefined;
      let creditsOwnerId: string | undefined;

      const outcome = await withMutation<RefundWire>(
        {
          principal,
          idempotencyKey,
          endpoint: 'POST /staff/refunds',
          requestHash: hashRequestBody({ staff_id: principal.staffId, ...body }),
          patternsToInvalidate: () =>
            creditsOwnerId !== undefined ? [creditsInvalidationPattern(creditsOwnerId)] : [],
          postCommit: async (wire) => {
            await firePendingRefundPostCommit({
              pending,
              stripe,
              log: request.log,
              context: { refundPath: 'staff-refund', chargeId: wire.charge_id },
              actor: actorOf(principal),
            });
          },
        },
        async (tx) => {
          await requireRefundRole(
            principal.role,
            { kind: 'new-refund', amountCents: body.amount_cents },
            tx,
          );
          const minted = await mintStaffRefund(tx, {
            paymentId: body.payment_id,
            amountCents: body.amount_cents,
            instrument: body.instrument,
            reason: body.reason,
            creditsToRemove: body.credits_to_remove,
            enrollmentId: body.enrollment_id,
            staffId: principal.staffId,
            idempotencyKey,
            log: request.log,
          });
          pending = minted.pending;
          if (minted.creditsRemoved > 0) creditsOwnerId = minted.ownerId;
          return { status: 201, body: await refundWireOf(tx, minted.refundId) };
        },
      );

      reply.code(outcome.status);
      return outcome.body;
    },
  );

  app.post(
    '/staff/refunds/:id/retry',
    { preHandler: [authHook] },
    async (request, reply): Promise<RefundWire> => {
      const principal = requirePrincipal(request);
      requireStaff(principal, 'retry a refund');
      const { id } = parseOrThrow(refundParamSchema, request.params, 'path');
      parseOrThrow(retryBodySchema, request.body, 'body');
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
      let pending: PendingStripeRefund | undefined;

      // cache-noop: a retry writes no credit_ledger row (B-5; design.md §2.7's red-first "a Retry writes no
      // `credit_ledger` row"), and nothing caches a charge or a refund (cache.ts:28-36).
      const outcome = await withMutation<RefundWire>(
        {
          principal,
          idempotencyKey,
          endpoint: 'POST /staff/refunds/:id/retry',
          requestHash: hashRequestBody({ staff_id: principal.staffId, id }),
          postCommit: async (wire) => {
            await firePendingRefundPostCommit({
              pending,
              stripe,
              log: request.log,
              context: { refundPath: 'staff-retry', chargeId: wire.charge_id, retryOf: id },
              actor: actorOf(principal),
            });
          },
        },
        async (tx) => {
          await requireRefundRole(principal.role, { kind: 'chain' }, tx);
          const retried = await retryStaffRefund(tx, {
            refundId: id,
            staffId: principal.staffId,
            idempotencyKey,
          });
          pending = retried.pending;
          return { status: 201, body: await refundWireOf(tx, retried.refundId) };
        },
      );

      reply.code(outcome.status);
      return outcome.body;
    },
  );

  app.post(
    '/staff/refunds/:id/resolve-external',
    { preHandler: [authHook] },
    async (request): Promise<RefundWire> => {
      const principal = requirePrincipal(request);
      requireStaff(principal, 'close a refund');
      const { id } = parseOrThrow(refundParamSchema, request.params, 'path');
      const body = parseOrThrow(resolveBodySchema, request.body, 'body');
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
      let creditsOwnerId: string | undefined;

      const outcome = await withMutation<RefundWire>(
        {
          principal,
          idempotencyKey,
          endpoint: 'POST /staff/refunds/:id/resolve-external',
          requestHash: hashRequestBody({ staff_id: principal.staffId, id, ...body }),
          patternsToInvalidate: () =>
            creditsOwnerId !== undefined ? [creditsInvalidationPattern(creditsOwnerId)] : [],
        },
        async (tx) => {
          await requireRefundRole(principal.role, { kind: 'chain' }, tx);
          const result = await refundsRepository.markResolvedExternal(tx, {
            id,
            note: body.note,
            staffId: principal.staffId,
            ...(body.outcome !== undefined ? { outcome: body.outcome } : {}),
            ...(body.instrument !== undefined ? { instrument: body.instrument } : {}),
          });
          switch (result.kind) {
            case 'resolved':
              if (result.creditsReturned > 0) creditsOwnerId = result.ownerId;
              return { status: 200, body: await refundWireOf(tx, id) };
            case 'not_found':
              throw new ApiError('not_found', `refund ${id} not found`);
            case 'wrong_status':
              throw new ApiError('conflict', `refund ${id} is not a failed or unroutable refund`);
            case 'superseded':
              throw new ApiError(
                'refund_superseded',
                `refund ${id} has been retried; close its retry`,
              );
            case 'in_flight':
              throw new ApiError('refund_in_flight', 'a refund on this payment is still pending');
            case 'instrument_required':
              throw new ApiError(
                'bad_request',
                'say how the money went back: instrument cash or check is required on a card refund closed as returned',
              );
            case 'over_remainder':
              throw new ApiError('over_cap', 'this payment has less left to return than that');
          }
        },
      );

      return outcome.body;
    },
  );
}
