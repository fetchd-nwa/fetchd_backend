import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import ts from 'typescript';
import { db } from '../../src/db/client.js';
import { chargesRepository } from '../../src/db/repositories/chargesRepository.js';
import { invoicesRepository } from '../../src/db/repositories/invoicesRepository.js';
import { chargePurpose, ledgerReason, notificationType } from '../../src/db/schema/schema.js';
import type { Tx } from '../../src/db/tx.js';
import { withActor } from '../../src/db/tx.js';
import type { ChargePurpose } from '../../src/contracts/wire.js';
import { FIXTURE_IDS } from './_fixture.js';
import { SKIP_WHEN_NO_DB, registerFixtureHooks } from './_harness.js';

/**
 * Wire 5.0.0-lg4.1, M4.02: the labels that left (DECISIONS 162, ruling 3).
 *
 * Why this is the test that a returning writer trips, and not a search: `'payg'` and
 * `'membership'` can only come back through the enum, because the column refuses them
 * and the compiler refuses them. So these call the real writers with each dead label
 * and require Postgres to say no, with the surviving label through the same writer as
 * the control: a refusal for any other reason would fail the control too. Bringing a
 * label back, in `schema.sql` and Drizzle together, is exactly what turns this red.
 */

registerFixtureHooks();

const ROLLED_BACK = new Error('rolled back on purpose');

/** Run `work` in a transaction that never commits; return what Postgres said. */
async function pgCodeOf(work: (tx: Tx) => Promise<unknown>): Promise<string | undefined> {
  let code: string | undefined;
  await withActor('test:removed-labels', async (tx) => {
    try {
      await tx.transaction(async (sp) => {
        await work(sp as unknown as Tx);
      });
    } catch (err) {
      code = pgCode(err);
    }
    throw ROLLED_BACK;
  }).catch((err: unknown) => {
    if (err !== ROLLED_BACK) throw err;
  });
  return code;
}

function pgCode(err: unknown): string | undefined {
  let cursor: unknown = err;
  while (typeof cursor === 'object' && cursor !== null) {
    const candidate = cursor as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === 'string') return candidate.code;
    cursor = candidate.cause;
  }
  return undefined;
}

const INVALID_ENUM_LABEL = '22P02';

function createCharge(tx: Tx, purpose: string): Promise<unknown> {
  return chargesRepository.create(tx, {
    ownerId: FIXTURE_IDS.ownerId,
    amountCents: 1000,
    status: 'succeeded',
    purpose: purpose as ChargePurpose,
    stripePaymentIntentId: `pi_removed_label_${purpose}`,
  });
}

function createInvoice(tx: Tx, purpose: string): Promise<unknown> {
  return invoicesRepository.createOpen(tx, {
    ownerId: FIXTURE_IDS.ownerId,
    amountCents: 1000,
    purpose: purpose as ChargePurpose,
    paymentMethodId: FIXTURE_IDS.paymentMethod1Id,
    dueAt: '2026-06-01T17:00:00.000Z',
  });
}

function insertLedgerRow(tx: Tx, reason: string): Promise<unknown> {
  return tx.execute(sql`
    INSERT INTO credit_ledger (dog_id, mode, location, delta, reason)
    VALUES (${FIXTURE_IDS.dog1Id}, 'school', 'fayetteville', 1, ${reason}::ledger_reason)
  `);
}

function insertNotification(tx: Tx, type: string): Promise<unknown> {
  return tx.execute(sql`
    INSERT INTO notifications (owner_id, type, title, body)
    VALUES (${FIXTURE_IDS.ownerId}, ${type}::notification_type, 't', 'b')
  `);
}

function insertScheduledNotification(tx: Tx, type: string): Promise<unknown> {
  return tx.execute(sql`
    INSERT INTO scheduled_notifications (owner_id, type, trigger, scheduled_for, title, body)
    VALUES (${FIXTURE_IDS.ownerId}, ${type}::notification_type, 'test', now(), 't', 'b')
  `);
}

