import { db } from '../db/client.js';
import { bookingsRepository } from '../db/repositories/bookingsRepository.js';
import { chargesRepository } from '../db/repositories/chargesRepository.js';
import { invoicesRepository } from '../db/repositories/invoicesRepository.js';
import { refundsRepository } from '../db/repositories/refundsRepository.js';
import type { InvoiceRow } from '../db/repositories/invoicesRepository.js';
import { withActor } from '../db/tx.js';
import {
  chargeBelongsToEnrollment,
  enrollmentIdentityOf,
  type EnrollmentIdentity,
} from '../lib/enrollmentIdentity.js';
import { reconcileCaptureKey } from '../lib/enrollmentPartial.js';
import {
  claimInvoiceWithCharge,
  resolveInvoiceAnchorBookingId,
} from '../lib/settleInvoiceCharge.js';
import { firePendingRefundPostCommit } from '../lib/pendingRefund.js';
import {
  defaultStripeClient,
  stripeIntentStatusToChargeStatus,
  type StripeClient,
} from '../lib/stripe.js';
import { cancelAndConfirm } from '../lib/withdrawSettlement.js';
import type { WorkerLogger } from './invoiceAutoCharge.js';

/**
 * Capture reconciler (2026-08-20, `designs/partial-success-enrollment.md` §3.7;
 * `designs/money-safety-rollback-and-replay.md` §7).
 *
 * Manual capture splits one indivisible-looking act into two: the enroll
 * transaction commits with the money merely HELD, and a post-commit capture
 * moves it. That split creates exactly one new state — **enrolled, capture not
 * finished** — and this phase is the thing that owns it. Without it, a capture
 * that failed after the commit is a dog attending a class nobody was charged
 * for, discoverable only by reading a log line: the "things not getting
 * charged" half of Allison's rule, arriving silently.
 *
 * Per tick: claim group-class enrollment charges still at `'requires_payment'`
 * with a PaymentIntent attached, older than {@link CAPTURE_GRACE_MINUTES}, and
 * ask Stripe what each intent actually is.
 *
 *   - `requires_capture` → **ask whether anything still owes this money, and
 *     only then capture** (ADDENDUM 3 §A3.3.1, 2026-08-21). Owed: capture it
 *     under a key derived from OUR charge-row id ({@link reconcileCaptureKey})
 *     and flip the row to `'succeeded'`. NOT owed: RELEASE it — cancel the
 *     authorization and flip the row `'failed'`. The precondition is the
 *     round-3 blocker's fix: this arm used to capture unconditionally, so a
 *     withdraw during the capture-pending window ended with money taken for a
 *     class with zero live bookings.
 *
 * **Every arm asks a ROW-SCOPED question first (§A3.17, 2026-08-22): is the
 * enrollment THIS CHARGE belongs to still live?** A `(cohort, dog)` is not an
 * enrollment — withdraw + re-enroll mints a second one under the same key — and
 * asking only "does this dog owe" let one enrollment's money answer for
 * another's in both directions: a live hold cancelled for an enrolled dog
 * because a previous enrollment's charge still showed a remainder, and a
 * withdrawn enrollment's stray hold CAPTURED because the re-enrollment
 * genuinely owed. A charge belongs to an enrollment by its `booking_id` anchor
 * (`lib/enrollmentIdentity.ts`), and the two questions are answered together in
 * {@link readRowMoneyState}.
 *   - `succeeded` → **already captured.** The money moved and only our flip was
 *     lost; write the flip. Never a second capture — this is the
 *     "already-captured is success-after-retrieve" rule, and it is why the
 *     retrieve happens before the capture rather than after a failure. Then, if
 *     the enrollment is GONE, return the money: a capture that won a race
 *     against a withdraw is money we promised back, and this phase mints and
 *     fires that refund unattended (§A3.3.2, Allison's Q-B ruling).
 *   - `canceled` → the hold is GONE. If the dog is still enrolled with no other
 *     way to collect **and no succeeded charge already covers it**, that is
 *     money we will never take for a service we are delivering, and it is the
 *     one state here that needs a human. ERROR, loud-once per process.
 *   - anything else → not a manual-capture hold of ours (the invoice lane
 *     writes `'requires_payment'` group-class rows too, on automatic-capture
 *     intents it then cancels). Left alone, quietly: a phase that shouted about
 *     other lanes' rows once a minute would bury the alarm that matters, which
 *     is the failure mode the duplicate-refund sweep already earned.
 *
 * **The worklist has a lease and an exit** (ADDENDUM 1 R3). The claim takes
 * the oldest rows by `updated_at` and bumps them, so working a row sends it to
 * the back of the queue and no row can starve the ones behind it; and a row
 * still stuck {@link CAPTURE_ABANDON_AFTER_HOURS} after it was minted stops
 * being claimed and is REPORTED instead. Neither existed in the round-1
 * build, and without them a `lost-hold` — which writes nothing, by design —
 * held the front of a `created_at`-ordered page forever while newer capturable
 * holds were never scanned. Both halves mirror `duplicateRefundRetry`.
 *
 * **The `succeeded` arm is deliberately lane-agnostic.** If a foreign row's
 * automatic-capture intent really did succeed, `'succeeded'` is the honest
 * status for it and the webhook would have written the same flip; writing it
 * here only means `handlePaymentIntentSucceeded` takes its already-terminal
 * arm. Recorded because the "left alone, quietly" sentence above is about the
 * NOT-CAPTURABLE statuses and was previously read as covering this one too.
 *
 * No DDL: `status`, `stripe_payment_intent_id`, `cohort_id`, `dog_id`,
 * `created_at` and `updated_at` already carry everything this needs.
 */

const WORKER_ACTOR = 'system:scheduler';

/**
 * How long a `'requires_payment'` enrollment charge rests before this phase
 * touches it. Long enough that a request whose post-commit capture is still
 * in flight is never raced (a Stripe round-trip is seconds, not minutes);
 * short enough that a genuinely stuck capture is money collected the same
 * hour, not the same day.
 */
export const CAPTURE_GRACE_MINUTES = 5;

