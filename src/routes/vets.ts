import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePrincipal, resolveAuthHook, type AuthRouteOptions } from '../auth/plugin.js';
import { hashRequestBody, requireIdempotencyKey, withMutation } from '../db/mutation.js';
import { vetsRepository } from '../db/repositories/vetsRepository.js';
import { ApiError } from '../lib/errors.js';
import { toVetWire, type VetWire } from '../lib/vetWire.js';
import { formatZodIssues } from '../lib/zodIssues.js';

/**
 * `GET /vets?q=` `[auth]` — vet typeahead. The create-dog flow searches
 * this FIRST so owners pick an existing row instead of duplicating a
 * clinic (DATA-CONTRACT §A vets amendment: "de-dup is a create-flow
 * concern, never a DB constraint").
 *
 * `GET /vets/:id` `[auth]` — single-vet read. Mirrors the POST/PATCH
 * response wire shape; 404 if the row is soft-expired or missing
 * (deferred from Day 7b — landed alongside the mutations that produce
 * the same shape).
 *
 * `POST /vets` `[auth]` — owner/staff create-if-missing. `source='app'`
 * always (the seed/Gingr import path is staff-tooling, not this route).
 * No DB unique constraint; dedup is a create-flow concern on the FE.
 *
 * `PATCH /vets/:id` `[staff]` — staff-only edit. A vet row is shared
 * across many owners; one owner must not be able to rename/expire it.
 *
 * `DELETE /vets/:id` `[staff]` — staff-only soft-expire. **Blocked** if
 * any live dog still names this vet as `primary_vet_id` (409 conflict).
 * Owners must reassign first — the §A amendment's API-block guard.
 *
 * Day 9b lands the first mutation surface composing `withMutation`. Every
 * write declares `keysToInvalidate: () => []` as the convention seam per
 * Day-8's invalidation map — vets aren't in scope for any current cached
 * read, but adding the callback site means a future cached read added
 * near these mutations isn't silently missing its invalidation.
 */

const VET_SEARCH_LIMIT = 50;

const searchQuerySchema = z.object({
  q: z.string().trim().min(1).optional(),
});

const paramsSchema = z.object({
  id: z.string().uuid(),
});

// Optional text fields accept `null` to clear explicitly OR a string that
// the server then normalizes (empty/whitespace → null). `name` is required
// (NOT NULL in DB) and must be a non-empty trimmed string.
const optionalText = z.string().nullable();

const postBodySchema = z
  .object({
    name: z.string().trim().min(1),
    phone: optionalText.optional(),
    email: optionalText.optional(),
    address: optionalText.optional(),
    notes: optionalText.optional(),
  })
  .strict();

const patchBodySchema = z
  .object({
    name: z.string().trim().min(1),
    phone: optionalText,
    email: optionalText,
    address: optionalText,
    notes: optionalText,
  })
  .strict()
  .partial();

