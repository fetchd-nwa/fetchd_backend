import type { z } from 'zod';

/**
 * Format a `ZodError` into the readable single-line string we return in
 * `AuthError` messages. Each issue is `path: message`; the root path
 * (`[]` from a top-level failure) renders as `(root)`; issues join with
 * `; `. Promoted Day-4b from inline copies in `auth/provisioning.ts` +
 * `routes/me.ts` + this day's `routes/vets.ts` (three uses, extraction
 * trip).
 *
 *   throw new AuthError('bad_request', `invalid query: ${formatZodIssues(parsed.error)}`);
 */
export function formatZodIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}
