import { and, asc, eq, lte, sql } from 'drizzle-orm';
import { pgTimestampToIso } from '../../lib/pgTimestamp.js';
import { db } from '../client.js';
import { leaseInstant } from '../locks.js';
import { charges, orders, owners } from '../schema/schema.js';
import type { Tx } from '../tx.js';

/** Polymorphic runner — pool for pre/post-tx reads, Tx for in-mutation work. */
type Runner = Tx | typeof db;

/**
 * Data-access seam for `orders` (M3.02, PAY-U04). One row per Confirm. It stores no
 * status: an order's money is read from its one charge, the row with
 * `charges.order_id` set, and a credits-only Confirm is an order with no charge.
 */
export interface OrderRow {
  id: string;
  ownerId: string;
  /** The invoice this order pays; NULL on a booking or a purchase. */
  invoiceId: string | null;
  createdAt: string;
}

const ORDER_PROJECTION = {
  id: orders.id,
  ownerId: orders.ownerId,
  invoiceId: orders.invoiceId,
  createdAt: orders.createdAt,
} as const;

/** One row of `GET /staff/payments/pending`, before its sessions are read. */
export interface PendingOrderRow {
  orderId: string;
  ownerId: string;
  ownerName: string | null;
  ownerEmail: string | null;
  createdAt: string;
  amountCents: number;
  purpose: typeof charges.$inferSelect.purpose;
}

export const ordersRepository = {
  async create(tx: Tx, args: { ownerId: string; invoiceId?: string | null }): Promise<OrderRow> {
    const [row] = await tx
      .insert(orders)
      .values({ ownerId: args.ownerId, invoiceId: args.invoiceId ?? null })
      .returning(ORDER_PROJECTION);
    if (!row) throw new Error('ordersRepository.create: INSERT returned no row');
    return row;
  },

  async findById(runner: Runner, id: string): Promise<OrderRow | undefined> {
    const [row] = await runner
      .select(ORDER_PROJECTION)
      .from(orders)
      .where(eq(orders.id, id))
      .limit(1);
    return row;
  },

  /**
   * Does another order on this invoice hold a `requires_payment` charge inside its
   * lease (design §1.1:925-926, §2.7:3815)? Past the lease a second tender goes
   * through, and PAY-35 refunds the loser (DECISIONS 142(b)). A plain read: the
   * caller holds the invoice's lock, which is what serialises two tx1s.
   */
  async invoiceHasChargeInLease(tx: Tx, args: { invoiceId: string; at?: Date }): Promise<boolean> {
    const [row] = await tx
      .select({ id: charges.id })
      .from(charges)
      .innerJoin(orders, eq(charges.orderId, orders.id))
      .where(
        and(
          eq(orders.invoiceId, args.invoiceId),
          eq(charges.status, 'requires_payment'),
          sql`${charges.attemptingUntil} > ${leaseInstant(args.at)}`,
        ),
      )
      .limit(1);
    return row !== undefined;
  },

  /**
   * Every order whose one charge is still `requires_payment`, older than the cutoff,
   * oldest first, across both campuses. An order paying an invoice is not listed:
   * `PendingPaymentWire.kind` has no word for it (DECISIONS 142(a)).
   */
  async findPendingOlderThan(
    runner: Runner,
    args: { olderThan: Date },
  ): Promise<PendingOrderRow[]> {
    return runner
      .select({
        orderId: orders.id,
        ownerId: orders.ownerId,
        ownerName: owners.name,
        ownerEmail: owners.email,
        createdAt: orders.createdAt,
        amountCents: charges.amountCents,
        purpose: charges.purpose,
      })
      .from(orders)
      .innerJoin(charges, eq(charges.orderId, orders.id))
      .innerJoin(owners, eq(owners.id, orders.ownerId))
      .where(
        and(
          eq(charges.status, 'requires_payment'),
          sql`${orders.invoiceId} IS NULL`,
          lte(orders.createdAt, args.olderThan.toISOString()),
        ),
      )
      .orderBy(asc(orders.createdAt));
  },
};

/** `orders.created_at`, as the wire writes an instant. */
export function orderCreatedAtIso(row: Pick<OrderRow, 'createdAt'>): string {
  return pgTimestampToIso(row.createdAt);
}
