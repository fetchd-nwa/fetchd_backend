import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import { actorOf } from '../auth/principal.js';
import type {
  ApiErrorEnvelope,
  CreditPackageWire,
  CreditPurchaseWire,
  GetCreditPackagesQuery,
  PostCreditPackagesPurchaseRequest,
} from '../contracts/wire.js';
import type { Equal, Expect } from '../contracts/typeAsserts.js';
import { creditPackagesRepository } from '../db/repositories/creditPackagesRepository.js';
import { creditsInvalidationPattern } from '../db/repositories/creditsRepository.js';
import { settingsRepository } from '../db/repositories/settingsRepository.js';
import { LOCATION_SLUGS } from '../db/schema/schema.js';
import { ApiError } from '../lib/errors.js';
import { bucketChicagoToday } from '../lib/chicagoDate.js';
import { peekEngineClaim } from '../db/idempotency.js';
import { hashRequestBody, requireIdempotencyKey } from '../db/mutation.js';
import type { Tx } from '../db/tx.js';
import { invalidateAll } from '../lib/cache.js';
import { confirmCharge } from '../lib/confirmCharge.js';
import { loadStripePaymentContext } from '../lib/loadStripePaymentContext.js';
import { requireOwner } from '../lib/principalNarrows.js';
import { defaultStripeClient, type StripeClient } from '../lib/stripe.js';
import { uuidId } from '../lib/uuidId.js';
import { formatZodIssues } from '../lib/zodIssues.js';

const LOCATION_KEYS = LOCATION_SLUGS;
type LocationKey = (typeof LOCATION_KEYS)[number];

/**
 * `GET /credit-packages` `[auth]` — the active catalog of purchasable
 * credit packs (DATA-CONTRACT §B CreditPackage Δ 2026-05-20).
 *
 * `POST /credit-packages/:key/purchase` `[auth, $]` — on the order engine: one order and
 * one charge written before Stripe, settled by the route, the webhook or the sweeper
 * through the one settle statement. The credits land in the owner's pool for the row's
 * campus, program and tier, and no dog is named.
 *
 * A pack is bought one at a time. A row with `single_day` true is sold by
 * `count` (1..`cred.single_day_purchase_max_count`), in one charge and one
 * lot; `count` on any other row is 422 `count_not_allowed` (CRED-U04).
 *
 * Catalog endpoint: both owner and staff principals get the same data
 * (rates + packages are reference data, not user data). Retirement is
 * `active = false` on the row — never DELETE; the wire filter is
 * server-side so retired packs never surface even if a stale client
 * caches one.
 */

// `CreditPackageWire` used to be declared right here. Since 1.13.0 it lives in
// `contracts/wire.ts` (shape unchanged by the move) and this route re-exports
// it, exactly like the `CreditPurchaseWire` note below.
export type { CreditPackageWire };

// `CreditPurchaseWire` used to be declared right here — a money response
// outside the versioned contract, which is why no client's `check:contracts`
// could ever guard it. Since 1.8.0 it lives in `contracts/wire.ts` (shape
// unchanged by the move) and this route imports it like every other wire type.

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

// The catalog is per-location since the Δ 2026-06-04 (pricing varies by school).
// A purchase names only the row, which carries its campus (CRED-U04).
const packagesQuerySchema = z.object({ location: z.enum(LOCATION_KEYS) });

/** Zod ↔ wire pin for the catalog query (design §5.1.3, `z.input`). */
export type GetCreditPackagesQueryConformance = Expect<
  Equal<z.input<typeof packagesQuerySchema>, GetCreditPackagesQuery>
>;

const purchaseBodySchema = z
  .object({
    payment_method_id: uuidId('payment_method_id must be a UUID'),
    // Above `cred.single_day_purchase_max_count`, or on a pack, is 422
    // `count_not_allowed` from the row: only the shape is refused here.
    count: z.number().int().positive().optional(),
  })
  .strict();

/**
 * Zod ↔ wire pin for the purchase body (design §5.1.3). `z.input`: `count` is
 * optional to a client, and the handler reads it as 1 when it is omitted.
 */
