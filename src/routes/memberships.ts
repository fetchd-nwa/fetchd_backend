import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import { db } from '../db/client.js';
import { chargesRepository } from '../db/repositories/chargesRepository.js';
import { paymentMethodsRepository } from '../db/repositories/paymentMethodsRepository.js';
import { creditLedgerRepository } from '../db/repositories/creditLedgerRepository.js';
import {
  creditPackagesRepository,
  type CreditPackageWithId,
} from '../db/repositories/creditPackagesRepository.js';
import { dogProgramsRepository } from '../db/repositories/dogProgramsRepository.js';
import { dogsRepository } from '../db/repositories/dogsRepository.js';
import {
  membershipsRepository,
  type MembershipRow,
} from '../db/repositories/membershipsRepository.js';
import { refundsRepository } from '../db/repositories/refundsRepository.js';
import { withMembershipCreateLock } from '../db/locks.js';
import { LOCATION_SLUGS, type LocationKey } from '../db/schema/schema.js';
import type { BookingMode } from '../lib/bookingMode.js';
import { bucketChicagoToday } from '../lib/chicagoDate.js';
import { hashRequestBody, requireIdempotencyKey, withMutation } from '../db/mutation.js';
import { ApiError } from '../lib/errors.js';
import { loadStripePaymentContext } from '../lib/loadStripePaymentContext.js';
import { firstPeriod, membershipEndsAt } from '../lib/membershipBilling.js';
import type { PendingDuplicateRefund } from '../lib/settleInvoiceCharge.js';
import { pgTimestampToIso } from '../lib/pgTimestamp.js';
import { requireOwner } from '../lib/principalNarrows.js';
import {
  defaultStripeClient,
  stripeIntentStatusToChargeBlocker,
  type StripeClient,
} from '../lib/stripe.js';
import { formatZodIssues } from '../lib/zodIssues.js';

/**
 * §J.1 credit-package subscriptions (DATA-CONTRACT §J.1, ruled 2026-07-09).
 *
 *   POST   /memberships      `[auth, $]` — subscribe: month-1 charges
 *                            synchronously (same charge→grant path as a
 *                            package purchase), membership row created active.
 *   GET    /memberships      `[auth]` — the owner's subscriptions.
 *   DELETE /memberships/:id  `[auth]` — cancel (status flip; granted lots stay).
 *
 * Renewals are SELF-BILLED: the scheduler's roll phase creates a card-backed
 * `invoices` row per later month and the existing auto-charge lane settles it
 * (`settleInvoiceCharge` grants on the winning settle). NOT Stripe Billing —
 * `stripe_subscription_id` stays NULL.
 *
 * Month-1 v1 constraint: the POST requires a SYNCHRONOUSLY-succeeding charge.
 * A non-succeeded intent (3DS `requires_action`, `processing`) is cancelled
 * (best-effort) and the POST 422s — there is deliberately NO async-reconcile
 * arm for membership creation (the package-purchase webhook catch-up has no
 * membership branch, and charging a card with no membership created is
 * worse than asking for a different card). Flagged in §J as a v1 limit.
 *
 * Pause is staff-mediated only (§J.1) — no owner pause verb here; the FE
 * carries "reach out to staff to pause".
 *
 * Uniqueness (ruled 2026-07-16): one ACTIVE membership per (dog, mode) —
 * day-school + daycare may coexist on a dog; two of the same mode may not.
 * Enforced in three layers: a pre-Stripe probe (friendly 409 before money
 * moves), an in-tx re-check under `withMembershipCreateLock` (a concurrent
 * subscribe that slipped past both pre-checks during the Stripe round-trip
 * gets its duplicate charge refunded, settle-lost-race style, and receives
 * the winner's membership with `charge_refunded: true`), and the partial
 * unique index `memberships_one_active_per_dog_mode` as the constraint floor.
 */

