import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import { db } from '../db/client.js';
import { chargesRepository, type ChargeStatus } from '../db/repositories/chargesRepository.js';
import { creditLedgerRepository } from '../db/repositories/creditLedgerRepository.js';
import { creditPackagesRepository } from '../db/repositories/creditPackagesRepository.js';
import { dogProgramsRepository } from '../db/repositories/dogProgramsRepository.js';
import { dogsRepository } from '../db/repositories/dogsRepository.js';
import { bookingMode, LOCATION_SLUGS } from '../db/schema/schema.js';
import { invalidatePattern } from '../lib/cache.js';
import { creditExpirySettingsRepository } from '../db/repositories/creditExpirySettingsRepository.js';
import { resolvePurchaseExpiry } from '../lib/creditExpiry.js';
import { ApiError } from '../lib/errors.js';
import { bucketChicagoToday } from '../lib/chicagoDate.js';
import { hashRequestBody, requireIdempotencyKey, withMutation } from '../db/mutation.js';
import { loadStripePaymentContext } from '../lib/loadStripePaymentContext.js';
import { requireOwner } from '../lib/principalNarrows.js';
import {
  defaultStripeClient,
  stripeIntentStatusToChargeStatus,
  type StripeClient,
} from '../lib/stripe.js';
import { formatZodIssues } from '../lib/zodIssues.js';

type BookingMode = (typeof bookingMode.enumValues)[number];
const LOCATION_KEYS = LOCATION_SLUGS;
type LocationKey = (typeof LOCATION_KEYS)[number];

/**
 * `GET /credit-packages` `[auth]` — the active catalog of purchasable
 * credit packs (DATA-CONTRACT §B CreditPackage Δ 2026-05-20).
 *
 * `POST /credit-packages/:key/purchase` `[auth, $]` — Day 14. Synchronous
 * confirmation path against Stripe test mode: the route creates +
 * confirms a PaymentIntent off the owner's stored payment_method, writes
 * the `charges` row mirroring Stripe's returned status, and (only on
 * `succeeded`) writes the matching `credit_ledger` purchase grant. 3DS
 * and async-settled paths return early with the client_secret and let
 * the Day-15 webhook reconcile the terminal status.
 *
 * Optional `quantity` (1–100, default 1) buys N units of the package in
 * one charge / one ledger lot — the app's "choose your own amount"
 * option sends N × the single-day pack.
 *
 * Catalog endpoint: both owner and staff principals get the same data
 * (rates + packages are reference data, not user data). Retirement is
 * `active = false` on the row — never DELETE; the wire filter is
 * server-side so retired packs never surface even if a stale client
 * caches one.
 */

export interface CreditPackageWire {
  key: string;
  location: LocationKey;
  mode: BookingMode;
  credits: number;
  price_cents: number;
  label: string;
  is_popular: boolean;
}

export interface CreditPurchaseWire {
  charge_id: string;
  charge_status: ChargeStatus;
  stripe_payment_intent_id: string;
  client_secret: string | null;
  credits_granted: number;
}

export interface CreditPackagesRouteOptions extends AuthRouteOptions {
  /** Stripe seam (Day 14). Contract tests inject a stub. */
  stripe?: StripeClient;
  /**
   * Injectable clock so contract tests get a deterministic "today" for the
   * effective-dated catalog lookup (Δ 2026-06-08). A factory, not a `Date`,
   * so a captured clock can't freeze production. Default = `new Date()`.
   */
  now?: () => Date;
}

const keyParamSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/i, 'key must be alphanumeric with dashes'),
});

// Catalog + purchase are per-location since the Δ 2026-06-04 (pricing varies
// by school). The owner app passes its selected location.
const packagesQuerySchema = z.object({ location: z.enum(LOCATION_KEYS) });

// Upper bound for a single purchase's unit count — matches the app's
// "choose your own amount" wheel (1–100 of the single-day pack).
const PURCHASE_QUANTITY_MAX = 100;

const purchaseBodySchema = z
  .object({
    dog_id: z.string().uuid('dog_id must be a UUID'),
    payment_method_id: z.string().uuid('payment_method_id must be a UUID'),
    location: z.enum(LOCATION_KEYS),
    // Buy N units of the package in ONE charge: quantity × price_cents,
    // quantity × credits granted. Powers the app's custom-amount option
    // (N × the single-day pack). Absent = 1 = the classic package purchase.
    quantity: z.number().int().min(1).max(PURCHASE_QUANTITY_MAX).default(1),
  })
  .strict();