/**
 * Past this age the reconciler stops claiming a row and starts naming it.
 *
 * **This bound is about ATTENTION, not key safety** — unlike
 * `DUPLICATE_REFUND_ABANDON_AFTER_HOURS`, which sits at Stripe's key lifetime
 * because a same-key retry past it could execute a second refund. Nothing like
 * that applies here: {@link reconcileCaptureKey} is derived from our own row
 * id, every capture is preceded by a retrieve, and Stripe refuses to capture
 * an intent that is not `requires_capture`. What a day of failure DOES mean is
 * that another tick will not fix it, and a row that cannot be fixed and cannot
 * leave is the thing that starves the queue. A hold expires on the card
 * network in ~7 days, so the alarm this raises has real time on it — which is
 * exactly why it must be raised rather than absorbed.
 */
export const CAPTURE_ABANDON_AFTER_HOURS = 24;

/** Per-tick batch. Small: each row costs a Stripe retrieve and maybe a capture. */
const DEFAULT_LIMIT = 25;

/** How many abandoned rows one alarm names individually. The TRUE count comes
 *  back beside it, so a saturated page can never flatter the number. */
const ABANDON_REPORT_LIMIT = 20;

export interface CaptureReconcilerOpts {
  stripe?: StripeClient;
  limit?: number;
  /** "Now" for the grace cutoff. Tests pin an instant. */
  now?: Date;
  log?: WorkerLogger;
}

export type CaptureReconcileOutcome =
  /** This tick captured the hold and flipped the row. */
  | 'captured'
  /** Stripe had already captured it; only our flip was missing. */
  | 'already-captured'
  /**
   * The hold was live and capturable, but NOTHING OWES IT — the dog withdrew.
   * This tick released the authorization instead of capturing it (ADDENDUM 3
   * §A3.3). Not an incident: it is the correct end of a withdrawn enrollment
   * whose payment was still settling, and it is the defence-in-depth for any
   * withdraw path that leaves a live hold behind.
   */
  | 'withdrawn-released'
  /**
   * The money was already captured and the enrollment is GONE — a capture that
   * won a race against a withdraw. This tick flipped the row and minted the
   * refund the withdraw promised (Allison's Q-B ruling: YES, unattended).
   */
  | 'refunded-post-withdraw'
  /**
   * We decided this hold must NOT be captured, our release lost the race to a
   * capture, and the row's own enrollment is still live — so the money is a
   * SURPLUS on a class that is already covered. This tick returned it
   * (ADDENDUM 3 §A3.18 D4; Allison's Q-F default: a payment we decided against
   * returns itself). Worker-internal — NOT a wire value.
   */
  | 'refunded-surplus'
  /**
   * The row's enrollment is live, nothing was owed because an OPEN INVOICE
   * covers the class — so this money is not surplus at all: it is that
   * invoice's own payment, arrived late. This tick SETTLED the invoice with it
   * (ADDENDUM 3 §A3.19 F1). Worker-internal — NOT a wire value.
   */
  | 'settled-invoice'
  /** The hold is gone and the dog is enrolled — money we will never collect. */
  | 'lost-hold'
  /** The hold is gone but nothing is owed — the dog withdrew, an open invoice
   *  covers it, or the money was already collected on another charge row
   *  (R6). Not an incident. */
  | 'released'
  /** The intent is not a capturable hold — another lane's row, or a hold still
   *  resolving. Left untouched. */
  | 'not-capturable'
  /** Stripe could not be reached, or the capture threw. Retried next tick. */
  | 'still-failing';

export interface CaptureReconcileResult {
  chargeId: string;
  outcome: CaptureReconcileOutcome;
}

export interface CaptureReconcilerTickResult {
  scanned: number;
  captured: number;
  /** Rows now needing a human — see {@link CaptureReconcileOutcome} `lost-hold`. */
  lostHolds: number;
  /** Holds released because nothing owed them (§A3.3.1). */
  withdrawnReleased: number;
  /** Captured money returned to a withdrawn owner, unattended (§A3.3.2). */
  refundedPostWithdraw: number;
  /** Surplus captures returned on a live-but-covered enrollment (§A3.18 D4). */
  refundedSurplus: number;
  /** Open invoices settled by money that turned out to be their own (§A3.19 F1). */
  settledInvoices: number;
  /**
   * Rows past {@link CAPTURE_ABANDON_AFTER_HOURS} that this phase no longer
   * claims. The TRUE count from an unbounded query, never the report page's
   * length — a saturated page must not make stuck money look smaller.
   */
  abandoned: number;
  /** True when the capped report page could not hold every abandoned row. */
  abandonedTruncated: boolean;
  /**
   * Of the abandoned rows ON THE PAGE, how many are money we have still not
   * collected (same `owed` question the lost-hold alarm asks). The rest are
   * bookkeeping: a withdrawn dog, an invoice-lane row, or money already taken
   * on another charge. The split exists so one alarm is not made to carry two
   * sentences, only one of which any given reader can act on.
   */
  abandonedUncollected: number;
  results: CaptureReconcileResult[];
}

/**
 * Charge ids this PROCESS has already alarmed about. The lost-hold condition
 * is standing, not transient: nothing this worker does clears it, so a plain
 * ERROR every tick would emit the same line once a minute forever and bury the
 * next real incident. Loud once, counted after — the same posture the verify
 * lane and the duplicate-refund sweep settled on.
 */
const ALARMED_CHARGE_IDS = new Set<string>();

/** The same memory for the abandon report, kept separate because a row can be
 *  alarmed as a lost hold on day 0 and abandoned on day 1, and both are worth
 *  saying exactly once. */
const ALARMED_ABANDONED_IDS = new Set<string>();

