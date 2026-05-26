import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePrincipal, resolveAuthHook, type AuthRouteOptions } from '../auth/plugin.js';
import { hashRequestBody, requireIdempotencyKey, withMutation } from '../db/mutation.js';
import {
  dogFeedingRepository,
  type FeedingValues,
} from '../db/repositories/dogFeedingRepository.js';
import {
  dogMedicationsRepository,
  type MedicationUpdate,
} from '../db/repositories/dogMedicationsRepository.js';
import {
  dogVaccinesRepository,
  type VaccineUpdate,
} from '../db/repositories/dogVaccinesRepository.js';
import { dogsRepository, type DogUpdate } from '../db/repositories/dogsRepository.js';
import { requiredVaccinesRepository } from '../db/repositories/requiredVaccinesRepository.js';
import { vetsRepository } from '../db/repositories/vetsRepository.js';
import { evaluationStatus } from '../db/schema/schema.js';
import {
  toDogWire,
  toFeedingWire,
  toMedicationWire,
  toVaccineWire,
  type DogWire,
  type FeedingWire,
  type MedicationWire,
  type VaccineWire,
} from '../lib/dogWire.js';
import { ApiError } from '../lib/errors.js';
import { normalizeOptional } from '../lib/normalize.js';
import { pgEnumTuple } from '../lib/pgEnumTuple.js';
import { requireOwner } from '../lib/principalNarrows.js';
import { parseOrThrow } from '../lib/zodIssues.js';

/**
 * Dogs surface — top-level `/dogs` reads + mutations from Day-9a/9c +
 * the nested resource mutations from Day-9d (vaccines / medications /
 * feeding).
 *
 * Top-level (Day 9a/9c):
 * - `GET /dogs` `[auth]` — every live dog the owner owns; staff get
 *   `[]`. Day-9a thin orchestrator over `dogsRepository.findManyByOwner`
 *   + `toDogWire`.
 * - `GET /dogs/:id` `[auth]` — single-dog read, owner-scoped. 404 for
 *   "no such dog" and "not yours" so ids don't enumerate.
 * - `POST /dogs` — owner create. `primary_vet_id` reassign branch
 *   `FOR SHARE`s the target vet (matches Day-9b's `FOR UPDATE` on
 *   DELETE /vets, closes the cross-route race).
 * - `PATCH /dogs/:id` — owner edit. Same `FOR SHARE` guard on reassign.
 *   `birthdate` / `age_months_override` deliberately NOT in PATCH —
 *   the DB CHECK requires at least one non-null, so safely editing
 *   them needs a paired-clear guard that's still deferred (re-confirmed
 *   Day-9d; the fix lands in Day-10+ once the booking surface clarifies
 *   how birthdate edits interact with active bookings).
 * - `DELETE /dogs/:id` — owner soft-expire. Returns 204. Does NOT
 *   cascade to child rows (vaccines/medications/feeding/completed_
 *   classes stay live in DB but become unreachable through `findById`'s
 *   parent live() filter — preserves `booking_dogs` history).
 *
 * Nested resources (Day 9d):
 * - `POST /dogs/:id/vaccines` · `PATCH /dogs/:id/vaccines/:vid` ·
 *   `DELETE /dogs/:id/vaccines/:vid` — owner-only. Body may set
 *   `requirement_key` (FK to `required_vaccines.key`); the route
 *   validates the key against the live catalog before write
 *   (`requirementKeyIsLive`) and rejects 422 if missing. Parent-dog
 *   ownership via `findOwnedExists`; parent-child guard via
 *   `dogVaccinesRepository.findByIdForDog`. POST/PATCH respond with
 *   the new `VaccineWire` shape (Day-9d §A amendment: `{ id, name,
 *   expires_at, requirement_key? }`).
 * - `POST /dogs/:id/medications` · `PATCH /dogs/:id/medications/:mid`
 *   · `DELETE /dogs/:id/medications/:mid` — symmetric with vaccines,
 *   no `requirement_key` (medications carry no gating catalog today).
 * - `PUT /dogs/:id/feeding` — 1:1 upsert via
 *   `onConflictDoUpdate({ target: dog_feeding.dog_id, set: { ...RELINK,
 *   ... }})`. The canonical second RELINK use case (Day-2 owner/staff
 *   provisioning is the first): a soft-expired feeding row resurrects
 *   in the same statement, preserving the row's `created_at` + audit
 *   chain. No DELETE today — PUT semantics handle replace; "clear
 *   feeding" is YAGNI until a real use case lands.
 *
 * **Mutation-route choreography helper — STILL not extracted at the
 * Day-9d rule-of-10 mark.** Considered an `ownerMutationContext(req,
 * action)` that returns `{ principal, idempotencyKey }` and bundles
 * `requirePrincipal` + `requireOwner` + `requireIdempotencyKey`. The
 * helper would save 3 lines per mutation × 10 mutations = ~30 lines,
 * but: (1) it bundles two orthogonal concerns (auth narrow +
 * idempotency-key extraction) under one name, forcing the next reader
 * to learn what `mutationContext` does instead of seeing the three
 * named calls; (2) the request-hash input varies per verb
 * (`body` for POST, `{id,patch:body}` for PATCH, `{id}` for DELETE),
 * so the helper can't own it cleanly; (3) the `withMutation` call site
 * itself stays — the helper only thins the prelude, not the body. The
 * verbose prelude IS the universal mutation-setup vocabulary; replacing
 * it with a less-honest name doesn't pay. Day-10+ (the booking-txn
 * surface) might revisit if the prelude grows further (e.g. when
 * advisory locks need a per-route lock-key derivation).
 *
 * Every mutation declares `keysToInvalidate: () => []` as the Day-8
 * convention seam — dogs/vaccines/medications/feeding aren't in §3
 * cache map today; `dogprofile:{dogId}` deferred.
 */

