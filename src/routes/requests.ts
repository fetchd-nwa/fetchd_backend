import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import { hashRequestBody, requireIdempotencyKey, withMutation } from '../db/mutation.js';
import { dogsRepository } from '../db/repositories/dogsRepository.js';
import { requestsRepository } from '../db/repositories/requestsRepository.js';
import { comfortLevel, requestStatus } from '../db/schema/schema.js';
import {
  alreadyRequestedError,
  evaluationRequiredError,
  type UnpassedEvaluationStatus,
} from '../lib/bookingErrors.js';
import { ApiError } from '../lib/errors.js';
import { pgEnumTuple } from '../lib/pgEnumTuple.js';
import { requireOwner } from '../lib/principalNarrows.js';
import { type ComfortLevel, type PendingRequestWire } from '../lib/requestWire.js';
import { sortRequestsBySubmittedAt, wireManyRequests } from '../lib/wireManyRequests.js';
import { formatZodIssues, parseOrThrow } from '../lib/zodIssues.js';

/**
 * `GET /requests?status=` `[auth]` and `GET /requests/:id` `[auth]` —
 * the pending-request read surface (DATA-CONTRACT §C requests). Owner-
 * scoped; staff principals get an empty list / 404 (Day-19 staff portal
 * uses `/staff/requests/*` for cross-owner access — out of scope here).
 *
 * Day 12 added the owner-side mutation surface (§C.1 Model 3):
 *   - `POST /requests` — submit a pending request (PL / B&T / Boarding)
 *   - `PATCH /requests/:id` — edit preferred_dates / notes / focus /
 *     length_weeks (identity fields locked); status must be 'submitted'
 *   - `POST /requests/:id/cancel` — owner withdraws their own request
 *
 * The staff portal verb (`POST /staff/requests/:id/approve` /
 * `/deny`) lives in `routes/staffRequests.ts` so the URL surface and
 * principal narrows stay structurally distinct (mirrors Day-11's
 * routes/enrollments.ts split from routes/bookings.ts).
 *
 * Wire shape per §B PendingRequest (R1 multi-dog, R8 structured focus).
 * The DB stores notes + focus as scalar columns; the wire helper composes
 * them into `{notes:{per_dog?,joint?}, focus:{staff_preference?,
 * comfort_level?}}`. `notes` is whole-object optional-omit; `focus` is
 * required outer (always emit `{}` minimum), inner keys optional-omit.
 *
 * Layer responsibilities (mirrors Day-5a bookings):
 *   route   → parse query/params/body, gate, repo, wire, respond
 *   repo    → SQL queries + projection (3 batched lookups per list +
 *              mutation primitives)
 *   wire    → DB row + dog ids + preferred-date ISOs → §B JSON shape
 */
const REQUEST_STATUS_VALUES = pgEnumTuple(requestStatus);
const COMFORT_LEVEL_VALUES = pgEnumTuple(comfortLevel);

const statusQuerySchema = z.object({
  status: z.enum(REQUEST_STATUS_VALUES).optional(),
});

const uuidParamSchema = z.object({
  id: z.string().uuid(),
});

/**
 * Day-12 limits on the POST /requests + PATCH /requests bodies. All three
 * categories share the same caps — owner request submissions are
 * lightweight (1-3 preferred slots, 1-5 dogs, ≤92-day lookahead).
 *
 *   `MAX_PREFERRED_DATES` — 3 matches §C.1 Model 3 prose ("3 ranked
 *      preferred_dates" for PL/B&T; "2 preferred-date slots" for
 *      boarding is within the same cap). The FE varies how many slots
 *      it surfaces per category; the backend accepts up to 3.
 *
 *   `MAX_DOGS_PER_REQUEST` — five, matching the day-program POST
 *      /bookings cap (Day 10). Hostile bodies are bounded BEFORE we
 *      touch the DB.
 *
 *   `MAX_LOOKAHEAD_DAYS` — 92 matches the day-program lookahead +
 *      availability range cap. Submitting a request 6 months out is a
 *      different UX problem than booking a session; deferred.
 *
 *   `MAX_LENGTH_WEEKS` — 12 weeks is a generous cap. NWA's standard
 *      B&T is 2 weeks; 12 covers an extended residential without
 *      letting the FE silently submit `length_weeks: 9999`.
 *
 *   `MAX_NOTE_LENGTH` — 2000 chars/note, same as POST /bookings.notes.
 */
