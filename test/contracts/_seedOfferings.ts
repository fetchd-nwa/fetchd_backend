import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The two campus `offerings` documents exactly as `schema.sql`'s `day_program_settings`
 * seed INSERT writes them (plan unit P49, M5.24): what a database born from `schema.sql`
 * holds, read from the file rather than restated, so a test cannot agree with a copy.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCHEMA_PATH = path.join(REPO_ROOT, '.claude', 'backend', 'schema.sql');

export type Campus = 'fayetteville' | 'bentonville';
export type OfferingsDocument = Record<
  string,
  { offered: boolean; client_visible: boolean; name: string | null; description: string | null }
>;

export function seededOfferings(): Record<Campus, OfferingsDocument> {
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
  // The campus rows' INSERT (the global row's, `location` NULL, carries no offerings).
  const inserts = (schema.match(/^INSERT INTO day_program_settings \([\s\S]*?\);$/gm) ?? []).filter(
    (statement) => /\bofferings\b/.test(statement),
  );
  if (inserts.length !== 1) {
    throw new Error(`schema.sql seeds the campus offerings ${inserts.length} times, not once`);
  }
  const found = new Map<string, OfferingsDocument>();
  for (const match of (inserts[0] as string).matchAll(/'(fayetteville|bentonville)',\s*'(\{[^']*\})'/g)) {
    found.set(match[1] as string, JSON.parse(match[2] as string) as OfferingsDocument);
  }
  const fayetteville = found.get('fayetteville');
  const bentonville = found.get('bentonville');
  if (fayetteville === undefined || bentonville === undefined || found.size !== 2) {
    throw new Error('schema.sql seeds no offerings document for one campus');
  }
  return { fayetteville, bentonville };
}