/**
 * The largest UNCOLLECTED abandoned count this process has announced at ERROR.
 * Loud-once per row is silent about growth it cannot show: once the capped page
 * is full of rows already named, genuinely new abandoned money would arrive as
 * nothing but a climbing number nobody is watching. One ERROR per INCREASE
 * closes that without reopening the flood — the same fix, and the same
 * reasoning, as `ALARMED_BURIED_HIGH_WATER` in `duplicateRefundRetry`.
 *
 * **It is seeded and compared on the UNCOLLECTED count, not the total.** It
 * was the total on both sides, and that made the loudest line in this phase
 * lane-blind: `findAbandonedGroupClassCaptures` cannot tell an enrollment hold
 * from an invoice-lane row (`chargesRepository.ts:290-296` — those are
 * bookkeeping forever), so with ZERO uncollected money and three aged
 * bookkeeping rows the first tick fired an ERROR reading "MORE ABANDONED
 * ENROLLMENT HOLDS than this process has named", and every further aged
 * bookkeeping row bought another one. The sentence was false, and the alarm
 * that is supposed to mean "go and collect money" was being spent on rows
 * where there is none to collect — the precise failure mode the
 * uncollected/bookkeeping split was introduced to prevent.
 */
let alarmedUncollectedHighWater = 0;

/**
 * The largest TOTAL abandoned count this process has mentioned, at any level.
 * Growth in the bookkeeping half is worth saying once and worth saying at
 * INFO: it is a population an operator may want to prune, never a person to
 * page.
 */
let alarmedAbandonedTotalHighWater = 0;

export async function runCaptureReconcilerOnce(
  opts: CaptureReconcilerOpts = {},
): Promise<CaptureReconcilerTickResult> {
  const stripe = opts.stripe ?? defaultStripeClient;
  const log = opts.log;
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const olderThan = new Date(now.getTime() - CAPTURE_GRACE_MINUTES * 60 * 1000);
  const abandonFloor = new Date(now.getTime() - CAPTURE_ABANDON_AFTER_HOURS * 60 * 60 * 1000);

  // Claim in a short transaction, which is also the lease. Every Stripe call
  // below runs OUTSIDE it (R5).
  const pending = await withActor(WORKER_ACTOR, (tx) =>
    chargesRepository.claimPendingGroupClassCaptures(tx, {
      olderThan,
      mintedAfter: abandonFloor,
      limit,
    }),
  );
  const results: CaptureReconcileResult[] = [];
  let captured = 0;
  let lostHolds = 0;
  let withdrawnReleased = 0;
  let refundedPostWithdraw = 0;
  let refundedSurplus = 0;
  let settledInvoices = 0;

  for (const row of pending) {
    const outcome = await reconcileOne(stripe, row, log);
    results.push({ chargeId: row.id, outcome });
    if (outcome === 'captured' || outcome === 'already-captured') captured += 1;
    if (outcome === 'lost-hold') lostHolds += 1;
    if (outcome === 'withdrawn-released') withdrawnReleased += 1;
    if (outcome === 'refunded-post-withdraw') refundedPostWithdraw += 1;
    if (outcome === 'refunded-surplus') refundedSurplus += 1;
    if (outcome === 'settled-invoice') settledInvoices += 1;
  }

  const abandonReport = await reportAbandoned(abandonFloor, log);

  log?.info(
    {
      workerTick: 'scheduler',
      phase: 'capture-reconciler',
      scanned: pending.length,
      captured,
      lostHolds,
      withdrawnReleased,
      refundedPostWithdraw,
      refundedSurplus,
      settledInvoices,
      abandoned: abandonReport.total,
      abandonedTruncated: abandonReport.truncated,
      abandonedUncollected: abandonReport.uncollected,
    },
    'capture-reconciler pass complete',
  );

  return {
    scanned: pending.length,
    captured,
    lostHolds,
    withdrawnReleased,
    refundedPostWithdraw,
    refundedSurplus,
    settledInvoices,
    abandoned: abandonReport.total,
    abandonedTruncated: abandonReport.truncated,
    abandonedUncollected: abandonReport.uncollected,
    results,
  };
}

/**
 * Name the rows this phase has given up on — once each, and split by whether a
 * human actually has money to go and collect.
 *
 * Both halves are needed and neither can carry the other's sentence. "Charge
 * the owner in Stripe" is wrong for a withdrawn dog and wrong for an
 * invoice-lane row, and burying the rows where it IS right under the ones
 * where it is not is how an alarm stops being read — the same lesson the
 * duplicate-refund report's four-class split was earned from.
 *
 * **Three arms, and only two of them are ERRORs.** New uncollected rows are
 * named; a rise in the uncollected count with nothing new to name is an ERROR
 * about money the page cannot show; a rise in the TOTAL with no rise in
 * uncollected is bookkeeping and goes out at INFO.
 *
 * **Residual, inherited from the split itself** (DATA-CONTRACT §L.8): the
 * uncollected count is computed for the capped page only, while `total` is
 * unbounded. Once the page saturates with uncollected rows this process has
 * already named, further uncollected money arriving BEHIND the cap raises
 * `total` but not `uncollected`, so it lands on the INFO arm rather than the
 * ERROR one. Closing that needs an unbounded uncollected count — a SQL-side
 * count of the three-part `owed` predicate — which does not exist and was not
 * built here. Named because the alternative was keying the ERROR off `total`,
 * which is what made it fire for rows that owe nothing.
 */
