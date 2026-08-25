import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type {
  MembershipCreateWire,
  MembershipWire,
  PostMembershipsRequest,
} from '../contracts/wire.js';
import type { Equal, Expect } from '../contracts/typeAsserts.js';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import { actorOf } from '../auth/principal.js';
import { db } from '../db/client.js';
import {
  chargesRepository,
  type ChargeRow,
  type ChargeStatus,
} from '../db/repositories/chargesRepository.js';
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
import { LOCATION_SLUGS } from '../db/schema/schema.js';
import { withActor } from '../db/tx.js';
import { bucketChicagoToday } from '../lib/chicagoDate.js';
import { hashRequestBody, requireIdempotencyKey, withMutation } from '../db/mutation.js';
import { CANCELLABLE_STATUSES } from '../lib/enrollmentPartial.js';
import { ApiError } from '../lib/errors.js';
import { loadStripePaymentContext } from '../lib/loadStripePaymentContext.js';
import { firstPeriod, membershipEndsAt } from '../lib/membershipBilling.js';
import type { PendingDuplicateRefund } from '../lib/settleInvoiceCharge.js';
import { firePendingRefundPostCommit } from '../lib/pendingRefund.js';
import { pgTimestampToIso } from '../lib/pgTimestamp.js';
import { requireOwner } from '../lib/principalNarrows.js';
import {
  chargeBlockerForConfirm,
  defaultStripeClient,
  stripeIntentStatusToChargeStatus,
  type ChargeBlockerLogger,
  type StripeClient,
  type StripePaymentIntentResult,
} from '../lib/stripe.js';
import { cancelAndConfirm } from '../lib/withdrawSettlement.js';
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
 * A non-succeeded intent (3DS `requires_action`, `processing`) does not create a
 * membership and the POST 402s — there is deliberately NO async-reconcile arm
 * for membership creation (the package-purchase webhook catch-up has no
 * membership branch, and charging a card with no membership created is worse
 * than asking for a different card). Flagged in §J as a v1 limit.
 *
 * **THE MONTH-1 INVARIANT** (`designs/money-residue.md` §2, 2026-08-24), which
 * is what makes that constraint safe rather than merely stated:
 *
 *   > A membership month-1 charge row never commits `'succeeded'` without
 *   > either its membership or its refund row in the same transaction. A
 *   > `'requires_payment'` membership charge is an adjudication PENDING, and
 *   > whoever flips it terminal adjudicates the money — under the charge row's
 *   > lock.
 *
 * The cancel used to be BEST-EFFORT with a swallowed catch, and Stripe refuses
 * to cancel a `processing` intent, so the everyday slow-network case captured
 * money with no membership, no charge row, no refund and no record — while
 * telling the owner to try a different card. Now: the cancel arm RESOLVES
 * (`cancelAndConfirm`), a capture that wins the race completes the subscribe,
 * an un-cancellable `processing` intent is RECORDED at `'requires_payment'`
 * before the 402, and the webhook's month-1 arms adjudicate whatever settles
 * later — disposition REFUND, never reconstruct, which keeps the 402's "try a
 * different card" true.
 *
 * NOTE the guard that keeps this narrow: only month-1 PaymentIntents are in
 * scope. A membership RENEWAL is charged through the invoice lane and its PI
 * carries `invoice_id` metadata; the webhook's arms exclude those, and the
 * §A3.19 webhook-flip residual stays exactly as queued.
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

// Re-exported, not redeclared: the membership wire shapes moved into the
// versioned contract in 1.13.0 (wire.ts § domain:memberships, digest
// memberships/M), so both clients generate them instead of hand-mirroring.
// Every existing importer — `staffMemberships.ts`, the contract tests — keeps
// importing them from this module unchanged. Two copies could drift apart
// while both still compiled (the `ChargeStatus`/`chargesRepository`
// precedent).
export type { MembershipCreateWire, MembershipWire } from '../contracts/wire.js';

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

/**
 * §5.1.3 Zod ↔ wire pin: `PostMembershipsRequest` is exactly what this schema
 * ACCEPTS. `z.input`, not `z.infer` — the wire documents what a client may
 * send. Exported so no unused-locals rule can eat it. If this ever stops
 * compiling the WIRE TYPE is wrong (§14.1) — the schema is the truth.
 * Proven breakable before it was trusted: widening `term_months` to `number`,
 * dropping `payment_method_id`, widening `location` to `string`, and adding an
 * optional key each produce TS2344 (lane scratchpad, 2026-08-25).
 */
