import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import type { Equal, Expect } from '../contracts/typeAsserts.js';
import type {
  CompletedProgramsWire,
  CurriculumProgram,
  PostStaffDogsCompletedProgramsRequest,
} from '../contracts/wire.js';
import { hashRequestBody, requireIdempotencyKey, withMutation } from '../db/mutation.js';
import { dogProgramsRepository } from '../db/repositories/dogProgramsRepository.js';
import { dogsRepository } from '../db/repositories/dogsRepository.js';
import type { Tx } from '../db/tx.js';
import { CURRICULUM_PROGRAMS } from '../lib/alumni.js';
import { ApiError } from '../lib/errors.js';
import { pgTimestampToIso } from '../lib/pgTimestamp.js';
import { requireStaff } from '../lib/principalNarrows.js';
import { uuidId } from '../lib/uuidId.js';
import { formatZodIssues, parseOrThrow } from '../lib/zodIssues.js';

/**
 * §J.3 staff verbs — the alumni completed-programs record (DATA-CONTRACT §J.3,
 * ruled 2026-07-09). Staff conventions: requireStaff,
 * withMutation + Idempotency-Key on writes, inline wire type (NOT portal-mirrored
 * yet — the portal UI lives in the other repo).
 *
 *   GET    /staff/dogs/:dogId/completed-programs           list + is_alumni
 *   POST   /staff/dogs/:dogId/completed-programs {program} record a completion
 *   DELETE /staff/dogs/:dogId/completed-programs/:program  soft-expire a mistake
 *
 * Alumni is DERIVED (all 5 live rows). Becoming alumni touches no credit: alumni
 * lots take the ordinary expiry (ALUM-U16).
 */

const dogIdParamSchema = z.object({ dogId: uuidId('dogId must be a UUID') });

const programParamSchema = z.object({
  dogId: uuidId('dogId must be a UUID'),
  program: z.enum(CURRICULUM_PROGRAMS),
});

const recordBodySchema = z.object({ program: z.enum(CURRICULUM_PROGRAMS) }).strict();

/** §5.1.3 body pin. */
export type PostStaffCompletedProgramsBodyConformance = Expect<
  Equal<z.input<typeof recordBodySchema>, PostStaffDogsCompletedProgramsRequest>
>;

/**
 * The wire's `CurriculumProgram` is hand-listed (it must be — the DB floor is a
 * CHECK, not a pgEnum, so `conformance.ts`'s DrizzleEnum pin has nothing to
 * bite on). THIS is its drift guard: `lib/alumni.ts`'s `CURRICULUM_PROGRAMS`
 * drives the route's Zod enum, the repository row type and the alumni count, so
 * pinning the wire union to it makes any future divergence a `tsc` error here.
 * Proven breakable: deleting a member from either side fails with TS2344.
 */
export type CurriculumProgramConformance = Expect<
  Equal<CurriculumProgram, (typeof CURRICULUM_PROGRAMS)[number]>
>;

// CompletedProgramsWire promoted to `contracts/wire.ts` in 1.13.0 (digest
// dogs-profile/S) with `completed_programs[].program` typed `CurriculumProgram`
// instead of `string` — the repository row type already said so
// (dogProgramsRepository.ts:22-25) and the DB CHECK (schema.sql:475-476)
// enforces it.

/**
 * Assemble the wire from the dog's stored status and her live completions.
 * `undefined` when the dog is missing/expired — callers map to 404.
 */
async function loadCompletedProgramsWire(
  dogId: string,
  runner?: Tx,
): Promise<CompletedProgramsWire | undefined> {
  const isAlumni = await dogsRepository.findLiveAlumniStatus(dogId, runner);
  if (isAlumni === undefined) return undefined;
  const programs = await dogProgramsRepository.findLiveByDog(dogId, runner);
  const wire: CompletedProgramsWire = {
    dog_id: dogId,
    is_alumni: isAlumni,
    completed_programs: programs.map((p) => ({
      program: p.program,
      completed_at: pgTimestampToIso(p.completedAt),
    })),
  };
  return wire;
}

export interface StaffAlumniRouteOptions extends AuthRouteOptions {
  /** Injectable clock for the un-record's soft-expire stamp. */
  now?: () => Date;
}