async function reportAbandoned(
  mintedBefore: Date,
  log: WorkerLogger | undefined,
): Promise<{ total: number; truncated: boolean; uncollected: number }> {
  const { rows, total } = await chargesRepository.findAbandonedGroupClassCaptures(db, {
    mintedBefore,
    limit: ABANDON_REPORT_LIMIT,
  });
  if (total === 0) return { total: 0, truncated: false, uncollected: 0 };

  const uncollected: typeof rows = [];
  for (const row of rows) {
    if (await isUncollected(row)) uncollected.push(row);
  }
  const unreported = uncollected.filter((row) => !ALARMED_ABANDONED_IDS.has(row.id));

  if (unreported.length > 0) {
    for (const row of unreported) ALARMED_ABANDONED_IDS.add(row.id);
    // Both waters only ever RISE. A population that shrinks and regrows is
    // made of new rows, and new rows come back through this arm by name — so
    // monotonic here costs no alarm and is what keeps the two arms below from
    // re-firing on ground already covered.
    alarmedUncollectedHighWater = Math.max(alarmedUncollectedHighWater, uncollected.length);
    alarmedAbandonedTotalHighWater = Math.max(alarmedAbandonedTotalHighWater, total);
    log?.error(
      {
        workerTick: 'scheduler',
        phase: 'capture-reconciler',
        abandonedCount: total,
        newlyAbandonedCount: unreported.length,
        charges: unreported.map((row) => ({
          chargeId: row.id,
          ownerId: row.ownerId,
          cohortId: row.cohortId,
          dogId: row.dogId,
          amountCents: row.amountCents,
          paymentIntentId: row.stripePaymentIntentId,
        })),
      },
      'ABANDONED ENROLLMENT HOLDS: these dogs are enrolled, their authorizations have resisted capture for over a day, and this phase has stopped trying — the money will NOT collect itself and a card authorization expires on its own within about a week; capture or re-charge the listed PaymentIntents by hand in Stripe, or withdraw the dogs',
    );
  } else if (uncollected.length > alarmedUncollectedHighWater) {
    // Nothing NEW to name by row, but the UNCOLLECTED population grew — the
    // page is full of rows this process already announced. Say so once per
    // increase, and only for money: the arm below owns everything else.
    const previouslyAnnounced = alarmedUncollectedHighWater;
    alarmedUncollectedHighWater = uncollected.length;
    alarmedAbandonedTotalHighWater = Math.max(alarmedAbandonedTotalHighWater, total);
    log?.error(
      {
        workerTick: 'scheduler',
        phase: 'capture-reconciler',
        abandonedCount: total,
        uncollectedCount: uncollected.length,
        previouslyAnnounced,
        newlyUncollectedCount: uncollected.length - previouslyAnnounced,
      },
      "MORE UNCOLLECTED ABANDONED ENROLLMENT HOLDS than this process has named: the report page cannot show them, so list them with: SELECT * FROM charges WHERE purpose='group-class' AND status='requires_payment' AND stripe_payment_intent_id IS NOT NULL ORDER BY created_at ASC",
    );
  } else if (total > alarmedAbandonedTotalHighWater) {
    // The population grew and NONE of the growth we can see is money. The
    // ordinary producer is the invoice lane (`chargesRepository.ts:290-296`):
    // a `POST /invoices/:id/pay` writes a group-class `requires_payment` row
    // on an automatic-capture intent it then cancels, and that row is
    // bookkeeping for the rest of its life. It ages past 24h like anything
    // else. Counted, said once, and said at INFO — an ERROR here is an ERROR
    // no one can act on, and those are what bury the one above.
    const previouslyAnnounced = alarmedAbandonedTotalHighWater;
    alarmedAbandonedTotalHighWater = total;
    log?.info(
      {
        workerTick: 'scheduler',
        phase: 'capture-reconciler',
        abandonedCount: total,
        uncollectedCount: uncollected.length,
        previouslyAnnounced,
        newlyAbandonedCount: total - previouslyAnnounced,
      },
      'abandoned enrollment-hold rows grew, and none of the growth is money this phase can see uncollected — bookkeeping (an invoice-lane row, a withdrawn dog, or money already taken on another charge). No action; prune at leisure',
    );
  }

  return {
    total,
    truncated: total > rows.length,
    uncollected: uncollected.length,
  };
}

/**
 * The abandon report's money question — the same one {@link reconcileOne} asks
 * before it pages a human, asked of a row nobody is going to work.
 *
 * **Row-scoped since §A3.17**: uncollected iff THIS row's own enrollment is
 * live AND that enrollment owes. A superseded stray — the withdrawn
 * enrollment's hold, aged past the window while its owner re-enrolled — is
 * bookkeeping, not money a human can go and collect. Counting it as
 * uncollected put an un-actionable row into the one alarm that means "go and
 * collect money", which is how that alarm stops being read.
 */
async function isUncollected(row: RowIdentity): Promise<boolean> {
  const state = await readRowMoneyState(row);
  return state.rowEnrollmentLive && state.owed;
}

/** Everything an arm needs to know about one worklist row's enrollment. */
interface RowIdentity {
  /** Excluded from the "collected elsewhere" question — see §A3.19 F1. */
  id: string;
  cohortId: string;
  dogId: string;
  bookingId: string | null;
  /** DB microseconds (§A3.18 D3) — never a `Date`, never a string compare. */
  createdAtUs: string;
}

/**
 * The two questions every arm asks, answered together in ONE transaction off
 * ONE read of the live booking set (ADDENDUM 3 §A3.17).
 *
 * They are genuinely different questions and conflating them was the R4-3
 * defect:
 *
 *   - **`rowEnrollmentLive`** — is the enrollment THIS CHARGE belongs to still
 *     live? Stamped rows: the anchor is in the live set. Legacy rows: minted at
 *     or after the live set's birth. No live set at all ⇒ false.
 *   - **`owed`** — does the dog's CURRENT enrollment still owe us money?
 *
 * A row can be dead while the dog owes (a stray hold from a withdrawn
 * enrollment beside a re-enrollment that has not paid) and live while nothing
 * is owed (the ordinary withdrawn-and-settled case). Every arm below asks the
 * ROW-SCOPED one first, because "may we take this money" is a question about
 * the money's own enrollment, not about the dog's current balance.
 */
async function readRowMoneyState(row: RowIdentity): Promise<RowMoneyState> {
  return withActor(WORKER_ACTOR, async (tx) => {
    const liveBookings = await bookingsRepository.findLiveBookingsForCohortDog(
      tx,
      row.cohortId,
      row.dogId,
    );
    const enrollment = enrollmentIdentityOf(liveBookings);
    const openInvoice =
      enrollment === undefined
        ? undefined
        : await invoicesRepository.findOpenForCohortDog(tx, {
            cohortId: row.cohortId,
            dogId: row.dogId,
          });
    return {
      rowEnrollmentLive: chargeBelongsToEnrollment(row, enrollment),
      owed: await enrollmentStillOwesMoney(tx, row, enrollment, openInvoice),
      openInvoice,
      enrollment,
    };
  });
}