const MAX_PREFERRED_DATES = 3;
const MAX_DOGS_PER_REQUEST = 5;
const MAX_LOOKAHEAD_DAYS = 92;
const MAX_LENGTH_WEEKS = 12;
const MAX_NOTE_LENGTH = 2000;
const MAX_STAFF_PREF_LENGTH = 100;
const ONE_DAY_MS = 86_400_000;

/**
 * Categories that go through the request → approval flow (§C.1 Model 3).
 * Narrower than `service_category` because day-school / day-care use
 * POST /bookings (Day 10), group-class uses POST /enrollments (Day 11),
 * and evaluation is a direct booking (no approval).
 */
const REQUEST_CATEGORIES = ['private-lesson', 'board-and-train', 'boarding'] as const;
type RequestCategory = (typeof REQUEST_CATEGORIES)[number];

const focusBodySchema = z
  .object({
    staff_preference: z.string().trim().max(MAX_STAFF_PREF_LENGTH).optional(),
    comfort_level: z.enum(COMFORT_LEVEL_VALUES).optional(),
  })
  .strict();

const notesBodySchema = z
  .object({
    per_dog: z.string().max(MAX_NOTE_LENGTH).optional(),
    joint: z.string().max(MAX_NOTE_LENGTH).optional(),
  })
  .strict();

const isoDateTimeSchema = z.string().datetime({ offset: true });

const postRequestBodySchema = z
  .object({
    category: z.enum(REQUEST_CATEGORIES),
    lead_dog_id: z.string().uuid(),
    additional_dog_ids: z
      .array(z.string().uuid())
      .max(MAX_DOGS_PER_REQUEST - 1)
      .optional(),
    preferred_dates: z.array(isoDateTimeSchema).min(1).max(MAX_PREFERRED_DATES),
    notes: notesBodySchema.optional(),
    focus: focusBodySchema.optional(),
    length_weeks: z.number().int().min(1).max(MAX_LENGTH_WEEKS).optional(),
  })
  .strict();

type PostRequestBody = z.infer<typeof postRequestBodySchema>;

const patchRequestBodySchema = z
  .object({
    preferred_dates: z.array(isoDateTimeSchema).min(1).max(MAX_PREFERRED_DATES).optional(),
    notes: notesBodySchema.nullable().optional(),
    focus: focusBodySchema.nullable().optional(),
    length_weeks: z.number().int().min(1).max(MAX_LENGTH_WEEKS).nullable().optional(),
    // Identity fields explicitly accepted in the schema so Zod's strict
    // mode doesn't catch them with "unrecognized key" before the
    // validator can map them to a clearer 422. The post-parse check
    // rejects with the route-specific message.
    category: z.unknown().optional(),
    lead_dog_id: z.unknown().optional(),
    additional_dog_ids: z.unknown().optional(),
  })
  .strict();

