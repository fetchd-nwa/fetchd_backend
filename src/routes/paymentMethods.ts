import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import {
  paymentMethodsRepository,
  type PaymentMethodRow,
} from '../db/repositories/paymentMethodsRepository.js';
import { stripeCustomersRepository } from '../db/repositories/stripeCustomersRepository.js';
import { owners } from '../db/schema/schema.js';
import { ApiError } from '../lib/errors.js';
import { hashRequestBody, requireIdempotencyKey, withMutation } from '../db/mutation.js';
import { requireOwner } from '../lib/principalNarrows.js';
import { defaultStripeClient, type StripeClient } from '../lib/stripe.js';
import { materializePaymentMethod } from '../lib/materializePaymentMethod.js';
import { formatZodIssues } from '../lib/zodIssues.js';
import type { Expect, Equal } from '../contracts/typeAsserts.js';
import type {
  PatchPaymentMethodsRequest,
  PaymentMethodWire,
  PostPaymentMethodsConfirmRequest,
  PostPaymentMethodsSetupIntentResponse,
} from '../contracts/wire.js';

/**
 * `GET /payment-methods` `[auth]` — owner's stored cards (DATA-CONTRACT §C
 * payments + §B PaymentMethod). Owner-scoped through `payment_methods.
 * owner_id`; staff principals get an empty list (staff have no cards-of-
 * record in this surface — Day-9 mutations are owner-only too).
 *
 * Day 14 adds the write surface (HANDOFF §4.2):
 *   - POST /payment-methods/setup-intent — lazy-provision Stripe
 *     customer + create a SetupIntent. FE confirms client-side via
 *     Stripe Elements; the resulting payment_method id flows through
 *     Day-15's webhook to write the payment_methods row.
 *   - PATCH /payment-methods/:id — default-card toggle. The partial
 *     unique `payment_methods_one_default` is preserved by a
 *     clear-then-set sequence inside the same tx.
 *   - DELETE /payment-methods/:id — soft-expire (`expired_at = now()`);
 *     the post-commit Stripe detach is best-effort (logged + swallowed).
 *
 * Wire shape is the flat 7-key row from the FE's
 * `paymentMethodRepository.ts` Raw type. No wire helper needed today
 * (one call site with no optional keys); promote to
 * `lib/paymentMethodWire.ts` if a third call site appears.
 */

/**
 * Promoted to `contracts/wire.ts` in 1.13.0 (§6). Re-exported, not redeclared,
 * so this module's public surface is unchanged for any future importer.
 */
export type { PaymentMethodWire } from '../contracts/wire.js';

export interface PaymentMethodsRouteOptions extends AuthRouteOptions {
  /**
   * Stripe seam (Day 14). Contract tests inject an in-memory stub so the
   * suite stays offline; production wires `defaultStripeClient` which
   * reaches the real Stripe API via `env.STRIPE_SECRET_KEY`.
   */
  stripe?: StripeClient;
}

const uuidParamSchema = z.object({ id: z.string().uuid('id must be a UUID') });

const patchBodySchema = z.object({ is_default: z.literal(true) }).strict();

const confirmBodySchema = z.object({ setup_intent_id: z.string().min(1) }).strict();

/**
 * §5.1.3 Zod ↔ wire request-body pins. `z.input`, not `z.infer` — the wire
 * documents what a client may SEND. Exported so no unused-locals rule can eat
 * them. If either flips red, the WIRE TYPE is wrong, never the schema (§14.1).
 */
export type PatchPaymentMethodsBodyConformance = Expect<
  Equal<z.input<typeof patchBodySchema>, PatchPaymentMethodsRequest>
>;
export type PostPaymentMethodsConfirmBodyConformance = Expect<
  Equal<z.input<typeof confirmBodySchema>, PostPaymentMethodsConfirmRequest>
>;

