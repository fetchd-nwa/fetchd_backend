import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import type {
  AttendanceWire,
  GetStaffCheckinBoardQuery,
  GetStaffCheckinBoardResponse,
  PostStaffBookingsDogsCheckOutRequest,
  PostStaffBookingsDogsSendHomeRequest,
} from '../contracts/wire.js';
import type { Equal, Expect } from '../contracts/typeAsserts.js';
import { hashRequestBody, requireIdempotencyKey, withMutation } from '../db/mutation.js';
import { creditsInvalidationPattern } from '../db/repositories/creditsRepository.js';
import { LOCATION_SLUGS } from '../db/schema/schema.js';
import type { Tx } from '../db/tx.js';
import { readCheckinBoard } from '../lib/checkinBoard.js';
import {
  checkInInTx,
  checkOutInTx,
  noShowInTx,
  sendHomeInTx,
  turnAwayInTx,
  undoInTx,
  type VerbResult,
} from '../lib/checkinVerbs.js';
import { bucketChicagoToday, isValidCalendarDate } from '../lib/chicagoDate.js';
import { ApiError } from '../lib/errors.js';
import type { NoticeLog } from '../lib/noticeInSavepoint.js';
import { requireStaff } from '../lib/principalNarrows.js';
import { uuidId } from '../lib/uuidId.js';
import { formatZodIssues } from '../lib/zodIssues.js';

/**
 * The check-in board (6.0.0-lg5.1; DAY-U29, DAY-U40; design §2.3:2354-2418):
 *
 *   GET  /staff/checkin-board?location&date               the board's rows
 *   POST /staff/bookings/:id/dogs/:dogId/check-in          no body
 *   POST /staff/bookings/:id/dogs/:dogId/check-out         {note?, reissue_credit?}
 *   POST /staff/bookings/:id/dogs/:dogId/undo              no body
 *   POST /staff/bookings/:id/dogs/:dogId/turn-away         no body
 *   POST /staff/bookings/:id/dogs/:dogId/send-home         {training_completed?}
 *   POST /staff/bookings/:id/dogs/:dogId/no-show           no body (*Didn't come*)
 *
 * Any staff role, either campus. Each verb takes an `Idempotency-Key`, and everything that
 * reads a clock runs inside `withMutation`, after the claim, so a verb answered on its
 * date (or after 17:30) and replayed later, or with a desk clock moved back, gets its
 * stored answer (DECISIONS 128(a)). The transactions are `lib/checkinVerbs.ts`'s and the
 * settle `lib/settleDayShare.ts`'s; the board read is `lib/checkinBoard.ts`'s.
 */

/** Both path ids lowercased at the parse, before any key, lock or comparison. */
const shareParamSchema = z.object({ id: uuidId(), dogId: uuidId() });

const boardQuerySchema = z.object({
  location: z.enum(LOCATION_SLUGS),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD')
    .refine(isValidCalendarDate, 'not a real calendar date'),
});

/** `note` is the cancel reason's band (D17); the box omitted is unticked (answer 12). */
const checkOutBodySchema = z
  .object({
    note: z.string().trim().min(1).max(500).optional(),
    reissue_credit: z.boolean().optional(),
  })
  .strict();

/** *Finished training day*, omitted = unticked: the credit comes back (s09). */
const sendHomeBodySchema = z
  .object({
    training_completed: z.boolean().optional(),
  })
  .strict();

export type GetStaffCheckinBoardQueryConformance = Expect<
  Equal<z.input<typeof boardQuerySchema>, GetStaffCheckinBoardQuery>
>;
export type PostStaffBookingsDogsCheckOutBodyConformance = Expect<
  Equal<z.input<typeof checkOutBodySchema>, PostStaffBookingsDogsCheckOutRequest>
>;
export type PostStaffBookingsDogsSendHomeBodyConformance = Expect<
  Equal<z.input<typeof sendHomeBodySchema>, PostStaffBookingsDogsSendHomeRequest>
>;

export interface StaffCheckinRouteOptions extends AuthRouteOptions {
  /** Injectable clock: the verbs' `at` and date predicates, the board's today and 17:30. */
  now?: () => Date;
}

