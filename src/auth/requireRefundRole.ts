import type { StaffRole } from '../contracts/wire.js';
import { db } from '../db/client.js';
import { settingsRepository } from '../db/repositories/settingsRepository.js';
import type { Tx } from '../db/tx.js';
import { ApiError } from '../lib/errors.js';
import { passesRoleList, staffCapabilities } from '../lib/staffCapabilities.js';

/**
 * Who may move money back (PAY-U25; design §2.7:4172-4182, §1.1:1101-1125; wire 6.0.0
 * § refunds, D6). The refund routes' one gate, through `passesRoleList` as
 * {@link requireCreditEditRole} reads its list. Both settings are read per request, so an
 * owner's list edit or a limit change binds the next one:
 *
 *   - `'new-refund'` (`POST /staff/refunds`): a role on `staff.refund_role_list`, or any
 *     role whose `amount_cents` is at most `pay.refund_any_role_limit_cents` (one
 *     comparison, seeded 0: no ladder, no second list);
 *   - `'chain'` (*Retry to card*, *Returned*): the list alone (§1.1:1116, :1123);
 *   - `'proposal'`: `capabilities.refund_money`'s rule, so it matches the *Refund* action.
 *
 * Every refusal is the same 403 `refund_role_required`, with no `details` and a message that
 * names only the role, so it never says whether a payment exists. Unlike
 * `requireCreditEditRole` it is not a preHandler: the POSTs call it inside `withMutation`,
 * after the claim (DECISIONS 128(a)), so a replay of a 201 returns its stored body after the
 * caller's role leaves the list, and a refusal leaves no claim behind (153).
 */
export type RefundGate =
  | { kind: 'new-refund'; amountCents: number }
  | { kind: 'chain' }
  | { kind: 'proposal' };

export async function requireRefundRole(
  role: StaffRole,
  gate: RefundGate,
  runner: Tx | typeof db = db,
): Promise<void> {
  // One after the other: on a transaction both reads share one connection.
  const lists = await settingsRepository.staff(runner);
  const limit = await settingsRepository.refundAnyRoleLimitCents(runner);
  const passes =
    gate.kind === 'proposal'
      ? staffCapabilities(role, lists, limit).refund_money
      : passesRoleList(role, lists.refund_roles) ||
        (gate.kind === 'new-refund' && gate.amountCents <= limit);
  if (!passes) {
    throw new ApiError('refund_role_required', `the ${role} role may not do this refund verb`);
  }
}