export type PostMembershipsBodyConformance = Expect<
  Equal<z.input<typeof createBodySchema>, PostMembershipsRequest>
>;

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
        // THE MONTH-1 INVARIANT, arm (a) — `designs/money-residue.md` §2.2.
        // Resolve what actually happened instead of hoping a best-effort cancel
        // killed it, and RECORD the one status a cancel cannot kill. Returns
        // only when a capture won the race; every other arm throws.
        await resolveUnsettledMonthOneIntent({
          stripe,
          intent,
          ownerId: principal.ownerId,
          actor: actorOf(principal),
          dogId: body.dog_id,
          log: request.log,
        });
        // Fell through: `cancelAndConfirm` found the intent CAPTURED (a 3DS
        // sheet the owner completed in parallel, say). The owner asked to
        // subscribe and paid — complete it on the success path below rather
        // than minting an orphan and telling them to try a different card.
      }

      // Closure-captured handle for the post-commit Stripe refund — set only
      // on the uniqueness lost-race branch below (mirrors the invoice-pay
      // route's duplicate-settle refund seam).
      let pendingStripeRefund: PendingDuplicateRefund | undefined;
      // Computed ONCE, here, so the row stores the same string the fire sends.
      const refundIdempotencyKey = `${idempotencyKey}:dup-subscribe-refund`;

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
            await firePendingRefundPostCommit({
              pending: pendingStripeRefund,
              stripe,
              log: request.log,
              context: { dogId: body.dog_id, refundPath: 'membership-subscribe-lost-race' },
            });
          },
        },
        async (tx) =>
          withMembershipCreateLock(tx, body.dog_id, pkg.mode, async () => {
            // ── The month-1 invariant, arm (b) (money-residue §2.2) ──────────
            // Resolve THIS PaymentIntent's charge row FIRST, under its own
            // lock, before any branch below decides what to write. Arm (a) can
            // have committed a `'requires_payment'` row for this exact intent,
            // and the webhook can have adjudicated it since — so `create` here
            // was a unique-violation 500 on the retry path, and an unlocked
            // read would let this request and the webhook decide from the same
            // stale answer.
            /**
             * Turn an EXISTING row for this PaymentIntent into this request's
             * answer, or fall through when it is arm (a)'s adoptable
             * `'requires_payment'` row. Used from two places — the locked read
             * below and the INSERT loser (MR-A1.6.4) — because both discover
             * the same fact one moment apart.
             */
            const dispatchExistingCharge = async (existing: ChargeRow): Promise<void> => {
              if (existing.status === 'succeeded' || existing.status === 'refunded') {
                // The webhook already adjudicated this money. By the invariant
                // a terminal membership charge THIS request did not write
                // carries its refund — assert that rather than assume it, so a
                // broken invariant is loud instead of a silent double charge.
                //
                // **The question is "does a refund ROW exist", at ANY status**
                // (MR-A2.2). It used to be `sumNonFailedForCharge > 0`, which
                // excludes `'failed'` — so an orphan whose refund Stripe FAILED
                // read as "never adjudicated" and took the throw below: a 500
                // with no idempotency record, re-500ing on every retry forever.
                const adjudications = await refundsRepository.countAnyForCharge(tx, existing.id);
                if (adjudications === 0) {
                  throw new Error(
                    `month-1 invariant broken: membership charge ${existing.id} is '${existing.status}' with neither a membership nor a refund behind it`,
                  );
                }
                throw new ApiError('conflict', MONTH_ONE_RETURNED_SENTENCE);
              }
              if (existing.status === 'failed') {
                // A succeeded intent whose row says the payment failed is a
                // contradiction, not a branch to guess at.
                throw new Error(
                  `month-1: charge ${existing.id} is 'failed' but PaymentIntent ${intent.id} succeeded`,
                );
              }
              // `'requires_payment'` — arm (a)'s recorded row. ADOPT it.
            };

            const recorded = await chargesRepository.findByStripePaymentIntentIdForUpdate(
              tx,
              intent.id,
            );
            if (recorded !== undefined) await dispatchExistingCharge(recorded);

            /**
             * The charge row this request will grant (or refund) against: the
             * recorded row flipped terminal, or a fresh one. Either way exactly
             * ONE row exists per PaymentIntent, which is what keeps the retry
             * paths coherent instead of colliding on the unique index.
             *
             * **The no-row branch INSERTs idempotently and re-dispatches**
             * (MR-A1.6.4, Fable F6). A locked read of a row that does not exist
             * locks NOTHING, so the webhook's orphan arm can insert in the gap
             * between that read and this write — and `create` then raised a
             * unique violation that surfaced as a transient 500 with the money
             * already recorded and refunding. `ON CONFLICT DO NOTHING` leaves no
             * poisoned transaction and needs no exception mapping: the loser
             * simply re-reads the winner's row and answers through the SAME arms
             * the locked read uses. An indefinite 500 becomes a definite answer
             * in-request.
             */
            const resolveChargeRow = async (): Promise<{ id: string }> => {
              if (recorded !== undefined) {
                await chargesRepository.markStatus(tx, { id: recorded.id, status: 'succeeded' });
                return recorded;
              }
              const { charge, created } = await chargesRepository.insertIfAbsentByPaymentIntent(
                tx,
                {
                  ownerId: principal.ownerId,
                  amountCents: intent.amountCents,
                  status: 'succeeded',
                  purpose: 'membership',
                  stripePaymentIntentId: intent.id,
                  dogId: body.dog_id,
                },
              );
              if (created) return charge;
              // ── MR-A2.1: RE-LOCK before re-dispatching ──────────────────
              // `insertIfAbsentByPaymentIntent`'s conflict fallback is a PLAIN
              // read, so dispatching from it decided this request's answer
              // while holding NOTHING. The Fable lane executed the cost: the
              // webhook's locked flip+mint commits inside the read→dispatch
              // window, this request adopts the stale `'requires_payment'`
              // answer and grants — **membership AND refund both stand, and
              // the school eats one month's fee.** §2.2 always said the
              // adjudication happens "under the charge row's lock"; A1.6.4's
              // text omitted it and the build followed the text.
              //
              // Re-taking the lock here makes the loser BLOCK behind whichever
              // writer owns the row, then answer from what that writer decided.
              const locked = await chargesRepository.findByStripePaymentIntentIdForUpdate(
                tx,
                intent.id,
              );
              if (locked === undefined) {
                // Unreachable: the INSERT above conflicted, so the row exists
                // and is committed. Asserted rather than defaulted.
                throw new Error(
                  `month-1: PaymentIntent ${intent.id} conflicted on INSERT but has no row`,
                );
              }
              await dispatchExistingCharge(locked);
              // Fell through: the winner left it at `'requires_payment'`, so
              // this request adopts it exactly as it would have adopted arm
              // (a)'s row — and now does so under the lock that makes the
              // adoption safe.
              await chargesRepository.markStatus(tx, { id: locked.id, status: 'succeeded' });
              return locked;
            };

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
              const duplicateCharge = await resolveChargeRow();
              // ── MR-A3.1: THROUGH the capped helper ──────────────────────
              // This branch used to call `createPending` RAW at
              // `intent.amountCents`. The charge LOCK was held (via
              // `resolveChargeRow`) — the AMOUNT was what nothing guarded, and
              // MR-A1.2(i)'s inventory listed the site as compliant on the lock
              // and missed the cap. Executed: a charge already carrying an
              // adopted 4000c dashboard refund → this minted 9900c → 13900c of
              // non-failed refunds on a 9900c charge, and the post-commit fire
              // sent it. It was the last cap-entering write outside a capped
              // verb.
              //
              // The key factory is the CLIENT-KEYED leg shape (the withdraw
              // precedent): it ignores the row id and returns the request-derived
              // key, so replay semantics are exactly what they were. Re-locking
              // the already-held row inside the helper is a no-op and nothing
              // about lock order moves.
              const minted = await refundsRepository.mintCappedPendingRefund(tx, {
                chargeId: duplicateCharge.id,
                ownerId: principal.ownerId,
                bookingId: null,
                reason: 'duplicate-membership-subscribe',
                // Stored in the SAME tx as the row: without it a failed
                // post-commit `createRefund` was unretryable by anything,
                // because this key lives only in this request's closure.
                stripeIdempotencyKey: () => refundIdempotencyKey,
              });
              if (minted.kind === 'no-payment-intent') {
                // Unreachable: this charge row was created or adopted with
                // `intent.id` in this very transaction. Asserted, never
                // defaulted — a money path does not get to guess.
                throw new Error(
                  `duplicate-subscribe: charge ${duplicateCharge.id} has no PaymentIntent though ${intent.id} succeeded`,
                );
              }
              if (minted.kind === 'minted') {
                pendingStripeRefund = {
                  refundId: minted.refundId,
                  paymentIntentId: minted.paymentIntentId,
                  // The capped figure, not `intent.amountCents`. A partial clip
                  // means part of this charge's money was already returned or
                  // promised, so the refund that MOVES is the remainder — which
                  // is the true figure. The wire carries no amount, so nothing
                  // else changes.
                  amountCents: minted.amountCents,
                  stripeIdempotencyKey: minted.stripeIdempotencyKey,
                };
              } else {
                // `'nothing-to-refund'` — this charge's money is already fully
                // spoken for (returned, in flight, or attested). NOT the 409:
                // the winner membership EXISTS and the dog IS subscribed, so
                // "please start again" would be false. `charge_refunded: true`
                // stays true in substance — full prior coverage means the
                // return is already recorded and the owner's card nets exactly
                // one charge, which is the flag's whole contract.
                //
                // One WARN, because a human already intervened on this charge
                // and the no-silent rule applies even when the cap did its job.
                request.log.warn(
                  {
                    moneyEvent: 'duplicate-subscribe-already-covered',
                    chargeId: duplicateCharge.id,
                    ownerId: principal.ownerId,
                    dogId: body.dog_id,
                    chargeAmountCents: intent.amountCents,
                    paymentIntentId: intent.id,
                  },
                  'duplicate-subscribe charge already fully covered — no mint: the uniqueness lost-race would have refunded this charge, but its money is already returned, in flight, or attested out of band. The winner membership stands and the owner nets one charge; nothing further was sent',
                );
              }
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

            const charge = await resolveChargeRow();

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

/**
 * What the owner is told when the webhook adjudicated their month-1 payment
 * before their retry landed: the money came back and the subscribe did not
 * happen. Their next tap is a fresh Idempotency-Key, a fresh PaymentIntent, and
 * a clean subscribe (money-residue §2.2b, copy draft §6).
 *
 * **COPY FLAG, riding the §6 bundle for Allison's verbatim nod (MR-A2.5(d)2).**
 * "has been returned" overstates the state at the moment this is said: the
 * refund is usually still `'pending'`, and after MR-A2.2 this sentence is also
 * the answer while a FAILED refund is being returned by hand. The truthful
 * tense is "is being returned" / "is on its way". **The string stays as-is
 * until she rules** — copy never blocks a build, and the mechanism (money is
 * adjudicated, no membership exists, start again) is already true.
 */
const MONTH_ONE_RETURNED_SENTENCE =
  "that subscription payment didn't complete in time and has been returned to your card — please start again";

/** The one sentence for a month-1 confirm that did not settle. Unchanged by
 *  this design: the `charge_blocker` is what selects the client's copy, and
 *  after money-residue this sentence sits on a TRACKED charge with an
 *  auto-refund backstop rather than on nothing at all. */
const MONTH_ONE_BLOCKED_SENTENCE =
  'card could not be charged synchronously (declined or requires authentication) — memberships need a card that charges without extra steps; try a different card';

function monthOneBlockedError(intent: StripePaymentIntentResult, log: ChargeBlockerLogger): never {
  const blocker = chargeBlockerForConfirm(intent, log);
  if (blocker === undefined) {
    // Unreachable: the caller establishes a non-succeeded status, and
    // `succeeded` is the ONLY input for which the helper returns undefined.
    // TypeScript narrows `intent.status` but not `intent`, so the impossible
    // arm is asserted rather than defaulted — a `?? 'declined'` here would
    // silently re-bury the thrown error's code.
    throw new Error(
      `unreachable: non-succeeded PaymentIntent ${intent.id} (${intent.status}) derived no charge blocker`,
    );
  }
  // Wire 1.9.0: one code and one vocabulary across all three grant sites (here,
  // `enrollments.ts`, `requestConfirmPayment.ts`). This arm used to throw
  // `invalid_payload` (422), which no client could recognize as a money
  // outcome.
  throw new ApiError('payment_failed', MONTH_ONE_BLOCKED_SENTENCE, {
    kind: 'payment_failed',
    charge_blocker: blocker,
  });
}

/**
 * Resolve a month-1 PaymentIntent that did NOT come back `succeeded`, and never
 * leave the money unaccounted for (`designs/money-residue.md` §2.2a).
 *
 * **What this replaces.** A best-effort `cancelPaymentIntent` in a `try {} catch
 * {}` that swallowed every failure, followed by the 402. Stripe REFUSES to
 * cancel a `processing` PaymentIntent — the exact fact the withdraw machinery is
 * built on — so the ordinary "slow card network" case went: cancel throws, catch
 * swallows, owner is told to try a different card, **no `charges` row is ever
 * written** (the route only writes inside `withMutation`, which the throw never
 * reaches), and hours later the PI settles. Money captured at Stripe with no
 * membership, no credits, no row, no refund and no notification anywhere; an
 * owner who obeyed the 402 and subscribed on a second card was double-charged.
 *
 * The arms, and why each is the honest answer:
 *
 *   - **cancellable** → {@link cancelAndConfirm}, the shared primitive, so the
 *     cancel/capture race has ONE reading in this codebase.
 *       · `canceled` → today's 402, byte-compatible.
 *       · `captured` → a capture won (a 3DS sheet completed in parallel). The
 *         owner asked to subscribe and paid: RETURN, and the caller completes
 *         the subscribe. No orphan is minted.
 *       · `processing` → the recorded-processing arm.
 *       · throws (unreadable) → propagates. Nothing is recorded and nothing is
 *         claimed — the §A3.2 abort posture — and the webhook backstop covers
 *         whatever the intent later does.
 *   - **`processing` at first look** → no cancel is ATTEMPTED, because Stripe
 *     would refuse it and a cancel we know will fail is theatre. Record the
 *     intent at its honest status and answer with the `processing` blocker,
 *     which is the one blocker that tells the client NOT to retry.
 *   - **`canceled` at first look** → a retry of an attempt whose cancel landed;
 *     same 402, same classing.
 */
async function resolveUnsettledMonthOneIntent(args: {
  stripe: Pick<StripeClient, 'retrievePaymentIntent' | 'cancelPaymentIntent'>;
  intent: StripePaymentIntentResult;
  ownerId: string;
  actor: string;
  dogId: string;
  log: ChargeBlockerLogger;
}): Promise<void> {
  const { intent } = args;
  if (CANCELLABLE_STATUSES.has(intent.status)) {
    const resolved = await cancelAndConfirm({
      stripe: args.stripe,
      paymentIntentId: intent.id,
    });
    if (resolved.kind === 'captured') return;
    if (resolved.kind === 'canceled') monthOneBlockedError(intent, args.log);
    await recordAndAnswerProcessingMonthOne(args);
  }
  if (intent.status === 'processing') {
    await recordAndAnswerProcessingMonthOne(args);
  }
  monthOneBlockedError(intent, args.log);
}

/**
 * Record the in-flight intent, then **ANSWER FROM THE ROW IT JUST WROTE**
 * (MR-A1.3, 2026-08-24). Always throws.
 *
 * **Why the read-back exists.** The design premised the 409 on the owner's
 * same-key retry receiving a now-`succeeded` PaymentIntent back from Stripe's
 * idempotency cache. That contradicts this repo's own documented replay
 * semantics (`enrollmentPartial.ts:343-344`): **a same-key confirm replays the
 * ORIGINAL response snapshot, not current state.** The Opus attack lane
 * executed the consequence (P4-B1): processing-first subscribe → 402 + recorded
 * row → the webhook settles it and mints the refund → the owner taps again on
 * the same key → Stripe replays `processing` → this arm's idempotent record
 * no-ops → and the owner was told **"try a different card" over money already
 * being returned**. The designed 409 was unreachable on that arc.
 *
 * So when the record is a no-op (`created === false`) the row is the only thing
 * that knows what happened, and it decides:
 *
 *   - `'succeeded'`/`'refunded'` WITH non-failed refunds → **409**, the same
 *     `MONTH_ONE_RETURNED_SENTENCE` arm (b) throws. One string, one meaning.
 *   - `'succeeded'` with NO refunds → the month-1 invariant is broken; throw
 *     loud. Arm (b)'s exact posture — a broken invariant must never degrade to
 *     a polite 402.
 *   - `'failed'` → today's 402: the payment genuinely failed.
 *   - `'requires_payment'` → today's 402 processing answer: still in flight.
 *
 * **A plain read suffices** — this arm writes no cap state, so nothing about
 * MR-A1.2's cap-entering lock rule applies. A webhook flip racing between the
 * read and the answer at worst answers 402 where 409 has just become true, and
 * the owner's next tap heals it. Stated so nobody over-locks an answer-only
 * read.
 */
async function recordAndAnswerProcessingMonthOne(args: {
  intent: StripePaymentIntentResult;
  ownerId: string;
  actor: string;
  dogId: string;
}): Promise<never> {
  const recorded = await recordProcessingMonthOneCharge(args);
  if (recorded.created) throw monthOneProcessingError();
  throw await monthOneAnswerForExistingCharge(args.actor, recorded.charge);
}

/**
 * The one place that turns an already-existing month-1 charge row into the
 * owner's answer. Shared by arm (a)'s read-back and arm (b)'s
 * `insertIfAbsentByPaymentIntent` loser (MR-A1.6.4), so the two cannot drift
 * into two different sentences for one state.
 *
 * **The adjudication test is a refund ROW EXISTING, at any status** (MR-A2.2,
 * 2026-08-24 — this jsdoc used to document the non-failed SUM, which is the
 * money question, not this one). A `'failed'` refund still proves a writer
 * decided this money; whether it was successfully DELIVERED is the refund
 * machinery's problem, and it has its own worklist and alarms for that. Asking
 * the sum here meant a month-1 orphan whose refund Stripe failed took the
 * invariant throw — a permanent 500 on a state that is merely unfinished.
 *
 * The invariant throw survives for the one genuinely broken state: a terminal
 * charge with ZERO refund rows.
 */
async function monthOneAnswerForExistingCharge(
  actor: string,
  charge: { id: string; status: ChargeStatus },
): Promise<ApiError> {
  if (charge.status === 'succeeded' || charge.status === 'refunded') {
    const adjudications = await withActor(actor, (tx) =>
      refundsRepository.countAnyForCharge(tx, charge.id),
    );
    if (adjudications === 0) {
      throw new Error(
        `month-1 invariant broken: membership charge ${charge.id} is '${charge.status}' with neither a membership nor a refund behind it`,
      );
    }
    return new ApiError('conflict', MONTH_ONE_RETURNED_SENTENCE);
  }
  if (charge.status === 'failed') return monthOneBlockedByFailure();
  // `'requires_payment'` — still in flight, and the money may yet land.
  return monthOneProcessingError();
}

/** The 402 for a month-1 charge whose row says the payment FAILED. Same
 *  sentence, `'declined'` blocker: trying another card is now the right advice
 *  (unlike the `processing` arm, where it is the double charge). */
function monthOneBlockedByFailure(): ApiError {
  return new ApiError('payment_failed', MONTH_ONE_BLOCKED_SENTENCE, {
    kind: 'payment_failed',
    charge_blocker: 'declined',
  });
}

/** The 402 for money that is genuinely still in flight. `'processing'` is the
 *  blocker the wire already carries (1.8.0) and the one that refuses a retry —
 *  telling an owner "try a different card" here is the reachable double charge. */
function monthOneProcessingError(): ApiError {
  return new ApiError('payment_failed', MONTH_ONE_BLOCKED_SENTENCE, {
    kind: 'payment_failed',
    charge_blocker: 'processing',
  });
}

/**
 * Commit the un-cancellable in-flight PaymentIntent as a `'requires_payment'`
 * membership charge — **in its own small transaction, BEFORE the 402 is
 * thrown**.
 *
 * Its own tx and not `withMutation`'s, deliberately (money-residue §2.7.4): the
 * 402 rolls that transaction back, and a failure record that exists only when
 * the request SUCCEEDS records nothing.
 *
 * `insertIfAbsentByPaymentIntent` rather than `create`: the owner's same-key
 * retry gets the same PaymentIntent back from Stripe, reaches here again, and
 * must find the write idempotent rather than a unique violation. **It returns
 * the found row and whether IT created it** — which is the whole input to the
 * read-back above (MR-A1.3): a no-op insert means somebody else owns this
 * PaymentIntent's fate, and only the row says who.
 *
 * The status is the honest one for money in flight, through the mapper so the
 * claim is compiler-checked — and `'requires_payment'` is also what keeps this
 * row out of the owner ledger (R32) until somebody adjudicates it.
 */
async function recordProcessingMonthOneCharge(args: {
  intent: StripePaymentIntentResult;
  ownerId: string;
  actor: string;
  dogId: string;
}): Promise<{ charge: ChargeRow; created: boolean }> {
  return withActor(args.actor, async (tx) =>
    chargesRepository.insertIfAbsentByPaymentIntent(tx, {
      ownerId: args.ownerId,
      amountCents: args.intent.amountCents,
      status: stripeIntentStatusToChargeStatus('processing'),
      purpose: 'membership',
      stripePaymentIntentId: args.intent.id,
      dogId: args.dogId,
    }),
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
