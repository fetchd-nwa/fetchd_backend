/**
 * `normalizeOptional` is the empty-string-collapse helper every nullable-text
 * field on a mutation body runs through. Promoted from `routes/vets.ts` at
 * the Day-9c rule-of-two trigger (dogs adds three more nullable text
 * fields: `special_notes`, `evaluation_date`, plus `primary_vet_id` which
 * is a UUID rather than text but follows the same null-or-omit convention).
 *
 * Semantics:
 *   - `undefined` → `undefined` (key absent on PATCH = "don't touch this column")
 *   - `null`      → `null`      (explicit clear)
 *   - `''` / whitespace → `null` (matches the wire's omit-on-null convention so
 *                                 a round-trip POST{phone:''} → GET emits no
 *                                 `phone` key — same as POST{phone:null})
 *   - non-empty trimmed string → the trimmed value
 *
 * The asymmetry between PATCH's `undefined`-skips-key and POST's
 * `undefined`-→-null is load-bearing on the call-site side: POST builds a
 * full INSERT values object (the `?? null` coalesce happens at the call
 * site), PATCH builds a partial UPDATE set (it skips the key when this
 * returns `undefined`). The helper itself only collapses empty → null.
 */
export function normalizeOptional(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