/**
 * The state, plus **why** nothing is owed — because the disposition of money
 * in hand depends on it (§A3.19 F1). `rowEnrollmentLive` implies live bookings,
 * so `!owed` is exhaustive by construction: either an OPEN INVOICE covers the
 * class, or the money was COLLECTED ELSEWHERE on another charge. Those mean
 * opposite things, and the build treated them alike.
 */
interface RowMoneyState {
  rowEnrollmentLive: boolean;
  owed: boolean;
  /** The not-owed SOURCE, when it is an invoice. */
  openInvoice: InvoiceRow | undefined;
  enrollment: EnrollmentIdentity | undefined;
}

async function reconcileOne(
  stripe: StripeClient,
  row: {
    id: string;
    ownerId: string;
    amountCents: number;
    stripePaymentIntentId: string;
    cohortId: string;
    dogId: string;
    bookingId: string | null;
    createdAtUs: string;
  },
  log: WorkerLogger | undefined,
): Promise<CaptureReconcileOutcome> {
  let live;
  try {
    live = await stripe.retrievePaymentIntent(row.stripePaymentIntentId);
  } catch (err) {
    log?.error(
      {
        workerTick: 'scheduler',
        phase: 'capture-reconciler',
        chargeId: row.id,
        paymentIntentId: row.stripePaymentIntentId,
        err: err instanceof Error ? err.message : String(err),
      },
      'capture-reconciler could not read a PaymentIntent; will retry next tick',
    );
    return 'still-failing';
  }

  if (live.status === 'succeeded') {
    // The money already moved. Writing the flip is the whole remaining job —
    // and doing it here rather than re-capturing is what keeps one enrollment
    // to one capture.
    await flipToSucceeded(row.id);
    // …and THEN the question the round-3 blocker showed this arm never asked:
    // is there still an enrollment behind this money? (§A3.3.2)
    return settlePostWithdrawRefund(stripe, row, log);
  }

  if (live.status === 'requires_capture') {
    // ── The capture precondition (§A3.3.1, respecified §A3.17) ──────────
    // Ask the money question BEFORE capturing, not after. Under manual
    // capture a `requires_capture` row is a LIVE HOLD, and the round-3
    // blocker was this arm capturing one for a dog with zero live bookings:
    // money taken for a class we are not delivering, reported as an ordinary
    // `'captured'`, with no verb able to recover it.
    //
    // TWO questions now, in this order, because §A3.16's single one could not
    // tell one enrollment from another:
    //
    //   (i)  THIS ROW's enrollment is gone ⇒ RELEASE, never capture, no matter
    //        what the dog's current enrollment owes. Without it, a withdraw
    //        that left a `release_pending` hold behind had that hold captured
    //        the moment the owner re-enrolled and failed a capture — the
    //        current enrollment genuinely owed, so both rows read "owed" and
    //        the tick collected TWICE for one class.
    //   (ii) it IS the current enrollment's row ⇒ capture iff that enrollment
    //        still owes, exactly as before.
    const state = await readRowMoneyState(row);
    if (!state.rowEnrollmentLive || !state.owed) return releaseUnowedHold(stripe, row, log);

    try {
      await stripe.capturePaymentIntent(row.stripePaymentIntentId, reconcileCaptureKey(row.id));
    } catch (err) {
      log?.error(
        {
          workerTick: 'scheduler',
          phase: 'capture-reconciler',
          chargeId: row.id,
          paymentIntentId: row.stripePaymentIntentId,
          err: err instanceof Error ? err.message : String(err),
        },
        'capture-reconciler capture failed; the hold is intact and will be retried next tick',
      );
      return 'still-failing';
    }
    await flipToSucceeded(row.id);
    return 'captured';
  }

  if (live.status !== 'canceled') {
    // Not ours, or not settled yet. Silent by design — see the module doc.
    return 'not-capturable';
  }

  // The hold is gone. Whether that MATTERS is a money question, and it is
  // asked as one below — row-scoped first (§A3.17). A cancelled hold belonging
  // to a WITHDRAWN enrollment is nothing to page about however much the dog's
  // current enrollment owes: that debt has its own row, and the tick that
  // reaches it will say so. Paging here instead was a transient false alarm
  // decided by nothing but worklist order.
  const state = await readRowMoneyState(row);

  if (!state.rowEnrollmentLive || !state.owed) return 'released';

  if (!ALARMED_CHARGE_IDS.has(row.id)) {
    ALARMED_CHARGE_IDS.add(row.id);
    log?.error(
      {
        workerTick: 'scheduler',
        phase: 'capture-reconciler',
        chargeId: row.id,
        paymentIntentId: row.stripePaymentIntentId,
        cohortId: row.cohortId,
        dogId: row.dogId,
        ownerId: row.ownerId,
        amountCents: row.amountCents,
      },
      'LOST HOLD: a dog is enrolled in a group class and its authorization is CANCELLED — this enrollment will never be charged unless a human collects it (charge the owner in Stripe, or withdraw the dog)',
    );
  }
  return 'lost-hold';
}

/**
 * Release a live hold that nothing owes (§A3.3.1) — the ordinary end of a
 * withdraw whose payment was still `processing`, and the backstop for any
 * withdraw path ADDENDUM 3 missed.
 *
 * The cancel is resolved against live truth rather than trusted or swallowed
 * ({@link cancelAndConfirm}, shared with the withdraw arm so the two cannot
 * read the same race differently). Three answers:
 *
 *   - cancelled ⇒ the hold is released, the row flips `'failed'` — the
 *     established canceled→failed mapping, which ALSO ends this phase's claim
 *     on the row (its worklist predicate is `status='requires_payment'`).
 *   - a capture won the race ⇒ the money moved for an enrollment that is gone,
 *     which is precisely the succeeded arm's business: flip and refund.
 *   - anything unreadable ⇒ `'still-failing'`, retried next tick. **A capture
 *     is never attempted on a not-owed row**, not even after a failed cancel.
 */
