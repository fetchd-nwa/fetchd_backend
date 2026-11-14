import { db } from '../db/client.js';
import { chargesRepository } from '../db/repositories/chargesRepository.js';
import { refundsRepository } from '../db/repositories/refundsRepository.js';
import { withActor } from '../db/tx.js';
import { applyLiveRefund, mapStripeRefundStatus } from './refundApply.js';
import {
  stripeIdempotencyErrorKind,
  stripeRefundRefusal,
  type StripeClient,
  type StripePaymentIntentId,
} from './stripe.js';

/** The actor a reply's apply runs under when the caller names none: Stripe told us. */
const REPLY_ACTOR = 'system:stripe-webhook';

/**
 * The handle a pending-refund writer hands its caller to fire after commit —
 * ONE type for every money-back site (`designs/client-keyed-refund-recovery.md`
 * §2.2 named five; the booking cancel's money-back branch, one of them, was
 * deleted in P21, wire 6.0.0-lg5.2). It used to be two structurally identical
 * interfaces declared in two files (`cancelBookingService.PendingStripeRefund`,
 * `settleInvoiceCharge.PendingDuplicateRefund`), which is how the fourth field
 * below could have been added to one and forgotten on the other.
 *
 * `stripeIdempotencyKey` is the load-bearing addition: the EXACT key this
 * refund's Stripe call will use, computed once, stored on the `refunds` row in
 * the same transaction that minted it, and read from that row by the retry
 * sweep. Before it existed, three of the four writers derived their key from
 * the CLIENT's request `Idempotency-Key`, which lives only in that request's
 * closure — so a `createRefund` that failed post-commit could never be retried
 * by anything, and the money silently never returned.
 */
export interface PendingStripeRefund {
  refundId: string;
  paymentIntentId: string;
  amountCents: number;
  /** The key BOTH the post-commit fire and the sweep's retry send. */
  stripeIdempotencyKey: string;
}

/**
 * THE Stripe `createRefund` params, built in exactly one place.
 *
 * A same-key retry only REPLAYS the original refund when the parameters match
 * byte-for-byte; same key + drifted params is Stripe's `idempotency_error`
 * (400, no money moved — loud and safe, but the refund then never lands).
 * Every site used to hand-build this object literal, so "the sweep rebuilds the
 * params differently from the fire" was a live regression away at all times.
 * One constructor makes that unreachable except by editing this function, and
 * the byte-equality pin in the suite is what watches this function.
 *
 * **`metadata.refund_id`** (P22, B-7(b) 2): every create names our row, so Stripe's refund
 * says whose it is. The refund events match by it before any amount (`refundApply.ts`, step
 * 2), and the refund sweep's look-up finds a refund a lost or stored-error create left at
 * Stripe by it, before any fresh key could send a second one. Rows minted before P22 were
 * created with none; only a rebuilt database holds them.
 */
export function refundCreateParams(pending: {
  refundId: string;
  paymentIntentId: string;
  amountCents: number;
}): {
  paymentIntentId: StripePaymentIntentId;
  amountCents: number;
  reason: string;
  metadata: { refund_id: string };
} {
  return {
    paymentIntentId: pending.paymentIntentId,
    amountCents: pending.amountCents,
    reason: 'requested_by_customer',
    metadata: { refund_id: pending.refundId },
  };
}

/**
 * The post-commit half of every pending refund's contract, for every site:
 * fire `createRefund` under the row's STORED key, persist the returned `re_*`
 * so `charge.refund.updated` matches deterministically, and on failure LOG and
 * LEAVE THE ROW PENDING (R35 — the pending row is the commitment).
 *
 * Since P22 (wire 6.0.0; design §2.7:4215-4217) the reply's own status is applied
 * too: a terminal reply (`succeeded`, or `failed`) goes through the one apply
 * function ({@link applyRefundStatus}) in the transaction that follows the call,
 * under the charge lock, exactly as a refund event's would; a `pending` reply
 * waits for Stripe's refund events. Every lane gets it, the staff refund among
 * them: what a `succeeded` event did a moment later, the reply now does at once.
 *
 * Leaving it pending is now a real instruction rather than a hopeful sentence:
 * `workers/duplicateRefundRetry.ts` claims exactly these rows and re-fires them
 * under the same stored key, so a transient rate limit or dropped connection
 * costs a few minutes instead of an owner's money.
 *
 * `stripe` is narrowed to the one verb so a caller cannot be handed more Stripe
 * surface than this needs. A no-op on `undefined` — the defensive zero-refund
 * cases (a charge already fully pending-refunded; every booking cancel since P21,
 * which moves no money) have nothing to send back.
 */
