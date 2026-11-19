import { z } from 'zod';
import { MAX_MESSAGE_SEQ } from '../contracts/wire.js';
import { ApiError } from './errors.js';
import { formatZodIssues } from './zodIssues.js';

/**
 * `?after_seq=` on both message lists (9.2.0 `GetThreadsMessagesQuery` and
 * `GetStaffThreadsMessagesQuery`, W4; contract-notes mechanic 15; brief CR4): an integer from 0 to
 * `MAX_MESSAGE_SEQ`, coerced from the query string as `GetNotificationsQuery.limit` is. Out of
 * range, a fraction or not a number is 400, logged below the pager's level: unbounded, Postgres
 * answered 22003, a 500 that pages (M1-a). Each route pins its wire type to this schema.
 */
export const afterSeqQuerySchema = z.object({
  after_seq: z.coerce.number().int().min(0).max(MAX_MESSAGE_SEQ).optional(),
});

/** `?after_seq=`, or 400 `bad_request`. */
export function parseAfterSeqQuery(query: unknown): number | undefined {
  const parsed = afterSeqQuerySchema.safeParse(query ?? {});
  if (!parsed.success) {
    throw new ApiError('bad_request', `invalid query: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data.after_seq;
}
