#!/usr/bin/env node
// Stage 2 of the 24h idempotency-key-window probe (`node scripts/probe-24h-stage2.mjs`).
//
// Stage 1 (2026-08-13, see scripts/probe-24h-record.json) planted a succeeded
// test-mode PaymentIntent under a recorded key and params, and measured that a
// same-key retry REPLAYS (same PI id) and that Stripe's replay header is
// `idempotent-replayed` — not the documented `Idempotency-Replayed`. What
// nothing has measured is the claim now load-bearing in THREE places
// (IDEMPOTENCY_KEY_SAFE_WINDOW_HOURS, DUPLICATE_REFUND_ABANDON_AFTER_HOURS,
// and the verify lane's re-issue arm): that the key survives ~24 hours.
//
// This re-issues the IDENTICAL request under the recorded key, >24h later:
//   · same PI id back  → the key survived 24h: the 20h safe window has real
//     margin, and past-window parks are the conservative arm we thought.
//   · a NEW PI id      → the key expired: every "re-issue" past expiry is a
//     fresh execution, the 20h window is the only thing standing between the
//     verify lane and a second charge, and its margin should be REDUCED, not
//     relaxed. Also check whether the fresh execution double-charged the
//     probe customer (harmless in test mode; the point is to SEE it).
//
// Refuses to run before the 24h mark, and refuses non-sk_test keys.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(HERE, '..');
const require_ = createRequire(path.join(BACKEND, 'package.json'));
const Stripe = require_('stripe');

let key;
for (const f of ['.env.local', '.env']) {
  const text = fs.readFileSync(path.join(BACKEND, f), 'utf8');
  const found = (text.match(/^STRIPE_SECRET_KEY=(.+)$/m) ?? [])[1]?.trim();
  if (found && !found.includes('placeholder')) {
    key = found;
    break;
  }
}
if (!key?.startsWith('sk_test_')) {
  console.error('REFUSING: no sk_test_ key found (.env.local layered over .env)');
  process.exit(1);
}

const rec = JSON.parse(fs.readFileSync(path.join(HERE, 'probe-24h-record.json'), 'utf8'));
const readyAt = new Date(Date.parse(rec.plantedAt) + 24 * 3600e3);
if (new Date() < readyAt) {
  console.error(`REFUSING: stage 2 measures the >24h window and it is not 24h yet — run after ${readyAt.toISOString()}`);
  process.exit(1);
}

const stripe = new Stripe(key);
const intent = await stripe.paymentIntents.create(rec.params, {
  idempotencyKey: rec.idempotencyKey,
});
const headers = intent.lastResponse?.headers ?? {};
const survived = intent.id === rec.firstIntentId;
console.log(`planted:   ${rec.plantedAt} (${rec.firstIntentId})`);
console.log(`re-issued: ${new Date().toISOString()} (${intent.id})`);
console.log(`idempotent-replayed header: ${headers['idempotent-replayed'] ?? 'ABSENT'}`);
console.log(
  survived
    ? 'VERDICT: the key SURVIVED >24h — replay, same id. The 20h safe window has real margin.'
    : 'VERDICT: the key EXPIRED — fresh execution, NEW id. The 20h window is the only guard; consider REDUCING it, and record this in STATUS + both workers.',
);
if (!survived) {
  console.log('cleanup: two succeeded test-mode intents now exist for the probe customer', rec.customerId);
}
console.log(`\nEither way: record the verdict in STATUS.md, and delete probe customer ${rec.customerId} in the Stripe test dashboard when done.`);