export interface MembershipWire {
  id: string;
  dog_id: string;
  mode: BookingMode;
  location: LocationKey;
  package_key: string;
  package_label: string;
  credits_per_month: number;
  price_cents: number;
  term_months: number;
  status: 'active' | 'completed' | 'canceled';
  started_at: string;
  current_period_start: string;
  current_period_end: string;
  ends_at: string;
  /** Omit-on-null: present ⇒ staff-paused (rolls skip until staff resume). */
  paused_at?: string;
  /**
   * §J.1: the card this subscription's rolled invoices bill (memberships pin
   * their payment method at POST). Omitted when the bound card is no longer
   * live — the dunning lane owns that state, the list stays honest.
   */
  payment_method?: { brand: string; last4: string };
}

export interface MembershipCreateWire {
  membership: MembershipWire;
  charge_id: string;
  charge_status: 'succeeded';
  stripe_payment_intent_id: string;
  credits_granted: number;
  /**
   * True only on the uniqueness lost-race branch: a concurrent subscribe for
   * the same (dog, mode) won during THIS request's Stripe round-trip, so this
   * charge is a duplicate being refunded post-commit. `membership` then
   * carries the WINNER's row (the dog IS subscribed) and `credits_granted` is
   * 0 (only the winning charge granted). Mirrors the invoice-pay wire's
   * honest lost-race signal.
   */
  charge_refunded: boolean;
}

export function toMembershipWire(
  row: MembershipRow,
  pkg: CreditPackageWithId,
  paymentMethod?: { brand: string; last4: string },
): MembershipWire {
  const wire: MembershipWire = {
    id: row.id,
    dog_id: row.dogId,
    mode: row.mode,
    location: pkg.location,
    package_key: pkg.key,
    package_label: pkg.label,
    credits_per_month: pkg.credits,
    price_cents: pkg.price_cents,
    term_months: row.termMonths,
    status: row.status,
    started_at: pgTimestampToIso(row.startedAt),
    current_period_start: pgTimestampToIso(row.currentPeriodStart),
    current_period_end: pgTimestampToIso(row.currentPeriodEnd),
    ends_at: pgTimestampToIso(row.endsAt),
  };
  if (row.pausedAt !== null) wire.paused_at = pgTimestampToIso(row.pausedAt);
  if (paymentMethod !== undefined) {
    wire.payment_method = { brand: paymentMethod.brand, last4: paymentMethod.last4 };
  }
  return wire;
}

/**
 * Resolve the pinned package for a membership row. FK-protected (RESTRICT) —
 * a miss is corrupt state, not a 404.
 */
export async function loadMembershipPackage(
  membership: MembershipRow,
  runner: Parameters<typeof creditPackagesRepository.findById>[0] = db,
): Promise<CreditPackageWithId> {
  const pkg = await creditPackagesRepository.findById(runner, membership.packageId);
  if (pkg === undefined) {
    throw new Error(`memberships: credit package ${membership.packageId} not found`);
  }
  return pkg;
}

const idParamSchema = z.object({ id: z.string().uuid('id must be a UUID') });

const createBodySchema = z
  .object({
    dog_id: z.string().uuid('dog_id must be a UUID'),
    package_key: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9-]+$/i, 'package_key must be alphanumeric with dashes'),
    // package_key alone is ambiguous across locations (same catalog-key rule
    // as POST /credit-packages/:key/purchase) — the location pins the row.
    location: z.enum(LOCATION_SLUGS),
    term_months: z.union([z.literal(3), z.literal(6), z.literal(9), z.literal(12)]),
    payment_method_id: z.string().uuid('payment_method_id must be a UUID'),
  })
  .strict();

export interface MembershipsRouteOptions extends AuthRouteOptions {
  /** Stripe seam. Contract tests inject a stub. */
  stripe?: StripeClient;
  /** Injectable clock (period bounds + catalog effective-date lookup). */
  now?: () => Date;
}

