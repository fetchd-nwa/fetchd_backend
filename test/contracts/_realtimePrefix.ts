import { randomBytes } from 'node:crypto';

/**
 * CR1 (brief; design A2 OL9; MB13 M5): every test run gets its own realtime channel prefix.
 * Redis pub/sub ignores the db index, so two runs on one Redis (the gate of record's `npm test`
 * beside a branch suite) would otherwise hear each other's events. When the environment names
 * no `REALTIME_CHANNEL_PREFIX`, this sets `test-<8 hex>`.
 *
 * A side-effect module, imported FIRST by `_harness.ts`, because `src/env.ts` parses the
 * environment once, at import: an assignment anywhere after an import that reaches `env.ts`
 * is too late, and the bus would resolve `local`. `test/contracts/realtime-bus.test.ts` proves
 * it in a child process with the variable removed.
 */
const named = process.env.REALTIME_CHANNEL_PREFIX;
if (named === undefined || named.trim().length === 0) {
  process.env.REALTIME_CHANNEL_PREFIX = `test-${randomBytes(4).toString('hex')}`;
}
