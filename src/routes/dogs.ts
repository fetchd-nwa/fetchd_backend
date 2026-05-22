import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePrincipal, resolveAuthHook, type AuthRouteOptions } from '../auth/plugin.js';
import { hashRequestBody, requireIdempotencyKey, withMutation } from '../db/mutation.js';
import { dogsRepository, type DogUpdate } from '../db/repositories/dogsRepository.js';
import { vetsRepository } from '../db/repositories/vetsRepository.js';
import { evaluationStatus } from '../db/schema/schema.js';
import { ApiError } from '../lib/errors.js';
import { toDogWire, type DogWire } from '../lib/dogWire.js';
import { normalizeOptional } from '../lib/normalize.js';
import { pgEnumTuple } from '../lib/pgEnumTuple.js';
import { formatZodIssues } from '../lib/zodIssues.js';

/**
 * `GET /dogs` `[auth]` — every live dog the authenticated owner owns,
 * emitted in the DATA-CONTRACT §B Dog wire shape. Staff principals get
 * an empty list (the owner app surface only exposes owner-owned dogs;
 * staff use the deferred staff portal). Day-9a refactor: the assembly
 * + wire conversion live in `dogsRepository.findManyByOwner` +
 * `lib/dogWire.ts`; this handler is a thin orchestrator.
 *
 * `GET /dogs/:id` `[auth]` — single-dog read, owner-scoped. 404 covers
 * both "no such dog" and "not yours" so ids don't enumerate. Mirrors
 * the POST/PATCH response wire shape. Deferred §C read from Day-7b;
 * landed alongside the mutations that produce the same shape.
 *
 * `POST /dogs` — owner create. Server stamps `owner_id` from the
 * principal and `source='app'` from the schema default. `primary_vet_id`
 * optional: when set, the route `FOR SHARE`s the target vet row inside
 * the withMutation tx — the matching half of Day-9b's `FOR UPDATE` on
 * DELETE /vets, so the two serialize and a concurrent vet-delete can't
 * leave the new dog pointing at a soft-expired vet.
 *
 * `PATCH /dogs/:id` — owner edit. Ownership-checked via
 * `findOwnedExists` (404 on miss). Same `FOR SHARE` guard on the
 * `primary_vet_id` reassign branch. `birthdate` / `age_months_override`
 * are intentionally NOT in the PATCH body — the DB CHECK requires at
 * least one to be non-null, so safely editing them needs a paired-clear
 * guard that Day-9d will land (currently deferred; owners re-create via
 * DELETE + POST today).
 *
 * `DELETE /dogs/:id` — owner soft-expire. Ownership-checked. Returns
 * 204. Soft-expiring a dog does NOT cascade to its child rows (vaccines
 * / medications / feeding / completed_classes) — those stay live in DB
 * but become unreachable through `findById` (parent live() filter).
 * The dog's `booking_dogs` history is preserved per the never-DELETE
 * invariant.
 *
 * **Mutation-route choreography (rule-of-three deliberately NOT
 * extracted, Day-9c).** Day-9b's three vet mutations + Day-9c's three
 * dog mutations all match: `requirePrincipal` → kind narrow →
 * `requireIdempotencyKey` → params parse → body parse → build set →
 * `withMutation` → repo call → reply. A `mutationContext(req, endpoint,
 * body)` helper that returned `{ principal, idempotencyKey, requestHash
 * }` would save ~2 lines per mutation; the cost is a new abstraction
 * the next reader must learn, and the verb-shape variance (POST 201 +
 * body, PATCH 200 + body, DELETE 204 + null) doesn't fit one wrapper
 * cleanly. Day-9d's six nested-resource mutations are the right place
 * to re-evaluate; until then the boilerplate is honest declarative code
 * where each line names a distinct thing.
 *
 * Every mutation declares `keysToInvalidate: () => []` as the Day-8
 * convention seam — dogs aren't in §3 cache map today; the
 * `dogprofile:{dogId}` cache mentioned in the §3 comment is deferred.
 */

const EVALUATION_STATUSES = pgEnumTuple(evaluationStatus);

const paramsSchema = z.object({
  id: z.string().uuid(),
});

