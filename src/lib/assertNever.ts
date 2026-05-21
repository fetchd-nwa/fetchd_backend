/**
 * Exhaustiveness sentinel for `switch` statements over discriminated unions
 * + Postgres enum types. A future variant added to the union compiles as a
 * hard error at every `assertNever` call site — the "default case" is the
 * type checker, not a runtime if-chain.
 *
 * Extracted Day-7a at the rule-of-three threshold: previously inlined in
 * `creditsRepository.mode` (Day 5b), `reportWire.program` (Day 6b), and
 * `threadWire.sender_kind` (Day 7a). Pure 3-line helper with no module
 * imports — the kind of deep-module thing CLAUDE.md warns against extracting
 * shallowly, but at three call sites the duplication costs more than the
 * import.
 *
 * The runtime branch only fires when the type system is bypassed (a bad
 * cast, an `as` lie, a JSONB blob with a stale value). The thrown error
 * carries the offending value so a contract test or production log can
 * surface what didn't match — never just `'unreachable'`.
 */
export function assertNever(value: never): never {
  throw new Error(`assertNever: unhandled discriminant ${JSON.stringify(value)}`);
}
