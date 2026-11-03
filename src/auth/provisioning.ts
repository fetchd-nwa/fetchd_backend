import { z } from 'zod';
import { ApiError } from '../lib/errors.js';

/**
 * What the Supabase "user created" webhook writes: NOTHING. It mints no
 * `staff` row (ACCT-U05; design §2.1:2099-2115, :1713) and, from 3.0.0-lg2.1,
 * no `owners` row either (ACCT-U04; design §2.2:2244, "`provisioning.ts:38-42`
 * path removed"; build P05 X9).
 *
 * Owner rows have two writers in v1, and neither is this webhook: §2.11's seed
 * step (Stage A's fake families) and the import (Stage B's real ones) create
 * the auth user through the admin API with no `app_role` and no owner fields,
 * then write the owner row with its uid themselves. Supabase's own sign-ups are
 * off in both stages (question 29), so no token can mint an owner row. Staff
 * rows have one writer, `npm run staff:provision`, which puts `app_role` in
 * `app_metadata` (a field only the admin API writes) and inserts the row
 * itself. `raw_user_meta_data` is what a client's `signUp({options: {data}})`
 * writes, so nothing in it confers anything: owner fields and an `app_role`
 * there are ignored alike.
 *
 * So every delivery the HMAC check lets through is answered 200
 * `{result: 'skipped'}` with nothing written, or 422 `invalid_payload` when it
 * is not a Supabase auth record at all. The skip's reason is logged, never
 * returned:
 *   - `not_insert`: the payload's `type` is not INSERT (DECISIONS 78, 81(d)).
 *     Read before the record, so an UPDATE (every sign-in writes
 *     `last_sign_in_at`) is skipped whatever it carries;
 *   - `staff_app_role`: `raw_app_meta_data.app_role` is set — the staffer's
 *     row is the script's;
 *   - `no_app_role`: any other INSERT, owner fields or not.
 *
 * A body with no `type` is read as an INSERT; what production actually sends
 * is read at the M1 production step (design.md:2117-2121).
 */

/** A metadata object as Supabase sends it: absent and `null` both mean `{}`. */
const metadata = z
  .record(z.unknown())
  .nullish()
  .transform((value) => value ?? {});

const envelopeSchema = z.object({
  record: z.object({
    id: z.string().uuid(),
    email: z.string().email(),
    raw_app_meta_data: metadata,
    raw_user_meta_data: metadata,
  }),
});

export type SkipReason =
  /** A webhook event other than INSERT (DECISIONS 78). */
  | 'not_insert'
  /** `raw_app_meta_data.app_role` is set: a staffer, provisioned by the script. */
  | 'staff_app_role'
  /** Any INSERT without `app_role`: owner rows are the seed's and the import's. */
  | 'no_app_role';

export interface WebhookSkip {
  kind: 'skip';
  reason: SkipReason;
}

/**
 * Pure: webhook body → why it writes nothing, or a precise `invalid_payload`
 * for a body that is not a Supabase auth record. No DB, no crypto —
 * unit-tested in isolation.
 */
export function parseInvite(body: unknown): WebhookSkip {
  if (isObject(body) && Object.hasOwn(body, 'type') && body.type !== 'INSERT') {
    return { kind: 'skip', reason: 'not_insert' };
  }
  const envelope = envelopeSchema.safeParse(body);
  if (!envelope.success) {
    throw new ApiError(
      'invalid_payload',
      'unexpected webhook payload (expected a Supabase auth.users record)',
    );
  }
  if (Object.hasOwn(envelope.data.record.raw_app_meta_data, 'app_role')) {
    return { kind: 'skip', reason: 'staff_app_role' };
  }
  return { kind: 'skip', reason: 'no_app_role' };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
