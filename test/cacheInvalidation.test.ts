import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = join(__dirname, '..', 'src', 'routes');

/**
 * Day 10 cache-invariant lint — promotes the §3 cache map in
 * `lib/cache.ts` from documentation-as-contract to a build-time gate.
 *
 * Every `withMutation(...)` call in `src/routes/*.ts` MUST declare,
 * inside its params object, one of:
 *
 *   - `keysToInvalidate: () => [...]`      (exact-match wipes; OK to
 *     return [] when the mutation legitimately touches nothing in the
 *     cache map — `() => []` IS a valid declaration)
 *   - `patternsToInvalidate: () => [...]`  (glob wipes; same)
 *
 * OR — for mutations that genuinely don't touch any cached entity AND
 * the author wants to be explicit instead of using `() => []` — a
 * `cache-noop` comment somewhere in the 400 chars surrounding the
 * call, e.g.:
 *
 *   // cache-noop: owners table isn't in the §3 cache map
 *   const outcome = await withMutation({...});
 *
 * Why this is build-time enforcement (and not docs-only): the §3 map
 * lives in `lib/cache.ts` as a markdown table. A future mutation that
 * forgets to declare its invalidation list won't fail at runtime —
 * it'll silently leave stale entries until TTL. This test runs at
 * every `npm test` + every CI build, so the gap closes at the PR
 * stage, not after a stale-cache complaint lands in production.
 *
 * The lint walks the TypeScript AST (no fragile regex over braces/
 * strings/comments) — drops in cleanly for future routes.
 */

const INVALIDATION_PROPERTIES = new Set(['keysToInvalidate', 'patternsToInvalidate']);
const NOOP_MARKER = /\bcache-noop\b/i;
const COMMENT_WINDOW_CHARS = 400;

interface Violation {
  file: string;
  line: number;
  reason: 'no_declaration' | 'malformed_params';
}

function scanFile(filePath: string, relativeName: string): Violation[] {
  const source = readFileSync(filePath, 'utf8');
  const sourceFile = ts.createSourceFile(
    relativeName,
    source,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
    ts.ScriptKind.TS,
  );
  const violations: Violation[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isWithMutationCallee(node.expression)) {
      const firstArg = node.arguments[0];
      if (firstArg === undefined || !ts.isObjectLiteralExpression(firstArg)) {
        violations.push({
          file: relativeName,
          line: lineOf(sourceFile, node),
          reason: 'malformed_params',
        });
      } else if (!hasInvalidationProperty(firstArg) && !hasNoopMarker(source, node.getStart())) {
        violations.push({
          file: relativeName,
          line: lineOf(sourceFile, node),
          reason: 'no_declaration',
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

/**
 * The callee can be the bare identifier `withMutation` or a generic
 * call like `withMutation<DogWire>`. ts-AST normalizes both into a
 * `CallExpression.expression` of type `Identifier`.
 */
function isWithMutationCallee(expr: ts.Expression): boolean {
  return ts.isIdentifier(expr) && expr.text === 'withMutation';
}

function hasInvalidationProperty(obj: ts.ObjectLiteralExpression): boolean {
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop)) continue;
    const name = prop.name;
    if (name === undefined) continue;
    const text = ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null;
    if (text !== null && INVALIDATION_PROPERTIES.has(text)) return true;
  }
  return false;
}

/**
 * Look ±200 chars around the call for a `cache-noop` marker comment.
 * Wider than a single line so a doc-block above the route handler
 * can carry the justification without forcing it onto the call line
 * itself.
 */
function hasNoopMarker(source: string, callStart: number): boolean {
  const start = Math.max(0, callStart - COMMENT_WINDOW_CHARS);
  const end = Math.min(source.length, callStart + COMMENT_WINDOW_CHARS);
  return NOOP_MARKER.test(source.slice(start, end));
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
}

test('every withMutation call declares cache invalidation (or marks `// cache-noop:`)', () => {
  const violations: Violation[] = [];
  const files = readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.ts'));
  for (const file of files) {
    violations.push(...scanFile(join(ROUTES_DIR, file), file));
  }
  if (violations.length > 0) {
    const lines = violations.map((v) => {
      if (v.reason === 'malformed_params') {
        return `  ${v.file}:${v.line} — first argument to withMutation isn't an object literal (lint can't analyze; refactor or add a cache-noop comment)`;
      }
      return `  ${v.file}:${v.line} — missing 'keysToInvalidate' / 'patternsToInvalidate' / cache-noop comment`;
    });
    assert.fail(
      `Cache-invalidation invariant violated. Every withMutation call must declare what cache entries it invalidates (per the §3 map in lib/cache.ts), even if the answer is "nothing" (use \`keysToInvalidate: () => []\` or a \`// cache-noop: <reason>\` comment).\n\n${lines.join('\n')}\n`,
    );
  }
});

/**
 * Sanity-check: the lint actually finds calls. A regression that
 * silently breaks `withMutation` detection (e.g., the helper gets
 * renamed and the lint stops matching) would leave the cache invariant
 * effectively unenforced even though the test passes. Pin a floor on
 * the count so a drop is loud — bump when new routes legitimately add
 * mutations.
 */
test('cache-invalidation lint matches the expected number of withMutation call sites', () => {
  let count = 0;
  const files = readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.ts'));
  for (const file of files) {
    const source = readFileSync(join(ROUTES_DIR, file), 'utf8');
    const sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && isWithMutationCallee(node.expression)) count += 1;
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  // 12 mutations as of Day 10:
  //   - vets: POST + PATCH + DELETE (3)
  //   - me: PATCH (1)
  //   - dogs: POST + PATCH + DELETE (3)
  //   - dog-nested vaccines: POST + PATCH + DELETE (3)
  //   - dog-nested medications: POST + PATCH + DELETE (3)
  //   - dog-nested feeding: PUT (1)
  //   - bookings: POST (1)
  //   = 15 total. Bump when Day-11+ adds more.
  assert.ok(
    count >= 15,
    `Expected at least 15 withMutation call sites across api/src/routes (Day-10 baseline); found ${count}. Did the helper get renamed or moved?`,
  );
});
