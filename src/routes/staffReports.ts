import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import { hashRequestBody, requireIdempotencyKey, withMutation } from '../db/mutation.js';
import { bookingsRepository } from '../db/repositories/bookingsRepository.js';
import { dogsRepository } from '../db/repositories/dogsRepository.js';
import { notificationsRepository } from '../db/repositories/notificationsRepository.js';
import { reportsRepository } from '../db/repositories/reportsRepository.js';
import { staffRepository } from '../db/repositories/staffRepository.js';
import { reportProgram, serviceCategory } from '../db/schema/schema.js';
import { ApiError } from '../lib/errors.js';
import { pgEnumTuple } from '../lib/pgEnumTuple.js';
import { requireStaff } from '../lib/principalNarrows.js';
import { toReportWire, type ReportProgram, type ReportWire } from '../lib/reportWire.js';

/**
 * Day-19 staff portal verb 2 — report authoring (DATA-CONTRACT R2).
 *
 *   POST  /staff/reports       — author a report (base + results|content)
 *   PATCH /staff/reports/:id   — edit an existing report's content fields
 *
 * R2 is a discriminated union on `program`. Two program families:
 *   - SESSION programs carry a `content` variant doc (REQUIRED).
 *   - CURRICULUM programs carry a `results` envelope and NO `content`.
 * The schema `reports_check` CHECK is the DB backstop; this route raises a
 * clean 422 first. `content` is opaque JSONB — the FE owns its internal
 * shape per `lib/reportWire` `to*Content`; the route validates presence-
 * by-program + the known `results` envelope structure.
 *
 * POST creates the report row (visible immediately in the owner's
 * `/dogs/:id/reports` read, scoped by dog_id), optionally back-links one
 * booking's `session_report_id`, and enqueues a `report-published`
 * notification to the dog's owner.
 *
 * Group-class reports back-link the WHOLE cohort run: a `link_booking_id`
 * pointing at a group-class booking propagates `session_report_id` to every
 * weekly booking for that (cohort, dog) — see
 * `bookingsRepository.setSessionReportId` (Day-19b, DATA-CONTRACT group-class
 * enrollment). The `report_id`-vs-`session_report_id` distinction is left
 * documented-open; only `session_report_id` is used here.
 *
 * DEFERRED to Day-19c (documented in HANDOFF):
 *   - report-photo / report-video media attachment (staff-author media
 *     ownership rework across POST/GET/DELETE /media).
 */

const SERVICE_CATEGORY_VALUES = pgEnumTuple(serviceCategory);
const REPORT_PROGRAM_VALUES = pgEnumTuple(reportProgram);

/** Programs that carry a `content` variant doc (REQUIRED); the rest are
 * curriculum programs that carry a `results` envelope and no content. */
const SESSION_PROGRAMS: ReadonlySet<ReportProgram> = new Set([
  'private-lesson',
  'boarding-session',
  'board-train-session',
  'group-class-session',
]);

const MAX_EXCERPT_LEN = 2000;
const MAX_FULL_TEXT_LEN = 20000;
const MAX_VERDICT_LEN = 500;

const uuidParamSchema = z.object({ id: z.string().uuid() });

const skillResultSchema = z
  .object({
    status: z.enum(['pass', 'learning', 'pending']),
    score: z.string().optional(),
    meta: z.array(z.object({ label: z.string(), value: z.string() }).strict()).optional(),
  })
  .strict();

const resultsEnvelopeSchema = z
  .object({
    results: z.record(skillResultSchema).optional(),
    practice_at_home: z.array(z.object({ text: z.string() }).strict()).optional(),
    friends_today: z.array(z.string()).optional(),
    additional_skills_completed: z.array(z.string()).optional(),
  })
  .strict();

// Opaque variant doc — the FE owns the internal shape (R2 `to*Content`).
const contentSchema = z.record(z.unknown());

