# Money/booking edge-case review — 2026-06-18

Outcome of the schema + money-path audit. **Four code fixes shipped + tested
(703/703, tsc + eslint clean); four items deferred because they need a business
or design decision, not a patch.** No commit yet.

## Shipped (verified)

### #1 — Orphaned package purchase is reconstructed by the webhook
*Risk closed: customer charged, zero credits, no recovery.*

Stripe captures payment **outside** the purchase tx; if that tx then failed
entirely, the `payment_intent.succeeded` webhook used to find no `charges` row
and drop the event (`orphan-event`, marked processed → no redelivery).

- `webhooks/stripeEventHandlers.ts` — `handlePaymentIntentSucceeded` now, when
  the charge row is absent, calls `maybeReconstructOrphanedPackagePurchase`:
  rebuilds the `charges` row (succeeded, `purpose=package`) **and** the
  `credit_ledger` grant from the PI metadata. Idempotent under a concurrent
  client retry — the charge insert is `ON CONFLICT DO NOTHING` on the unique
  PI (`chargesRepository.insertIfAbsentByPaymentIntent`), the grant is the
  existing no-op-if-present `maybeWritePurchaseLedgerRow`. New outcome
  `reconstructed-package-purchase`.
- Non-package orphans stay dropped (invoice-auto-charge orphans self-heal via
  the worker's next tick; a truly unknown PI isn't ours).
- Tests: `test/contracts/stripe-webhook-recovery.test.ts` (reconstruct;
  idempotent redelivery → still one charge + one grant; non-package orphan
  fabricates nothing).

### #3 — Refund webhook forces redelivery instead of stranding
`charge.refund.updated` with no matching `refunds` row now **throws**
(`WebhookRetryError`) → the receiver releases the `stripe_events` claim → 500 →
Stripe redelivers, instead of marking it processed and leaving the refund
`pending` forever (charge never flips to `refunded`). The `refunds` row commits
before the post-commit Stripe call, so "not found" is always a delivery race
that resolves on redelivery. Test in the recovery file + the existing
`stripe-webhook.test.ts` case updated to the new contract.

### #8 — Invoice auto-charge: Stripe call no longer runs inside a locked tx
*Minimizes transaction latency (the explicit ask).* The worker held a
`FOR UPDATE` row lock + a DB connection across the ~30s Stripe round-trip for
the whole batch. Rewritten to a **lease** pattern:
- `invoicesRepository.leaseDueOpen` — short claim tx: `FOR UPDATE SKIP LOCKED`
  the due rows, push `next_attempt_at` to a lease horizon, commit (locks
  released immediately).
- Per invoice: pool reads + the Stripe call with **no tx open**, then a short
  record tx (charge+markPaid atomic, or recordFailedAttempt).
- Crash-safe: a worker dying before recording leaves the lease to expire; the
  re-lease re-attempts with the same `auto-charge:{id}:{attempts}` Stripe
  idempotency key → same PI, no double charge.

### #4 — Non-settled PI is cancelled (double-charge window closed)
When `createAndConfirmPaymentIntent` returns a non-`succeeded` status
(`requires_action`/`processing`/`requires_payment_method`), the worker now
**cancels that PI** (new best-effort `stripe.cancelPaymentIntent` seam) before
scheduling the retry, so it can't later auto-succeed and double-charge against
the next attempt's fresh PI. Counts toward the park cap. Test asserts the cancel
fires + no charge row + attempt incremented.
*(Low probability for card-only off-session — Stripe usually throws on decline —
but cheap, correct insurance.)*

## Deferred — need a decision, not a patch

### #2 — Credit expiry (BUSINESS DECISION REQUIRED)
There is a direct contradiction:
- **Memory `project_credit_expiry` (2026-06-13):** Shanthi's rule = ">1-credit
  packs expire 1 year after purchase; single-day never."
- **`schema.sql:823`:** *"credits DO NOT expire … do not re-add expiry without
  a new business decision."*

Today credits silently **never** expire (money the business expects to reclaim),
and the data model **cannot express** expiry — `dog_credit_balance` is a flat
`SUM(delta)`, with no lot/expiry tracking. Implementing it right is a
**lot-allocation** change, not a flag:
- A purchase grant becomes a *lot* with an `expires_at` (1yr for >1-credit packs,
  null for single-day).
- The balance must be computed lot-aware (only count credits from non-expired
  lots, net of debits allocated to each lot).
- Debits allocate FIFO across non-expired lots; **refunds must restore to the
  original lot if unexpired, else they resurrect dead credits**.
- An expiry surfaces in the `GET /credits` read (or a periodic snapshot), not a
  destructive sweep (append-only ledger).

**Recommendation:** design this as its own task. Decision needed first: confirm
the rule (1yr from purchase, >1-credit only) and whether expiry is lazy
(computed at read) or materialized. I can draft the lot-model migration +
balance rewrite + tests once confirmed. **Do not** bolt it onto the flat ledger.

### #5 — Notify on parked (un-collectable) invoice
After `MAX_AUTO_CHARGE_ATTEMPTS` the invoice parks with no owner/staff
notification and no booking reversal. Doing it right needs a new
`payment-failed` (or `payment-action-needed`) value in the `notification_type`
enum (a real `ALTER TYPE` migration + wire + FE row renderer) **and** the staff
surface — which is the deferred Day-16/19 staff-notification subsystem. Pairing
the owner notification with the staff surface keeps it one coherent change.
**Recommendation:** fold into the Day-16/19 notification work; decision needed on
whether a parked invoice should also auto-cancel/flag the backing booking.

### #6 — PAYG / membership day-program booking (CONFIRM DESIGN)
`POST /bookings` unconditionally debits credits — no PAYG-charge or
membership-grant branch. This is fine **iff** PAYG = "buy a 1-credit pack first"
and memberships periodically grant via the `membership-grant` ledger reason.
If a member's grant hasn't run, or a PAYG owner books with no credits, they hit
`insufficient_credits`. **Recommendation:** confirm the intended PAYG/membership
UX; if per-session PAYG-at-booking is wanted, that's a new branch (charge instead
of debit) + tests. No code until the design is confirmed.

### #7 — DB-level double-booking backstop (LOW VALUE)
The in-lock `booking_dogs` duplicate guard is correct and race-free. A DB unique
constraint can't cleanly express the multi-dog/additional-dog "(dog, category,
day)" shape, and a partial index on `lead_dog_id` only would miss additional
dogs + false-positive on cancelled rows. **Recommendation:** leave as-is; the
app guard under the advisory lock is the right enforcement point.

## Notes confirmed during the audit (no action)
- Negative-balance invariant is airtight: debits are the only negative delta and
  always run under the `(dog, mode, location)` advisory lock with a balance check.
- Cancel/refund: row-locked, double-cancel guarded, forfeit branch, and the
  money-back path caps at `charge − Σ non-failed refunds`.
- Idempotency: atomic claim, errors roll back the claim row (retry re-attempts,
  never replays an error), mismatch + in-flight guarded.
- Booking-create tx is already network-free (no Stripe inside) — already tight.
