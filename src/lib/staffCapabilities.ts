import type { StaffCapabilitiesWire, StaffRole, StaffSettingsWire } from '../contracts/wire.js';
import { mayEditClass } from './settingsRegistry.js';

/**
 * `StaffMeWire.capabilities` — what a staffer may do, computed by the server
 * (STAFF-U07; design §1.1:695-709, §2.1:2049-2079). The portal draws from
 * these and never from `role`; the server guards re-check either way, so a
 * flag is a courtesy, not the gate.
 *
 * Three sources, each the one place its rule lives:
 *   - the settings registry's class map (`mayEditClass`): `edit_prices` (the
 *     `price` class — no role in v1, the owner included: q27 → (a)) and
 *     `edit_money_policy` (the `money` class: owner and manager, STAFF-77);
 *   - the two fixed reads of STAFF-12 / STAFF-13: `open_money_reports` and
 *     `open_payment_history`, owner and manager (contract notes J2);
 *   - the five `staff_settings` lists (`passesRoleList`), and
 *     `pay.refund_any_role_limit_cents` for `refund_money`.
 *
 * Computed on each `GET /me` from the rows read for it — no cache — so an
 * owner's list edit shows at the caller's next `GET /me` (J3).
 */

/** STAFF-09: the owner role passes every list whatever it holds, so the owner
 *  can never be edited out of a verb; any other role passes when it is on the
 *  list. The rule every list-backed verb applies (`requireCreditEditRole`, the
 *  first, reads its list through this same function). */
export function passesRoleList(role: StaffRole, list: readonly StaffRole[]): boolean {
  return role === 'owner' || list.includes(role);
}

/** Owner and manager: the money reports (STAFF-12) and payment history (STAFF-13). */
const MONEY_READERS: ReadonlySet<StaffRole> = new Set<StaffRole>(['owner', 'manager']);

export type RoleLists = Pick<
  StaffSettingsWire,
  | 'refund_roles'
  | 'credit_hand_edit_roles'
  | 'desk_sale_roles'
  | 'custom_invoice_roles'
  | 'cash_day_totals_roles'
>;

export function staffCapabilities(
  role: StaffRole,
  lists: RoleLists,
  refundAnyRoleLimitCents: number,
): StaffCapabilitiesWire {
  return {
    edit_prices: mayEditClass(role, 'price'),
    edit_money_policy: mayEditClass(role, 'money'),
    open_money_reports: MONEY_READERS.has(role),
    open_payment_history: MONEY_READERS.has(role),
    // Above 0, every role may refund up to the limit (§1.1:697-699; seeded 0).
    refund_money: passesRoleList(role, lists.refund_roles) || refundAnyRoleLimitCents > 0,
    edit_credits: passesRoleList(role, lists.credit_hand_edit_roles),
    custom_invoice: passesRoleList(role, lists.custom_invoice_roles),
    desk_sale: passesRoleList(role, lists.desk_sale_roles),
    cash_day_totals: passesRoleList(role, lists.cash_day_totals_roles),
  };
}