/** Empty/whitespace strings collapse to `null` so `toVetWire`'s omit-on-null convention round-trips. */
function normalizeOptional(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function requireStaff(
  principal: ReturnType<typeof requirePrincipal>,
  action: 'edit' | 'delete',
): void {
  if (principal.kind !== 'staff') {
    throw new ApiError('forbidden', `only staff may ${action} vets`);
  }
}

export function registerVetsRoute(app: FastifyInstance, opts: AuthRouteOptions = {}): void {
  const authHook = resolveAuthHook(opts);

  app.get('/vets', { preHandler: [authHook] }, async (request): Promise<VetWire[]> => {
    const parsed = searchQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw new ApiError('bad_request', `invalid query: ${formatZodIssues(parsed.error)}`);
    }
    const rows = await vetsRepository.search(parsed.data.q, VET_SEARCH_LIMIT);
    return rows.map(toVetWire);
  });

  app.get('/vets/:id', { preHandler: [authHook] }, async (request): Promise<VetWire> => {
    const parsedParams = paramsSchema.safeParse(request.params);
    if (!parsedParams.success) {
      throw new ApiError('bad_request', `invalid vet id: ${formatZodIssues(parsedParams.error)}`);
    }
    const row = await vetsRepository.findById(parsedParams.data.id);
    if (!row) {
      throw new ApiError('not_found', 'vet not found');
    }
    return toVetWire(row);
  });

  app.post('/vets', { preHandler: [authHook] }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);

    const parsed = postBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('bad_request', `invalid vet payload: ${formatZodIssues(parsed.error)}`);
    }

    const values = {
      // Zod's `.trim().min(1)` already produced a non-empty trimmed name.
      name: parsed.data.name,
      phone: normalizeOptional(parsed.data.phone) ?? null,
      email: normalizeOptional(parsed.data.email) ?? null,
      address: normalizeOptional(parsed.data.address) ?? null,
      notes: normalizeOptional(parsed.data.notes) ?? null,
    };

    const outcome = await withMutation<VetWire>(
      {
        principal,
        idempotencyKey,
        endpoint: 'POST /vets',
        requestHash: hashRequestBody(parsed.data),
        keysToInvalidate: () => [],
      },
      async (tx) => {
        const row = await vetsRepository.create(tx, values);
        return { status: 201, body: toVetWire(row) };
      },
    );

    reply.code(outcome.status);
    return outcome.body;
  });

  app.patch('/vets/:id', { preHandler: [authHook] }, async (request, reply) => {
    const principal = requirePrincipal(request);
    requireStaff(principal, 'edit');

    const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);

    const parsedParams = paramsSchema.safeParse(request.params);
    if (!parsedParams.success) {
      throw new ApiError('bad_request', `invalid vet id: ${formatZodIssues(parsedParams.error)}`);
    }

    const parsed = patchBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('bad_request', `invalid vet patch: ${formatZodIssues(parsed.error)}`);
    }

    const set: Parameters<typeof vetsRepository.update>[2] = {};
    // Zod's `.trim().min(1)` produced a non-empty trimmed name when present.
    if (parsed.data.name !== undefined) set.name = parsed.data.name;
    if (parsed.data.phone !== undefined) set.phone = normalizeOptional(parsed.data.phone) ?? null;
    if (parsed.data.email !== undefined) set.email = normalizeOptional(parsed.data.email) ?? null;
    if (parsed.data.address !== undefined)
      set.address = normalizeOptional(parsed.data.address) ?? null;
    if (parsed.data.notes !== undefined) set.notes = normalizeOptional(parsed.data.notes) ?? null;

    if (Object.keys(set).length === 0) {
      throw new ApiError('bad_request', 'no updatable fields in request body');
    }

    const outcome = await withMutation<VetWire>(
      {
        principal,
        idempotencyKey,
        endpoint: 'PATCH /vets/:id',
        requestHash: hashRequestBody({ id: parsedParams.data.id, patch: parsed.data }),
        keysToInvalidate: () => [],
      },
      async (tx) => {
        const row = await vetsRepository.update(tx, parsedParams.data.id, set);
        if (!row) {
          throw new ApiError('not_found', 'vet not found');
        }
        return { status: 200, body: toVetWire(row) };
      },
    );

    reply.code(outcome.status);
    return outcome.body;
  });

  app.delete('/vets/:id', { preHandler: [authHook] }, async (request, reply) => {
    const principal = requirePrincipal(request);
    requireStaff(principal, 'delete');

    const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);

    const parsedParams = paramsSchema.safeParse(request.params);
    if (!parsedParams.success) {
      throw new ApiError('bad_request', `invalid vet id: ${formatZodIssues(parsedParams.error)}`);
    }

    const outcome = await withMutation<null>(
      {
        principal,
        idempotencyKey,
        endpoint: 'DELETE /vets/:id',
        requestHash: hashRequestBody({ id: parsedParams.data.id }),
        keysToInvalidate: () => [],
      },
      async (tx) => {
        // `FOR UPDATE` on the vet row at the top of the txn — Day-9b's
        // half of the prophylactic race closure. Day-9c's PATCH/POST
        // /dogs `FOR SHARE` on the same row to participate; see the
        // `findByIdForUpdate` doc for the full lock semantics.
        const existing = await vetsRepository.findByIdForUpdate(parsedParams.data.id, tx);
        if (!existing) {
          throw new ApiError('not_found', 'vet not found');
        }
        if (await vetsRepository.hasLiveDogReferences(parsedParams.data.id, tx)) {
          throw new ApiError(
            'conflict',
            'vet is referenced by one or more live dogs; reassign primary_vet_id before deletion',
          );
        }
        await vetsRepository.softExpire(tx, parsedParams.data.id);
        return { status: 204, body: null };
      },
    );

    reply.code(outcome.status);
    return outcome.body;
  });
}
