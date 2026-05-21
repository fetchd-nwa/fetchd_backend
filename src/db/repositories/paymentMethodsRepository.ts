import { and, asc, desc, eq } from 'drizzle-orm';
import { db } from '../client.js';
import { paymentMethods } from '../schema/schema.js';
import { live } from '../softExpire.js';

/**
 * Data-access seam for `payment_methods`. Day-7b read-only addition; Day-9
 * will extend with the SetupIntent + add + patch-default + soft-expire
 * mutations.
 *
 * Wire shape per the FE `paymentMethodRepository.ts` Raw type — flat
 * 7-key row, all required. Card lifecycle uses soft-expire (`expired_at`
 * non-null = removed) so retained charge history can still reference a
 * card after it's "deleted" from the FE perspective.
 */

export interface PaymentMethodRow {
  id: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  cardholderName: string;
  isDefault: boolean;
}

const PAYMENT_METHOD_PROJECTION = {
  id: paymentMethods.id,
  brand: paymentMethods.brand,
  last4: paymentMethods.last4,
  expMonth: paymentMethods.expMonth,
  expYear: paymentMethods.expYear,
  cardholderName: paymentMethods.cardholderName,
  isDefault: paymentMethods.isDefault,
} as const;

export const paymentMethodsRepository = {
  /**
   * Owner's live cards. Default emits first (single hero slot in the FE),
   * then oldest-first as the secondary order — predictable for the FE
   * and for snapshot diffs. `live()` filter drops soft-expired rows; the
   * partial unique index `payment_methods_one_default` already enforces
   * at most one live default per owner so no extra dedupe is needed here.
   */
  async findLiveByOwner(ownerId: string): Promise<PaymentMethodRow[]> {
    return db
      .select(PAYMENT_METHOD_PROJECTION)
      .from(paymentMethods)
      .where(and(eq(paymentMethods.ownerId, ownerId), live(paymentMethods)))
      .orderBy(desc(paymentMethods.isDefault), asc(paymentMethods.createdAt));
  },
};