async function releaseUnowedHold(
  stripe: StripeClient,
  row: {
    id: string;
    ownerId: string;
    amountCents: number;
    stripePaymentIntentId: string;
    cohortId: string;
    dogId: string;
    bookingId: string | null;
    createdAtUs: string;
  },
  log: WorkerLogger | undefined,
): Promise<CaptureReconcileOutcome> {
  let resolved;
  try {
    resolved = await cancelAndConfirm({
      stripe,
      paymentIntentId: row.stripePaymentIntentId,
    });
  } catch (err) {
    log?.error(
      {
        workerTick: 'scheduler',
        phase: 'capture-reconciler',
        chargeId: row.id,
        paymentIntentId: row.stripePaymentIntentId,
        err: err instanceof Error ? err.message : String(err),
      },
      'capture-reconciler could not release a hold nothing owes; the hold is intact, no money moved, and the next tick tries again',
    );
    return 'still-failing';
  }

  if (resolved.kind === 'captured') {
    // OUR release lost the race. The disposition is state-scoped (§A3.19 F1),
    // so this caller and the succeeded-at-retrieve one reach the same answer.
    await flipToSucceeded(row.id);
    return settlePostWithdrawRefund(stripe, row, log);
  }
  if (resolved.kind === 'processing') {
    // Stripe refuses to cancel a `processing` intent. It cannot capture itself
    // either, so the row stays claimed and the next tick asks again — which is
    // exactly what the withdraw's `release_pending` promise depends on.
    return 'still-failing';
  }

  await withActor(WORKER_ACTOR, (tx) =>
    chargesRepository.markStatus(tx, {
      id: row.id,
      status: stripeIntentStatusToChargeStatus('canceled'),
    }),
  );
  log?.info(
    {
      workerTick: 'scheduler',
      phase: 'capture-reconciler',
      chargeId: row.id,
      paymentIntentId: row.stripePaymentIntentId,
      cohortId: row.cohortId,
      dogId: row.dogId,
      amountCents: row.amountCents,
    },
    // The sentence states the branch's ACTUAL basis (§A3.17.3 item 8). It used
    // to assert "the dog is not enrolled", which this branch does not know and
    // which was flatly FALSE on the R4-3 defect — an enrolled dog whose hold
    // was being cancelled because a previous enrollment's charge said the money
    // was already in hand. Three conditions reach here and the line names all
    // three.
    'capture-reconciler released an authorization nothing owes — the dog is not enrolled, the hold belongs to a withdrawn enrollment, or the current enrollment’s money is already collected or invoiced; the hold was cancelled instead of captured and the owner is charged nothing',
  );
  return 'withdrawn-released';
}

/**
 * Captured money for an enrollment that no longer exists — return it (§A3.3.2).
 *
 * Allison ruled this YES, unattended (Q-B, 2026-08-21): it is the second half
 * of "no uncertains" — the Amazon model, where a cancelled order refunds itself
 * — and the alternative is a human queue for money we already promised back in
 * the withdraw response. It is the arm that makes `release_pending` true when
 * the in-flight payment turns out to have been a capture completing.
 *
 * **Live bookings, not the full `owed` predicate.** The question here is "is
 * this enrollment gone", not "does someone owe us" — an enrolled dog with an
 * open invoice owes money and must never be refunded on this arm.
 *
 * **And "this enrollment", not "this (cohort, dog)"** (§A3.17, walk item 6 —
 * Q-E, default YES). A `release_pending` intent that resolves `succeeded`
 * AFTER the owner re-enrolled the same dog used to be KEPT
 * (`'already-captured'`), because the NEW enrollment's bookings answered for
 * the OLD charge: the withdrawn class's money silently paid for a different
 * purchase and the withdraw's own promise — "you won't pay for this class" —
 * broke. Row-scoped, the old capture refunds and the new enrollment charges
 * its own instrument. Net card movement is identical; the statement becomes
 * true.
 *
 * The R9 cap does the deduplication: a withdraw that already minted the refund
 * makes `maxRefund` zero and this arm a no-op, so the withdraw's refund leg and
 * this arm cannot both return the same money. The stored key is derived from
 * OUR refund row — by reconciler time the client's request key is long swept —
 * so the retry sweep can re-fire it forever under one spelling
 * (`designs/client-keyed-refund-recovery.md` §2.1).
 */