const optionalText = z.string().nullable();
const optionalUuid = z.string().uuid().nullable();
/** ISO date 'YYYY-MM-DD' (Postgres `date`). Trailing time disallowed. */
const optionalBirthdate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'birthdate must be YYYY-MM-DD');
/** ISO datetime with timezone offset (Postgres `timestamptz`). */
const optionalEvaluationDate = z.string().datetime({ offset: true }).nullable();
const optionalAgeMonths = z.number().int().positive();

/**
 * POST body. `birthdate` / `age_months_override` are present-or-absent
 * (no explicit-null branch — they're write-once at create today). The
 * DB CHECK `(birthdate IS NOT NULL OR age_months_override IS NOT NULL)`
 * is enforced explicitly via `.refine` so the error is
 * `invalid_payload` rather than a raw Postgres `check_violation`.
 */
const postBodySchema = z
  .object({
    name: z.string().trim().min(1),
    breed: z.string().trim().min(1),
    birthdate: optionalBirthdate.optional(),
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

/**
 * PATCH body. All keys optional; route enforces at-least-one-present
 * (else 400 "no updatable fields"). `birthdate` / `age_months_override`
 * are deliberately absent — see the route doc.
 */
const patchBodySchema = z
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

/**
 * Narrow the principal to owner. PATCH/DELETE /dogs and POST /dogs are
 * owner-only — staff dog-management is a Day-19 portal verb. Uses an
 * `asserts` predicate so the call site narrows the static type after
 * the check.
 */
function requireOwner(
  principal: ReturnType<typeof requirePrincipal>,
  action: 'create' | 'edit' | 'delete',
): asserts principal is { kind: 'owner'; ownerId: string; supabaseUid: string } {
  if (principal.kind !== 'owner') {
    throw new ApiError('forbidden', `only owners may ${action} dogs`);
  }
}

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

  app.get('/dogs', { preHandler: [authHook] }, async (request): Promise<DogWire[]> => {
    const principal = requirePrincipal(request);
    if (principal.kind !== 'owner') return [];

    const assembled = await dogsRepository.findManyByOwner(principal.ownerId);
    const today = now();
    return assembled.map((d) => toDogWire(d, today));
  });

  app.get('/dogs/:id', { preHandler: [authHook] }, async (request): Promise<DogWire> => {
    const principal = requirePrincipal(request);
    const parsedParams = paramsSchema.safeParse(request.params);
    if (!parsedParams.success) {
      throw new ApiError('bad_request', `invalid dog id: ${formatZodIssues(parsedParams.error)}`);
    }
    // Staff get the same 404 as "not yours / not found" — consistency with
    // GET /dogs returning [] to staff, and so ids don't enumerate.
    if (principal.kind !== 'owner') {
      throw new ApiError('not_found', 'dog not found');
    }
    const assembled = await dogsRepository.findById(parsedParams.data.id, principal.ownerId);
    if (!assembled) {
      throw new ApiError('not_found', 'dog not found');
    }
    return toDogWire(assembled, now());
  });

  app.post('/dogs', { preHandler: [authHook] }, async (request, reply) => {
    const principal = requirePrincipal(request);
    requireOwner(principal, 'create');
    const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);

    const parsed = postBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('bad_request', `invalid dog payload: ${formatZodIssues(parsed.error)}`);
    }

    const body = parsed.data;
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
    requireOwner(principal, 'edit');
    const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);

    const parsedParams = paramsSchema.safeParse(request.params);
    if (!parsedParams.success) {
      throw new ApiError('bad_request', `invalid dog id: ${formatZodIssues(parsedParams.error)}`);
    }

    const parsed = patchBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('bad_request', `invalid dog patch: ${formatZodIssues(parsed.error)}`);
    }

    const body = parsed.data;
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

    const dogId = parsedParams.data.id;
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
    requireOwner(principal, 'delete');
    const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);

    const parsedParams = paramsSchema.safeParse(request.params);
    if (!parsedParams.success) {
      throw new ApiError('bad_request', `invalid dog id: ${formatZodIssues(parsedParams.error)}`);
    }

    const dogId = parsedParams.data.id;

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
}
