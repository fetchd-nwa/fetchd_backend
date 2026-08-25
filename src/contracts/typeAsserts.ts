/**
 * Compile-time helpers for the route-side Zod ↔ wire request-body pins
 * (designs/wire-contract-completion.md §5.1.3). Server-side only — never
 * copied to a client (wire.ts carries its own local pair for §16, since it
 * cannot import). Usage, in the ROUTE file beside the schema:
 *
 *   export type PostBookingsBodyConformance = Expect<
 *     Equal<z.input<typeof postBookingBodySchema>, PostBookingsRequest>
 *   >;
 *
 * `z.input`, not `z.infer` — the wire documents what a client may SEND
 * (pre-default, pre-transform). Exported so `noUnusedLocals`-style rules
 * can't eat the pin (the `ContractEnumConformance` precedent). Where Zod's
 * optional-key inference and the wire type disagree structurally, the WIRE
 * TYPE is corrected to the schema's truth — never the reverse (§14.1).
 */
export type Expect<T extends true> = T;

/** Invariant (bidirectional) equality — `extends` alone would miss a strict
 *  subset/superset. Same construction as `conformance.ts` and wire.ts §16. */
export type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