export function registerStaffAlumniRoute(
  app: FastifyInstance,
  opts: StaffAlumniRouteOptions = {},
): void {
  const authHook = resolveAuthHook(opts);
  const nowFactory = opts.now ?? ((): Date => new Date());

  // --- GET /staff/dogs/:dogId/completed-programs ------------------------
  app.get(
    '/staff/dogs/:dogId/completed-programs',
    { preHandler: [authHook] },
    async (request): Promise<CompletedProgramsWire> => {
      const principal = requirePrincipal(request);
      requireStaff(principal, 'read a dog completed-programs record');
      const { dogId } = parseDogIdParam(request.params);
      const wire = await loadCompletedProgramsWire(dogId);
      if (wire === undefined) {
        throw new ApiError('not_found', `dog ${dogId} not found`);
      }
      return wire;
    },
  );

  // --- POST /staff/dogs/:dogId/completed-programs -----------------------
  // Record one course completion. Idempotent at two levels: the
  // Idempotency-Key replay AND the partial-unique no-op (re-recording an
  // already-live (dog, program) succeeds without a second row).
  app.post(
    '/staff/dogs/:dogId/completed-programs',
    { preHandler: [authHook] },
    async (request, reply): Promise<CompletedProgramsWire> => {
      const principal = requirePrincipal(request);
      requireStaff(principal, 'record a completed program');
      const { dogId } = parseDogIdParam(request.params);
      const body = parseOrThrow(recordBodySchema, request.body, 'body');
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);

      const outcome = await withMutation<CompletedProgramsWire>(
        {
          principal,
          idempotencyKey,
          endpoint: 'POST /staff/dogs/:dogId/completed-programs',
          requestHash: hashRequestBody({ dogId, body }),
          keysToInvalidate: () => [],
        },
        async (tx) => {
          // Row-lock the dog first: serializes concurrent program records, so the
          // count that sets `is_alumni` below sees them all (see lockForAlumniUpdate).
          const dogExists = await dogsRepository.lockForAlumniUpdate(tx, dogId);
          if (!dogExists) {
            throw new ApiError('not_found', `dog ${dogId} not found`);
          }

          await dogProgramsRepository.recordCompletion(tx, {
            dogId,
            program: body.program,
            staffId: principal.staffId,
          });
          // Stored, set here under the dog's lock, and never cleared: a level un-recorded
          // later does not take it back (M4.11, ALUM-U02).
          const live = await dogProgramsRepository.findLiveByDog(dogId, tx);
          if (live.length === CURRICULUM_PROGRAMS.length) {
            await dogsRepository.markAlumni(tx, dogId);
          }
          const wire = await loadCompletedProgramsWire(dogId, tx);
          if (wire === undefined) {
            throw new Error(`staffAlumni: dog ${dogId} vanished mid-mutation`);
          }
          return { status: 201, body: wire };
        },
      );

      reply.code(outcome.status);
      return outcome.body;
    },
  );

  // --- DELETE /staff/dogs/:dogId/completed-programs/:program ------------
  // Soft-expire a mistaken record. 404 when there's no live completion to expire.
  app.delete(
    '/staff/dogs/:dogId/completed-programs/:program',
    { preHandler: [authHook] },
    async (request): Promise<CompletedProgramsWire> => {
      const principal = requirePrincipal(request);
      requireStaff(principal, 'un-record a completed program');
      const { dogId, program } = parseProgramParam(request.params);
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
      const now = nowFactory();

      const outcome = await withMutation<CompletedProgramsWire>(
        {
          principal,
          idempotencyKey,
          endpoint: 'DELETE /staff/dogs/:dogId/completed-programs/:program',
          requestHash: hashRequestBody({ dogId, program }),
          keysToInvalidate: () => [],
        },
        async (tx) => {
          const expired = await dogProgramsRepository.expireCompletion(tx, {
            dogId,
            program,
            now,
          });
          if (!expired) {
            throw new ApiError('not_found', `dog ${dogId} has no live ${program} completion`);
          }
          const wire = await loadCompletedProgramsWire(dogId, tx);
          if (wire === undefined) {
            throw new Error(`staffAlumni: dog ${dogId} vanished mid-mutation`);
          }
          return { status: 200, body: wire };
        },
      );

      return outcome.body;
    },
  );
}

function parseDogIdParam(params: unknown): { dogId: string } {
  const parsed = dogIdParamSchema.safeParse(params);
  if (!parsed.success) {
    throw new ApiError('bad_request', `invalid path: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}

function parseProgramParam(params: unknown): z.infer<typeof programParamSchema> {
  const parsed = programParamSchema.safeParse(params);
  if (!parsed.success) {
    throw new ApiError('bad_request', `invalid path: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}
