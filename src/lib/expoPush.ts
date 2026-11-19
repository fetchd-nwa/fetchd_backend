/**
 * Expo Push seam. The single integration point with Expo's push service;
 * all scheduler outbound calls go through `ExpoPushClient`. Tests inject
 * the in-memory stub (`test/contracts/_expoPushStub.ts`); production
 * boots `defaultExpoPushClient` which POSTs to Expo's HTTPS endpoint.
 *
 * Dependency rule (Clean Architecture): only this file knows the Expo
 * wire format. Routes / workers / repositories consume `ExpoPushClient`
 * via DI — swap the provider (APNs direct, FCM, etc.) by replacing
 * this module's default impl; no caller changes.
 *
 * Mirrors `lib/stripe.ts` shape (Day-14): client interface + default
 * impl + result types. Day-20 may add retry/backoff at this seam when
 * push delivery reliability matters.
 */

/** What a single notification carries to one device. */
export interface ExpoPushMessage {
  /** The Expo push token registered by the device. */
  to: string;
  title: string;
  body: string;
  /** Free-form payload — the FE reads `data.deep_link_path` to route on tap. */
  data?: Record<string, string>;
  /** iOS sound — Expo accepts 'default' or null. Default is 'default'. */
  sound?: 'default' | null;
  /**
   * The app icon's badge count (O-MSG-LIVE, A2 FM1; her answer 4: her unread school
   * messages). Set only by the direct message push. ABSENT on every other push: Expo
   * sets the icon to whatever number is sent, so a `0` here would wipe her badge on
   * every booking notice.
   */
  badge?: number;
}

/**
 * What Expo returns per message. The `data.id` is Expo's receipt id we'd
 * poll for delivery status (Day-20+ observability). Today we capture it
 * for logging only; failure surfaces as `status='error'` with a message.
 */
export interface ExpoPushTicket {
  status: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: { error?: string };
}

export interface ExpoPushClient {
  /**
   * Send a batch of push messages. Returns one ticket per message in the
   * same order. Throws on transport failure (network down, 5xx, or the
   * 10 s abort); per-message failures surface as `status='error'` tickets.
   *
   * The scheduler currently calls this post-commit and logs-and-swallows
   * any throw — DB state is the source of truth; an undelivered push
   * doesn't invalidate the delivered-feed entry.
   */
  sendBatch(messages: ExpoPushMessage[]): Promise<ExpoPushTicket[]>;
}

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

/**
 * Every call to Expo is aborted after this long, the body read included (A1 D8, which
 * carries P31's design §2.9 timeout into P45). A stalled Expo then costs a staff reply's
 * push at most 10 s, and the shutdown that drains in-flight pushes is bounded by it (A2
 * FM2: Railway's drain is set to this plus 5 s).
 */
export const EXPO_PUSH_TIMEOUT_MS = 10_000;

/** What `makeExpoPushClient` can be given; production passes nothing. */
export interface ExpoPushClientDeps {
  /** Expo's endpoint; a test points it at a local fake. */
  url?: string;
  fetch?: typeof fetch;
  /** The abort timer, injectable so a test need not wait 10 s. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * The message as Expo's wire carries it. Each optional key is written only when the
 * caller set it, so an unset `badge` is ABSENT from the JSON (never `0`, never `null`)
 * and `data` (with `thread_id` when the producer stamps it) passes through as given.
 */
function toExpoWire(message: ExpoPushMessage): Record<string, unknown> {
  return {
    to: message.to,
    title: message.title,
    body: message.body,
    ...(message.sound !== undefined ? { sound: message.sound } : {}),
    ...(message.badge !== undefined ? { badge: message.badge } : {}),
    ...(message.data !== undefined ? { data: message.data } : {}),
  };
}

/**
 * A client that POSTs to Expo's push API and expects the JSON envelope
 * `{ data: ExpoPushTicket[] }`. No retries — Day-20 will add those if
 * delivery flakiness shows up in production telemetry.
 *
 * `fetch` is Node 18+ global; no extra dependency.
 */
export function makeExpoPushClient(deps: ExpoPushClientDeps = {}): ExpoPushClient {
  const url = deps.url ?? EXPO_PUSH_URL;
  const fetchFn = deps.fetch ?? fetch;
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer =
    deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  return {
    async sendBatch(messages) {
      if (messages.length === 0) return [];
      const controller = new AbortController();
      const timer = setTimer(() => {
        controller.abort(new Error(`expo push: aborted after ${EXPO_PUSH_TIMEOUT_MS} ms`));
      }, EXPO_PUSH_TIMEOUT_MS);
      try {
        const response = await fetchFn(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            // Expo's payload-compression header — recommended in their docs for
            // multi-message batches. No SDK dependency required.
            'Accept-Encoding': 'gzip, deflate',
          },
          body: JSON.stringify(messages.map(toExpoWire)),
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`expo push: HTTP ${response.status} ${response.statusText}`);
        }
        // Still inside the abort window: a body that never ends is aborted too.
        const payload = (await response.json()) as { data?: ExpoPushTicket[] };
        return payload.data ?? [];
      } finally {
        clearTimer(timer);
      }
    },
  };
}

/** Default production client: Expo's real endpoint, the real clock. */
export const defaultExpoPushClient: ExpoPushClient = makeExpoPushClient();
