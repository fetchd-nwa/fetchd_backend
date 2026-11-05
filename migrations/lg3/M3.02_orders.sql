-- M3.02 (S20, PAY-U04, PAY-U05) — the order: one Confirm, at most one charge.
-- design §4 LG3 (design.md:6189), §2.7 (design.md:3811-3815, :3832-3845).
-- Rev.: yes (drop the columns, then the table). Empty prod: creates; 0 rows to backfill.
--
-- `orders` stores no status: an order's money is read from its one charge, the
-- row with `charges.order_id` set. Many orders may try one invoice, one at a time,
-- so `orders.invoice_id` is not unique; `invoices.order_id` is the other direction,
-- written only by a purchase's settle, and unique.
--
-- `invoices_order_id_uidx` is plain, not partial, and that is load-bearing. NULLs
-- never conflict, so it holds every custom invoice with no order, and a writer's
-- `ON CONFLICT (order_id)` infers it with no WHERE repeated. A partial index would
-- answer 42P10 to that statement after Stripe has taken the money.
--
-- `attempting_until` is the request's and `next_sweep_at` is the sweeper's. On a
-- `requires_payment` charge, `next_sweep_at` set means the sweeper has claimed it, and
-- the request may not write again. On a `failed` charge, set means its intent can still
-- move and the sweeper looks again at this time; NULL means there is nothing left to
-- look at.
--
-- The frozen create parameters are `amount_cents` (already on the row), and the
-- three below it. `stripe_customer_id` and `stripe_payment_method_id` are what a
-- re-send under K0 must repeat byte for byte. `payment_method_id` is ours: the card
-- the settle rebinds an invoice to (PAY-12). No frozen price column (question 37).
CREATE TABLE orders (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id   uuid NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  invoice_id uuid REFERENCES invoices(id)
);
REVOKE ALL ON orders FROM anon, authenticated;
CREATE INDEX orders_owner_idx ON orders (owner_id);
CREATE INDEX orders_invoice_idx ON orders (invoice_id) WHERE invoice_id IS NOT NULL;

ALTER TABLE bookings         ADD COLUMN order_id uuid REFERENCES orders(id);
ALTER TABLE charges          ADD COLUMN order_id uuid REFERENCES orders(id);
ALTER TABLE invoices         ADD COLUMN order_id uuid REFERENCES orders(id);
ALTER TABLE idempotency_keys ADD COLUMN order_id uuid REFERENCES orders(id);

CREATE INDEX bookings_order_idx ON bookings (order_id) WHERE order_id IS NOT NULL;
CREATE UNIQUE INDEX charges_order_id_uidx ON charges (order_id);
CREATE UNIQUE INDEX invoices_order_id_uidx ON invoices (order_id);
CREATE INDEX idempotency_keys_order_idx ON idempotency_keys (order_id) WHERE order_id IS NOT NULL;

ALTER TABLE charges
  ADD COLUMN stripe_idempotency_key   text,
  ADD COLUMN attempt_count            integer NOT NULL DEFAULT 0,
  ADD COLUMN blocker                  text,
  ADD COLUMN attempting_until         timestamptz,
  ADD COLUMN next_sweep_at            timestamptz,
  ADD COLUMN last_stripe_error        text,
  ADD COLUMN stripe_customer_id       text,
  ADD COLUMN stripe_payment_method_id text,
  ADD COLUMN payment_method_id        uuid REFERENCES payment_methods(id);

CREATE INDEX charges_attempting_idx ON charges (attempting_until)
  WHERE status = 'requires_payment' AND order_id IS NOT NULL;
CREATE INDEX charges_watch_idx ON charges (next_sweep_at)
  WHERE status = 'failed' AND next_sweep_at IS NOT NULL;
