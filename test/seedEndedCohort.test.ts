import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { SEED } from '../scripts/seed-ids.js';

/**
 * P50 #11 (DECISIONS 460). The class lines on her Invoices tab read generic because the
 * seeds wrote group-class money rows with no cohort and no dog. The seeds now name one
 * cohort, `SEED.cohortPuppyFayEndedId`, with Waffles. That cohort is past AND soft-expired
 * on purpose: `GET /group-classes/:key/cohorts` lists every unexpired cohort, past ones
 * first, so an ended cohort alone could sit at the top of Puppy's list, take an enrolment,
 * and lend that enrolment the seeded open invoice as its `pay-later` status.
 *
 * Neither seed is imported here: both call `main()` at import time and would RUN, wiping
 * the database they reach. They are read as text and parsed into a syntax tree (as
 * `routeIdSpelling.test.ts` reads `src/`), so a comment or a string cannot pass for a row.
 * `seed-ids.ts` has no side effects, which is why it is its own module.
 */

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
const ENDED_COHORT_ID = 'c0407000-0000-4000-8000-000000000008';

function parse(name: string): ts.SourceFile {
  return ts.createSourceFile(
    name,
    readFileSync(join(SCRIPTS, name), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function property(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.PropertyAssignment | undefined {
  return object.properties.find(
    (p): p is ts.PropertyAssignment =>
      ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === name,
  );
}

/**
 * The rows a seed writes to `table` whose `id:` is exactly `idExpression` (e.g.
 * `SEED.chargeRefundedId`): object literals passed to `db.insert(<table>).values(...)`, alone
 * or in an array. Only rows of an insert count, so a deep link naming the same id
 * (`deepLinkToPath({ kind: 'invoice', id: QA.invoicePaidId })`) is not one.
 */
function insertedRows(
  file: ts.SourceFile,
  table: string,
  idExpression: string,
): ts.ObjectLiteralExpression[] {
  const found: ts.ObjectLiteralExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'values' &&
      ts.isCallExpression(node.expression.expression) &&
      node.expression.expression.expression.getText(file) === 'db.insert' &&
      node.expression.expression.arguments[0]?.getText(file) === table
    ) {
      for (const arg of node.arguments) {
        const rows = ts.isArrayLiteralExpression(arg) ? [...arg.elements] : [arg];
        for (const row of rows) {
          if (!ts.isObjectLiteralExpression(row)) continue;
          if (property(row, 'id')?.initializer.getText(file) === idExpression) found.push(row);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** A numeric literal expression (`-60`, `-60 + 3 * 7`, `(7)`), or undefined if it is not one. */
function evaluate(node: ts.Expression): number | undefined {
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (ts.isParenthesizedExpression(node)) return evaluate(node.expression);
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken) {
    const operand = evaluate(node.operand);
    return operand === undefined ? undefined : -operand;
  }
  if (ts.isBinaryExpression(node)) {
    const left = evaluate(node.left);
    const right = evaluate(node.right);
    if (left === undefined || right === undefined) return undefined;
    switch (node.operatorToken.kind) {
      case ts.SyntaxKind.PlusToken:
        return left + right;
      case ts.SyntaxKind.MinusToken:
        return left - right;
      case ts.SyntaxKind.AsteriskToken:
        return left * right;
      default:
        return undefined;
    }
  }
  return undefined;
}

/** `daysFromNow(<days>, <hour>?)`'s evaluated arguments, or undefined if it is not that call. */
function daysFromNowArgs(node: ts.Expression): number[] | undefined {
  if (!ts.isCallExpression(node)) return undefined;
  if (!ts.isIdentifier(node.expression) || node.expression.text !== 'daysFromNow') return undefined;
  const args = node.arguments.map(evaluate);
  return args.every((a): a is number => a !== undefined) ? args : undefined;
}

/** The text of a property's value, or undefined if the object does not set it. */
function valueText(
  file: ts.SourceFile,
  object: ts.ObjectLiteralExpression,
  name: string,
): string | undefined {
  return property(object, name)?.initializer.getText(file);
}

test('seed-ids: the ended Puppy cohort is c0407000-…-0008, in the cohort family db:dev:check maps', () => {
  assert.equal(SEED.cohortPuppyFayEndedId, ENDED_COHORT_ID);
});

test('seed-dev: the ended Puppy cohort is past and soft-expired, expired at its end (step 3b)', () => {
  const file = parse('seed-dev.ts');
  const rows = insertedRows(file, 'cohorts', 'SEED.cohortPuppyFayEndedId');
  assert.equal(
    rows.length,
    1,
    'seed-dev.ts inserts exactly one cohort naming SEED.cohortPuppyFayEndedId',
  );
  const row = rows[0]!;

  const start = property(row, 'startDate');
  const end = property(row, 'endDate');
  const expired = property(row, 'expiredAt');
  assert.ok(start !== undefined, 'the row sets startDate');
  assert.ok(end !== undefined, 'the row sets endDate');
  assert.ok(
    expired !== undefined,
    'the row sets expiredAt: an ended cohort that is not expired is still listed and still takes an enrolment',
  );

  const startArgs = daysFromNowArgs(start.initializer);
  const endArgs = daysFromNowArgs(end.initializer);
  const expiredArgs = daysFromNowArgs(expired.initializer);
  assert.ok(
    startArgs !== undefined,
    `startDate is daysFromNow(<number>…): ${start.initializer.getText(file)}`,
  );
  assert.ok(
    endArgs !== undefined,
    `endDate is daysFromNow(<number>…): ${end.initializer.getText(file)}`,
  );
  assert.ok(startArgs[0]! < 0, `startDate is in the past: daysFromNow(${startArgs[0]})`);
  assert.ok(endArgs[0]! < 0, `endDate is in the past: daysFromNow(${endArgs[0]})`);
  assert.ok(startArgs[0]! < endArgs[0]!, 'it starts before it ends');
  assert.deepEqual(expiredArgs, endArgs, 'expiredAt is its end, the same daysFromNow call');
});

test('the four seeded group-class money rows name the ended cohort and Waffles (P50 #11)', () => {
  const dev = parse('seed-dev.ts');
  const refunded = insertedRows(dev, 'charges', 'SEED.chargeRefundedId');
  assert.equal(refunded.length, 1, 'seed-dev.ts inserts the refunded charge once');
  assert.equal(valueText(dev, refunded[0]!, 'cohortId'), 'SEED.cohortPuppyFayEndedId');
  assert.equal(valueText(dev, refunded[0]!, 'dogId'), 'SEED.dogWafflesId');

  const qa = parse('seed-notifications-qa.ts');
  for (const [table, id] of [
    ['charges', 'QA.chargePaidId'],
    ['invoices', 'QA.invoicePaidId'],
    ['invoices', 'QA.invoiceInPersonId'],
  ] as const) {
    const rows = insertedRows(qa, table, id);
    assert.equal(rows.length, 1, `seed-notifications-qa.ts inserts ${id} into ${table} once`);
    assert.equal(valueText(qa, rows[0]!, 'cohortId'), 'BASE.cohortPuppyFayEndedId', id);
    assert.equal(valueText(qa, rows[0]!, 'dogId'), 'BASE.dogWafflesId', id);
  }
});

test('seed-notifications-qa: BASE copies SEED, and the ended cohort is a borrowed row it checks first', () => {
  const qa = parse('seed-notifications-qa.ts');
  let base: ts.ObjectLiteralExpression | undefined;
  let borrowed: ts.ArrayLiteralExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      let init: ts.Expression = node.initializer;
      while (ts.isAsExpression(init) || ts.isSatisfiesExpression(init)) init = init.expression;
      if (node.name.text === 'BASE' && ts.isObjectLiteralExpression(init)) base = init;
      if (node.name.text === 'BORROWED_FROM_SEED_DEV' && ts.isArrayLiteralExpression(init)) {
        borrowed = init;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(qa);
  assert.ok(base !== undefined, 'BASE is an object literal');
  assert.ok(borrowed !== undefined, 'BORROWED_FROM_SEED_DEV is an array literal');

  // "Keep in sync with its SEED": every id BASE copies is SEED's, key for key.
  const seed = SEED as Readonly<Record<string, string>>;
  for (const p of base.properties) {
    assert.ok(ts.isPropertyAssignment(p) && ts.isIdentifier(p.name), 'BASE holds plain keys');
    assert.ok(ts.isStringLiteral(p.initializer), `BASE.${p.name.text} is a string literal`);
    assert.equal(p.initializer.text, seed[p.name.text], `BASE.${p.name.text} equals SEED's`);
  }
  assert.equal(valueText(qa, base, 'cohortPuppyFayEndedId'), `'${ENDED_COHORT_ID}'`);

  // The precondition names the cohort, so a database without it is refused before a write.
  const cohortChecks = borrowed.elements.filter(
    (e) =>
      ts.isObjectLiteralExpression(e) &&
      valueText(qa, e, 'table') === "'cohorts'" &&
      valueText(qa, e, 'id') === 'BASE.cohortPuppyFayEndedId',
  );
  assert.equal(cohortChecks.length, 1, 'BORROWED_FROM_SEED_DEV checks the ended cohort in cohorts');
});
