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
import { creditLedgerRepository } from '../db/repositories/creditLedgerRepository.js';
import { dogProgramsRepository } from '../db/repositories/dogProgramsRepository.js';
import { dogsRepository } from '../db/repositories/dogsRepository.js';
import type { Tx } from '../db/tx.js';
import { CURRICULUM_PROGRAMS } from '../lib/alumni.js';
import { ApiError } from '../lib/errors.js';
import { pgTimestampToIso } from '../lib/pgTimestamp.js';
import { requireStaff } from '../lib/principalNarrows.js';
import { formatZodIssues, parseOrThrow } from '../lib/zodIssues.js';

/**
 * §J.3 staff verbs — the alumni completed-programs record + attendance-flag
 * clear (DATA-CONTRACT §J.3, ruled 2026-07-09). Follows `staffCreditExpiry.ts`
 * conventions: requireStaff, withMutation + Idempotency-Key on writes, inline
 * wire type (NOT portal-mirrored yet — the portal UI lives in the other repo).
 *
 *   GET    /staff/dogs/:dogId/completed-programs           list + is_alumni + flag
 *   POST   /staff/dogs/:dogId/completed-programs {program} record a completion
 *   DELETE /staff/dogs/:dogId/completed-programs/:program  soft-expire a mistake
 *   POST   /staff/dogs/:dogId/clear-alumni-flag            clear the §J.3 flag
 *
 * Alumni is DERIVED (all 5 live rows) — recording the 5th program is the
 * became-alumni moment: the dog's existing live credit lots get
 * `expires_at = NULL` (`clearExpiryForDog`) inside the same tx.
 *
 * The DELETE deliberately does NOT re-stamp lot expiries: lots cleared at the
 * became-alumni moment stay never-expire even if a completion is later
 * un-recorded (re-stamping would need the original windows, which the clear
 * discarded — and a staff data-entry fix shouldn't silently shorten credits
 * the owner already saw as non-expiring). Future grants DO expire again,
 * because `isAlumni` is re-derived at every grant site.
 */

const dogIdParamSchema = z.object({ dogId: z.string().uuid('dogId must be a UUID') });

const programParamSchema = z.object({
  dogId: z.string().uuid('dogId must be a UUID'),
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
 * Assemble the wire from the two repo halves (programs list + dogs-row flag).
 * `undefined` when the dog is missing/expired — callers map to 404.
 */
async function loadCompletedProgramsWire(
  dogId: string,
  runner?: Tx,
): Promise<CompletedProgramsWire | undefined> {
  const flag = await dogsRepository.findAlumniFlagForStaff(dogId, runner);
  if (flag === undefined) return undefined;
  const programs = await dogProgramsRepository.findLiveByDog(dogId, runner);
  const wire: CompletedProgramsWire = {
    dog_id: dogId,
    is_alumni: programs.length === CURRICULUM_PROGRAMS.length,
    completed_programs: programs.map((p) => ({
      program: p.program,
      completed_at: pgTimestampToIso(p.completedAt),
    })),
  };
  if (flag.alumniAttendanceFlaggedAt !== null) {
    wire.alumni_attendance_flagged_at = pgTimestampToIso(flag.alumniAttendanceFlaggedAt);
  }
  return wire;
}

export interface StaffAlumniRouteOptions extends AuthRouteOptions {
  /** Injectable clock for the became-alumni lot-clear + flag stamps. */
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
  // already-live (dog, program) succeeds without a second row). Recording
  // the 5th program is the became-alumni moment → clearExpiryForDog.
  app.post(
    '/staff/dogs/:dogId/completed-programs',
    { preHandler: [authHook] },
    async (request, reply): Promise<CompletedProgramsWire> => {
      const principal = requirePrincipal(request);
      requireStaff(principal, 'record a completed program');
      const { dogId } = parseDogIdParam(request.params);
      const body = parseOrThrow(recordBodySchema, request.body, 'body');
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
      const now = nowFactory();

      const outcome = await withMutation<CompletedProgramsWire>(
        {
          principal,
          idempotencyKey,
          endpoint: 'POST /staff/dogs/:dogId/completed-programs',
          requestHash: hashRequestBody({ dogId, body }),
          // Becoming alumni rewrites live lots' expires_at — the cached
          // per-dog credit reads are stale the moment that lands.
          patternsToInvalidate: (wire) => (wire.is_alumni ? [`credits:${dogId}:*`] : []),
        },
        async (tx) => {
          // Row-lock the dog first: serializes concurrent program records so
          // the "5th program" count is race-free (see lockForAlumniUpdate).
          const dogExists = await dogsRepository.lockForAlumniUpdate(tx, dogId);
          if (!dogExists) {
            throw new ApiError('not_found', `dog ${dogId} not found`);
          }

          const inserted = await dogProgramsRepository.recordCompletion(tx, {
            dogId,
            program: body.program,
            staffId: principal.staffId,
          });
          // `undefined` = already recorded (live row exists) — success, and
          // by definition not the became-alumni moment, so no lot clear.
          if (inserted !== undefined && (await dogProgramsRepository.isAlumni(dogId, tx))) {
            await creditLedgerRepository.clearExpiryForDog(tx, dogId, now);
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
  // Soft-expire a mistaken record. Does NOT re-stamp lot expiries (see the
  // module doc). 404 when there's no live completion to expire.
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

  // --- POST /staff/dogs/:dogId/clear-alumni-flag -------------------------
  // Staff clear after the re-check/eval. Idempotent — clearing an already-
  // clear flag returns the same 200 wire. The monthly scan won't re-flag
  // within the same month (the notification dedupe row doubles as the guard).
  app.post(
    '/staff/dogs/:dogId/clear-alumni-flag',
    { preHandler: [authHook] },
    async (request): Promise<CompletedProgramsWire> => {
      const principal = requirePrincipal(request);
      requireStaff(principal, 'clear an alumni attendance flag');
      const { dogId } = parseDogIdParam(request.params);
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);

      const outcome = await withMutation<CompletedProgramsWire>(
        {
          principal,
          idempotencyKey,
          endpoint: 'POST /staff/dogs/:dogId/clear-alumni-flag',
          requestHash: hashRequestBody({ dogId }),
          keysToInvalidate: () => [],
        },
        async (tx) => {
          const dogExists = await dogsRepository.findAlumniFlagForStaff(dogId, tx);
          if (dogExists === undefined) {
            throw new ApiError('not_found', `dog ${dogId} not found`);
          }
          await dogsRepository.clearAlumniAttendanceFlag(tx, dogId);
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