export function registerPaymentMethodsRoute(
  app: FastifyInstance,
  opts: PaymentMethodsRouteOptions = {},
): void {
  const authHook = resolveAuthHook(opts);
  const stripe = opts.stripe ?? defaultStripeClient;

  // --- GET /payment-methods --------------------------------------------
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

  // --- POST /payment-methods/setup-intent ------------------------------
  //
  // Provisions a Stripe customer for the owner (lazy — first-card flow)
  // then mints a SetupIntent. Two Stripe calls (`customers.create` +
  // `setupIntents.create`) flank the DB tx because they need to surface
  // their outputs (customer_id, client_secret) to the response. Both
  // use the same Idempotency-Key so a retry returns the same artifacts.
  //
  // Idempotency contract:
  //   - First call: Stripe customer created → row inserted → SI created
  //   - Retry with same key: `withIdempotency` returns the stored body
  //     verbatim (no Stripe round-trip, no DB writes)
  //   - Mismatched body on same key: `withIdempotency` returns 422
  //
  // The customer pre-create lives OUTSIDE the tx because Stripe is the
  // ultimate source of identity for the customer id, and we want the
  // DB INSERT to record what Stripe minted (not vice versa). If the
  // tx fails after Stripe minted a customer, we orphan one Stripe
  // customer — acceptable; the next retry re-uses the same id via the
  // Stripe-side idempotency key.
  app.post(
    '/payment-methods/setup-intent',
    { preHandler: [authHook] },
    async (request, reply): Promise<PostPaymentMethodsSetupIntentResponse> => {
      const principal = requirePrincipal(request);
      requireOwner(principal, 'create a setup intent');
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);

      // cache-noop: stripe_customers + payment_methods aren't in the §3
      // cache map (Day-8 `lib/cache.ts`); payment_methods rows are only
      // written here / by Day-15 webhook, never cached.
      const outcome = await withMutation<PostPaymentMethodsSetupIntentResponse>(
        {
          principal,
          idempotencyKey,
          endpoint: 'POST /payment-methods/setup-intent',
          // No request body; the hash pins the (endpoint, owner) tuple so a
          // retry with no body still detects state mismatches.
          requestHash: hashRequestBody({ ownerId: principal.ownerId }),
        },
        async (tx) => {
          let customerRow = await stripeCustomersRepository.findByOwner(tx, principal.ownerId);
          if (customerRow === undefined) {
            // Inline owner read: no `ownersRepository` exists yet (today /me
            // queries owners directly). This is the second site reading the
            // owner row outside /me; if a third appears, extract.
            const [owner] = await tx
              .select({ name: owners.name, email: owners.email })
              .from(owners)
              .where(eq(owners.id, principal.ownerId))
              .limit(1);
            if (owner === undefined) {
              throw new ApiError('not_found', `owner ${principal.ownerId} not found`);
            }
            const created = await stripe.createCustomer(
              {
                email: owner.email,
                name: owner.name,
                ownerId: principal.ownerId,
              },
              `${idempotencyKey}:customer`,
            );
            customerRow = await stripeCustomersRepository.create(tx, {
              ownerId: principal.ownerId,
              stripeCustomerId: created.id,
            });
          }

          const intent = await stripe.createSetupIntent(
            { customerId: customerRow.stripeCustomerId },
            `${idempotencyKey}:setup-intent`,
          );

          return {
            status: 201,
            body: { setup_intent_id: intent.id, client_secret: intent.clientSecret },
          };
        },
      );

      reply.code(outcome.status);
      return outcome.body;
    },
  );

  // --- POST /payment-methods/confirm -----------------------------------
  //
  // Synchronous counterpart to the `setup_intent.succeeded` webhook. The FE
  // confirms the SetupIntent client-side (Stripe Elements), then POSTs its id
  // here so the card row materializes immediately — no waiting on an async
  // webhook for the "card added" UX. The webhook stays wired as the backstop;
  // both converge on `materializePaymentMethod`, idempotent by
  // stripe_payment_method_id, so a confirm + a webhook racing on the same card
  // collapse to one row.
  //
  // Trust model: the client supplies a `setup_intent_id`, never a
  // payment_method id. We retrieve the SetupIntent from Stripe and verify
  //   (a) status === 'succeeded' (the card actually attached), and
  //   (b) its customer maps to THIS owner (tenancy gate — a client can't
  //       confirm someone else's SetupIntent onto their own account).
  // The displayable card bits (brand/last4/exp) come from Stripe's
  // `retrievePaymentMethod`, never the client.
  //
  // Returns the full owner card list (mirrors GET + PATCH) so the FE replaces
  // its cache with canonical post-confirm state in one round-trip.
  app.post(
    '/payment-methods/confirm',
    { preHandler: [authHook] },
    async (request, reply): Promise<PaymentMethodWire[]> => {
      const principal = requirePrincipal(request);
      requireOwner(principal, 'confirm a payment method');
      const { setup_intent_id } = parseConfirmBody(request.body);
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);

      // cache-noop: payment_methods not in the §3 cache map.
      const outcome = await withMutation<PaymentMethodWire[]>(
        {
          principal,
          idempotencyKey,
          endpoint: 'POST /payment-methods/confirm',
          requestHash: hashRequestBody({ setupIntentId: setup_intent_id }),
        },
        async (tx) => {
          // The owner must already have a Stripe customer (the setup-intent
          // route provisions it before the FE can confirm). Absence here means
          // the client skipped the setup-intent step — malformed flow.
          const customerRow = await stripeCustomersRepository.findByOwner(tx, principal.ownerId);
          if (customerRow === undefined) {
            throw new ApiError(
              'bad_request',
              'no Stripe customer on file; request a setup intent before confirming',
            );
          }

          // All Stripe calls live inside the mutation closure so a replay with
          // the same Idempotency-Key returns the stored body without re-hitting
          // Stripe (mirrors the setup-intent route).
          const intent = await stripe.retrieveSetupIntent(setup_intent_id);
          if (intent.status !== 'succeeded' || intent.paymentMethodId === null) {
            throw new ApiError(
              'bad_request',
              `setup intent ${setup_intent_id} is not a completed card setup (status ${intent.status})`,
            );
          }
          if (intent.customerId !== customerRow.stripeCustomerId) {
            // Tenancy gate. 404 rather than 403 so a probe can't confirm that
            // someone else's SetupIntent exists (same convention as :id reads).
            throw new ApiError('not_found', `setup intent ${setup_intent_id} not found`);
          }

          const snapshot = await stripe.retrievePaymentMethod(intent.paymentMethodId);
          await materializePaymentMethod(tx, { ownerId: principal.ownerId, snapshot });

          const rows = await paymentMethodsRepository.findLiveByOwner(principal.ownerId, tx);
          return { status: 200, body: rows.map(toPaymentMethodWire) };
        },
      );

      reply.code(outcome.status);
      return outcome.body;
    },
  );

  // --- PATCH /payment-methods/:id --------------------------------------
  //
  // Today: `is_default: true` is the only legal mutation. Empty bodies
  // and any other field are 400 (Zod `.strict()`). The clear-then-set
  // sequence inside one tx keeps the partial unique
  // `payment_methods_one_default` happy regardless of whether another
  // default existed first.
  //
  // Returns the new full owner card list (mirrors GET /payment-methods)
  // so the FE applies the default-flip optimistically and then receives
  // the canonical post-mutation state in one round-trip.
  app.patch(
    '/payment-methods/:id',
    { preHandler: [authHook] },
    async (request, reply): Promise<PaymentMethodWire[]> => {
      const principal = requirePrincipal(request);
      requireOwner(principal, 'edit a payment method');
      const { id } = parseUuidParam(request.params);
      const body = parsePatchBody(request.body);
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);

      // cache-noop: payment_methods not in the §3 cache map.
      const outcome = await withMutation<PaymentMethodWire[]>(
        {
          principal,
          idempotencyKey,
          endpoint: 'PATCH /payment-methods/:id',
          requestHash: hashRequestBody({ id, body }),
        },
        async (tx) => {
          // Verify the row exists + is owned + is live BEFORE the partial-
          // unique mutation so a 404 doesn't accidentally clear someone
          // else's default. Same shape DELETE uses.
          const target = await paymentMethodsRepository.findLiveByIdForOwner(tx, {
            id,
            ownerId: principal.ownerId,
          });
          if (target === undefined) {
            throw new ApiError('not_found', `payment method ${id} not found`);
          }
          // Idempotent fast-path: already the default → still re-emit the
          // canonical list. (Skipping the clear/set saves a write but the
          // `withIdempotency` wrapper already handles replay; this also
          // covers a stale-state retry that lost the idempotency key.)
          if (!target.isDefault) {
            await paymentMethodsRepository.clearDefault(tx, principal.ownerId);
            const updated = await paymentMethodsRepository.setDefault(tx, {
              id,
              ownerId: principal.ownerId,
            });
            if (updated === undefined) {
              throw new Error(`PATCH /payment-methods/${id}: row vanished after setDefault`);
            }
          }

          const rows = await paymentMethodsRepository.findLiveByOwner(principal.ownerId, tx);
          return { status: 200, body: rows.map(toPaymentMethodWire) };
        },
      );

      reply.code(outcome.status);
      return outcome.body;
    },
  );

  // --- DELETE /payment-methods/:id -------------------------------------
  //
  // Soft-expire the card + zero is_default; post-commit Stripe detach is
  // best-effort. Returns 204 (no body) so the FE applies the removal
  // optimistically and refetches the list separately if needed.
  app.delete('/payment-methods/:id', { preHandler: [authHook] }, async (request, reply) => {
    const principal = requirePrincipal(request);
    requireOwner(principal, 'delete a payment method');
    const { id } = parseUuidParam(request.params);
    const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);

    // cache-noop: payment_methods not in the §3 cache map.
    const outcome = await withMutation<{ stripePaymentMethodId: string } | null>(
      {
        principal,
        idempotencyKey,
        endpoint: 'DELETE /payment-methods/:id',
        requestHash: hashRequestBody({ id }),
        // Post-commit Stripe detach — best-effort. `MutationParams.postCommit`
        // owns the swallow + log + skip-on-replay boilerplate; the DB
        // soft-expire is the source of truth, Day-15 webhook reconciliation
        // catches drift if the detach fails.
        postCommit: async (body) => {
          if (body === null) return;
          await stripe.detachPaymentMethod(body.stripePaymentMethodId);
        },
      },
      async (tx) => {
        const expired = await paymentMethodsRepository.softExpire(tx, {
          id,
          ownerId: principal.ownerId,
        });
        if (expired === undefined) {
          throw new ApiError('not_found', `payment method ${id} not found`);
        }
        return {
          status: 204,
          body: { stripePaymentMethodId: expired.stripePaymentMethodId },
        };
      },
    );

    reply.code(outcome.status);
    return outcome.status === 204 ? undefined : outcome.body;
  });
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

function parseUuidParam(params: unknown): { id: string } {
  const parsed = uuidParamSchema.safeParse(params);
  if (!parsed.success) {
    throw new ApiError('bad_request', `invalid path: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}

function parsePatchBody(body: unknown): z.infer<typeof patchBodySchema> {
  const parsed = patchBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError('bad_request', `invalid body: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}

function parseConfirmBody(body: unknown): z.infer<typeof confirmBodySchema> {
  const parsed = confirmBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError('bad_request', `invalid body: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}