const SITES: ReadonlyArray<{
  site: string;
  write: (tx: Tx, label: string) => Promise<unknown>;
  dead: readonly string[];
  live: string;
}> = [
  {
    site: 'chargesRepository.create',
    write: createCharge,
    dead: ['payg', 'membership'],
    live: 'group-class',
  },
  {
    site: 'invoicesRepository.createOpen',
    write: createInvoice,
    dead: ['payg', 'membership'],
    live: 'group-class',
  },
  {
    site: 'credit_ledger.reason',
    write: insertLedgerRow,
    dead: ['membership-grant'],
    live: 'adjustment',
  },
  {
    site: 'notifications.type',
    write: insertNotification,
    dead: ['membership-ended', 'alumni-attendance'],
    live: 'invoice-overdue',
  },
  {
    site: 'scheduled_notifications.type',
    write: insertScheduledNotification,
    dead: ['membership-ended', 'alumni-attendance'],
    live: 'invoice-overdue',
  },
];

for (const { site, write, dead, live } of SITES) {
  test(`${site}: the database takes '${live}'`, SKIP_WHEN_NO_DB, async () => {
    assert.equal(await pgCodeOf((tx) => write(tx, live)), undefined);
  });
  for (const label of dead) {
    test(`${site}: the database refuses '${label}'`, SKIP_WHEN_NO_DB, async () => {
      assert.equal(await pgCodeOf((tx) => write(tx, label)), INVALID_ENUM_LABEL);
    });
  }
}

test(
  'the three enums hold exactly the survivors, on Drizzle and in Postgres',
  SKIP_WHEN_NO_DB,
  async () => {
    const expected = {
      charge_purpose: ['package', 'board-train', 'group-class'],
      ledger_reason: ['purchase', 'booking-debit', 'cancel-refund', 'adjustment'],
      notification_type: [
        'booking-confirmed',
        'report-published',
        'booking-cancelled',
        'announcement',
        'message-received',
        'booking-reminder',
        'boarding-profile-check',
        'credits-expiring',
        'payment-failed',
        'payment-succeeded',
        'spay-neuter-reminder',
        'payment-due',
        'invoice-overdue',
        'card-expiring',
        'waitlist-spot-open',
      ],
    };
    assert.deepEqual([...chargePurpose.enumValues], expected.charge_purpose);
    assert.deepEqual([...ledgerReason.enumValues], expected.ledger_reason);
    assert.deepEqual([...notificationType.enumValues], expected.notification_type);
    for (const [typeName, labels] of Object.entries(expected)) {
      const rows = await db.execute(sql`
      SELECT e.enumlabel
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = ${typeName}
       ORDER BY e.enumsortorder
    `);
      assert.deepEqual(
        (rows.rows as { enumlabel: string }[]).map((row) => row.enumlabel),
        labels,
        typeName,
      );
    }
  },
);

/**
 * The members of `LedgerEntryWire.kind`, read off the contract's own syntax tree.
 * `ledgerWire.ts` assigns a row's kind to this field, so a wider wire compiles quietly
 * (mutant mF in the P17 notes). `LedgerEntryWire` is the one union of this size with no
 * tuple beside it and no pgEnum behind it, so nothing else holds it.
 */
function ledgerEntryKinds(): string[] {
  const wirePath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../src/contracts/wire.ts',
  );
  const source = ts.createSourceFile(
    wirePath,
    fs.readFileSync(wirePath, 'utf8'),
    ts.ScriptTarget.ES2022,
    true,
  );
  const members: string[] = [];
  source.forEachChild((node) => {
    if (!ts.isInterfaceDeclaration(node) || node.name.text !== 'LedgerEntryWire') return;
    for (const member of node.members) {
      if (!ts.isPropertySignature(member) || member.name.getText(source) !== 'kind') continue;
      const type = member.type;
      assert.ok(type !== undefined && ts.isUnionTypeNode(type), 'kind is a union');
      for (const entry of type.types) {
        assert.ok(ts.isLiteralTypeNode(entry) && ts.isStringLiteral(entry.literal));
        members.push(entry.literal.text);
      }
    }
  });
  return members;
}

test("LedgerEntryWire.kind is 'session' | 'credit-pack' and nothing else", () => {
  assert.deepEqual(ledgerEntryKinds().sort(), ['credit-pack', 'session']);
});