const EVALUATION_STATUSES = pgEnumTuple(evaluationStatus);

const paramsSchema = z.object({
  id: z.string().uuid(),
});

const vaccineParamsSchema = z.object({
  id: z.string().uuid(),
  vid: z.string().uuid(),
});

const medicationParamsSchema = z.object({
  id: z.string().uuid(),
  mid: z.string().uuid(),
});

const optionalText = z.string().nullable();
const optionalUuid = z.string().uuid().nullable();
/** ISO date 'YYYY-MM-DD' (Postgres `date`). Trailing time disallowed. */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
/** ISO datetime with timezone offset (Postgres `timestamptz`). */
const optionalEvaluationDate = z.string().datetime({ offset: true }).nullable();
const optionalAgeMonths = z.number().int().positive();

/**
 * POST body for /dogs. The DB CHECK `(birthdate IS NOT NULL OR
 * age_months_override IS NOT NULL)` is enforced explicitly via `.refine`
 * so the error is `bad_request` (Zod parse failure) rather than a raw
 * Postgres `check_violation` 5xx.
 */
const postDogBodySchema = z
  .object({
    name: z.string().trim().min(1),
    breed: z.string().trim().min(1),
    birthdate: isoDate.optional(),
    age_months_override: optionalAgeMonths.optional(),
    primary_vet_id: optionalUuid.optional(),
    special_notes: optionalText.optional(),
    evaluation_status: z.enum(EVALUATION_STATUSES).optional(),
    evaluation_date: optionalEvaluationDate.optional(),
  })
  .strict()
  .refine((body) => body.birthdate !== undefined || body.age_months_override !== undefined, {
    message: 'one of birthdate or age_months_override is required',
    path: ['birthdate'],
  });

const patchDogBodySchema = z
  .object({
    name: z.string().trim().min(1),
    breed: z.string().trim().min(1),
    primary_vet_id: optionalUuid,
    special_notes: optionalText,
    evaluation_status: z.enum(EVALUATION_STATUSES),
    evaluation_date: optionalEvaluationDate,
  })
  .strict()
  .partial();

const postVaccineBodySchema = z
  .object({
    name: z.string().trim().min(1),
    expires_at: isoDate,
    requirement_key: z.string().trim().min(1).nullable().optional(),
  })
  .strict();

const patchVaccineBodySchema = z
  .object({
    name: z.string().trim().min(1),
    expires_at: isoDate,
    requirement_key: z.string().trim().min(1).nullable(),
  })
  .strict()
  .partial();

const postMedicationBodySchema = z
  .object({
    name: z.string().trim().min(1),
    dose: z.string().trim().min(1),
    frequency: z.string().trim().min(1),
  })
  .strict();

const patchMedicationBodySchema = postMedicationBodySchema.partial();

const feedingBodySchema = z
  .object({
    brand: z.string().trim().min(1),
    amount: z.string().trim().min(1),
    frequency: z.string().trim().min(1),
    notes: optionalText.optional(),
  })
  .strict();

