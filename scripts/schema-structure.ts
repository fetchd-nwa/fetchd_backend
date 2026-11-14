/**
 * The structure `schema.sql` builds, and the structure a database holds, compared both ways:
 * `db:dev:check`'s structural half (P21 B-2; DECISIONS 264(c), 265(c)).
 *
 * WHY. The row check walks the seed manifest, so a database that holds every seeded row but
 * an old schema read "fresh": on 2026-11-12 dev still had P20's dropped `booking_dogs`
 * attendance columns and no `checkin_events`, and the check said "fresh, 55 rows".
 *
 * WHAT IT COMPARES. Every table `schema.sql` creates with its columns (missing and extra), and
 * every enum type with its labels in order. Not column types, defaults, constraints, indexes,
 * triggers, functions, views, grants or comments: those need a fresh load to compare
 * (`scripts/db/fingerprint.sql`), which a read-only check cannot make.
 *
 * HOW IT STAYS HONEST. The expected structure is parsed from `schema.sql` at run time, never a
 * hand list. The parse reads SQL through `maskSql`, the migration runner's lexer, so a table in
 * a comment, a string or a function body is never a table. It refuses, naming the statement,
 * any statement that could change a table's columns or an enum's labels in a way it does not
 * read (`ALTER TABLE` beyond `ADD CONSTRAINT`, `ALTER TYPE`, `DROP TABLE`/`TYPE`, `LIKE`,
 * `AS`, `PARTITION OF`, `INHERITS`, a composite type, a table created twice): a check that
 * silently stops covering something is worse than no check. `test/schemaStructure.test.ts`
 * proves the parse against the test database, a fresh load of the same file: zero
 * differences.
 */
import { maskSql } from '../src/db/migrate.js';

export interface SchemaStructure {
  /** Table → its column names. */
  tables: ReadonlyMap<string, ReadonlySet<string>>;
  /** Enum type → its labels in order. */
  enums: ReadonlyMap<string, readonly string[]>;
}

/** Runs one read-only catalog statement. */
export type CatalogQuery = (text: string) => Promise<{ rows: unknown[] }>;

class Unreadable extends Error {
  constructor(why: string, statement: string) {
    const shown = statement.trim().replace(/\s+/g, ' ').slice(0, 160);
    super(
      `schema-structure cannot read ${why}: "${shown}". Teach scripts/schema-structure.ts this form.`,
    );
  }
}

const IDENT = String.raw`(?:"(?:[^"]|"")*"|[A-Za-z_\u0080-￿][A-Za-z0-9_$\u0080-￿]*)`;
const QUALIFIED = new RegExp(String.raw`^(${IDENT})(?:\s*\.\s*(${IDENT}))?`);
const LEADING_IDENT = new RegExp(String.raw`^(${IDENT})`);

/** An identifier as Postgres stores it: a quoted one verbatim, a bare one folded to lower case. */
function unquote(ident: string): string {
  return ident.startsWith('"') ? ident.slice(1, -1).replace(/""/g, '"') : ident.toLowerCase();
}

/**
 * The name at the start of `text` (`name` or `public.name`), and where it ends. Another schema
 * is refused: this check reads `public` alone.
 */
function readName(text: string, statement: string): { name: string; end: number } {
  const lead = /^\s*/.exec(text)?.[0].length ?? 0;
  const match = QUALIFIED.exec(text.slice(lead));
  if (match === null) throw new Unreadable('a statement whose name it cannot find', statement);
  const [whole, first, second] = match as unknown as [string, string, string | undefined];
  if (second !== undefined && unquote(first) !== 'public') {
    throw new Unreadable('an object outside schema public', statement);
  }
  return { name: unquote(second ?? first), end: lead + whole.length };
}

/** The offset of the `)` that closes the `(` at `open`, read on masked code. */
function closingParen(code: string, open: number, statement: string): number {
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === '(') depth += 1;
    else if (code[i] === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Unreadable('an unclosed parenthesis', statement);
}

/** `[from, to)` cut at the commas outside every parenthesis, read on masked code. */
function topLevelParts(code: string, from: number, to: number): Array<[number, number]> {
  const parts: Array<[number, number]> = [];
  let depth = 0;
  let start = from;
  for (let i = from; i < to; i += 1) {
    if (code[i] === '(') depth += 1;
    else if (code[i] === ')') depth -= 1;
    else if (code[i] === ',' && depth === 0) {
      parts.push([start, i]);
      start = i + 1;
    }
  }
  parts.push([start, to]);
  return parts;
}

