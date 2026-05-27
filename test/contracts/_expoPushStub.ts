import type { ExpoPushClient, ExpoPushMessage, ExpoPushTicket } from '../../src/lib/expoPush.js';

/**
 * In-memory `ExpoPushClient` for contract tests. Mirrors `_stripeStub.ts`
 * (Day-14/15): each test that exercises a scheduler tick constructs its
 * own stub, injects it via the worker's `expoPush` opt, and asserts on
 * the recorded calls — no network, no global mutable state across tests.
 *
 * Override knobs:
 *   - `setNextBatchTickets(tickets)` — the next `sendBatch` returns
 *     these exact tickets (in the order received). Tests use it to
 *     exercise the per-message error branch.
 *   - `throwOnNextBatch()` — the next `sendBatch` rejects, simulating
 *     a transport failure (Expo HTTP 5xx, network down, etc.).
 *
 * Default behavior:
 *   - `sendBatch(messages)` returns one `{status: 'ok', id: 'rcpt_test_*'}`
 *     per message and records the call.
 */

export interface ExpoPushStubCall {
  method: 'sendBatch';
  messages: ExpoPushMessage[];
}

export interface ExpoPushStub extends ExpoPushClient {
  readonly calls: ExpoPushStubCall[];
  setNextBatchTickets(tickets: ExpoPushTicket[]): void;
  throwOnNextBatch(): void;
}

let receiptCounter = 0;

export function makeExpoPushStub(): ExpoPushStub {
  const calls: ExpoPushStubCall[] = [];
  let queuedTickets: ExpoPushTicket[] | null = null;
  let shouldThrow = false;

  return {
    calls,
    setNextBatchTickets(tickets) {
      queuedTickets = tickets;
    },
    throwOnNextBatch() {
      shouldThrow = true;
    },
    async sendBatch(messages) {
      calls.push({ method: 'sendBatch', messages: messages.slice() });
      if (shouldThrow) {
        shouldThrow = false;
        throw new Error('stub: simulated Expo push transport failure');
      }
      if (queuedTickets !== null) {
        const out = queuedTickets;
        queuedTickets = null;
        return out;
      }
      return messages.map(() => ({
        status: 'ok' as const,
        id: `rcpt_test_${++receiptCounter}`,
      }));
    },
  };
}
