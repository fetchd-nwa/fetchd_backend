import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';

/**
 * The pin on R14's class (DECISIONS 132(b)). Every id parses through `uuidId()`
 * (`lib/uuidId.ts`), which lowercases it, so a `.uuid` of any shape in `src/routes/` is
 * an id that can reach a key in a second spelling, and one in `src/lib/` is the same id
 * one import away. `uuidId.ts` is the one exemption, for its one `.uuid`: a second in
 * that file fails, so the file cannot hold a `bareId()` either.
 *
 * It reads the syntax tree, not the text, so a chain split across lines is still one
 * `.uuid` and a comment or a string is not one. An id that never says `.uuid`, a bare
 * `z.string()` or an unparsed param, is the other half's: `route-id-params.test.ts` in
 * `test/contracts/` sends a non-uuid in every path param on the real route table.
 *
 * What still passes both halves, each run in `units/P14/evidence/backend/fix1/`:
 *   - a hand `.regex` that refuses in uuid's words: it parses and does not lowercase;
 *   - a destructured `uuid` (`const { uuid } = z.string()`): no access this reads;
 *   - a bare `z.string()` id in a body or a query: the other half fires path params.
 * This reads `src/routes/` and `src/lib/` only. These stop a mistake, not a determined
 * author, so the rest is a reviewer's to catch.
 */

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const PINNED_TREES = ['routes', 'lib'];
const SHARED_SCHEMA = 'lib/uuidId.ts';

function isUuidAccess(node: ts.Node): ts.Node | undefined {
  if (ts.isPropertyAccessExpression(node) && node.name.text === 'uuid') return node.name;
  if (
    ts.isElementAccessExpression(node) &&
    ts.isStringLiteralLike(node.argumentExpression) &&
    node.argumentExpression.text === 'uuid'
  ) {
    return node.argumentExpression;
  }
  return undefined;
}

/** Every `.uuid` in one source, as `name:line`. */
function uuidSites(name: string, source: string): string[] {
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const sites: string[] = [];
  const visit = (node: ts.Node): void => {
    const access = isUuidAccess(node);
    if (access !== undefined) {
      const { line } = file.getLineAndCharacterOfPosition(access.getStart(file));
      sites.push(`${name}:${line + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return sites;
}

function pinnedFiles(): string[] {
  return PINNED_TREES.flatMap((tree) =>
    readdirSync(join(SRC_DIR, tree), { recursive: true, encoding: 'utf8' })
      .filter((path) => path.endsWith('.ts'))
      .map((path) => `${tree}/${path}`),
  ).sort();
}

function sitesIn(path: string): string[] {
  return uuidSites(path, readFileSync(join(SRC_DIR, path), 'utf8'));
}

test('the pin sees a .uuid however it is spelled, and not a comment or a string', () => {
  const sites = (source: string): string[] => uuidSites('probe.ts', source);

  assert.deepEqual(sites(`const a = z.string().uuid();`), ['probe.ts:1']);
  assert.deepEqual(sites(`const a = z.string().uuid('id must be a UUID').toLowerCase();`), [
    'probe.ts:1',
  ]);
  assert.deepEqual(sites(`const a = z\n  .string()\n  .uuid();`), ['probe.ts:3']);
  assert.deepEqual(sites(`const a = z.string()\n  .uuid\n  ();`), ['probe.ts:2']);
  assert.deepEqual(sites(`const a = z.string()\n  // the id\n  .uuid();`), ['probe.ts:3']);
  assert.deepEqual(sites(`const a = z.string()['uuid']();`), ['probe.ts:1']);
  assert.deepEqual(sites(`const a = z.object({ ids: z.array(z.string().uuid()) });`), [
    'probe.ts:1',
  ]);

  assert.deepEqual(
    sites(
      `// z.string().uuid()\n/* .uuid() */\nconst a = 'z.string().uuid()';\nconst b = uuidId();`,
    ),
    [],
  );
});

test('no route or lib module spells .uuid: every id goes through uuidId()', () => {
  const files = pinnedFiles();
  // `credits.ts` is F4's route. A scan that found nothing to read would pass.
  for (const expected of ['routes/credits.ts', SHARED_SCHEMA]) {
    assert.ok(files.includes(expected), `src/ read as: ${files.join(', ')}`);
  }

  const sites = files.filter((path) => path !== SHARED_SCHEMA).flatMap(sitesIn);
  assert.deepEqual(
    sites,
    [],
    `${sites.length} bare .uuid in src/routes/ and src/lib/; use uuidId() from lib/uuidId.ts:\n${sites.join('\n')}`,
  );
});

test('uuidId.ts is the one exemption, for exactly one .uuid', () => {
  assert.equal(sitesIn(SHARED_SCHEMA).length, 1, `${SHARED_SCHEMA}: ${sitesIn(SHARED_SCHEMA)}`);
});