const postReportBodySchema = z
  .object({
    dog_id: z.string().uuid(),
    date: z.string().datetime({ offset: true }),
    category: z.enum(SERVICE_CATEGORY_VALUES),
    program: z.enum(REPORT_PROGRAM_VALUES),
    excerpt: z.string().trim().min(1).max(MAX_EXCERPT_LEN),
    full_text: z.string().trim().min(1).max(MAX_FULL_TEXT_LEN),
    trainer_staff_id: z.string().uuid().optional(),
    visit_count: z.number().int().min(0).optional(),
    verdict_headline: z.string().trim().max(MAX_VERDICT_LEN).optional(),
    results: resultsEnvelopeSchema.optional(),
    content: contentSchema.optional(),
    link_booking_id: z.string().uuid().optional(),
  })
  .strict();

type PostReportBody = z.infer<typeof postReportBodySchema>;

const patchReportBodySchema = z
  .object({
    excerpt: z.string().trim().min(1).max(MAX_EXCERPT_LEN).optional(),
    full_text: z.string().trim().min(1).max(MAX_FULL_TEXT_LEN).optional(),
    visit_count: z.number().int().min(0).nullable().optional(),
    verdict_headline: z.string().trim().max(MAX_VERDICT_LEN).nullable().optional(),
    results: resultsEnvelopeSchema.nullable().optional(),
    content: contentSchema.nullable().optional(),
  })
  .strict();

type PatchReportBody = z.infer<typeof patchReportBodySchema>;

export function registerStaffReportsRoute(app: FastifyInstance, opts: AuthRouteOptions = {}): void {
  const authHook = resolveAuthHook(opts);

  // --- POST /staff/reports ------------------------------------------------
  app.post(
    '/staff/reports',
    { preHandler: [authHook] },
    async (request, reply): Promise<ReportWire> => {
      const principal = requirePrincipal(request);
      requireStaff(principal, 'author a report');
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
      const body = parsePostBody(request.body);
      assertContentByProgram(body.program, body.content);

      // cache-noop: report reads aren't in the §3 cache map (no read-
      // through wrap on reportsRepository); the owner's next /dogs/:id/
      // reports read sees the new row directly.
      const outcome = await withMutation<ReportWire>(
        {
          principal,
          idempotencyKey,
          endpoint: 'POST /staff/reports',
          requestHash: hashRequestBody(body),
        },
        async (tx) => {
          const ownerId = await dogsRepository.findOwnerIdInTx(tx, body.dog_id);
          if (ownerId === undefined) {
            throw new ApiError('not_found', `dog ${body.dog_id} not found`);
          }

          const { id } = await reportsRepository.create(tx, {
            dogId: body.dog_id,
            date: body.date,
            trainerStaffId: body.trainer_staff_id ?? principal.staffId,
            category: body.category,
            program: body.program,
            excerpt: body.excerpt,
            fullText: body.full_text,
            visitCount: body.visit_count ?? null,
            verdictHeadline: body.verdict_headline ?? null,
            results: body.results ?? null,
            content: body.content ?? null,
          });

          // Optional back-link. The booking must be live + its lead dog must
          // be this report's dog (coherence guard). For a group-class booking
          // the link fans out to every weekly booking of the (cohort, dog).
          if (body.link_booking_id !== undefined) {
            const linked = await bookingsRepository.setSessionReportId(tx, {
              bookingId: body.link_booking_id,
              reportId: id,
              dogId: body.dog_id,
            });
            if (linked === undefined) {
              throw new ApiError(
                'invalid_payload',
                `link_booking_id ${body.link_booking_id} is not a live booking for dog ${body.dog_id}`,
              );
            }
          }

          await notificationsRepository.enqueue(tx, {
            ownerId,
            type: 'report-published',
            title: 'New report card',
            body: body.excerpt,
            deepLinkPath: `/reports/${id}`,
            dogIds: [body.dog_id],
          });

          const wire = await wireOneReport(tx, id);
          return { status: 201, body: wire };
        },
      );

      reply.code(outcome.status);
      return outcome.body;
    },
  );

  // --- PATCH /staff/reports/:id -------------------------------------------
  //
  // Edit the content fields of an existing report. Identity columns
  // (dog_id / category / program) are locked — a re-author POSTs a new
  // report. No re-notification (an edit is a correction, not a publish).
  app.patch(
    '/staff/reports/:id',
    { preHandler: [authHook] },
    async (request): Promise<ReportWire> => {
      const principal = requirePrincipal(request);
      requireStaff(principal, 'edit a report');
      const { id } = parseUuidParam(request.params);
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
      const body = parsePatchBody(request.body);

      // cache-noop: report reads aren't cached (see POST).
      const outcome = await withMutation<ReportWire>(
        {
          principal,
          idempotencyKey,
          endpoint: 'PATCH /staff/reports/:id',
          requestHash: hashRequestBody({ id, ...body }),
        },
        async (tx) => {
          const existing = await reportsRepository.findByIdInTx(tx, id);
          if (existing === undefined) {
            throw new ApiError('not_found', `report ${id} not found`);
          }
          // Re-validate content against the STORED program: curriculum
          // reports can't grow a content doc; session reports can't drop it.
          if (body.content !== undefined) {
            const isSession = SESSION_PROGRAMS.has(existing.program);
            if (!isSession && body.content !== null) {
              throw new ApiError(
                'invalid_payload',
                `content is not allowed on a ${existing.program} (curriculum) report`,
              );
            }
            if (isSession && body.content === null) {
              throw new ApiError(
                'invalid_payload',
                `content cannot be cleared on a ${existing.program} (session) report`,
              );
            }
          }

          await reportsRepository.update(tx, id, {
            excerpt: body.excerpt,
            fullText: body.full_text,
            visitCount: body.visit_count,
            verdictHeadline: body.verdict_headline,
            results: body.results,
            content: body.content,
          });

          const wire = await wireOneReport(tx, id);
          return { status: 200, body: wire };
        },
      );
      return outcome.body;
    },
  );
}