export function registerCreditPackagesRoute(
  app: FastifyInstance,
  opts: CreditPackagesRouteOptions = {},
): void {
  const authHook = resolveAuthHook(opts);
  const stripe = opts.stripe ?? defaultStripeClient;
  const nowFactory = opts.now ?? ((): Date => new Date());

  app.get(
    '/credit-packages',
    { preHandler: [authHook] },
    async (request): Promise<CreditPackageWire[]> => {
      requirePrincipal(request); // any authenticated principal; catalog is shared
      const { location } = parsePackagesQuery(request.query);
      return creditPackagesRepository.findActive(location, bucketChicagoToday(nowFactory()));
    },
  );

  // --- POST /credit-packages/:key/purchase -----------------------------
  //
  // Stripe call lives OUTSIDE `withMutation` so the network round-trip
  // doesn't pin a Postgres tx open. Retry safety: the same Idempotency-
  // Key flows into BOTH the Stripe `paymentIntents.create` (Stripe-side
  // dedupe) AND the `withIdempotency` wrapper (DB-side dedupe). A retry
  // with the same key re-fetches the same PI from Stripe + replays the
  // stored DB outcome — no double-charge, no double-grant.
  //
  // Failure of the Stripe call before the DB tx commits = no rows
  // written, Stripe-side state may or may not have created an intent
  // (depends on where the failure lands). The client retries with the
  // same key; if Stripe DID create one earlier, it returns the cached
  // PI; the DB tx now runs and writes the rows. Self-healing.
  app.post(
    '/credit-packages/:key/purchase',
    { preHandler: [authHook] },
    async (request, reply): Promise<CreditPurchaseWire> => {
      const principal = requirePrincipal(request);
      requireOwner(principal, 'purchase credits');
      const { key } = parseKeyParam(request.params);
      const body = parsePurchaseBody(request.body);
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);

      // ── Pre-Stripe validation (read-only, before the network call) ──
      // These checks run twice on retry — that's intentional. If state
      // changed between attempts (card deleted, dog deleted), the second
      // call surfaces the new truth as a 404/422 BEFORE re-calling
      // Stripe with a stale intent.
      const purchaseContext = await loadPurchaseContext({
        key,
        location: body.location,
        ownerId: principal.ownerId,
        dogId: body.dog_id,
        paymentMethodId: body.payment_method_id,
        today: bucketChicagoToday(nowFactory()),
      });
      const pkg = purchaseContext.pkg;
      // Quantity multiplies the whole purchase: one charge, one ledger lot.
      // Metadata carries the TOTAL so the Day-15 webhook's reconcile path
      // (which grants straight from metadata.credits) needs no quantity
      // awareness at all.
      const grantCredits = pkg.credits * body.quantity;

      // ── Stripe call (outside the tx; idempotency-keyed) ──
      const intent = await stripe.createAndConfirmPaymentIntent(
        {
          customerId: purchaseContext.stripeCustomerId,
          paymentMethodId: purchaseContext.stripePaymentMethodId,
          amountCents: pkg.price_cents * body.quantity,
          currency: 'usd',
          metadata: {
            owner_id: principal.ownerId,
            dog_id: body.dog_id,
            // package_id is the load-bearing FK the async webhook stamps onto
            // the ledger; package_key rides along for human-readable Stripe
            // dashboard reconciliation.
            package_id: pkg.id,
            package_key: pkg.key,
            credits: String(grantCredits),
            quantity: String(body.quantity),
            mode: pkg.mode,
            location: pkg.location,
          },
        },
        `${idempotencyKey}:payment-intent`,
      );

      const chargeStatus = stripeIntentStatusToChargeStatus(intent.status);

      // ── DB writes (inside withMutation; idempotency-keyed) ──
      const outcome = await withMutation<CreditPurchaseWire>(
        {
          principal,
          idempotencyKey,
          endpoint: 'POST /credit-packages/:key/purchase',
          // Hash over client-supplied params only — `intent.id` is
          // server-generated and differs per Stripe call (under the same
          // idempotency key Stripe returns the SAME intent.id, but the
          // replay path skips Stripe entirely, so we never re-read it).
          requestHash: hashRequestBody({ key, body }),
          // Drop the per-dog credits cache (§3 invalidation map; Day-8
          // deferred this key for Day-14). The cache reads
          // `dog_credit_balance` which is now stale post-purchase.
          patternsToInvalidate: (wire) =>
            wire.charge_status === 'succeeded' ? [`credits:${body.dog_id}:*`] : [],
        },
        async (tx) => {
          const charge = await chargesRepository.create(tx, {
            ownerId: principal.ownerId,
            amountCents: intent.amountCents,
            status: chargeStatus,
            purpose: 'package',
            stripePaymentIntentId: intent.id,
          });

          if (chargeStatus === 'succeeded') {
            // §J.3: an alumni dog's lot never expires — skip the window read
            // entirely. Otherwise stamp from credit_expiry_settings
            // (per-location → org-default → code default), read inside this tx.
            // 1-credit packs never expire either (helper returns null).
            const dogIsAlumni = await dogProgramsRepository.isAlumni(body.dog_id, tx);
            // Expiry keys off the TOTAL granted: 10 × the never-expiring
            // single-day pack is a bulk buy and gets the multi-credit window.
            const expiresAt = dogIsAlumni
              ? null
              : resolvePurchaseExpiry(
                  grantCredits,
                  await creditExpirySettingsRepository.resolveExpiryWindowMonths(pkg.location, tx),
                  nowFactory(),
                );
            await creditLedgerRepository.creditPurchase(tx, {
              dogId: body.dog_id,
              mode: pkg.mode,
              location: pkg.location,
              delta: grantCredits,
              packageId: pkg.id,
              chargeId: charge.id,
              // Stamped once at purchase (non-retroactive).
              expiresAt,
            });
          }

          return {
            status: 201,
            body: {
              charge_id: charge.id,
              charge_status: chargeStatus,
              stripe_payment_intent_id: intent.id,
              client_secret: intent.clientSecret,
              credits_granted: chargeStatus === 'succeeded' ? grantCredits : 0,
            },
          };
        },
      );

      // Belt-and-suspenders: even when `patternsToInvalidate` is empty
      // (status != succeeded), make sure stale `credits:*` from a prior
      // session's cache layer doesn't persist past a retry that goes
      // from requires_payment → (eventually webhook → succeeded).
      // Day-15's webhook owns that flip's invalidation; this is a
      // belt for the Day-14 sync-confirm window.
      if (!outcome.replayed && outcome.body.charge_status !== 'succeeded') {
        try {
          await invalidatePattern(`credits:${body.dog_id}:*`);
        } catch {
          // ignore — best-effort cleanup
        }
      }

      reply.code(outcome.status);
      return outcome.body;
    },
  );
}

