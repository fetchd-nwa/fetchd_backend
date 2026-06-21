// Post-`drizzle-kit pull` repair.
//
// drizzle-kit's introspection codegen has a few deterministic defects against
// our hardened schema, and it cannot know about the type-level refinements we
// layer on the raw column types. Drizzle is query-only here (Day-0 lock #1 —
// schema.sql is the canonical DDL; none of these calls generate DDL), so each
// fix below restores valid TS that *matches canonical schema.sql exactly*, with
// zero behavioural drift. Run automatically by `npm run db:introspect` so the
// generated surface is correct-by-construction every pull.
//
// Two classes of fix live here:
//   A. codegen defects — drizzle emits invalid/mangled TS (the `.default()`
//      cases, the extensionless relations import).
//   B. type-level brands — drizzle pulls `location`/`cta_kind` as plain `text`,
//      dropping the `.$type<LocationKey>()` / cta-kind literal-union narrowing,
//      and it drops the `LOCATION_SLUGS` const + `LocationKey` type entirely
//      (a LOCAL derivation, not a DB object — there is nothing in the DB for
//      drizzle to round-trip it from). We reapply both, byte-for-byte.
//
// Doctrine: targeted rules only, never a blanket regex; every reapplied token
// is verified by the fail-loud safety net at the bottom. If a future pull
// surfaces a NEW defect, add a targeted rule here — never edit frozen schema.sql.
import { readFileSync, writeFileSync } from 'node:fs';

const SCHEMA = new URL('../src/db/schema/schema.ts', import.meta.url);
const RELATIONS = new URL('../src/db/schema/relations.ts', import.meta.url);

// Replace EVERY occurrence of an exact literal. A no-op (literal absent) is
// silent so the script is idempotent — re-running on already-fixed output does
// nothing. Correctness is enforced by the safety net, not by this helper.
function repair(file, label, find, replace) {
  const before = readFileSync(file, 'utf8');
  if (!before.includes(find)) return;
  writeFileSync(file, before.split(find).join(replace), 'utf8');
  console.log(`fixed: ${label}`);
}

// Like `repair`, but for tokens that MUST be present in fresh drizzle output.
// If the anchor/literal is missing we fail loud immediately rather than silently
// skipping — a missing anchor means drizzle's output shape moved and the brand
// would otherwise be dropped without a trace. Already-applied (idempotent
// re-run) is detected via `done` and skipped cleanly.
function requireReplace(file, label, find, replace, done) {
  const before = readFileSync(file, 'utf8');
  if (before.includes(done)) return; // already applied (second consecutive pull)
  if (!before.includes(find)) {
    console.error(
      `fix-introspection: anchor missing for "${label}" — drizzle output shape changed.`,
    );
    process.exit(1);
  }
  writeFileSync(file, before.split(find).join(replace), 'utf8');
  console.log(`fixed: ${label}`);
}

// ---------------------------------------------------------------------------
// A. Codegen defects
// ---------------------------------------------------------------------------

// 1. Empty-string column default `DEFAULT ''` → mangled `.default(')`.
//    Canonical: `text NOT NULL DEFAULT ''`.
repair(SCHEMA, "empty-string default → .default('')", ".default(')", ".default('')");

// 2. Empty enum-array default `DEFAULT '{}'::enum[]` → invalid `.default([""])`
//    ("" is not a valid enum member). Canonical: `enum[] NOT NULL DEFAULT '{}'`.
repair(SCHEMA, 'empty enum-array default → .default([])', '.default([""])', '.default([])');

// 3. NodeNext requires explicit extensions on relative imports; drizzle-kit
//    emits extensionless `from "./schema"` in relations.ts.
repair(RELATIONS, 'relations.ts import → ./schema.js', 'from "./schema"', 'from "./schema.js"');

// ---------------------------------------------------------------------------
// B. Type-level brands (dropped on every pull — reapplied here)
// ---------------------------------------------------------------------------