/**
 * Re-read a report in-tx and emit its §B wire shape, resolving the trainer
 * name. Shared by POST + PATCH so both return the same shape the owner
 * reads back.
 */
async function wireOneReport(
  tx: Parameters<typeof reportsRepository.findByIdInTx>[0],
  id: string,
): Promise<ReportWire> {
  const row = await reportsRepository.findByIdInTx(tx, id);
  if (row === undefined) {
    throw new Error(`staff report ${id}: row vanished before re-fetch`);
  }
  const trainerName = await staffRepository.resolveTrainerNames([row]);
  return toReportWire(row, trainerName(row.trainerStaffId));
}

/**
 * Enforce the R2 content rule: session programs require a `content`
 * variant doc; curriculum programs forbid one. The schema CHECK is the
 * backstop; this is the clean 422.
 */
function assertContentByProgram(program: ReportProgram, content: unknown): void {
  const isSession = SESSION_PROGRAMS.has(program);
  if (isSession && content === undefined) {
    throw new ApiError('invalid_payload', `content is required for the session program ${program}`);
  }
  if (!isSession && content !== undefined) {
    throw new ApiError(
      'invalid_payload',
      `content is not allowed for the curriculum program ${program}`,
    );
  }
}

function parsePostBody(body: unknown): PostReportBody {
  const parsed = postReportBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError('invalid_payload', `invalid body: ${parsed.error.message}`);
  }
  return parsed.data;
}

function parsePatchBody(body: unknown): PatchReportBody {
  const parsed = patchReportBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError('invalid_payload', `invalid body: ${parsed.error.message}`);
  }
  return parsed.data;
}

function parseUuidParam(params: unknown): { id: string } {
  const parsed = uuidParamSchema.safeParse(params);
  if (!parsed.success) {
    throw new ApiError('bad_request', `invalid path: ${parsed.error.message}`);
  }
  return parsed.data;
}