/**
 * Resolve the (package, dog ownership, Stripe pm context) tuple for a
 * purchase. The Stripe pm-context half (payment_method + stripe_customer)
 * is shared with `POST /invoices/:id/pay` + B&T `confirm-payment` and
 * lives in `lib/loadStripePaymentContext.ts` (rule-of-two extract Day-15).
 *
 * 404 collapses for "missing" + "not yours" + "expired" / "retired" — id
 * enumeration is the security concern; the wire response carries the
 * same shape across all four cases.
 */
async function loadPurchaseContext(args: {
  key: string;
  location: LocationKey;
  ownerId: string;
  dogId: string;
  paymentMethodId: string;
  today: string;
}): Promise<{
  pkg: {
    id: string;
    key: string;
    location: LocationKey;
    mode: BookingMode;
    credits: number;
    price_cents: number;
  };
  stripeCustomerId: string;
  stripePaymentMethodId: string;
}> {
  const pkg = await creditPackagesRepository.findByKey(db, args.key, args.location, args.today);
  if (pkg === undefined) {
    throw new ApiError('not_found', `credit package ${args.key} not found or retired`);
  }

  const dogOwned = await dogsRepository.findOwnedExists(args.dogId, args.ownerId, db);
  if (!dogOwned) {
    throw new ApiError('not_found', `dog ${args.dogId} not found`);
  }

  const stripeCtx = await loadStripePaymentContext({
    ownerId: args.ownerId,
    paymentMethodId: args.paymentMethodId,
  });

  return {
    pkg,
    stripeCustomerId: stripeCtx.stripeCustomerId,
    stripePaymentMethodId: stripeCtx.stripePaymentMethodId,
  };
}

function parseKeyParam(params: unknown): { key: string } {
  const parsed = keyParamSchema.safeParse(params);
  if (!parsed.success) {
    throw new ApiError('bad_request', `invalid path: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}

function parsePackagesQuery(query: unknown): { location: LocationKey } {
  const parsed = packagesQuerySchema.safeParse(query);
  if (!parsed.success) {
    throw new ApiError('bad_request', `invalid query: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}

function parsePurchaseBody(body: unknown): z.infer<typeof purchaseBodySchema> {
  const parsed = purchaseBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError('bad_request', `invalid body: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}
