import { SIGNUP_FIELDS, type SignupField, type SignupFieldMode } from '../contracts/wire.js';

/**
 * The sign-up map's one test of "filled" (ACCT-U04; design §2.2:2244; wire
 * 3.0.0-lg2.1, `ProfileIncompleteDetails`). Pure: no route, request or wire
 * response type, so the booking pre-check (ACCT-U11) reuses it as `PATCH /me`
 * and `MeWire.missing_mandatory_fields` do.
 *
 * Per field:
 *   - `name`, `phone`: not NULL, with a visible character (`isNonBlank`).
 *     `PATCH /me` stores a blank one as NULL, so NULL is the stored form of
 *     "empty"; the visible-character test covers a row written before that (a
 *     pre-3.0.0 `PATCH /me` stored `'  '`) and one an import writes;
 *   - `location` (the home campus): not NULL;
 *   - `emergency_contact`: its name and its phone both non-blank;
 *   - `address`: line 1, city, state and zip all non-blank (line 2 is not
 *     asked of anyone);
 *   - `email`: always — it is the login identity, `NOT NULL`, and fixed
 *     `mandatory` in the map.
 */

/** The `owners` columns the test reads. A Drizzle `owners` row satisfies it. */
export interface SignupFieldValues {
  name: string | null;
  phone: string | null;
  location: string | null;
  emergencyName: string | null;
  emergencyPhone: string | null;
  addressLine1: string | null;
  addressCity: string | null;
  addressState: string | null;
  addressZip: string | null;
}

export type SignupFieldMap = Record<SignupField, SignupFieldMode>;

/**
 * The characters that show nothing (P05 fix round 1, BF1; Opus nice N1):
 * white space of every width, the C0 and C1 controls, and the zero-width and
 * other invisible format characters and fillers. A superset of JavaScript's
 * `\s`. Listed by code point, not by Unicode property, because Postgres
 * regexes have no `\p{…}`: the same class is matched by `isNonBlank` here and
 * by `db/visibleText.ts` in SQL, so a route and a repository can never
 * disagree on a stored value. U+0000 is left out: Postgres text cannot hold it.
 */
export const INVISIBLE_CODE_POINTS: ReadonlyArray<readonly [number, number]> = [
  [0x0001, 0x0020], // the C0 controls (tab, LF, CR…) and the space
  [0x007f, 0x00a0], // DEL, the C1 controls (NEL), NBSP
  [0x00ad, 0x00ad], // soft hyphen
  [0x034f, 0x034f], // combining grapheme joiner
  [0x061c, 0x061c], // Arabic letter mark
  [0x115f, 0x1160], // Hangul choseong and jungseong fillers
  [0x1680, 0x1680], // Ogham space mark
  [0x17b4, 0x17b5], // Khmer inherent vowels
  [0x180b, 0x180f], // Mongolian variation selectors and vowel separator
  [0x2000, 0x200f], // en to hair spaces, ZWSP, ZWNJ, ZWJ, LRM, RLM
  [0x2028, 0x202f], // line and paragraph separators, bidi embeddings, narrow NBSP
  [0x205f, 0x206f], // medium math space, word joiner, invisible operators, bidi isolates
  [0x2800, 0x2800], // braille pattern blank
  [0x3000, 0x3000], // ideographic space
  [0x3164, 0x3164], // Hangul filler
  [0xfe00, 0xfe0f], // variation selectors
  [0xfeff, 0xfeff], // zero-width no-break space (BOM)
  [0xffa0, 0xffa0], // halfwidth Hangul filler
  [0xfff0, 0xfff8], // unassigned specials (Default_Ignorable)
  [0xfff9, 0xfffb], // interlinear annotation marks
  [0x1bca0, 0x1bca3], // shorthand format controls
  [0x1d173, 0x1d17a], // musical format characters
  [0xe0000, 0xe0fff], // tag characters, variation selectors supplement, the rest of the block
];

/** One character outside the invisible class — a regex both engines read the
 *  same way (a bracket expression of literal code points and ranges). */
export const VISIBLE_CHARACTER_PATTERN = `[^${INVISIBLE_CODE_POINTS.map(([from, to]) =>
  from === to
    ? String.fromCodePoint(from)
    : `${String.fromCodePoint(from)}-${String.fromCodePoint(to)}`,
).join('')}]`;

const VISIBLE_CHARACTER = new RegExp(VISIBLE_CHARACTER_PATTERN, 'u');

/** A string with at least one visible character. */
export function isNonBlank(value: string | null): value is string {
  return value !== null && VISIBLE_CHARACTER.test(value);
}

export function isFilled(field: SignupField, row: SignupFieldValues): boolean {
  switch (field) {
    case 'name':
      return isNonBlank(row.name);
    case 'phone':
      return isNonBlank(row.phone);
    case 'email':
      return true;
    case 'location':
      return row.location !== null;
    case 'emergency_contact':
      return isNonBlank(row.emergencyName) && isNonBlank(row.emergencyPhone);
    case 'address':
      return (
        isNonBlank(row.addressLine1) &&
        isNonBlank(row.addressCity) &&
        isNonBlank(row.addressState) &&
        isNonBlank(row.addressZip)
      );
  }
}

/**
 * The fields the map marks `mandatory` that `row` leaves empty, in
 * `SIGNUP_FIELDS` order (the map is jsonb, which keeps no key order). Never
 * `email`. `[]` when none.
 */
export function missingMandatoryFields(row: SignupFieldValues, map: SignupFieldMap): SignupField[] {
  return SIGNUP_FIELDS.filter((field) => map[field] === 'mandatory' && !isFilled(field, row));
}
