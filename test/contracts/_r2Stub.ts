import type {
  R2Client,
  SignPutUrlArgs,
  SignPutUrlResult,
  SignGetUrlArgs,
  HeadObjectResult,
  GetObjectBytesResult,
} from '../../src/lib/r2.js';

/**
 * In-memory `R2Client` for contract tests. Mirrors `_stripeStub` /
 * `_expoPushStub` (Day-14/16): each test that exercises the media surface
 * constructs its own stub, injects it via the route/worker's `r2` opt, and
 * asserts on `calls` + `objects` — no network, no shared mutable state.
 *
 * The stub holds a `Map<key, {contentType, bytes}>` so a `putObjectBytes`
 * followed by a `headObject(key)` reflects the same data, and the
 * derivatives-worker test can drive a sharp pipeline through real bytes
 * (a 1x1 PNG synthesized by the test) and assert on the resulting WebPs.
 *
 * Override knobs:
 *   - `setNextHeadObjectMissing()` — the next `headObject` returns null
 *     once, even if the key is in the map. Used to exercise the
 *     422 `media_upload_missing` branch on POST /media.
 *   - `throwOnNextPutObject()` — the next `putObjectBytes` rejects with a
 *     transport-failure-shaped Error. Used by the derivatives worker test
 *     to confirm a failure flips the job row to `'failed'` + records
 *     `last_error`, and the source asset stays usable.
 *   - `throwOnPutObjectAfter(n)` — the (n+1)th `putObjectBytes` rejects
 *     (i.e. the first `n` succeed). Used to exercise mid-pipeline failures
 *     where some derivatives land in R2 before the worker errors — the
 *     job parks at `'failed'`, the source row stays at `derivatives = []`
 *     (no half-populated manifest), and the partial R2 objects become
 *     Day-20-cleanup-sweep candidates.
 *   - `seedObject({key, contentType, bytes})` — pre-populate the bucket
 *     with bytes (used by the worker test to seed a source image without
 *     going through the route).
 */

export interface R2StubObject {
  contentType: string;
  bytes: Uint8Array;
}

export interface R2StubCall {
  method: 'signPutUrl' | 'signGetUrl' | 'headObject' | 'getObjectBytes' | 'putObjectBytes';
  key: string;
  contentType?: string;
}

export interface R2Stub extends R2Client {
  readonly calls: R2StubCall[];
  readonly objects: Map<string, R2StubObject>;
  setNextHeadObjectMissing(): void;
  throwOnNextPutObject(): void;
  throwOnPutObjectAfter(n: number): void;
  seedObject(args: { key: string; contentType: string; bytes: Uint8Array }): void;
}

export function makeR2Stub(): R2Stub {
  const calls: R2StubCall[] = [];
  const objects = new Map<string, R2StubObject>();
  let nextHeadMissing = false;
  let nextPutThrows = false;
  /** -1 = disabled; otherwise the count of remaining successful puts before
   *  the next put rejects. Decremented on every put. */
  let putsUntilThrow = -1;

  return {
    calls,
    objects,
    setNextHeadObjectMissing() {
      nextHeadMissing = true;
    },
    throwOnNextPutObject() {
      nextPutThrows = true;
    },
    throwOnPutObjectAfter(n) {
      putsUntilThrow = n;
    },
    seedObject({ key, contentType, bytes }) {
      objects.set(key, { contentType, bytes });
    },

    async signPutUrl(args: SignPutUrlArgs): Promise<SignPutUrlResult> {
      calls.push({ method: 'signPutUrl', key: args.key, contentType: args.contentType });
      return {
        url: `https://stub.r2.invalid/${args.key}?signed=put&expires=${args.expiresSeconds}`,
        headers: { 'Content-Type': args.contentType },
      };
    },

    async signGetUrl(args: SignGetUrlArgs): Promise<string> {
      calls.push({ method: 'signGetUrl', key: args.key });
      return `https://stub.r2.invalid/${args.key}?signed=get&expires=${args.expiresSeconds}`;
    },

    async headObject({ key }): Promise<HeadObjectResult | null> {
      calls.push({ method: 'headObject', key });
      if (nextHeadMissing) {
        nextHeadMissing = false;
        return null;
      }
      const obj = objects.get(key);
      if (obj === undefined) return null;
      return {
        bytes: obj.bytes.byteLength,
        contentType: obj.contentType,
        etag: `stub-etag-${key.length}`,
      };
    },

    async getObjectBytes({ key }): Promise<GetObjectBytesResult> {
      calls.push({ method: 'getObjectBytes', key });
      const obj = objects.get(key);
      if (obj === undefined) {
        throw new Error(`stub: no object at ${key}`);
      }
      return { bytes: obj.bytes, contentType: obj.contentType };
    },

    async putObjectBytes({ key, contentType, bytes }): Promise<void> {
      calls.push({ method: 'putObjectBytes', key, contentType });
      if (nextPutThrows) {
        nextPutThrows = false;
        throw new Error('stub: simulated R2 putObject transport failure');
      }
      if (putsUntilThrow >= 0) {
        if (putsUntilThrow === 0) {
          putsUntilThrow = -1;
          throw new Error('stub: simulated R2 putObject mid-pipeline failure');
        }
        putsUntilThrow -= 1;
      }
      objects.set(key, { contentType, bytes });
    },
  };
}