export async function firePendingRefundPostCommit(args: {
  pending: PendingStripeRefund | undefined;
  stripe: Pick<StripeClient, 'createRefund'>;
  log: { error(obj: Record<string, unknown>, msg?: string): void };
  /** Context for the failure log line — whatever names the money for an operator. */
  context: Record<string, unknown>;
  /** Who the reply's apply is written as; Stripe's system actor when omitted. */
  actor?: string;
}): Promise<void> {
  const { pending, stripe, log } = args;
  if (pending === undefined) return;
  let reply: Awaited<ReturnType<StripeClient['createRefund']>>;
  try {
    reply = await stripe.createRefund(refundCreateParams(pending), pending.stripeIdempotencyKey);
    await refundsRepository.markStripeId({ id: pending.refundId, stripeRefundId: reply.id });
  } catch (err) {
    // Stripe said no, for good (B-7(c)): the row is failed now, never re-fired. The
    // idempotency errors keep their own arms (the sweep's), so they are asked first.
    const refusal = stripeIdempotencyErrorKind(err) === undefined ? stripeRefundRefusal(err) : undefined;
    if (refusal !== undefined) {
      await refuseRefundAtCreate({
        refundId: pending.refundId,
        paymentIntentId: pending.paymentIntentId,
        stripeIdempotencyKey: pending.stripeIdempotencyKey,
        refusal,
        log,
        context: args.context,
        ...(args.actor !== undefined ? { actor: args.actor } : {}),
      }).catch((refuseErr: unknown) => {
        log.error(
          {
            ...args.context,
            refundId: pending.refundId,
            err: refuseErr instanceof Error ? refuseErr.message : String(refuseErr),
          },
          'Stripe refused this refund at create, and marking the row failed threw; the row stays pending and the refund sweep marks it failed on its next re-send, which Stripe answers with the same refusal',
        );
      });
      return;
    }
    log.error(
      {
        ...args.context,
        refundId: pending.refundId,
        paymentIntentId: pending.paymentIntentId,
        amountCents: pending.amountCents,
        stripeIdempotencyKey: pending.stripeIdempotencyKey,
        err: err instanceof Error ? err.message : String(err),
      },
      'pending refund failed to fire; the row stays pending and the retry sweep re-fires it under the SAME stored key',
    );
    return;
  }
  // A `pending` reply waits for Stripe's refund events and the sweep's poll.
  if (mapStripeRefundStatus(reply.status) === undefined) return;
  try {
    const row = await refundsRepository.findById(db, pending.refundId);
    if (row === undefined) throw new Error(`refund ${pending.refundId} does not exist`);
    await withActor(args.actor ?? REPLY_ACTOR, (tx) =>
      applyLiveRefund(tx, {
        chargeId: row.chargeId,
        live: {
          id: reply.id,
          status: reply.status,
          amountCents: reply.amountCents,
          paymentIntentId: pending.paymentIntentId,
          metadataRefundId: pending.refundId,
        },
        log,
      }),
    );
  } catch (err) {
    log.error(
      {
        ...args.context,
        refundId: pending.refundId,
        stripeRefundId: reply.id,
        replyStatus: reply.status,
        err: err instanceof Error ? err.message : String(err),
      },
      "Stripe answered this refund but applying its status failed; the row stays pending with its re_ stored, and Stripe's next refund event for it applies the status",
    );
  }
}

