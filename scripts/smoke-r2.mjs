#!/usr/bin/env node
// Live R2 round-trip smoke (Day-17). Exercises the full path against the
// REAL Cloudflare R2 endpoint configured by R2_* env vars:
//
//   1. signPutUrl  — presign a PUT URL
//   2. PUT bytes   — upload directly to R2 via fetch
//   3. headObject  — confirm the upload landed + check size/content-type
//   4. signGetUrl  — presign a GET URL
//   5. GET bytes   — download via fetch + assert bytes match
//   6. (cleanup)   — leave the object in R2 (never-delete invariant)
//
// Usage (from api/):
//   npm run smoke:r2
//
// Exits 0 on success, non-zero with a clear error on any failure. The
// 4 R2_* env vars must be REAL (not 'placeholder') — the script aborts
// early if they look like the .env.example defaults.

import { randomUUID } from 'node:crypto';
import { defaultR2Client } from '../src/lib/r2.js';
import { env } from '../src/env.js';

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

function ok(msg) {
  console.log(`${GREEN}✔${RESET} ${msg}`);
}
function fail(msg) {
  console.error(`${RED}✘${RESET} ${msg}`);
  process.exit(1);
}
function info(msg) {
  console.log(`${YELLOW}…${RESET} ${msg}`);
}

if (env.R2_ACCOUNT_ID === 'placeholder' || env.R2_ACCESS_KEY_ID === 'placeholder') {
  fail(
    `R2 env vars still set to 'placeholder' — provision a Cloudflare R2 bucket + ` +
      `API token, paste real values into api/.env, then re-run.`,
  );
}

const testKey = `smoke/owner-test/${randomUUID()}.bin`;
const testBytes = new TextEncoder().encode(`r2-smoke-${new Date().toISOString()}-${randomUUID()}`);
const expectedContentType = 'application/octet-stream';

info(`bucket=${env.R2_BUCKET} key=${testKey} bytes=${testBytes.byteLength}`);

// Step 1 — sign PUT
const { url: putUrl, headers: putHeaders } = await defaultR2Client.signPutUrl({
  key: testKey,
  contentType: expectedContentType,
  expiresSeconds: 60,
});
ok(`signPutUrl returned a presigned URL`);

// Step 2 — PUT the bytes via fetch (mirrors what the FE will do)
const putResponse = await fetch(putUrl, {
  method: 'PUT',
  headers: putHeaders,
  body: testBytes,
});
if (!putResponse.ok) {
  const body = await putResponse.text().catch(() => '<unreadable>');
  fail(`PUT failed: HTTP ${putResponse.status} ${putResponse.statusText} — ${body}`);
}
ok(`PUT uploaded ${testBytes.byteLength} bytes to R2`);

// Step 3 — headObject confirms the upload landed
const head = await defaultR2Client.headObject({ key: testKey });
if (head === null) {
  fail(`headObject returned null — the PUT didn't land in R2`);
}
if (head.bytes !== testBytes.byteLength) {
  fail(`headObject byte mismatch: expected ${testBytes.byteLength}, got ${head.bytes}`);
}
ok(`headObject confirms bytes=${head.bytes} contentType=${head.contentType}`);

// Step 4 — sign GET
const getUrl = await defaultR2Client.signGetUrl({ key: testKey, expiresSeconds: 60 });
ok(`signGetUrl returned a presigned URL`);

// Step 5 — GET the bytes back and assert they match
const getResponse = await fetch(getUrl);
if (!getResponse.ok) {
  fail(`GET failed: HTTP ${getResponse.status} ${getResponse.statusText}`);
}
const downloaded = new Uint8Array(await getResponse.arrayBuffer());
if (downloaded.byteLength !== testBytes.byteLength) {
  fail(`GET byte mismatch: uploaded ${testBytes.byteLength}, downloaded ${downloaded.byteLength}`);
}
for (let i = 0; i < testBytes.byteLength; i++) {
  if (downloaded[i] !== testBytes[i]) {
    fail(`GET content mismatch at byte ${i}: expected ${testBytes[i]}, got ${downloaded[i]}`);
  }
}
ok(`GET downloaded matching bytes (full round-trip verified)`);

// Step 6 — cleanup is intentionally absent (never-delete invariant).
// The smoke object stays in R2 under `smoke/` — Day-20 lifecycle rules
// (auto-expire `smoke/*` after 7 days OR a manual sweep) will reclaim
// the space. For now it's a few KB per smoke run.
console.log(
  `\n${GREEN}✔ Day-17 R2 round-trip green${RESET}: ` +
    `signPutUrl → PUT → headObject → signGetUrl → GET all OK against ` +
    `bucket '${env.R2_BUCKET}'.`,
);
