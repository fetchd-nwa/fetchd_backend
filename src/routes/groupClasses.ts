import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import { ApiError } from '../lib/errors.js';
import { formatZodIssues } from '../lib/zodIssues.js';
import { pgEnumTuple } from '../lib/pgEnumTuple.js';
import {
  computeEligibility,
  toCohortWire,
  toGroupClassWire,
  type CohortWire,
  type GroupClassWire,
  type GroupEligibilityWire,
} from '../lib/groupClassWire.js';
import { groupClassesRepository } from '../db/repositories/groupClassesRepository.js';
import { cohortsRepository } from '../db/repositories/cohortsRepository.js';
import { dogCompletedClassesRepository } from '../db/repositories/dogCompletedClassesRepository.js';
import { groupClassKey } from '../db/schema/schema.js';

/**
 * Group-class read surface (DATA-CONTRACT §C group-classes):
 *   GET /group-classes                       — catalog
 *   GET /group-classes/:key                  — single class
 *   GET /group-classes/:key/cohorts          — cohorts for one class
 *   GET /cohorts/:id                         — single cohort
 *   GET /dogs/:id/group-eligibility?class=   — R7 server-derived check
 *
 * The first four are catalog reads — owner + staff both see the same
 * data (no per-user scoping). Eligibility is owner-only (dog ownership-
 * checked, 404 same response as not-found so ids don't enumerate).
 *
 * Wire shapes:
 *   - GroupClass: `price_per_dog_cents` (cents on the wire); `age_range?`
 *     optional-omit. Ordering enum-natural via the repo's `ORDER BY key`.
 *   - Cohort: `capacity` additive (Day-6a); `end_date?` optional-omit
 *     (open-enrollment cohorts have no end). Ordering by `start_date` ASC.
 *   - GroupEligibility: `missing_prereq_options?` omitted when eligible
 *     (Day-4a convention); emits the OR-list when ineligible. OR-prereq
 *     semantics: a class is eligible iff the dog has completed AT LEAST
 *     ONE of the prereq options (or the class has none).
 */
const GROUP_CLASS_KEY_VALUES = pgEnumTuple(groupClassKey);

const groupClassParamSchema = z.object({
  key: z.enum(GROUP_CLASS_KEY_VALUES),
});

const uuidParamSchema = z.object({
  id: z.string().uuid(),
});

const eligibilityQuerySchema = z.object({
  class: z.enum(GROUP_CLASS_KEY_VALUES),
});

export function registerGroupClassesRoute(app: FastifyInstance, opts: AuthRouteOptions = {}): void {
  const authHook = resolveAuthHook(opts);

  // --- GET /group-classes -------------------------------------------------
  app.get('/group-classes', { preHandler: [authHook] }, async (): Promise<GroupClassWire[]> => {
    const rows = await groupClassesRepository.findAll();
    return rows.map(toGroupClassWire);
  });

  // --- GET /group-classes/:key --------------------------------------------
  app.get(
    '/group-classes/:key',
    { preHandler: [authHook] },
    async (request): Promise<GroupClassWire> => {
      const { key } = parseGroupClassParam(request.params);
      const row = await groupClassesRepository.findByKey(key);
      if (row === undefined) {
        throw new ApiError('not_found', `group class ${key} not found`);
      }
      return toGroupClassWire(row);
    },
  );

  // --- GET /group-classes/:key/cohorts ------------------------------------
  app.get(
    '/group-classes/:key/cohorts',
    { preHandler: [authHook] },
    async (request): Promise<CohortWire[]> => {
      const { key } = parseGroupClassParam(request.params);
      const rows = await cohortsRepository.findByClassKey(key);
      return rows.map(toCohortWire);
    },
  );

  // --- GET /cohorts/:id ---------------------------------------------------
  app.get('/cohorts/:id', { preHandler: [authHook] }, async (request): Promise<CohortWire> => {
    const { id } = parseUuidParam(request.params);
    const row = await cohortsRepository.findById(id);
    if (row === undefined) {
      throw new ApiError('not_found', `cohort ${id} not found`);
    }
    return toCohortWire(row);
  });

  // --- GET /dogs/:id/group-eligibility?class= ----------------------------
  // Owner-scoped via dog ownership. Same 404 response for unknown dog OR
  // dog-not-yours OR (the only other case the route maps to 404 here) an
  // unknown class key would have been rejected by Zod at parse-time. The
  // R7-server-derived branch lives in `computeEligibility` (pure).
  app.get(
    '/dogs/:id/group-eligibility',
    { preHandler: [authHook] },
    async (request): Promise<GroupEligibilityWire> => {
      const principal = requirePrincipal(request);
      const { id: dogId } = parseUuidParam(request.params);
      const { class: classKey } = parseEligibilityQuery(request.query);
      if (principal.kind !== 'owner') {
        throw new ApiError('not_found', `dog ${dogId} not found`);
      }
      const completedKeys = await dogCompletedClassesRepository.findCompletedKeysForOwnedDog(
        dogId,
        principal.ownerId,
      );
      if (completedKeys === undefined) {
        throw new ApiError('not_found', `dog ${dogId} not found`);
      }
      const prereqOptions = await groupClassesRepository.findPrereqOptionsForClass(classKey);
      return computeEligibility(classKey, prereqOptions, completedKeys);
    },
  );
}

// ---- query/param parsing --------------------------------------------

function parseGroupClassParam(params: unknown): z.infer<typeof groupClassParamSchema> {
  const parsed = groupClassParamSchema.safeParse(params);
  if (!parsed.success) {
    throw new ApiError('bad_request', `invalid path: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}

function parseUuidParam(params: unknown): { id: string } {
  const parsed = uuidParamSchema.safeParse(params);
  if (!parsed.success) {
    throw new ApiError('bad_request', `invalid path: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}

function parseEligibilityQuery(query: unknown): z.infer<typeof eligibilityQuerySchema> {
  const parsed = eligibilityQuerySchema.safeParse(query);
  if (!parsed.success) {
    throw new ApiError('bad_request', `invalid query: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}
