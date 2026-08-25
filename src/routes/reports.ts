import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import { ApiError } from '../lib/errors.js';
import { formatZodIssues } from '../lib/zodIssues.js';
import { pgEnumTuple } from '../lib/pgEnumTuple.js';
import { toReportWire, type ReportWire } from '../lib/reportWire.js';
import { reportsRepository, type ReportRow } from '../db/repositories/reportsRepository.js';
import { staffRepository } from '../db/repositories/staffRepository.js';
import { reportProgram } from '../db/schema/schema.js';

/**
 * `GET /dogs/:id/reports` `[auth]` and three companions — the reports
 * read surface (DATA-CONTRACT §C reports). The three DOG-scoped reads are
 * owner-scoped through the dog FK; staff principals get an empty list / null
 * there and use the dog-scoped `GET /staff/reports` instead.
 *
 * Δ wire 1.13.0 (design §9): `GET /reports/:id` is the exception — a staff
 * principal now reads any LIVE report cross-owner through it. The owner
 * branch is untouched.
 *
 * R2 rehydration is the new ground (Day 6b): the DB stores curriculum
 * keys in a `reports.results` JSONB envelope and the variant doc in
 * `reports.content` JSONB; the wire helper spreads to four sibling
 * curriculum keys + emits the variant doc under the program-keyed wire
 * field. See `lib/reportWire.ts` for the rehydration mechanics.
 *
 * Layer responsibilities (mirrors Day-5a bookings):
 *   route   → parse query/params, call repo, wire, respond
 *   repo    → SQL queries + projection (reports + staff lookup)
 *   wire    → DB row + trainer name → §B JSON shape (pure)
 */
const REPORT_PROGRAM_VALUES = pgEnumTuple(reportProgram);

const dogIdParamSchema = z.object({
  id: z.string().uuid(),
});

const reportIdParamSchema = z.object({
  id: z.string().uuid(),
});

const resolveQuerySchema = z.object({
  reportId: z.string().uuid().optional(),
  program: z.enum(REPORT_PROGRAM_VALUES).optional(),
});

export function registerReportsRoute(app: FastifyInstance, opts: AuthRouteOptions = {}): void {
  const authHook = resolveAuthHook(opts);

  // --- GET /dogs/:id/reports ---------------------------------------------
  app.get(
    '/dogs/:id/reports',
    { preHandler: [authHook] },
    async (request): Promise<ReportWire[]> => {
      const principal = requirePrincipal(request);
      const { id: dogId } = parseDogIdParam(request.params);
      if (principal.kind !== 'owner') return [];

      const rows = await reportsRepository.findLiveForOwnedDog(dogId, principal.ownerId);
      return wireReports(rows);
    },
  );

  // --- GET /dogs/:id/reports/latest -------------------------------------
  // Most-recent report for the dog. `null` when none, or when the dog
  // isn't owned by this principal (same response, no id leak).
  app.get(
    '/dogs/:id/reports/latest',
    { preHandler: [authHook] },
    async (request): Promise<ReportWire | null> => {
      const principal = requirePrincipal(request);
      const { id: dogId } = parseDogIdParam(request.params);
      if (principal.kind !== 'owner') return null;

      const row = await reportsRepository.findLatestForOwnedDog(dogId, principal.ownerId);
      if (row === undefined) return null;
      const [wire] = await wireReports([row]);
      return wire ?? null;
    },
  );

  // --- GET /dogs/:id/reports/resolve?reportId=&program= -----------------
  // Share/preview resolver. Preference: (1) exact id match if `reportId`
  // belongs to this dog, (2) most-recent of the requested `program`
  // variant for this dog, (3) most-recent overall. Returns `null` if
  // the dog has no reports at all. Mirrors `mobile/src/repositories/
  // reportRepository.ts:resolveForRoute` semantics exactly.
  app.get(
    '/dogs/:id/reports/resolve',
    { preHandler: [authHook] },
    async (request): Promise<ReportWire | null> => {
      const principal = requirePrincipal(request);
      const { id: dogId } = parseDogIdParam(request.params);
      const { reportId, program } = parseResolveQuery(request.query);
      if (principal.kind !== 'owner') return null;

      if (reportId !== undefined) {
        const direct = await reportsRepository.findByIdForOwner(reportId, principal.ownerId);
        if (direct !== undefined && direct.dogId === dogId) {
          const [wire] = await wireReports([direct]);
          if (wire !== undefined) return wire;
        }
      }

      const rows = await reportsRepository.findLiveForOwnedDog(dogId, principal.ownerId);
      if (program !== undefined) {
        const variantMatch = rows.find((r) => r.program === program);
        if (variantMatch !== undefined) {
          const [wire] = await wireReports([variantMatch]);
          return wire ?? null;
        }
      }
      const latest = rows[0];
      if (latest === undefined) return null;
      const [wire] = await wireReports([latest]);
      return wire ?? null;
    },
  );

  // --- GET /reports/:id --------------------------------------------------
  // Single report by id. Two branches, one wire shape:
  //
  //   owner — scoped through the dog FK. 404 if the report doesn't exist OR
  //     doesn't belong to a dog this owner owns — same response so an
  //     attacker can't enumerate ids. UNCHANGED at 1.13.0.
  //   staff — any LIVE report, cross-owner (wire 1.13.0 / design §9). Through
  //     1.12.0 this branch 404'd every non-owner principal and pushed staff at
  //     `/staff/reports/*`, which only ever listed BY DOG — so a portal surface
  //     holding a bare report id had nowhere to resolve it. A staff principal
  //     has no owner scope, so there is nothing here to scope against.
  //
  // A soft-deleted report is 404 for BOTH (`live(reports)` in either query).
  app.get('/reports/:id', { preHandler: [authHook] }, async (request): Promise<ReportWire> => {
    const principal = requirePrincipal(request);
    const { id } = parseReportIdParam(request.params);
    const row =
      principal.kind === 'staff'
        ? await reportsRepository.findLiveById(id)
        : await reportsRepository.findByIdForOwner(id, principal.ownerId);
    if (row === undefined) {
      throw new ApiError('not_found', `report ${id} not found`);
    }
    const [wire] = await wireReports([row]);
    if (wire === undefined) {
      throw new Error(`report ${id}: wireReports unexpectedly emitted no row`);
    }
    return wire;
  });
}

// ---- query/param parsing --------------------------------------------

function parseDogIdParam(params: unknown): { id: string } {
  const parsed = dogIdParamSchema.safeParse(params);
  if (!parsed.success) {
    throw new ApiError('bad_request', `invalid path: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}

function parseReportIdParam(params: unknown): { id: string } {
  const parsed = reportIdParamSchema.safeParse(params);
  if (!parsed.success) {
    throw new ApiError('bad_request', `invalid path: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}

function parseResolveQuery(query: unknown): z.infer<typeof resolveQuerySchema> {
  const parsed = resolveQuerySchema.safeParse(query);
  if (!parsed.success) {
    throw new ApiError('bad_request', `invalid query: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}

// ---- denormalize ------------------------------------------------------

/**
 * Resolve trainer names + emit §B wire shapes. One batched staff
 * lookup regardless of row count — cost is constant in the input size.
 * Pure side of the route: takes already-sorted rows; returns the JSON
 * the FE consumes.
 */
async function wireReports(rows: ReportRow[]): Promise<ReportWire[]> {
  if (rows.length === 0) return [];
  const trainerName = await staffRepository.resolveTrainerNames(rows);
  return rows.map((row) => toReportWire(row, trainerName(row.trainerStaffId)));
}