async function settlePostWithdrawRefund(
  stripe: StripeClient,
  row: {
    id: string;
    ownerId: string;
    amountCents: number;
    stripePaymentIntentId: string;
    cohortId: string;
    dogId: string;
    bookingId: string | null;
    createdAtUs: string;
  },
  log: WorkerLogger | undefined,
): Promise<CaptureReconcileOutcome> {
  let state = await readRowMoneyState(row);

  // ── The disposition is decided by the STATE, not by which caller found it
  //    (§A3.19 F1) ────────────────────────────────────────────────────────
  //
  // §A3.18.4 scoped this to a PRODUCER — "the reconciler itself decided
  // not-owed and its release lost the race" — and that literal scope was the
  // defect: the succeeded-at-retrieve caller reached the IDENTICAL state (row
  // live, not owed, duplicate money in hand) and returned `'already-captured'`
  // silently. Its ordinary producer is the invoice pay route's async arm, and
  // it left the covering invoice OPEN for `invoiceAutoCharge` to collect the
  // same class a second time.
  //
  // `rowEnrollmentLive` implies live bookings, so `!owed` is EXHAUSTIVE by
  // construction — an open invoice, or money collected elsewhere — and those
  // mean opposite things:
  //
  //   · **open invoice** ⇒ this is not surplus at all. It is that invoice's
  //     own payment, arrived late, and the honest thing is to SETTLE it.
  //     Refund-then-recollect is the worst statement an owner could see for a
  //     payment that simply went through.
  //   · **collected elsewhere** ⇒ a true duplicate ⇒ refund it.
  //
  // And the two states either side stand unchanged: enrollment GONE ⇒ the
  // withdraw's promised refund (§A3.3.2, Q-B); live and genuinely OWED ⇒ we
  // are entitled to it (the owed-flip protection — the state is re-read AFTER
  // the race, so a flip to owed keeps the money).
  if (state.rowEnrollmentLive && state.owed) return 'already-captured';

  if (state.rowEnrollmentLive && state.openInvoice !== undefined) {
    const settled = await settleCoveringInvoice(row, state.openInvoice, state, log);
    if (settled !== undefined) return settled;
    // The claim lost — the invoice was settled or voided in the window (R11's
    // guard). Re-read and fall into the arms that already exist.
    state = await readRowMoneyState(row);
  }

  const arm: 'post-withdraw' | 'surplus' = state.rowEnrollmentLive ? 'surplus' : 'post-withdraw';

  // The R9 cap under the charge row's LOCK (§A3.18 D2): this leg and the API
  // withdraw's refund leg were measured genuinely overlapping, both reading
  // `sumNonFailed = 0` and both committing a full refund under different keys.
  const pending = await withActor(WORKER_ACTOR, (tx) =>
    refundsRepository.mintCappedPendingRefund(tx, {
      chargeId: row.id,
      ownerId: row.ownerId,
      bookingId: null,
      reason: 'cancel',
      stripeIdempotencyKey: withdrawRefundIdempotencyKey,
    }),
  );

  if (pending.kind !== 'minted') {
    // Someone already committed to returning this money — the withdraw arm's
    // own refund leg. Nothing owed, nothing to do.
    return 'already-captured';
  }

  log?.error(
    {
      workerTick: 'scheduler',
      phase: 'capture-reconciler',
      chargeId: row.id,
      paymentIntentId: row.stripePaymentIntentId,
      cohortId: row.cohortId,
      dogId: row.dogId,
      ownerId: row.ownerId,
      amountCents: pending.amountCents,
      refundId: pending.refundId,
    },
    arm === 'surplus'
      ? 'SURPLUS REFUND: a capture completed for an enrollment this tick had already decided NOT to charge — its class is covered by an open invoice or another charge — so the money is being returned automatically; no action needed unless the refund itself keeps failing'
      : 'POST-WITHDRAW REFUND: a capture completed for a dog that is no longer enrolled, so this tick is returning the money automatically — no action needed unless the refund itself keeps failing',
  );

  await firePendingRefundPostCommit({
    pending: {
      refundId: pending.refundId,
      paymentIntentId: pending.paymentIntentId,
      amountCents: pending.amountCents,
      stripeIdempotencyKey: pending.stripeIdempotencyKey,
    },
    stripe,
    log: {
      error: (obj, msg) => log?.error(obj, msg),
    },
    context: {
      workerTick: 'scheduler',
      phase: 'capture-reconciler',
      chargeId: row.id,
      refundPath: arm === 'surplus' ? 'reconciler-surplus' : 'reconciler-post-withdraw',
    },
  });
  return arm === 'surplus' ? 'refunded-surplus' : 'refunded-post-withdraw';
}

/**
 * **The money is the open invoice's own payment, arrived late — settle it**
 * (ADDENDUM 3 §A3.19 F1, updating Q-F in place: money in hand pays the open
 * invoice; true duplicates refund themselves).
 *
 * The ordinary producer is `POST /invoices/:id/pay`'s async arm: a `processing`
 * intent survives its cancel attempt, the charge row is written at
 * `requires_payment` as audit trail stamped with the invoice's anchor, the
 * invoice is deliberately left OPEN for the owner's next attempt — and then the
 * intent succeeds anyway. Refunding that and letting `invoiceAutoCharge`
 * collect the same class again at `due_at` is the worst statement an owner
 * could see for a payment that simply went through.
 *
 * **Belt-and-braces before we settle anything**: the invoice's own anchor must
 * belong to THIS charge's enrollment. Post-D1 both are stamped, and a mismatch
 * has no ordinary producer — every withdraw voids the open invoice — so a
 * mismatch is treated as collected-elsewhere (the caller's next arm refunds it)
 * and WARN'd rather than settling a stranger's invoice with this money. The
 * §A3.19 F2 fallback resolves the invoice's anchor when it carries none, so a
 * legacy invoice is not condemned to the refund arm for lacking a stamp.
 *
 * Returns `undefined` when the atomic `markPaid` claim LOST — the invoice was
 * settled or voided inside the window (R11's guard, reused) — which tells the
 * caller to re-read the state and take the arms that already exist.
 */
async function settleCoveringInvoice(
  row: {
    id: string;
    ownerId: string;
    amountCents: number;
    cohortId: string;
    dogId: string;
    bookingId: string | null;
    createdAtUs: string;
  },
  invoice: InvoiceRow,
  state: RowMoneyState,
  log: WorkerLogger | undefined,
): Promise<CaptureReconcileOutcome | undefined> {
  const belongs = await withActor(WORKER_ACTOR, async (tx) => {
    const anchor = await resolveInvoiceAnchorBookingId(tx, invoice, {
      warn: (obj, msg) => log?.warn({ workerTick: 'scheduler', phase: 'capture-reconciler', ...obj }, msg),
    });
    return anchor !== null && (state.enrollment?.bookingIds.includes(anchor) ?? false);
  });
  if (!belongs) {
    log?.warn(
      {
        workerTick: 'scheduler',
        phase: 'capture-reconciler',
        chargeId: row.id,
        invoiceId: invoice.id,
        cohortId: row.cohortId,
        dogId: row.dogId,
      },
      'an open invoice covers this dog but does NOT belong to this charge’s enrollment, so this money is not its payment — treating it as collected elsewhere rather than settling an invoice it may not be for',
    );
    return undefined;
  }

  const claimed = await withActor(WORKER_ACTOR, (tx) =>
    claimInvoiceWithCharge(tx, {
      invoice,
      chargeId: row.id,
      amountCents: row.amountCents,
      purpose: 'group-class',
      // The owner never got an HTTP response for this settle — the worker
      // initiated it — so the receipt is the only way they learn, exactly as
      // the auto-charge lane reasons.
      notifyOwner: true,
    }),
  );
  if (!claimed) return undefined;

  log?.info(
    {
      workerTick: 'scheduler',
      phase: 'capture-reconciler',
      chargeId: row.id,
      invoiceId: invoice.id,
      cohortId: row.cohortId,
      dogId: row.dogId,
      ownerId: row.ownerId,
      amountCents: row.amountCents,
    },
    'capture-reconciler settled an open invoice with money that turned out to be its own payment arriving late — the owner is charged once, the invoice is closed, and the auto-charge lane will not bill this class again',
  );
  return 'settled-invoice';
}