const TABLE_CONSTRAINT = /^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN|EXCLUDE)\b/i;
const ENUM_LIST = /^\s*(?:'(?:[^']|'')*'\s*(?:,\s*'(?:[^']|'')*'\s*)*)?$/;

/**
 * The tables, columns and enums a `schema.sql` creates. Throws on any statement form that could
 * change them and that it does not read.
 */
export function parseSchemaStructure(sql: string): SchemaStructure {
  // One lexer, three masks of the same offsets: keywords and parentheses are read with
  // everything masked; names with quoted identifiers kept; enum labels with strings kept.
  const code = maskSql(sql);
  const names = maskSql(sql, {
    comments: true,
    strings: true,
    quotedIdentifiers: false,
    dollarBodies: true,
  });
  const strings = maskSql(sql, {
    comments: true,
    strings: false,
    quotedIdentifiers: true,
    dollarBodies: true,
  });
  const tables = new Map<string, Set<string>>();
  const enums = new Map<string, string[]>();

  let start = 0;
  for (let i = 0; i <= code.length; i += 1) {
    if (i < code.length && code[i] !== ';') continue;
    const [from, to] = [start, i];
    start = i + 1;
    const statementCode = code.slice(from, to);
    if (statementCode.trim() === '') continue;
    const original = sql.slice(from, to);
    const lead = from + (/^\s*/.exec(statementCode)?.[0].length ?? 0);
    const head = code.slice(lead, to).replace(/\s+/g, ' ');

    const createTable = /^CREATE (UNLOGGED )?TABLE (IF NOT EXISTS )?/i.exec(head);
    if (/^CREATE (TEMP|TEMPORARY|GLOBAL|LOCAL) /i.test(head)) {
      throw new Unreadable('a temporary table', original);
    }
    if (createTable !== null) {
      const keyword = /^CREATE\s+(UNLOGGED\s+)?TABLE\s+(IF\s+NOT\s+EXISTS\s+)?/i.exec(
        names.slice(lead, to),
      ) as RegExpExecArray;
      const nameAt = lead + keyword[0].length;
      const { name, end } = readName(names.slice(nameAt, to), original);
      const afterName = nameAt + end;
      const open = afterName + (/^\s*/.exec(code.slice(afterName, to))?.[0].length ?? 0);
      if (code[open] !== '(')
        throw new Unreadable('a table not defined by a column list', original);
      const close = closingParen(code, open, original);
      if (code.slice(close + 1, to).trim() !== '') {
        throw new Unreadable('a table clause after its column list', original);
      }
      if (tables.has(name)) throw new Unreadable(`table ${name} created twice`, original);
      const columns = new Set<string>();
      for (const [a, b] of topLevelParts(code, open + 1, close)) {
        const element = names.slice(a, b).trim();
        const keywordOf = code.slice(a, b).trim();
        if (element === '') throw new Unreadable('an empty column list entry', original);
        if (/^LIKE\b/i.test(keywordOf)) throw new Unreadable('CREATE TABLE … (LIKE …)', original);
        if (TABLE_CONSTRAINT.test(keywordOf)) continue;
        const column = LEADING_IDENT.exec(element);
        if (column === null) throw new Unreadable('a column it cannot name', original);
        columns.add(unquote(column[1] as string));
      }
      tables.set(name, columns);
      continue;
    }

    if (/^CREATE TYPE /i.test(head)) {
      const keyword = /^CREATE\s+TYPE\s+/i.exec(names.slice(lead, to)) as RegExpExecArray;
      const nameAt = lead + keyword[0].length;
      const { name, end } = readName(names.slice(nameAt, to), original);
      const rest = code.slice(nameAt + end, to);
      const asEnum = /^\s*AS\s+ENUM\s*/i.exec(rest);
      if (asEnum === null) throw new Unreadable('a type that is not an enum', original);
      const open = nameAt + end + asEnum[0].length;
      if (code[open] !== '(') throw new Unreadable('an enum without a label list', original);
      const close = closingParen(code, open, original);
      if (code.slice(close + 1, to).trim() !== '') {
        throw new Unreadable('an enum clause after its labels', original);
      }
      const list = strings.slice(open + 1, close);
      if (!ENUM_LIST.test(list)) throw new Unreadable('an enum label list', original);
      if (enums.has(name)) throw new Unreadable(`enum ${name} created twice`, original);
      enums.set(
        name,
        [...list.matchAll(/'((?:[^']|'')*)'/g)].map((m) => (m[1] as string).replace(/''/g, "'")),
      );
      continue;
    }

    const alterTable = /^ALTER TABLE (ONLY )?(IF EXISTS )?/i.exec(head);
    if (alterTable !== null) {
      const keyword = /^ALTER\s+TABLE\s+(ONLY\s+)?(IF\s+EXISTS\s+)?/i.exec(
        names.slice(lead, to),
      ) as RegExpExecArray;
      const nameAt = lead + keyword[0].length;
      const { end } = readName(names.slice(nameAt, to), original);
      for (const [a, b] of topLevelParts(code, nameAt + end, to)) {
        if (!/^ADD\s+CONSTRAINT\s/i.test(code.slice(a, b).trim())) {
          throw new Unreadable('an ALTER TABLE action other than ADD CONSTRAINT', original);
        }
      }
      continue;
    }

    if (/^ALTER TYPE /i.test(head)) throw new Unreadable('ALTER TYPE', original);
    if (/^DROP (TABLE|TYPE|SCHEMA)\b/i.test(head)) throw new Unreadable('a DROP', original);
  }
  return { tables, enums };
}