export type PostCreditPackagesPurchaseBodyConformance = Expect<
  Equal<z.input<typeof purchaseBodySchema>, PostCreditPackagesPurchaseRequest>
>;

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
  // One order, one charge, `cancel-order` (design §2.4:2978-3022; `lib/confirmCharge.ts`
  // holds the protocol). The charge is written before Stripe with what was bought frozen
  // on it, so whichever of the route, the webhook or the sweeper settles it grants exactly
  // that, once. A `processing` intent stays live: the arm is the answer, never a cancel.
  app.post(
    '/credit-packages/:key/purchase',
    { preHandler: [authHook] },
    async (request, reply): Promise<CreditPurchaseWire | ApiErrorEnvelope> => {
      const principal = requirePrincipal(request);
      requireOwner(principal, 'purchase credits');
      const { key } = parseKeyParam(request.params);
      const body = parsePurchaseBody(request.body);
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
      const endpoint = 'POST /credit-packages/:key/purchase';
      const requestHash = hashRequestBody({ key, ...body });

      // A stored answer replays, a stored 402 included; an open claim is 409.
      const replay = await peekEngineClaim<CreditPurchaseWire | ApiErrorEnvelope>(
        idempotencyKey,
        endpoint,
        requestHash,
        principal.ownerId,
      );
      if (replay !== undefined) {
        reply.code(replay.status);
        return replay.body;
      }

      const result = await confirmCharge<CreditPurchaseWire>(
        {
          actor: actorOf(principal),
          ownerId: principal.ownerId,
          claim: { key: idempotencyKey, ownerId: principal.ownerId, endpoint, requestHash },
          // A refusal here rolls tx1 back: no order, no claim, no Stripe call.
          inTx1: async (tx) => {
            const today = bucketChicagoToday(nowFactory());
            const pkg = await creditPackagesRepository.findByKey(tx, key, today);
            if (pkg === undefined) {
              throw new ApiError('not_found', `credit package ${key} not found or retired`);
            }
            if (body.count !== undefined) await assertCountAllowed(tx, pkg, body.count);
            const count = body.count ?? 1;
            // The ownership check too: a card that is not a live card of hers is the generic 404.
            const card = await loadStripePaymentContext(
              { ownerId: principal.ownerId, paymentMethodId: body.payment_method_id },
              tx,
            );
            return {
              amountCents: pkg.price_cents * count,
              purpose: 'package',
              bookingId: null,
              cohortId: null,
              dogId: null,
              packageId: pkg.id,
              creditsCount: pkg.credits * count,
              card: { ...card, paymentMethodId: body.payment_method_id },
            };
          },
          stripe,
          log: request.log,
          now: opts.now,
        },
        'cancel-order',
      );

      switch (result.kind) {
        case 'answered':
          await invalidateAll([creditsInvalidationPattern(principal.ownerId)], request.log);
          reply.code(result.status);
          return result.body;
        case 'processing':
          // Not stored: the claim stays open, so a same-key request answers 409 until the
          // order settles, and the final answer is what it then replays.
          reply.code(201);
          return {
            charge_id: result.chargeId,
            charge_status: 'requires_payment',
            stripe_payment_intent_id: result.intent.id,
            client_secret: result.intent.clientSecret,
            credits_granted: 0,
            charge_blocker: 'processing',
          };
        case 'open':
          throw new ApiError(
            'idempotency_inflight',
            'this purchase has no answer yet: re-send it under the same Idempotency-Key',
          );
      }
    },
  );
}

/**
 * `count` is the single days of one purchase: a pack is bought one at a time, so any
 * `count` on one is refused, `count: 1` included. The limit is read here, never a
 * constant: `cred.single_day_purchase_max_count` is staff-editable (§3.5).
 */
async function assertCountAllowed(
  tx: Tx,
  pkg: { single_day: boolean },
  count: number,
): Promise<void> {
  if (!pkg.single_day) {
    throw new ApiError('count_not_allowed', 'a pack is bought one at a time');
  }
  const { single_day_purchase_max_count: limit } = await settingsRepository.credit(tx);
  if (count > limit) {
    throw new ApiError('count_not_allowed', `at most ${limit} single days in one purchase`);
  }
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
