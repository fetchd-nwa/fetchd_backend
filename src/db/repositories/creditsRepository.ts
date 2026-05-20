import { and, eq } from 'drizzle-orm';
import { db } from '../client.js';
import { dogCreditBalance, dogs } from '../schema/schema.js';
import { live } from '../softExpire.js';

/**
 * Per-dog credit balance, owner-scoped. Combines ownership check + balance
 * read into one query through `dogs LEFT JOIN dog_credit_balance` so the
 * route gets a single yes/no/here's-the-data answer:
 *
 *   null               → dog doesn't exist or doesn't belong to this owner
 *                        (route maps to 404; same response either way so
 *                        ids don't enumerate)
 *   { school, daycare} → dog exists; zero defaults applied where the
 *                        ledger has no rows for that mode (DATA-CONTRACT
 *                        §B Credits Δ 2026-05-20 zero-sentinel — a
 *                        freshly-provisioned dog never 404s)
 *
 * The view `dog_credit_balance` (schema.sql:640-643) is `SUM(delta)
 * GROUP BY (dog_id, mode)` over the append-only `credit_ledger`. A dog
 * with zero ledger rows produces zero view rows; the LEFT JOIN preserves
 * the `dogs` row with NULL mode/balance, which the route filters out
 * before pivoting.
 */
export interface CreditsBalance {
  school: number;
  daycare: number;
}

export const creditsRepository = {
  async findBalancesForOwnedDog(dogId: string, ownerId: string): Promise<CreditsBalance | null> {
    const rows = await db
      .select({
        mode: dogCreditBalance.mode,
        balance: dogCreditBalance.balance,
      })
      .from(dogs)
      .leftJoin(dogCreditBalance, eq(dogCreditBalance.dogId, dogs.id))
      .where(and(eq(dogs.id, dogId), eq(dogs.ownerId, ownerId), live(dogs)));

    if (rows.length === 0) return null;

    let school = 0;
    let daycare = 0;
    for (const row of rows) {
      if (row.balance === null || row.mode === null) continue; // dog exists, no ledger rows for this mode
      switch (row.mode) {
        case 'school':
          school = row.balance;
          break;
        case 'daycare':
          daycare = row.balance;
          break;
        default:
          // Exhaustive over `booking_mode` enum. If a future mode lands without
          // a wire-shape decision, this fails the compile — better than silent
          // drop. Schema is locked at the two values today.
          assertNever(row.mode);
      }
    }
    return { school, daycare };
  },
};

function assertNever(x: never): never {
  throw new Error(`creditsRepository: unhandled booking_mode value: ${String(x)}`);
}
