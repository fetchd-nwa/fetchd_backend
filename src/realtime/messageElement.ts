import type { R2Client } from '../lib/r2.js';
import { wireManyMessages } from '../lib/wireManyThreads.js';
import type { MessageElementFor } from './frames.js';

/**
 * The `message.created` element builder (pass 3 item 1's seam, wired in phase F): the function
 * both GETs call, `wireManyMessages(rows, r2, audience)` (`GET /threads/:id/messages` with
 * `'owner'`, `GET /staff/threads/:id/messages` with `'staff'`), on one row, with the routes'
 * R2 client. So a frame's `message` is exactly the element the reader's own GET returns:
 * `client_message_id` and `receipt` on her own side only, staff names as her side reads them,
 * signed attachment URLs, and never `reach` (B15, CR33). `buildApp()` passes
 * `defaultR2Client`, as its routes use; a test passes its R2 stub.
 */
export function messageElementFromGet(r2: R2Client): MessageElementFor {
  return async (row, audience) => {
    const [element] = await wireManyMessages([row], r2, audience);
    if (element === undefined) throw new Error(`message ${row.id}: no element was built`);
    return element;
  };
}