type PatchRequestBody = z.infer<typeof patchRequestBodySchema>;

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
      const sorted = sortRequestsBySubmittedAt(rows, 'desc');
      return wireManyRequests(sorted);
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
      const [wire] = await wireManyRequests([row]);
      if (wire === undefined) {
        // pending_request_dogs is empty for this request — structural bug.
        throw new Error(
          `pending_request ${id}: failed to resolve lead dog from pending_request_dogs`,
        );
      }
      return wire;
    },
  );

  // --- POST /requests -----------------------------------------------------
  //
  // Day 12 owner-side request submission (DATA-CONTRACT §C.1 Model 3).
  // Single transaction:
  //   1. Per-category invariant check (B&T = single dog + length_weeks
  //      required; PL/boarding = no length_weeks).
  //   2. Ownership gate per dog (lead + every additional).
  //   3. Evaluation gate at the request boundary for B&T + boarding
  //      (Day 12b, §A Amendment 2026-05-23). Lead-only — additional
  //      dogs are caught at the staff approve verb's checkBookingGates.
  //   4. INSERT pending_requests row (status='submitted'). Source = 'app'.
  //   5. INSERT pending_request_dogs (lead + additionals).
  //   6. INSERT pending_request_preferred_dates (ordinal 1, 2, 3 …).
  //   7. Re-read the full row + child rows and emit the wire shape.
  //
  // Returns 201 + PendingRequestWire. No payment/vaccine/agreement gates
  // fire on submission — those fire when the staff approve verb attempts
  // the booking INSERT. The evaluation gate is the one exception: B&T
  // + boarding pre-check at the request boundary so owners can't submit
  // for an un-evaluated dog (staff would otherwise bounce it back).
  app.post(
    '/requests',
    { preHandler: [authHook] },
    async (request, reply): Promise<PendingRequestWire> => {
      const principal = requirePrincipal(request);
      requireOwner(principal, 'submit a request');
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
      const body = parseOrThrow(postRequestBodySchema, request.body, 'body');
      const parsed = validatePostRequestBody(body);

      const outcome = await withMutation<PendingRequestWire>(
        {
          principal,
          idempotencyKey,
          endpoint: 'POST /requests',
          requestHash: hashRequestBody(body),
          // No cache keys today — `/requests` reads aren't cached in
          // the §3 map. Day-19 portal queue reads may add `requests:*`
          // patterns; the seam is declared so the cache-invalidation
          // lint passes.
          keysToInvalidate: () => [],
        },
        async (tx) => {
          // 1. Ownership gate — every dog (lead + additionals) must
          //    belong to the principal. Same response for "not owned"
          //    vs "doesn't exist" so dog ids don't enumerate across
          //    owners (mirrors POST /bookings).
          for (const dogId of parsed.allDogIds) {
            const exists = await dogsRepository.findOwnedExists(dogId, principal.ownerId, tx);
            if (!exists) {
              throw new ApiError('not_found', `dog ${dogId} not found`);
            }
          }

          // 2. Evaluation gate at the request boundary (Day 12b,
          //    §A Amendment 2026-05-23 step 5). Board-and-train +
          //    boarding require the LEAD dog to have a passing
          //    evaluation before the owner can submit a request —
          //    saves staff a round-trip otherwise the approve verb
          //    would have to bounce it back. Private-lesson is
          //    staff-curated and does NOT gate at this boundary.
          //
          //    Additional dogs (boarding multi-dog) aren't checked
          //    here — the staff approve verb's checkBookingGates call
          //    will catch any unpassed additional dog at booking-
          //    insert time. Lead-only matches both the spec and the
          //    schema trigger's predicate.
          if (parsed.category === 'board-and-train' || parsed.category === 'boarding') {
            const statuses = await dogsRepository.findEvaluationStatusInTx(tx, [parsed.leadDogId]);
            const leadEval = statuses[0];
            if (leadEval !== undefined && leadEval.evaluationStatus !== 'passed') {
              throw evaluationRequiredError([
                {
                  dog_id: parsed.leadDogId,
                  // Narrow: the conditional above excludes 'passed'.
                  evaluation_status: leadEval.evaluationStatus as UnpassedEvaluationStatus,
                },
              ]);
            }
          }

          // 2b. Duplicate guard (Day-19d) — block a second OPEN request of
          //     the same category for a dog that already has one in flight.
          //     Once the prior request converts or cancels, re-requesting is
          //     allowed. Roster-matched (lead or additional).
          const alreadyRequested = await requestsRepository.findOpenByDogsAndCategory(
            tx,
            parsed.allDogIds,
            parsed.category,
          );
          if (alreadyRequested.length > 0) {
            throw alreadyRequestedError({ category: parsed.category, dog_ids: alreadyRequested });
          }

          // 3. INSERT pending_requests row.
          const { id } = await requestsRepository.create(tx, {
            ownerId: principal.ownerId,
            leadDogId: parsed.leadDogId,
            category: parsed.category,
            notesPerDog: parsed.notesPerDog,
            notesJoint: parsed.notesJoint,
            staffPreference: parsed.staffPreference,
            comfortLevel: parsed.comfortLevel,
            lengthWeeks: parsed.lengthWeeks,
          });

          // 4. INSERT join rows.
          await requestsRepository.addDogs(tx, id, {
            lead: parsed.leadDogId,
            additional: parsed.additionalDogIds,
          });
          await requestsRepository.addPreferredDates(tx, id, parsed.preferredDates);

          // 5. Re-read + wire. The re-read goes through the same
          //    findFullByIdInTx the approve verb uses, so a future
          //    schema change to the projection only touches one place.
          const row = await requestsRepository.findFullByIdInTx(tx, id);
          if (row === undefined) {
            throw new Error(`POST /requests: row ${id} vanished before re-fetch`);
          }
          const [wire] = await wireManyRequests([row], tx);
          if (wire === undefined) {
            throw new Error(`POST /requests: wire assembly for ${id} returned no row`);
          }
          return { status: 201, body: wire };
        },
      );

      reply.code(outcome.status);
      return outcome.body;
    },
  );

  // --- PATCH /requests/:id ------------------------------------------------
  //
  // Day 12 owner-side request edit. Allowed fields: preferred_dates,
  // notes, focus, length_weeks. Identity fields (category, lead_dog_id,
  // additional_dog_ids) are LOCKED — the owner re-submits if those
  // change. State-machine guard: only requests at status='submitted' are
  // editable; once converted/approved/cancelled an edit is 422.
  app.patch(
    '/requests/:id',
    { preHandler: [authHook] },
    async (request): Promise<PendingRequestWire> => {
      const principal = requirePrincipal(request);
      requireOwner(principal, 'edit their requests');
      const { id } = parseUuidParam(request.params);
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
      const body = parseOrThrow(patchRequestBodySchema, request.body, 'body');
      const parsed = validatePatchRequestBody(body);

      const outcome = await withMutation<PendingRequestWire>(
        {
          principal,
          idempotencyKey,
          endpoint: 'PATCH /requests/:id',
          requestHash: hashRequestBody({ id, ...body }),
          keysToInvalidate: () => [],
        },
        async (tx) => {
          // 1. Read + owner-scope check. Same 404 response for not-found
          //    vs not-yours so request ids don't enumerate.
          const row = await requestsRepository.findFullByIdInTx(tx, id);
          if (row === undefined || row.ownerId !== principal.ownerId) {
            throw new ApiError('not_found', `pending request ${id} not found`);
          }

          // 2. State-machine guard — only 'submitted' is editable. The
          //    other states are observable but immutable from the
          //    owner's side.
          if (row.status !== 'submitted') {
            throw new ApiError(
              'conflict',
              `pending request ${id} is ${row.status} and cannot be edited`,
            );
          }

          // 3. Apply the partial update + (optionally) replace preferred
          //    dates. UPDATE before the preferred-dates replace so the
          //    pending_requests audit row captures the prior scalar
          //    state alongside the date-replacement audit rows.
          await requestsRepository.update(tx, id, {
            notesPerDog: parsed.notesPerDog,
            notesJoint: parsed.notesJoint,
            staffPreference: parsed.staffPreference,
            comfortLevel: parsed.comfortLevel,
            lengthWeeks: parsed.lengthWeeks,
          });
          if (parsed.preferredDates !== undefined) {
            await requestsRepository.replacePreferredDates(tx, id, parsed.preferredDates);
          }

          // 4. Re-read + wire. The post-update full-row read is the
          //    same projection the read endpoints use.
          const updated = await requestsRepository.findFullByIdInTx(tx, id);
          if (updated === undefined) {
            throw new Error(`PATCH /requests/${id}: row vanished before re-fetch`);
          }
          const [wire] = await wireManyRequests([updated], tx);
          if (wire === undefined) {
            throw new Error(`PATCH /requests/${id}: wire assembly returned no row`);
          }
          return { status: 200, body: wire };
        },
      );
      return outcome.body;
    },
  );

  // --- POST /requests/:id/cancel ------------------------------------------
  //
  // Day 12 owner-side withdrawal. Sets status='cancelled' without
  // stamping approved_at / approved_by_staff_id (the staff deny verb
  // does both). Allowed from 'submitted' and 'approved-awaiting-payment'
  // (a B&T request whose owner changed their mind before paying); 422
  // from converted/cancelled.
  app.post(
    '/requests/:id/cancel',
    { preHandler: [authHook] },
    async (request): Promise<PendingRequestWire> => {
      const principal = requirePrincipal(request);
      requireOwner(principal, 'cancel their requests');
      const { id } = parseUuidParam(request.params);
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);

      const outcome = await withMutation<PendingRequestWire>(
        {
          principal,
          idempotencyKey,
          endpoint: 'POST /requests/:id/cancel',
          requestHash: hashRequestBody({ id }),
          keysToInvalidate: () => [],
        },
        async (tx) => {
          const row = await requestsRepository.findFullByIdInTx(tx, id);
          if (row === undefined || row.ownerId !== principal.ownerId) {
            throw new ApiError('not_found', `pending request ${id} not found`);
          }
          if (row.status === 'cancelled' || row.status === 'converted') {
            throw new ApiError(
              'conflict',
              `pending request ${id} is ${row.status} and cannot be cancelled`,
            );
          }

          await requestsRepository.markCancelled(tx, id);

          const updated = await requestsRepository.findFullByIdInTx(tx, id);
          if (updated === undefined) {
            throw new Error(`POST /requests/${id}/cancel: row vanished before re-fetch`);
          }
          const [wire] = await wireManyRequests([updated], tx);
          if (wire === undefined) {
            throw new Error(`POST /requests/${id}/cancel: wire assembly returned no row`);
          }
          return { status: 200, body: wire };
        },
      );
      return outcome.body;
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

// ---- body validation -------------------------------------------------

interface ValidatedPostRequestBody {
  category: RequestCategory;
  leadDogId: string;
  additionalDogIds: string[];
  allDogIds: string[];
  preferredDates: string[];
  notesPerDog: string | null;
  notesJoint: string | null;
  staffPreference: string | null;
  comfortLevel: ComfortLevel | null;
  lengthWeeks: number | null;
}

/**
 * Cross-field invariants Zod doesn't express cleanly — per-category
 * constraints from §C.1 Model 3:
 *
 *   - Board-and-train: single dog only (no additional_dog_ids);
 *     `length_weeks` REQUIRED.
 *   - Private-lesson + boarding: any of {1..5} dogs; `length_weeks`
 *     MUST be omitted.
 *   - Dog ids distinct; lead not in additionals; all preferred dates
 *     in the future + within MAX_LOOKAHEAD_DAYS.
 */
function validatePostRequestBody(body: PostRequestBody): ValidatedPostRequestBody {
  const additionalDogIds = body.additional_dog_ids ?? [];
  const allDogIds = [body.lead_dog_id, ...additionalDogIds];

  // Distinct dog ids — lead in additionals OR duplicated additionals
  // are both the same defect from the user's POV.
  if (new Set(allDogIds).size !== allDogIds.length) {
    throw new ApiError('invalid_payload', 'lead_dog_id and additional_dog_ids must be distinct');
  }

  // Per-category invariants.
  if (body.category === 'board-and-train') {
    if (additionalDogIds.length > 0) {
      throw new ApiError(
        'invalid_payload',
        'board-and-train requests are single-dog only — additional_dog_ids is not allowed',
      );
    }
    if (body.length_weeks === undefined) {
      throw new ApiError(
        'invalid_payload',
        'board-and-train requests require length_weeks (program duration)',
      );
    }
  } else if (body.length_weeks !== undefined) {
    // PL + boarding don't carry length_weeks (it's a B&T-only field
    // per §B PendingRequest); a stray value is the FE encoding the
    // wrong shape.
    throw new ApiError(
      'invalid_payload',
      `length_weeks is only valid for board-and-train requests, not ${body.category}`,
    );
  }

  // Preferred dates — distinct, in the future, within lookahead.
  const nowMs = Date.now();
  const lookAheadMs = nowMs + MAX_LOOKAHEAD_DAYS * ONE_DAY_MS;
  const dateSet = new Set<string>();
  for (const iso of body.preferred_dates) {
    if (dateSet.has(iso)) {
      throw new ApiError('invalid_payload', `preferred_dates contains duplicate ${iso}`);
    }
    dateSet.add(iso);
    const ms = Date.parse(iso);
    if (ms <= nowMs) {
      throw new ApiError('invalid_payload', `preferred_dates entry ${iso} is in the past`);
    }
    if (ms > lookAheadMs) {
      throw new ApiError(
        'invalid_payload',
        `preferred_dates entry ${iso} exceeds the ${MAX_LOOKAHEAD_DAYS}-day lookahead window`,
      );
    }
  }

  return {
    category: body.category,
    leadDogId: body.lead_dog_id,
    additionalDogIds,
    allDogIds,
    preferredDates: body.preferred_dates,
    notesPerDog: normalizeNullableString(body.notes?.per_dog),
    notesJoint: normalizeNullableString(body.notes?.joint),
    staffPreference: normalizeNullableString(body.focus?.staff_preference),
    comfortLevel: body.focus?.comfort_level ?? null,
    lengthWeeks: body.length_weeks ?? null,
  };
}

interface ValidatedPatchRequestBody {
  notesPerDog: string | null | undefined;
  notesJoint: string | null | undefined;
  staffPreference: string | null | undefined;
  comfortLevel: ComfortLevel | null | undefined;
  lengthWeeks: number | null | undefined;
  preferredDates: string[] | undefined;
}

function validatePatchRequestBody(body: PatchRequestBody): ValidatedPatchRequestBody {
  // Identity fields are locked — reject before the repo. Cross-owner
  // re-target via PATCH would be a privilege-escalation if it landed.
  if (body.category !== undefined) {
    throw new ApiError('invalid_payload', 'category cannot be changed after submission');
  }
  if (body.lead_dog_id !== undefined) {
    throw new ApiError('invalid_payload', 'lead_dog_id cannot be changed after submission');
  }
  if (body.additional_dog_ids !== undefined) {
    throw new ApiError('invalid_payload', 'additional_dog_ids cannot be changed after submission');
  }

  // Preferred dates — same future-window check as POST.
  if (body.preferred_dates !== undefined) {
    const nowMs = Date.now();
    const lookAheadMs = nowMs + MAX_LOOKAHEAD_DAYS * ONE_DAY_MS;
    const dateSet = new Set<string>();
    for (const iso of body.preferred_dates) {
      if (dateSet.has(iso)) {
        throw new ApiError('invalid_payload', `preferred_dates contains duplicate ${iso}`);
      }
      dateSet.add(iso);
      const ms = Date.parse(iso);
      if (ms <= nowMs) {
        throw new ApiError('invalid_payload', `preferred_dates entry ${iso} is in the past`);
      }
      if (ms > lookAheadMs) {
        throw new ApiError(
          'invalid_payload',
          `preferred_dates entry ${iso} exceeds the ${MAX_LOOKAHEAD_DAYS}-day lookahead window`,
        );
      }
    }
  }

  // Notes / focus / length_weeks — undefined = leave unchanged; null =
  // clear; value = set. Empty strings normalize to null at the trust
  // boundary so the wire helper's omit-on-null convention round-trips.
  return {
    notesPerDog: extractPatchScalar(body.notes, 'per_dog'),
    notesJoint: extractPatchScalar(body.notes, 'joint'),
    staffPreference: extractPatchScalar(body.focus, 'staff_preference'),
    comfortLevel: extractPatchEnum<ComfortLevel>(body.focus, 'comfort_level'),
    lengthWeeks: body.length_weeks === undefined ? undefined : (body.length_weeks ?? null),
    preferredDates: body.preferred_dates,
  };
}

/**
 * Lift a nested PATCH scalar to the partial-update tri-state:
 *   - container undefined → undefined (leave unchanged)
 *   - container null → null (clear)
 *   - container present, field undefined → undefined (leave unchanged)
 *   - container present, field empty/null → null (clear)
 *   - container present, field set → string (set)
 *
 * Patching `notes: null` clears BOTH notes_per_dog and notes_joint;
 * patching `notes: { per_dog: 'x' }` leaves notes_joint unchanged.
 * Same shape for `focus` and its two inner fields.
 */
function extractPatchScalar(
  container: { [k: string]: unknown } | null | undefined,
  key: string,
): string | null | undefined {
  if (container === undefined) return undefined;
  if (container === null) return null;
  const value = container[key];
  if (value === undefined) return undefined;
  return normalizeNullableString(typeof value === 'string' ? value : undefined);
}

function extractPatchEnum<T extends string>(
  container: { [k: string]: unknown } | null | undefined,
  key: string,
): T | null | undefined {
  if (container === undefined) return undefined;
  if (container === null) return null;
  const value = container[key];
  if (value === undefined) return undefined;
  return value === null ? null : (value as T);
}

/**
 * Trim + normalize an optional string. Empty/undefined → null so the
 * wire helper's omit-on-null convention round-trips cleanly (mirrors
 * `lib/normalize.ts:normalizeOptional` from Day-9c).
 */
function normalizeNullableString(input: string | undefined): string | null {
  if (input === undefined) return null;
  const trimmed = input.trim();
  return trimmed === '' ? null : trimmed;
}