/** The tables, columns and enums in a database's schema `public`, by catalog reads alone. */
export async function readDatabaseStructure(query: CatalogQuery): Promise<SchemaStructure> {
  // Extension-owned objects (deptype 'e') are not schema.sql's.
  const columns = await query(`
    SELECT c.relname AS "table", a.attname AS "column"
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_catalog.pg_attribute a
        ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
       AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                        WHERE d.classid = 'pg_catalog.pg_class'::regclass
                          AND d.objid = c.oid AND d.deptype = 'e')
     ORDER BY c.relname, a.attnum`);
  const tables = new Map<string, Set<string>>();
  for (const row of columns.rows as Array<{ table: string; column: string | null }>) {
    const set = tables.get(row.table) ?? new Set<string>();
    if (row.column !== null) set.add(row.column);
    tables.set(row.table, set);
  }
  const labels = await query(`
    SELECT t.typname AS "enum", e.enumlabel AS "label"
      FROM pg_catalog.pg_type t
      JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
      LEFT JOIN pg_catalog.pg_enum e ON e.enumtypid = t.oid
     WHERE n.nspname = 'public' AND t.typtype = 'e'
       AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                        WHERE d.classid = 'pg_catalog.pg_type'::regclass
                          AND d.objid = t.oid AND d.deptype = 'e')
     ORDER BY t.typname, e.enumsortorder`);
  const enums = new Map<string, string[]>();
  for (const row of labels.rows as Array<{ enum: string; label: string | null }>) {
    const list = enums.get(row.enum) ?? [];
    if (row.label !== null) list.push(row.label);
    enums.set(row.enum, list);
  }
  return { tables, enums };
}

/** One line per difference, `expected` being schema.sql's and `actual` the database's. */
export function structureDifferences(expected: SchemaStructure, actual: SchemaStructure): string[] {
  const lines: string[] = [];
  for (const table of expected.tables.keys()) {
    if (!actual.tables.has(table)) lines.push(`table ${table}: in schema.sql, absent here`);
  }
  for (const table of actual.tables.keys()) {
    if (!expected.tables.has(table)) lines.push(`table ${table}: here, not in schema.sql`);
  }
  for (const [table, want] of expected.tables) {
    const have = actual.tables.get(table);
    if (have === undefined) continue;
    for (const column of want) {
      if (!have.has(column)) lines.push(`column ${table}.${column}: in schema.sql, absent here`);
    }
    for (const column of have) {
      if (!want.has(column)) lines.push(`column ${table}.${column}: here, not in schema.sql`);
    }
  }
  for (const name of expected.enums.keys()) {
    if (!actual.enums.has(name)) lines.push(`enum ${name}: in schema.sql, absent here`);
  }
  for (const name of actual.enums.keys()) {
    if (!expected.enums.has(name)) lines.push(`enum ${name}: here, not in schema.sql`);
  }
  for (const [name, want] of expected.enums) {
    const have = actual.enums.get(name);
    if (have === undefined || have.join('\u0000') === want.join('\u0000')) continue;
    lines.push(
      `enum ${name}: labels differ: schema.sql (${want.join(', ')}), here (${have.join(', ')})`,
    );
  }
  return lines;
}