export function registerStaffCheckinRoute(
  app: FastifyInstance,
  opts: StaffCheckinRouteOptions = {},
): void {
  const authHook = resolveAuthHook(opts);
  const nowFactory = opts.now ?? ((): Date => new Date());

  app.get(
    '/staff/checkin-board',
    { preHandler: [authHook] },
    async (request): Promise<GetStaffCheckinBoardResponse> => {
      requireStaff(requirePrincipal(request), 'read the check-in board');
      const parsed = boardQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        throw new ApiError('bad_request', `invalid query: ${formatZodIssues(parsed.error)}`);
      }
      const now = nowFactory();
      if (parsed.data.date > bucketChicagoToday(now)) {
        throw new ApiError('bad_request', `invalid query: date ${parsed.data.date} is after today`);
      }
      return readCheckinBoard({ ...parsed.data, now });
    },
  );

  /** One verb's route: the claim, then the verb's transaction. */
  function registerVerb(
    verb: 'check-in' | 'check-out' | 'undo' | 'turn-away' | 'send-home' | 'no-show',
    run: (
      tx: Tx,
      args: {
        bookingId: string;
        dogId: string;
        staffId: string;
        now: Date;
        body: unknown;
        log: NoticeLog;
      },
    ) => Promise<VerbResult>,
    parseBody: (body: unknown) => Record<string, unknown>,
  ): void {
    const endpoint = `POST /staff/bookings/:id/dogs/:dogId/${verb}`;
    app.post(
      `/staff/bookings/:id/dogs/:dogId/${verb}`,
      { preHandler: [authHook] },
      async (request): Promise<AttendanceWire> => {
        const principal = requirePrincipal(request);
        requireStaff(principal, `${verb} a dog`);
        const params = shareParamSchema.safeParse(request.params);
        if (!params.success) {
          throw new ApiError('bad_request', `invalid path: ${formatZodIssues(params.error)}`);
        }
        const { id: bookingId, dogId } = params.data;
        const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
        const body = parseBody(request.body);
        let creditsOwnerId: string | undefined;
        let seatFreedAt: string | undefined;
        const outcome = await withMutation<AttendanceWire>(
          {
            principal,
            idempotencyKey,
            endpoint,
            requestHash: hashRequestBody({ bookingId, dogId, ...body }),
            // A credit that moved (a return, a re-check-in's re-debit) wipes her balance
            // cache, and a turn-away's freed seat its campus's availability. Every other
            // verb leaves the seat where it was: a checked-in dog's seat is hers all day.
            patternsToInvalidate: () => [
              ...(creditsOwnerId !== undefined ? [creditsInvalidationPattern(creditsOwnerId)] : []),
              ...(seatFreedAt !== undefined ? [`avail:${seatFreedAt}:*`] : []),
            ],
          },
          async (tx) => {
            const result = await run(tx, {
              bookingId,
              dogId,
              staffId: principal.staffId,
              now: nowFactory(),
              body,
              log: request.log,
            });
            creditsOwnerId = result.creditsOwnerId;
            seatFreedAt = result.seatFreedAt;
            return { status: 200, body: result.body };
          },
        );
        return outcome.body;
      },
    );
  }

  /** The no-body verbs read no body (D11): whatever arrives is ignored, and not hashed. */
  const noBody = (): Record<string, unknown> => ({});

  registerVerb('check-in', (tx, a) => checkInInTx(tx, a), noBody);
  registerVerb(
    'check-out',
    (tx, a) => {
      const body = a.body as z.infer<typeof checkOutBodySchema>;
      return checkOutInTx(tx, {
        ...a,
        reissueCredit: body.reissue_credit ?? false,
        ...(body.note !== undefined ? { note: body.note } : {}),
      });
    },
    (body) => {
      const parsed = checkOutBodySchema.safeParse(body ?? {});
      if (!parsed.success) {
        throw new ApiError('invalid_payload', `invalid body: ${formatZodIssues(parsed.error)}`);
      }
      return parsed.data;
    },
  );
  registerVerb('undo', (tx, a) => undoInTx(tx, a), noBody);
  registerVerb('turn-away', (tx, a) => turnAwayInTx(tx, a), noBody);
  registerVerb(
    'send-home',
    (tx, a) => {
      const body = a.body as z.infer<typeof sendHomeBodySchema>;
      return sendHomeInTx(tx, { ...a, trainingCompleted: body.training_completed ?? false });
    },
    (body) => {
      const parsed = sendHomeBodySchema.safeParse(body ?? {});
      if (!parsed.success) {
        throw new ApiError('invalid_payload', `invalid body: ${formatZodIssues(parsed.error)}`);
      }
      return parsed.data;
    },
  );
  registerVerb('no-show', (tx, a) => noShowInTx(tx, a), noBody);
}
