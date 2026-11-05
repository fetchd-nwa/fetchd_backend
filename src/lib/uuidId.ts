import { z } from 'zod';

/**
 * Every id a route parses: a uuid, lowercased. Postgres reads a uuid in either case,
 * so a capitalised id is the same row to every query and a different string to
 * everything that compares strings: a distinct check, a second insert's primary key,
 * an advisory lock, a cache key, a notification's dedupe key. Past this parse there is
 * one spelling, so none of those has to think about it. `test/routeIdSpelling.test.ts`
 * fails on any `.uuid` left in `src/routes/` (DECISIONS 132(b)).
 *
 * `message` replaces zod's words where a route names the field in its refusal.
 */
export function uuidId(message?: string): z.ZodString {
  return z.string().uuid(message).toLowerCase();
}
