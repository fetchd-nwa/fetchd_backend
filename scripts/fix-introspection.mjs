// Post-`drizzle-kit pull` repair.
//
// drizzle-kit's introspection codegen has a few deterministic defects against
// our hardened schema. Drizzle is query-only here (Day-0 lock #1 — schema.sql
// is the canonical DDL; these `.default()` calls never generate DDL), so each
// fix below restores valid TS that *matches canonical schema.sql exactly*,
// with zero behavioural drift. Run automatically by `npm run db:introspect`
// so the generated surface is correct-by-construction every pull.
//
// If a future pull surfaces a NEW defect, add a targeted rule here — never a
// blanket regex, and never edit the frozen schema.sql.
import { readFileSync, writeFileSync } from 'node:fs';

const SCHEMA = new URL('../src/db/schema/schema.ts', import.meta.url);
const RELATIONS = new URL('../src/db/schema/relations.ts', import.meta.url);

function repair(file, label, find, replace) {
  const before = readFileSync(file, 'utf8');
  if (!before.includes(find)) return;
  writeFileSync(file, before.split(find).join(replace), 'utf8');
  console.log(`fixed: ${label}`);
}

// 1. Empty-string column default `DEFAULT ''` → mangled `.default(')`.
//    Canonical: `text NOT NULL DEFAULT ''`.
repair(SCHEMA, "empty-string default → .default('')", ".default(')", ".default('')");

// 2. Empty enum-array default `DEFAULT '{}'::enum[]` → invalid `.default([""])`
//    ("" is not a valid enum member). Canonical: `enum[] NOT NULL DEFAULT '{}'`.
repair(SCHEMA, 'empty enum-array default → .default([])', '.default([""])', '.default([])');

// 3. NodeNext requires explicit extensions on relative imports; drizzle-kit
//    emits extensionless `from "./schema"` in relations.ts.
repair(RELATIONS, 'relations.ts import → ./schema.js', 'from "./schema"', 'from "./schema.js"');

// Safety net: assert every known broken token is gone. A failure here means
// drizzle-kit changed its output shape — fail loud instead of shipping
// broken TS that only surfaces at `tsc`.
const schema = readFileSync(SCHEMA, 'utf8');
const relations = readFileSync(RELATIONS, 'utf8');
const remaining = [
  schema.includes(".default(')") && 'schema.ts: mangled empty-string default',
  schema.includes('.default([""])') && 'schema.ts: invalid empty enum-array default',
  relations.includes('from "./schema"') && 'relations.ts: extensionless ./schema import',
].filter(Boolean);
if (remaining.length > 0) {
  console.error(`fix-introspection: unrepaired defects:\n  - ${remaining.join('\n  - ')}`);
  process.exit(1);
}
console.log('fix-introspection: generated schema is clean.');