export interface DogsRouteOptions extends AuthRouteOptions {
  /**
   * Injectable clock so contract tests get a deterministic `age_months`. A
   * factory (not a `Date`) is the right shape: a captured `Date` at
   * registration time would freeze production's clock. Default factory =
   * `() => new Date()`.
   */
  now?: () => Date;
}

export function registerDogsRoute(app: FastifyInstance, opts: DogsRouteOptions = {}): void {
  const authHook = resolveAuthHook(opts);
  const now = opts.now ?? (() => new Date());

  // ────────────────────────────────────────────────────────────────────
  // Top-level dogs (Day 9a + 9c)
  // ────────────────────────────────────────────────────────────────────

  app.get('/dogs', { preHandler: [authHook] }, async (request): Promise<DogWire[]> => {
    const principal = requirePrincipal(request);
    if (principal.kind !== 'owner') return [];

    const assembled = await dogsRepository.findManyByOwner(principal.ownerId);
    const today = now();
    return assembled.map((d) => toDogWire(d, today));
  });

  app.get('/dogs/:id', { preHandler: [authHook] }, async (request): Promise<DogWire> => {
    const principal = requirePrincipal(request);
    const { id } = parseOrThrow(paramsSchema, request.params, 'dog id');
    // Staff get the same 404 as "not yours / not found" — consistency with
    // GET /dogs returning [] to staff, and so ids don't enumerate.
    if (principal.kind !== 'owner') {
      throw new ApiError('not_found', 'dog not found');
    }
    const assembled = await dogsRepository.findById(id, principal.ownerId);
    if (!assembled) {
      throw new ApiError('not_found', 'dog not found');
    }
    return toDogWire(assembled, now());
  });

  app.post('/dogs', { preHandler: [authHook] }, async (request, reply) => {
    const principal = requirePrincipal(request);
    requireOwner(principal, 'create their dogs');
    const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);

    const body = parseOrThrow(postDogBodySchema, request.body, 'dog payload');
    const primaryVetId = body.primary_vet_id ?? null;
    const values = {
      ownerId: principal.ownerId,
      name: body.name,
      breed: body.breed,
      birthdate: body.birthdate ?? null,
      ageMonthsOverride: body.age_months_override ?? null,
      primaryVetId,
      specialNotes: normalizeOptional(body.special_notes) ?? '',
      evaluationStatus: body.evaluation_status ?? 'not-evaluated',
      evaluationDate: body.evaluation_date ?? null,
    };

    const outcome = await withMutation<DogWire>(
      {
        principal,
        idempotencyKey,
        endpoint: 'POST /dogs',
        requestHash: hashRequestBody(body),
        keysToInvalidate: () => [],
      },
      async (tx) => {
        if (primaryVetId !== null) {
          // FOR SHARE the target vet — matching half of Day-9b's
          // findByIdForUpdate on DELETE /vets. The vet must be live at
          // commit time, not just at request entry.
          const targetVet = await vetsRepository.findByIdForShare(primaryVetId, tx);
          if (!targetVet) {
            throw new ApiError(
              'invalid_payload',
              'primary_vet_id refers to a vet that is not live',
            );
          }
        }
        const created = await dogsRepository.create(tx, values);
        const assembled = await dogsRepository.findById(created.id, principal.ownerId, tx);
        if (!assembled) {
          // Defense in depth: a just-created row matched on (id, ownerId, live)
          // can only fail to re-fetch if a trigger soft-expired it mid-txn,
          // which no existing trigger does. Throw so the txn rolls back rather
          // than emit a wrong wire shape.
          throw new Error('dogs.create: row vanished before re-fetch inside txn');
        }
        return { status: 201, body: toDogWire(assembled, now()) };
      },
    );

    reply.code(outcome.status);
    return outcome.body;
  });

  app.patch('/dogs/:id', { preHandler: [authHook] }, async (request, reply) => {
    const principal = requirePrincipal(request);
    requireOwner(principal, 'edit their dogs');
    const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);

    const { id: dogId } = parseOrThrow(paramsSchema, request.params, 'dog id');
    const body = parseOrThrow(patchDogBodySchema, request.body, 'dog patch');

    const set: DogUpdate = {};
    if (body.name !== undefined) set.name = body.name;
    if (body.breed !== undefined) set.breed = body.breed;
    if (body.primary_vet_id !== undefined) set.primaryVetId = body.primary_vet_id;
    if (body.special_notes !== undefined) {
      // PATCH `special_notes: null` or `''` clears to the schema default ('')
      // — the column is NOT NULL with default '', so we map null → ''.
      set.specialNotes = normalizeOptional(body.special_notes) ?? '';
    }
    if (body.evaluation_status !== undefined) set.evaluationStatus = body.evaluation_status;
    if (body.evaluation_date !== undefined) set.evaluationDate = body.evaluation_date;

    if (Object.keys(set).length === 0) {
      throw new ApiError('bad_request', 'no updatable fields in request body');
    }

    const reassignVetId = body.primary_vet_id;

    const outcome = await withMutation<DogWire>(
      {
        principal,
        idempotencyKey,
        endpoint: 'PATCH /dogs/:id',
        requestHash: hashRequestBody({ id: dogId, patch: body }),
        keysToInvalidate: () => [],
      },
      async (tx) => {
        if (!(await dogsRepository.findOwnedExists(dogId, principal.ownerId, tx))) {
          throw new ApiError('not_found', 'dog not found');
        }
        if (reassignVetId !== undefined && reassignVetId !== null) {
          const targetVet = await vetsRepository.findByIdForShare(reassignVetId, tx);
          if (!targetVet) {
            throw new ApiError(
              'invalid_payload',
              'primary_vet_id refers to a vet that is not live',
            );
          }
        }
        const updated = await dogsRepository.update(tx, dogId, set);
        if (!updated) {
          // findOwnedExists passed but the UPDATE-with-live() filter missed —
          // can only happen if the row was soft-expired between the two reads
          // inside the same tx, which no current trigger does. Map to 404 so
          // the client retry-loop terminates rather than spinning.
          throw new ApiError('not_found', 'dog not found');
        }
        const assembled = await dogsRepository.findById(dogId, principal.ownerId, tx);
        if (!assembled) {
          throw new Error('dogs.patch: row vanished before re-fetch inside txn');
        }
        return { status: 200, body: toDogWire(assembled, now()) };
      },
    );

    reply.code(outcome.status);
    return outcome.body;
  });

  app.delete('/dogs/:id', { preHandler: [authHook] }, async (request, reply) => {
    const principal = requirePrincipal(request);
    requireOwner(principal, 'delete their dogs');
    const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);

    const { id: dogId } = parseOrThrow(paramsSchema, request.params, 'dog id');

    const outcome = await withMutation<null>(
      {
        principal,
        idempotencyKey,
        endpoint: 'DELETE /dogs/:id',
        requestHash: hashRequestBody({ id: dogId }),
        keysToInvalidate: () => [],
      },
      async (tx) => {
        if (!(await dogsRepository.findOwnedExists(dogId, principal.ownerId, tx))) {
          throw new ApiError('not_found', 'dog not found');
        }
        await dogsRepository.softExpire(tx, dogId);
        return { status: 204, body: null };
      },
    );

    reply.code(outcome.status);
    return outcome.body;
  });

  // ────────────────────────────────────────────────────────────────────
  // Nested: vaccines (Day 9d)
  // ────────────────────────────────────────────────────────────────────

  app.post('/dogs/:id/vaccines', { preHandler: [authHook] }, async (request, reply) => {
    const principal = requirePrincipal(request);
    requireOwner(principal, 'create their dogs');
    const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);

    const { id: dogId } = parseOrThrow(paramsSchema, request.params, 'dog id');
    const body = parseOrThrow(postVaccineBodySchema, request.body, 'vaccine payload');
    const requirementKey = normalizeOptional(body.requirement_key) ?? null;

    const outcome = await withMutation<VaccineWire>(
      {
        principal,
        idempotencyKey,
        endpoint: 'POST /dogs/:id/vaccines',
        requestHash: hashRequestBody({ id: dogId, body }),
        keysToInvalidate: () => [],
      },
      async (tx) => {
        if (!(await dogsRepository.findOwnedExists(dogId, principal.ownerId, tx))) {
          throw new ApiError('not_found', 'dog not found');
        }
        if (requirementKey !== null) {
          if (!(await requiredVaccinesRepository.keyIsLive(requirementKey, tx))) {
            throw new ApiError(
              'invalid_payload',
              'requirement_key does not match a live required_vaccines entry',
            );
          }
        }
        const created = await dogVaccinesRepository.create(tx, {
          dogId,
          name: body.name,
          requirementKey,
          expiresAt: body.expires_at,
        });
        return { status: 201, body: toVaccineWire(created) };
      },
    );

    reply.code(outcome.status);
    return outcome.body;
  });

  app.patch('/dogs/:id/vaccines/:vid', { preHandler: [authHook] }, async (request, reply) => {
    const principal = requirePrincipal(request);
    requireOwner(principal, 'edit their dogs');
    const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);

    const { id: dogId, vid } = parseOrThrow(vaccineParamsSchema, request.params, 'dog/vaccine id');
    const body = parseOrThrow(patchVaccineBodySchema, request.body, 'vaccine patch');

    const set: VaccineUpdate = {};
    if (body.name !== undefined) set.name = body.name;
    if (body.expires_at !== undefined) set.expiresAt = body.expires_at;
    let requirementKeyToCheck: string | null | undefined;
    if (body.requirement_key !== undefined) {
      const normalized = normalizeOptional(body.requirement_key) ?? null;
      set.requirementKey = normalized;
      requirementKeyToCheck = normalized;
    }

    if (Object.keys(set).length === 0) {
      throw new ApiError('bad_request', 'no updatable fields in request body');
    }

    const outcome = await withMutation<VaccineWire>(
      {
        principal,
        idempotencyKey,
        endpoint: 'PATCH /dogs/:id/vaccines/:vid',
        requestHash: hashRequestBody({ id: dogId, vid, patch: body }),
        keysToInvalidate: () => [],
      },
      async (tx) => {
        if (!(await dogsRepository.findOwnedExists(dogId, principal.ownerId, tx))) {
          throw new ApiError('not_found', 'dog not found');
        }
        if (!(await dogVaccinesRepository.findByIdForDog(vid, dogId, tx))) {
          throw new ApiError('not_found', 'vaccine not found');
        }
        if (
          requirementKeyToCheck !== undefined &&
          requirementKeyToCheck !== null &&
          !(await requiredVaccinesRepository.keyIsLive(requirementKeyToCheck, tx))
        ) {
          throw new ApiError(
            'invalid_payload',
            'requirement_key does not match a live required_vaccines entry',
          );
        }
        const updated = await dogVaccinesRepository.update(tx, vid, set);
        if (!updated) {
          throw new ApiError('not_found', 'vaccine not found');
        }
        return { status: 200, body: toVaccineWire(updated) };
      },
    );

    reply.code(outcome.status);
    return outcome.body;
  });

  app.delete('/dogs/:id/vaccines/:vid', { preHandler: [authHook] }, async (request, reply) => {
    const principal = requirePrincipal(request);
    requireOwner(principal, 'delete their dogs');
    const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);

    const { id: dogId, vid } = parseOrThrow(vaccineParamsSchema, request.params, 'dog/vaccine id');

    const outcome = await withMutation<null>(
      {
        principal,
        idempotencyKey,
        endpoint: 'DELETE /dogs/:id/vaccines/:vid',
        requestHash: hashRequestBody({ id: dogId, vid }),
        keysToInvalidate: () => [],
      },
      async (tx) => {
        if (!(await dogsRepository.findOwnedExists(dogId, principal.ownerId, tx))) {
          throw new ApiError('not_found', 'dog not found');
        }
        if (!(await dogVaccinesRepository.findByIdForDog(vid, dogId, tx))) {
          throw new ApiError('not_found', 'vaccine not found');
        }
        await dogVaccinesRepository.softExpire(tx, vid);
        return { status: 204, body: null };
      },
    );

    reply.code(outcome.status);
    return outcome.body;
  });

  // ────────────────────────────────────────────────────────────────────
  // Nested: medications (Day 9d)
  // ────────────────────────────────────────────────────────────────────

  app.post('/dogs/:id/medications', { preHandler: [authHook] }, async (request, reply) => {
    const principal = requirePrincipal(request);
    requireOwner(principal, 'create their dogs');
    const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);

    const { id: dogId } = parseOrThrow(paramsSchema, request.params, 'dog id');
    const body = parseOrThrow(postMedicationBodySchema, request.body, 'medication payload');

    const outcome = await withMutation<MedicationWire>(
      {
        principal,
        idempotencyKey,
        endpoint: 'POST /dogs/:id/medications',
        requestHash: hashRequestBody({ id: dogId, body }),
        keysToInvalidate: () => [],
      },
      async (tx) => {
        if (!(await dogsRepository.findOwnedExists(dogId, principal.ownerId, tx))) {
          throw new ApiError('not_found', 'dog not found');
        }
        const created = await dogMedicationsRepository.create(tx, {
          dogId,
          name: body.name,
          dose: body.dose,
          frequency: body.frequency,
        });
        return { status: 201, body: toMedicationWire(created) };
      },
    );

    reply.code(outcome.status);
    return outcome.body;
  });

  app.patch('/dogs/:id/medications/:mid', { preHandler: [authHook] }, async (request, reply) => {
    const principal = requirePrincipal(request);
    requireOwner(principal, 'edit their dogs');
    const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);

    const { id: dogId, mid } = parseOrThrow(
      medicationParamsSchema,
      request.params,
      'dog/medication id',
    );
    const body = parseOrThrow(patchMedicationBodySchema, request.body, 'medication patch');

    const set: MedicationUpdate = {};
    if (body.name !== undefined) set.name = body.name;
    if (body.dose !== undefined) set.dose = body.dose;
    if (body.frequency !== undefined) set.frequency = body.frequency;

    if (Object.keys(set).length === 0) {
      throw new ApiError('bad_request', 'no updatable fields in request body');
    }

    const outcome = await withMutation<MedicationWire>(
      {
        principal,
        idempotencyKey,
        endpoint: 'PATCH /dogs/:id/medications/:mid',
        requestHash: hashRequestBody({ id: dogId, mid, patch: body }),
        keysToInvalidate: () => [],
      },
      async (tx) => {
        if (!(await dogsRepository.findOwnedExists(dogId, principal.ownerId, tx))) {
          throw new ApiError('not_found', 'dog not found');
        }
        if (!(await dogMedicationsRepository.findByIdForDog(mid, dogId, tx))) {
          throw new ApiError('not_found', 'medication not found');
        }
        const updated = await dogMedicationsRepository.update(tx, mid, set);
        if (!updated) {
          throw new ApiError('not_found', 'medication not found');
        }
        return { status: 200, body: toMedicationWire(updated) };
      },
    );

    reply.code(outcome.status);
    return outcome.body;
  });

  app.delete('/dogs/:id/medications/:mid', { preHandler: [authHook] }, async (request, reply) => {
    const principal = requirePrincipal(request);
    requireOwner(principal, 'delete their dogs');
    const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);

    const { id: dogId, mid } = parseOrThrow(
      medicationParamsSchema,
      request.params,
      'dog/medication id',
    );

    const outcome = await withMutation<null>(
      {
        principal,
        idempotencyKey,
        endpoint: 'DELETE /dogs/:id/medications/:mid',
        requestHash: hashRequestBody({ id: dogId, mid }),
        keysToInvalidate: () => [],
      },
      async (tx) => {
        if (!(await dogsRepository.findOwnedExists(dogId, principal.ownerId, tx))) {
          throw new ApiError('not_found', 'dog not found');
        }
        if (!(await dogMedicationsRepository.findByIdForDog(mid, dogId, tx))) {
          throw new ApiError('not_found', 'medication not found');
        }
        await dogMedicationsRepository.softExpire(tx, mid);
        return { status: 204, body: null };
      },
    );

    reply.code(outcome.status);
    return outcome.body;
  });

  // ────────────────────────────────────────────────────────────────────
  // Nested: feeding (Day 9d) — 1:1 PUT upsert via RELINK
  // ────────────────────────────────────────────────────────────────────

  app.put('/dogs/:id/feeding', { preHandler: [authHook] }, async (request, reply) => {
    const principal = requirePrincipal(request);
    requireOwner(principal, 'edit their dogs');
    const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);

    const { id: dogId } = parseOrThrow(paramsSchema, request.params, 'dog id');
    const body = parseOrThrow(feedingBodySchema, request.body, 'feeding payload');

    const values: FeedingValues = {
      brand: body.brand,
      amount: body.amount,
      frequency: body.frequency,
      notes: normalizeOptional(body.notes) ?? null,
    };

    const outcome = await withMutation<FeedingWire>(
      {
        principal,
        idempotencyKey,
        endpoint: 'PUT /dogs/:id/feeding',
        requestHash: hashRequestBody({ id: dogId, body }),
        keysToInvalidate: () => [],
      },
      async (tx) => {
        if (!(await dogsRepository.findOwnedExists(dogId, principal.ownerId, tx))) {
          throw new ApiError('not_found', 'dog not found');
        }
        const row = await dogFeedingRepository.upsert(tx, dogId, values);
        return { status: 200, body: toFeedingWire(row) };
      },
    );

    reply.code(outcome.status);
    return outcome.body;
  });
}
