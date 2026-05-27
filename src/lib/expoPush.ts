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
   * same order. Throws on transport failure (network down, 5xx);
   * per-message failures surface as `status='error'` tickets.
   *
   * The scheduler currently calls this post-commit and logs-and-swallows
   * any throw — DB state is the source of truth; an undelivered push
   * doesn't invalidate the delivered-feed entry.
   */
  sendBatch(messages: ExpoPushMessage[]): Promise<ExpoPushTicket[]>;
}

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

/**
 * Default production client. POSTs to Expo's push API; expects a JSON
 * envelope `{ data: ExpoPushTicket[] }`. No retries — Day-20 will add
 * those if delivery flakiness shows up in production telemetry.
 *
 * `fetch` is Node 18+ global; no extra dependency.
 */
export const defaultExpoPushClient: ExpoPushClient = {
  async sendBatch(messages) {
    if (messages.length === 0) return [];
    const response = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        // Expo's payload-compression header — recommended in their docs for
        // multi-message batches. No SDK dependency required.
        'Accept-Encoding': 'gzip, deflate',
      },
      body: JSON.stringify(messages),
    });
    if (!response.ok) {
      throw new Error(`expo push: HTTP ${response.status} ${response.statusText}`);
    }
    const payload = (await response.json()) as { data?: ExpoPushTicket[] };
    return payload.data ?? [];
  },
};
