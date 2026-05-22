import type { z } from 'zod';
import { ApiError } from './errors.js';

/**
 * Format a `ZodError` into the readable single-line string we return in
 * `ApiError` messages. Each issue is `path: message`; the root path
 * (`[]` from a top-level failure) renders as `(root)`; issues join with
 * `; `. Promoted Day-4b from inline copies in `auth/provisioning.ts` +
 * `routes/me.ts` + this day's `routes/vets.ts` (three uses, extraction
 * trip).
 *
 *   throw new ApiError('bad_request', `invalid query: ${formatZodIssues(parsed.error)}`);
 */
export function formatZodIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}

/**
 * Parse `value` against `schema`; on failure throw `ApiError('bad_request',
 * 'invalid {label}: {issues}')`. Promoted Day-9d at the rule-of-N trigger
 * — 20+ call sites of the same `safeParse → if !success → throw` pattern
 * across `routes/*` (every mutation route parses params + body; Day-9d's
 * 7 nested mutations push the count past the extraction threshold).
 *
 * The `label` argument is the noun the error message names ("dog id",
 * "vaccine payload", "vet patch"). Keeping it explicit per-call-site is
 * better than auto-inferring from the schema name — the schema is reusable
 * but the user-facing description should match the route's verb-and-noun
 * vocabulary.
 *
 *   const body = parseOrThrow(postBodySchema, request.body, 'vaccine payload');
 *
 * Throws `ApiError('bad_request', ...)`, never returns a Result — the
 * route layer's error mapper already converts ApiError to the JSON
 * envelope. Returning a Result would force every call site to re-check
 * `.ok` and re-throw; the throw lets the parsed data flow inline.
 */
export function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ApiError('bad_request', `invalid ${label}: ${formatZodIssues(result.error)}`);
  }
  return result.data;
}