/** The level-50 line of a refund Stripe refused at create (P22 B-7(c)). */
export const REFUND_REFUSED_AT_CREATE_ALARM =
  "Stripe refused this refund when it was created (HTTP 400, invalid_request_error): no refund exists at Stripe and no money went back, so the row is marked failed and is never sent again. Stripe's code (none, when it sent none) and message say why. The refund report (duplicate refund retry) names what to do with the row";

/**
 * **A create Stripe refused** (P22 B-7(c); P16 r3 Fable M2): HTTP 400 with `type:
 * invalid_request_error`, with or without a `code` (the recording's (c): an over-refund
 * carries none, a fully refunded charge `charge_already_refunded`). Stripe created no
 * refund and the refusal is the key's stored answer, so re-sending it can never succeed:
 * the row moves `pending → failed` in a short transaction under the charge lock, with one
 * level-50 line naming the row, the PaymentIntent and Stripe's own code and message, and is
 * never re-fired. Its money question goes to the refund report, which names the exits or,
 * for a row larger than what is still owed, the new refund that pays it (Fable M1).
 * Returns whether this call moved the row.
 */
export async function refuseRefundAtCreate(args: {
  refundId: string;
  paymentIntentId: string;
  stripeIdempotencyKey: string;
  refusal: { code: string | undefined; message: string };
  log: { error(obj: Record<string, unknown>, msg?: string): void };
  context?: Record<string, unknown>;
  actor?: string;
}): Promise<boolean> {
  const row = await refundsRepository.findById(db, args.refundId);
  if (row === undefined) return false;
  const failed = await withActor(args.actor ?? REPLY_ACTOR, async (tx) => {
    await chargesRepository.findByIdForUpdate(tx, row.chargeId);
    return refundsRepository.failUnsentPending(tx, {
      id: row.id,
      stripeIdempotencyKey: args.stripeIdempotencyKey,
    });
  });
  if (failed) {
    args.log.error(
      {
        ...(args.context ?? {}),
        moneyEvent: 'refund-refused-at-create',
        refundId: row.id,
        chargeId: row.chargeId,
        paymentIntentId: args.paymentIntentId,
        amountCents: row.amountCents,
        stripeIdempotencyKey: args.stripeIdempotencyKey,
        stripeCode: args.refusal.code ?? null,
        stripeMessage: args.refusal.message,
      },
      REFUND_REFUSED_AT_CREATE_ALARM,
    );
  }
  return failed;
}

/**
 * A refund that was born with nowhere to go (`schema.sql` `refund_status`,
 * design §4): the charge behind it carries no `stripe_payment_intent_id`, so
 * `status='unroutable'` was written INSTEAD of `'pending'` and no automatic
 * path will ever send it. Money owed with no route is a page-once event, at the
 * moment it becomes true — not a line that repeats on every worker tick forever.
 *
 * Called IN-TRANSACTION at the mint (since 2026-08-24 the group-class withdraw's
 * `refund_manual` arm — `designs/money-residue.md` §3; `cancelBookingService`'s
 * money-back branch, its first caller, was deleted in P21, wire 6.0.0-lg5.2),
 * never from a post-commit seam — ruled by the 2026-08-20 adversary panel, which
 * proved the post-commit placement loses the announcement PERMANENTLY on the
 * crash-then-replay arc (`withMutation` replays skip postCommit, and no report
 * class can ever name an unroutable row again). The cost of this placement is
 * a rare false alarm if the transaction then rolls back — loud and
 * recoverable, the right failure direction for money owed back. Do not move
 * this back to postCommit.
 */
export interface UnroutableRefundMint {
  refundId: string;
  ownerId: string;
  chargeId: string;
  amountCents: number;
}

export function logUnroutableRefundMint(
  log: { error(obj: Record<string, unknown>, msg?: string): void },
  mint: UnroutableRefundMint | undefined,
  context: Record<string, unknown> = {},
): void {
  if (mint === undefined) return;
  log.error(
    { ...context, ...mint },
    'refund owed with no Stripe route: the charge behind it has no PaymentIntent, so the row is born "unroutable" and nothing automatic will ever send it. A human must hand this money back and record it with Returned (POST /staff/refunds/:id/resolve-external)',
  );
}
