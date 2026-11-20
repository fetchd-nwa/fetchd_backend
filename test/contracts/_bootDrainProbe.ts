/**
 * A preload for a spawned `src/index.ts` (not a test file): `node --import <tsx> --import
 * <this file> <src/index.ts>`, all by absolute path from an empty working directory
 * (`_realBoot.ts`), used only by `message-push-drain.test.ts`'s entry-point case (FM2-a's
 * `index.ts` half).
 *
 * It sends nothing anywhere. On SIGTERM it puts one stalled thunk into the process's own
 * in-flight set (`trackInFlight`, the set pass 2's push uses) BEFORE `index.ts`'s own SIGTERM
 * listener runs (a preload's listener is registered first), and it marks the pool's `end()`
 * (what `closeDb` calls). Each mark is one stdout line, `PROBE <what> <epoch ms>`:
 *   · `PROBE tracked`: the stalled thunk is in the set;
 *   · `PROBE settled`: it settled (1.5 s later);
 *   · `PROBE closeDb`: the pool's `end()` was called.
 * So the parent can read whether the API's own shutdown sequence waited for the set before it
 * closed the pool, without any staff message (a spawned API must never send one: Expo's URL is
 * hard-coded) and without a test-side `drain` (the in-process FM2-a passes its own).
 */
import { pool } from '../../src/db/pool.js';
import { trackInFlight } from '../../src/realtime/settle.js';

const STALL_MS = 1_500;

function mark(what: string): void {
  process.stdout.write(`PROBE ${what} ${Date.now()}\n`);
}

const end = pool.end.bind(pool) as () => Promise<void>;
(pool as unknown as { end: () => Promise<void> }).end = () => {
  mark('closeDb');
  return end();
};

process.once('SIGTERM', () => {
  trackInFlight(
    () =>
      new Promise<void>((resolve) => {
        setTimeout(() => {
          mark('settled');
          resolve();
        }, STALL_MS);
      }),
    { log: { warn: () => undefined }, what: 'boot drain probe' },
  );
  mark('tracked');
});

mark('loaded');
