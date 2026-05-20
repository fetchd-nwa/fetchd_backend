import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import { ApiError } from '../lib/errors.js';
import { formatZodIssues } from '../lib/zodIssues.js';
import { pgEnumTuple } from '../lib/pgEnumTuple.js';
import { pgTimestampToDate, pgTimestampToIso } from '../lib/pgTimestamp.js';
import { groupRequestDogs, toRequestWire, type PendingRequestWire } from '../lib/requestWire.js';
import {
  requestsRepository,
  type PendingRequestRow,
} from '../db/repositories/requestsRepository.js';
import { requestStatus } from '../db/schema/schema.js';

/**
 * `GET /requests?status=` `[auth]` and `GET /requests/:id` `[auth]` —
 * the pending-request read surface (DATA-CONTRACT §C requests). Owner-
 * scoped; staff principals get an empty list / 404 (Day-19 staff portal
 * uses `/staff/requests/*` for cross-owner access — out of scope here).
 *
 * Wire shape per §B PendingRequest (R1 multi-dog, R8 structured focus).
 * The DB stores notes + focus as scalar columns; the wire helper composes
 * them into `{notes:{per_dog?,joint?}, focus:{staff_preference?,
 * comfort_level?}}`. `notes` is whole-object optional-omit; `focus` is
 * required outer (always emit `{}` minimum), inner keys optional-omit.
 *
 * Layer responsibilities (mirrors Day-5a bookings):
 *   route   → parse query/params, call repo, batch joins, wire, respond
 *   repo    → SQL queries + projection (3 batched lookups per list)
 *   wire    → DB row + dog ids + preferred-date ISOs → §B JSON shape
 */
const REQUEST_STATUS_VALUES = pgEnumTuple(requestStatus);

const statusQuerySchema = z.object({
  status: z.enum(REQUEST_STATUS_VALUES).optional(),
});

const uuidParamSchema = z.object({
  id: z.string().uuid(),
});

export function registerRequestsRoute(app: FastifyInstance, opts: AuthRouteOptions = {}): void {
  const authHook = resolveAuthHook(opts);

  // --- GET /requests?status= ----------------------------------------------
  app.get(
    '/requests',
    { preHandler: [authHook] },
    async (request): Promise<PendingRequestWire[]> => {
      const principal = requirePrincipal(request);
      const { status } = parseStatusQuery(request.query);
      if (principal.kind !== 'owner') return [];

      const rows = await requestsRepository.findLiveByOwner(principal.ownerId, status);
      const sorted = sortBySubmittedAt(rows, 'desc');
      return wireRequests(sorted);
    },
  );

  // --- GET /requests/:id --------------------------------------------------
  app.get(
    '/requests/:id',
    { preHandler: [authHook] },
    async (request): Promise<PendingRequestWire> => {
      const principal = requirePrincipal(request);
      const { id } = parseUuidParam(request.params);
      if (principal.kind !== 'owner') {
        throw new ApiError('not_found', `pending request ${id} not found`);
      }
      const row = await requestsRepository.findByIdForOwner(id, principal.ownerId);
      if (row === undefined) {
        throw new ApiError('not_found', `pending request ${id} not found`);
      }
      const [wire] = await wireRequests([row]);
      if (wire === undefined) {
        // pending_request_dogs is empty for this request — structural bug.
        throw new Error(
          `pending_request ${id}: failed to resolve lead dog from pending_request_dogs`,
        );
      }
      return wire;
    },
  );
}

// ---- query/param parsing --------------------------------------------

function parseStatusQuery(query: unknown): z.infer<typeof statusQuerySchema> {
  const parsed = statusQuerySchema.safeParse(query);
  if (!parsed.success) {
    throw new ApiError('bad_request', `invalid query: ${formatZodIssues(parsed.error)}`);
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

// ---- sort + denormalize ----------------------------------------------

/**
 * Sort by submitted_at — DESC (newest first) for the list view. Uses
 * `pgTimestampToDate` (not `new Date`) so the PG default timestamptz
 * format (single-pair `+TZ`, V8-incompatible) round-trips correctly —
 * same parser as `routes/bookings.ts:sortByScheduledAt`.
 */
function sortBySubmittedAt(
  rows: PendingRequestRow[],
  direction: 'asc' | 'desc',
): PendingRequestRow[] {
  const sorted = [...rows].sort(
    (a, b) =>
      pgTimestampToDate(a.submittedAt).getTime() - pgTimestampToDate(b.submittedAt).getTime(),
  );
  return direction === 'desc' ? sorted.reverse() : sorted;
}

/**
 * Denormalize a set of pending-request rows into wire shapes. Two batched
 * lookups (pending_request_dogs + pending_request_preferred_dates) regardless
 * of row count — cost is constant in the input size. Throws if any request
 * has no `pending_request_dogs` rows (structural invariant violation).
 */
async function wireRequests(rows: PendingRequestRow[]): Promise<PendingRequestWire[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [dogRows, dateRows] = await Promise.all([
    requestsRepository.findDogsByRequestIds(ids),
    requestsRepository.findPreferredDatesByRequestIds(ids),
  ]);
  const dogsByRequest = groupRequestDogs(dogRows);
  const datesByRequest = groupPreferredDates(dateRows);
  return rows.map((row) => {
    const dogIds = dogsByRequest.get(row.id);
    if (dogIds === undefined) {
      throw new Error(`pending_request ${row.id}: no pending_request_dogs rows found`);
    }
    const dates = datesByRequest.get(row.id) ?? [];
    return toRequestWire(row, dogIds, dates);
  });
}

/**
 * Group preferred-date rows into a per-request ISO array. Repo sorts by
 * `ordinal` ASC; this preserves that order and converts timestamptz to
 * ISO 8601 for emit.
 */
function groupPreferredDates(
  rows: { requestId: string; ordinal: number; preferredAt: string }[],
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const row of rows) {
    const existing = result.get(row.requestId) ?? [];
    existing.push(pgTimestampToIso(row.preferredAt));
    result.set(row.requestId, existing);
  }
  return result;
}
