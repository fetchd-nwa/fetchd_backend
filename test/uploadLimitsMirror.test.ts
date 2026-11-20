import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_UPLOAD_BYTES as WIRE_MAX_UPLOAD_BYTES,
  UPLOAD_IMAGE_CONTENT_TYPES,
  UPLOAD_VIDEO_CONTENT_TYPES,
} from '../src/contracts/wire.js';
import {
  IMAGE_TYPES,
  MAX_UPLOAD_BYTES,
  VIDEO_TYPES,
  assertContentTypeMatchesPurpose,
} from '../src/lib/mediaKeys.js';

/**
 * Wire 9.3.0-pre.1 (build DECISIONS 863 (ii)): the media routes' limits are exported by the
 * contract, so the clients import them and `check:contracts` carries a change to them. The
 * routes themselves enforce `src/lib/mediaKeys.ts`'s copies. This file holds the two equal,
 * in both directions: a change on either side alone is red here.
 *
 * Members, not order: the routes read a Set, so the contract's array order carries nothing.
 * Sorted arrays also make a duplicate in the contract's array red (a Set holds one).
 */

const sorted = (values: Iterable<string>): string[] => [...values].sort();

test('MAX_UPLOAD_BYTES: the contract’s equals the one the media routes enforce', () => {
  assert.equal(WIRE_MAX_UPLOAD_BYTES, MAX_UPLOAD_BYTES);
  assert.equal(MAX_UPLOAD_BYTES, 25 * 1024 * 1024, '25 MB, as the contract’s doc says');
});

test('UPLOAD_IMAGE_CONTENT_TYPES: the same members as mediaKeys IMAGE_TYPES, no more, no fewer', () => {
  assert.deepEqual(sorted(UPLOAD_IMAGE_CONTENT_TYPES), sorted(IMAGE_TYPES));
});

test('UPLOAD_VIDEO_CONTENT_TYPES: the same members as mediaKeys VIDEO_TYPES, no more, no fewer', () => {
  assert.deepEqual(sorted(UPLOAD_VIDEO_CONTENT_TYPES), sorted(VIDEO_TYPES));
});

test('the sets this file compares are the ones the content-type check reads', () => {
  // A photo purpose takes every contract image type and no video; a video purpose the
  // reverse; a chat attachment either. So the sets above are not a decoy beside the check.
  for (const type of UPLOAD_IMAGE_CONTENT_TYPES) {
    assert.doesNotThrow(() => assertContentTypeMatchesPurpose('dog-profile', type), type);
    assert.doesNotThrow(() => assertContentTypeMatchesPurpose('message-attachment', type), type);
    assert.throws(() => assertContentTypeMatchesPurpose('report-video', type), type);
  }
  for (const type of UPLOAD_VIDEO_CONTENT_TYPES) {
    assert.doesNotThrow(() => assertContentTypeMatchesPurpose('report-video', type), type);
    assert.doesNotThrow(() => assertContentTypeMatchesPurpose('message-attachment', type), type);
    assert.throws(() => assertContentTypeMatchesPurpose('report-photo', type), type);
  }
  assert.throws(() => assertContentTypeMatchesPurpose('message-attachment', 'image/gif'));
});