export function registerMembershipsRoute(
  app: FastifyInstance,
  opts: MembershipsRouteOptions = {},
): void {
  const authHook = resolveAuthHook(opts);
  const stripe = opts.stripe ?? defaultStripeClient;
  const nowFactory = opts.now ?? ((): Date => new Date());

  // --- POST /memberships ------------------------------------------------
  // Stripe call OUTSIDE withMutation (project invariant — no network call
  // pins a pg tx). Same double-keyed retry safety as the purchase route:
  // the Idempotency-Key flows into Stripe AND the DB dedupe.
  app.post(
    '/memberships',
    { preHandler: [authHook] },
    async (request, reply): Promise<MembershipCreateWire> => {
      const principal = requirePrincipal(request);
      requireOwner(principal, 'start a membership');
      const body = parseCreateBody(request.body);
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
      const now = nowFactory();

      // ── Pre-Stripe validation (read-only; re-runs on retry by design) ──
      const pkg = await creditPackagesRepository.findByKey(
        db,
        body.package_key,
        body.location,
        bucketChicagoToday(now),
      );
      if (pkg === undefined) {
        throw new ApiError('not_found', `credit package ${body.package_key} not found or retired`);
      }
      const dogOwned = await dogsRepository.findOwnedExists(body.dog_id, principal.ownerId, db);
      if (!dogOwned) {
        throw new ApiError('not_found', `dog ${body.dog_id} not found`);
      }
      // Uniqueness probe BEFORE the charge (ruled 2026-07-16): one active
      // membership per (dog, mode). Catching it here means no money moves on
      // the everyday case; the in-tx re-check below covers the concurrent
      // race this pool read can't see.
      const alreadySubscribed = await membershipsRepository.findActiveForDogMode(db, {
        dogId: body.dog_id,
        mode: pkg.mode,
      });
      if (alreadySubscribed !== undefined) {
        throw new ApiError(
          'conflict',
          `this dog already has an active ${pkg.mode} membership — a dog holds at most one membership per program`,
        );
      }
      const stripeCtx = await loadStripePaymentContext({
        ownerId: principal.ownerId,
        paymentMethodId: body.payment_method_id,
      });

      // ── Month-1 Stripe charge (outside the tx; idempotency-keyed) ──
      const intent = await stripe.createAndConfirmPaymentIntent(
        {
          customerId: stripeCtx.stripeCustomerId,
          paymentMethodId: stripeCtx.stripePaymentMethodId,
          amountCents: pkg.price_cents,
          currency: 'usd',
          metadata: {
            owner_id: principal.ownerId,
            dog_id: body.dog_id,
            purpose: 'membership',
            package_id: pkg.id,
            package_key: pkg.key,
            term_months: String(body.term_months),
            credits: String(pkg.credits),
            mode: pkg.mode,
            location: pkg.location,
          },
        },
        `${idempotencyKey}:payment-intent`,
      );

      if (intent.status !== 'succeeded') {
        // v1: no async-reconcile arm for membership creation (see module
        // doc). Cancel the PI so it can't later auto-succeed into a charge
        // with no membership behind it, then surface the state-block.
        try {
          await stripe.cancelPaymentIntent(intent.id);
        } catch {
          // best-effort — an uncancellable PI is caught by Stripe-side
          // idempotency on the client's retry with the same key.
        }
        throw new ApiError(
          'payment_failed',
          'card could not be charged synchronously (declined or requires authentication) — memberships need a card that charges without extra steps; try a different card',
          {
            kind: 'payment_failed',
            // Wire 1.9.0: one code and one vocabulary across all three grant
            // sites (here, `enrollments.ts`, `requestConfirmPayment.ts`). This
            // arm used to throw `invalid_payload` (422), which no client could
            // recognize as a money outcome — a membership decline rendered
            // mobile's generic "Couldn't complete the purchase" instead of the
            // one true sentence. Derived from the RAW status, which is only in
            // hand here.
            charge_blocker: stripeIntentStatusToChargeBlocker(intent.status, request.log),
          },
        );
      }

      // Closure-captured handle for the post-commit Stripe refund — set only
      // on the uniqueness lost-race branch below (mirrors the invoice-pay
      // route's duplicate-settle refund seam).
      let pendingStripeRefund: PendingDuplicateRefund | undefined;

      // ── DB writes (inside withMutation; idempotency-keyed) ──
      const outcome = await withMutation<MembershipCreateWire>(
        {
          principal,
          idempotencyKey,
          endpoint: 'POST /memberships',
          requestHash: hashRequestBody(body),
          // The month-1 grant landed — per-dog credit reads are stale (§3
          // map). The lost-race branch grants nothing, so nothing to wipe.
          patternsToInvalidate: (body) =>
            body.credits_granted > 0 ? [`credits:${body.membership.dog_id}:*`] : [],
          postCommit: async () => {
            if (pendingStripeRefund === undefined) return;
            const refund = await stripe.createRefund(
              {
                paymentIntentId: pendingStripeRefund.paymentIntentId,
                amountCents: pendingStripeRefund.amountCents,
                reason: 'requested_by_customer',
              },
              `${idempotencyKey}:dup-subscribe-refund`,
            );
            await refundsRepository.markStripeId({
              id: pendingStripeRefund.refundId,
              stripeRefundId: refund.id,
            });
          },
        },
        async (tx) =>
          withMembershipCreateLock(tx, body.dog_id, pkg.mode, async () => {
            // Uniqueness re-check under the lock: the pre-Stripe probe races
            // the seconds-wide charge round-trip of a concurrent subscribe.
            // A winner here means THIS charge double-bills — record it, hand
            // the refund to postCommit, and return the winner's membership
            // with the honest charge_refunded flag (the dog IS subscribed;
            // the owner's card nets exactly one charge).
            const winner = await membershipsRepository.findActiveForDogMode(tx, {
              dogId: body.dog_id,
              mode: pkg.mode,
            });
            if (winner !== undefined) {
              const duplicateCharge = await chargesRepository.create(tx, {
                ownerId: principal.ownerId,
                amountCents: intent.amountCents,
                status: 'succeeded',
                purpose: 'membership',
                stripePaymentIntentId: intent.id,
                dogId: body.dog_id,
              });
              const refund = await refundsRepository.createPending(tx, {
                ownerId: principal.ownerId,
                chargeId: duplicateCharge.id,
                bookingId: null,
                amountCents: intent.amountCents,
                reason: 'duplicate-membership-subscribe',
              });
              pendingStripeRefund = {
                refundId: refund.id,
                paymentIntentId: intent.id,
                amountCents: intent.amountCents,
              };
              return {
                status: 201,
                body: {
                  membership: toMembershipWire(winner, await loadMembershipPackage(winner, tx)),
                  charge_id: duplicateCharge.id,
                  charge_status: 'succeeded' as const,
                  stripe_payment_intent_id: intent.id,
                  credits_granted: 0,
                  charge_refunded: true,
                },
              };
            }

            const charge = await chargesRepository.create(tx, {
              ownerId: principal.ownerId,
              amountCents: intent.amountCents,
              status: 'succeeded',
              purpose: 'membership',
              stripePaymentIntentId: intent.id,
              dogId: body.dog_id,
            });

            const period = firstPeriod(now);
            const membership = await membershipsRepository.createActive(tx, {
              ownerId: principal.ownerId,
              dogId: body.dog_id,
              mode: pkg.mode,
              packageId: pkg.id,
              termMonths: body.term_months,
              paymentMethodId: body.payment_method_id,
              startedAt: now,
              currentPeriodStart: period.start,
              currentPeriodEnd: period.end,
              endsAt: membershipEndsAt(now, body.term_months),
            });

            // §J.1: the month's lot expires at the period's end — that IS the
            // "X days left to use X credits" reminder, via the existing
            // credits-expiring scan. §J.3: alumni dogs never expire.
            const dogIsAlumni = await dogProgramsRepository.isAlumni(body.dog_id, tx);
            await creditLedgerRepository.creditPurchase(tx, {
              dogId: body.dog_id,
              mode: pkg.mode,
              location: pkg.location,
              delta: pkg.credits,
              packageId: pkg.id,
              chargeId: charge.id,
              expiresAt: dogIsAlumni ? null : period.end,
              reason: 'membership-grant',
            });

            return {
              status: 201,
              body: {
                membership: toMembershipWire(membership, pkg),
                charge_id: charge.id,
                charge_status: 'succeeded' as const,
                stripe_payment_intent_id: intent.id,
                credits_granted: pkg.credits,
                charge_refunded: false,
              },
            };
          }),
      );

      reply.code(outcome.status);
      return outcome.body;
    },
  );

  // --- GET /memberships ---------------------------------------------------
  app.get(
    '/memberships',
    { preHandler: [authHook] },
    async (request): Promise<MembershipWire[]> => {
      const principal = requirePrincipal(request);
      requireOwner(principal, 'read memberships');
      const rows = await membershipsRepository.findByOwner(db, principal.ownerId);
      // Owner membership lists are tiny (a dog or three) — per-row package
      // resolution beats a bespoke join for now. One owner-scoped card fetch
      // covers every row's billing-card display (§J.1 pin).
      const cards = await paymentMethodsRepository.findLiveByOwner(principal.ownerId);
      const cardById = new Map(cards.map((c) => [c.id, { brand: c.brand, last4: c.last4 }]));
      return Promise.all(
        rows.map(async (row) =>
          toMembershipWire(
            row,
            await loadMembershipPackage(row),
            row.paymentMethodId !== null ? cardById.get(row.paymentMethodId) : undefined,
          ),
        ),
      );
    },
  );

  // --- DELETE /memberships/:id ---------------------------------------------
  // Owner cancel: rolls stop, already-granted lots stay. 404-collapse for
  // missing/not-yours; 409 when it already completed/canceled.
  app.delete(
    '/memberships/:id',
    { preHandler: [authHook] },
    async (request): Promise<MembershipWire> => {
      const principal = requirePrincipal(request);
      requireOwner(principal, 'cancel a membership');
      const { id } = parseIdParam(request.params);
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);

      const outcome = await withMutation<MembershipWire>(
        {
          principal,
          idempotencyKey,
          endpoint: 'DELETE /memberships/:id',
          requestHash: hashRequestBody({ id }),
          keysToInvalidate: () => [],
        },
        async (tx) => {
          const existing = await membershipsRepository.findByIdForOwner(tx, {
            id,
            ownerId: principal.ownerId,
          });
          if (existing === undefined) {
            throw new ApiError('not_found', `membership ${id} not found`);
          }
          const canceled = await membershipsRepository.cancel(tx, {
            id,
            ownerId: principal.ownerId,
          });
          if (canceled === 0) {
            throw new ApiError('conflict', `membership ${id} is ${existing.status}, not active`);
          }
          const fresh = await membershipsRepository.findByIdForOwner(tx, {
            id,
            ownerId: principal.ownerId,
          });
          if (fresh === undefined) {
            throw new Error(`memberships: ${id} vanished mid-cancel`);
          }
          return {
            status: 200,
            body: toMembershipWire(fresh, await loadMembershipPackage(fresh, tx)),
          };
        },
      );

      return outcome.body;
    },
  );
}

function parseIdParam(params: unknown): { id: string } {
  const parsed = idParamSchema.safeParse(params);
  if (!parsed.success) {
    throw new ApiError('bad_request', `invalid path: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}

function parseCreateBody(body: unknown): z.infer<typeof createBodySchema> {
  const parsed = createBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError('bad_request', `invalid body: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}