/**
 * THE Stripe idempotency key for a reconciler-minted post-withdraw refund.
 * Keyed on OUR refund row's uuid, never on a client request key: by reconciler
 * time that key is swept (24h TTL) and its Stripe window is closed, and a
 * fresh-minted key on a money path is how a retry becomes a second refund.
 * Same rule, and same reason, as {@link reconcileCaptureKey} and
 * `duplicateRefundIdempotencyKey`.
 *
 * NOT a member of `STRIPE_DERIVED_KEY_SUFFIXES` (`db/mutation.ts`) — that list
 * is the suffixes appended to a CLIENT's `Idempotency-Key`, and this key is not
 * one; it is minted whole from a uuid we own, exactly like the two keys named
 * above, neither of which is in the list either.
 */
function withdrawRefundIdempotencyKey(refundId: string): string {
  return `withdraw-refund:${refundId}`;
}

/**
 * Is this (cohort, dog) an enrollment we are delivering and have NOT been paid
 * for? The predicate behind both the LOST HOLD page and the abandon report,
 * and the one that decides whether a human is called.
 *
 * Three questions, and **the third one is the money question the round-1 build
 * never asked** (ADDENDUM 1 R6). Without it, an ordinary sequence paged a
 * human about money already in the bank: pay-later enroll → owner taps Pay now
 * → 3DS or a decline (`POST /invoices/:id/pay` writes a `requires_payment`
 * group-class row and cancels the intent) → the owner retries on another card
 * and the invoice is paid. The dog is enrolled, no invoice is open, the dead
 * row's intent retrieves `canceled` — and the ONE alarm in this system that
 * means "go collect money by hand" fires for a service that was paid for.
 * Firing it wrongly is how it stops being read.
 *
 * **The third question was respecified on 2026-08-22 (ADDENDUM 3 §A3.16), and
 * this predicate is no longer only an alarm gate.** It used to read a raw
 * "is there a succeeded charge" — which answers "paid" for money already given
 * back, because a refunded charge rests at `'succeeded'` until the
 * `charge.refund.updated` webhook flips it. While the predicate merely
 * SUPPRESSED a page, reading that as "collected" was a conservative error.
 * Round 4 promoted it to the gate that decides whether a live authorization may
 * be CANCELLED (§A3.3), and the same misreading became a money defect: measured
 * end-to-end, an enrolled dog with four live bookings had its hold cancelled
 * because a fully-refunded charge from a previous enrollment still said
 * "collected". Nothing was collected, nothing alarmed.
 *
 * So the clause now consumes {@link chargesRepository.findUnsettledSucceededCharge}
 * — the SAME read the withdraw settle uses, which is the point: one function,
 * so "is this enrollment paid" cannot mean two different things in two files.
 * Money in hand means a succeeded charge with a positive unrefunded remainder,
 * not a row whose status has not caught up yet.
 *
 * **§A3.17 (2026-08-22) scoped it to ONE enrollment.** "Is this enrollment
 * paid" was still asked of a (cohort, dog), and a (cohort, dog) is not an
 * enrollment: a withdraw + re-enroll mints a second one under the same key, so
 * the previous enrollment's remainder-positive charge — a `refund_manual`
 * NULL-PI row, or a refund the bank terminally failed — answered "collected"
 * for a dog whose CURRENT class nobody had paid for. The read now takes the
 * enrollment's identity, derived here from the live booking set this function
 * already had to fetch, and passed IN rather than re-read so the two questions
 * in {@link readRowMoneyState} cannot answer off two different reads of it.
 *
 * **Δ 2026-08-24 (money-residue 1.2):** the NULL-PI example above is no longer
 * a standing source of remainder-positive rows. The withdraw's `refund_manual`
 * arm now mints a terminal `'unroutable'` refund for the remainder, which
 * `sumNonFailedForCharge` counts — so such a charge reads remainder ZERO from
 * the mint onward. The identity rule is unchanged and still load-bearing for
 * the OTHER example, a Stripe-failed refund, whose amount genuinely drops back
 * out of the cap (`ne('failed')`) until a human resolves it.
 */
async function enrollmentStillOwesMoney(
  tx: Parameters<typeof bookingsRepository.findLiveBookingsForCohortDog>[0],
  row: { id: string; cohortId: string; dogId: string },
  enrollment: EnrollmentIdentity | undefined,
  /** Read once by {@link readRowMoneyState}, which also needs it as the
   *  not-owed SOURCE — passed in so the two cannot answer off two reads. */
  openInvoice: InvoiceRow | undefined,
): Promise<boolean> {
  // Withdrawn (or never seated): nothing is owed for a class we are not
  // delivering. `undefined` identity IS the empty live set.
  if (enrollment === undefined) return false;
  // The pay-later lane will bill it; that is not this phase's money.
  if (openInvoice !== undefined) return false;
  const collected = await chargesRepository.findUnsettledSucceededCharge(tx, {
    cohortId: row.cohortId,
    dogId: row.dogId,
    enrollment,
    // NOT this row. The reconciler flips a charge to `'succeeded'` before it
    // decides what the money is for, so counting it here would let a row report
    // that its own enrollment is already paid — and the surplus arm would then
    // refund the money that pays for the class the dog is attending (§9.7b
    // caught exactly that).
    excludeChargeId: row.id,
  });
  return collected === undefined;
}

async function flipToSucceeded(chargeId: string): Promise<void> {
  await withActor(WORKER_ACTOR, (tx) =>
    chargesRepository.markStatus(tx, { id: chargeId, status: 'succeeded' }),
  );
}