// 4. `LOCATION_SLUGS` const + `LocationKey` type. These are a LOCAL TS
//    derivation — locations is a table since the Δ 2026-06-08, so `slug` is the
//    natural key and `LOCATION_SLUGS` is the z.enum tuple. drizzle has nothing
//    to round-trip them from, so it drops them. Re-inserted right after the
//    `ledger_reason` enum (their canonical home in the committed baseline). The
//    anchor is a complete, unique enum declaration: enums are emitted in a
//    stable alpha order for a fixed schema, so this line is byte-stable across
//    pulls. requireReplace fails loud if `ledger_reason` ever drifts.
const LEDGER_REASON_ENUM = `export const ledgerReason = pgEnum("ledger_reason", ['purchase', 'booking-debit', 'cancel-refund', 'adjustment', 'membership-grant'])`;
const LOCATION_SLUGS_BLOCK = `${LEDGER_REASON_ENUM}
// Locations are a table since the Δ 2026-06-08 (was the \`location_key\`/\`app_location\`
// enums). \`slug\` is the natural key + the wire value; \`LOCATION_SLUGS\` is the TS
// tuple for z.enum validation (replaces the old LOCATION_SLUGS).
export const LOCATION_SLUGS = ['fayetteville', 'bentonville'] as const;
export type LocationKey = (typeof LOCATION_SLUGS)[number];`;
requireReplace(
  SCHEMA,
  'LOCATION_SLUGS const + LocationKey type',
  LEDGER_REASON_ENUM,
  LOCATION_SLUGS_BLOCK,
  'export const LOCATION_SLUGS',
);

// 5. `.$type<LocationKey>()` on the 10 `location` slug-FK columns. Every column
//    literally named `location` in the schema is a `text` FK to locations.slug
//    (verified against the DB at regeneration time — there is no free-text
//    `location` column), so branding by exact column-line literal is safe and
//    hits exactly those 10 sites in two forms (5 notNull / 5 nullable). The FK
//    itself is emitted by drizzle as a table-level foreignKey() callback, so we
//    add ONLY the brand here — no inline .references() (that would duplicate it).
//    The nullable form grew 4 → 5 with credit_expiry_settings.location
//    (2026-06-20): NULL = org-wide default, a slug = per-location override —
//    still a locations.slug FK, so the same brand applies.
repair(
  SCHEMA,
  'LocationKey brand → location text().notNull() (×5)',
  'location: text().notNull(),',
  'location: text().$type<LocationKey>().notNull(),',
);
repair(
  SCHEMA,
  'LocationKey brand → location text() nullable (×5)',
  'location: text(),',
  'location: text().$type<LocationKey>(),',
);

// 6. `.$type<LocationKey>()` on announcements.target_location (1 site, unique).
repair(
  SCHEMA,
  'LocationKey brand → target_location',
  'targetLocation: text("target_location"),',
  'targetLocation: text("target_location").$type<LocationKey>(),',
);

// 7. `.$type<'enroll' | 'route' | 'external'>()` on announcements.cta_kind.
//    The DB CHECK constrains the value set; the brand reflects that guarantee
//    so reads narrow without a cast. The 2-line comment is part of the
//    canonical text and is reapplied with it.
repair(
  SCHEMA,
  'cta_kind literal-union brand',
  `	ctaKind: text("cta_kind"),`,
  `	// CHECK (cta_kind IN ('enroll','route','external')) enforces this at the DB;
	// $type reflects that guarantee at compile time so reads narrow without a cast.
	ctaKind: text("cta_kind").$type<'enroll' | 'route' | 'external'>(),`,
);

// ---------------------------------------------------------------------------
// Safety net: fail loud if anything is unrepaired or any brand count is off.
// A failure here means drizzle changed its output shape — surface it now, not
// at `tsc` (codegen defects) or as a silent type regression (missing brands).
// ---------------------------------------------------------------------------
const schema = readFileSync(SCHEMA, 'utf8');
const relations = readFileSync(RELATIONS, 'utf8');

const LOCATION_KEY_BRAND_SITES = 11; // 10 `location` columns + 1 target_location
const CTA_KIND_BRAND_SITES = 1;
const locationKeyBrands = (schema.match(/\.\$type<LocationKey>\(\)/g) ?? []).length;
const ctaKindBrands = (schema.match(/\.\$type<'enroll' \| 'route' \| 'external'>\(\)/g) ?? [])
  .length;

const problems = [
  schema.includes(".default(')") && 'schema.ts: mangled empty-string default',
  schema.includes('.default([""])') && 'schema.ts: invalid empty enum-array default',
  relations.includes('from "./schema"') && 'relations.ts: extensionless ./schema import',
  !schema.includes('export const LOCATION_SLUGS') && 'schema.ts: LOCATION_SLUGS const missing',
  !schema.includes('export type LocationKey =') && 'schema.ts: LocationKey type missing',
  locationKeyBrands !== LOCATION_KEY_BRAND_SITES &&
    `schema.ts: expected ${LOCATION_KEY_BRAND_SITES} LocationKey brands, found ${locationKeyBrands}`,
  ctaKindBrands !== CTA_KIND_BRAND_SITES &&
    `schema.ts: expected ${CTA_KIND_BRAND_SITES} cta_kind brand, found ${ctaKindBrands}`,
].filter(Boolean);

if (problems.length > 0) {
  console.error(`fix-introspection: unrepaired defects:\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}
console.log('fix-introspection: generated schema is clean.');
