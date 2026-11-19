import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolvePrincipalById, type MirrorPrincipal } from '../../src/auth/mirror.js';
import { livePrincipalsAmong } from '../../src/realtime/frames.js';
import { FIXTURE_IDS } from './_fixture.js';
import { readSchoolAccount, registerFixtureHooks } from './_harness.js';

/**
 * The socket's two principal reads filter staff through pass 1's `livePrincipal()`
 * (`staffRepository.ts`: live AND NOT `is_system_account`; rs3 M5.26, design §2.9:4554), so
 * the school's system row, *NWA School for Dogs*, is never a principal on the socket
 * (integration stage 0; MB13 H3, MB23 item 12, which had no direct red test):
 *   · `resolvePrincipalById`: the end of both auth arms, every heartbeat, every inbound
 *     `typing`/`ack` (A2 OM5);
 *   · `livePrincipalsAmong`: OM2's one liveness query at delivery (LR16: with the row's role).
 * Each is called directly with the system row's own id, read by its flag through the harness
 * (`readSchoolAccount`, never a hard-coded id, never inserted). A live staffer beside it is the
 * control: it comes back, with its row's role, so an empty answer is the filter's and not a
 * read that sees nothing.
 */

registerFixtureHooks();

const RACHEL = FIXTURE_IDS.staffRachelId;
const OWNER_A = FIXTURE_IDS.ownerId;

function byKey(list: readonly MirrorPrincipal[]): MirrorPrincipal[] {
  return [...list].sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
}

test('resolvePrincipalById: the system row is null; a live staffer (control) resolves with its row role', async () => {
  const school = await readSchoolAccount();
  assert.equal(await resolvePrincipalById({ kind: 'staff', id: school.id }), null);
  assert.deepEqual(await resolvePrincipalById({ kind: 'staff', id: RACHEL }), {
    kind: 'staff',
    id: RACHEL,
    role: 'trainer',
  });
});

test('livePrincipalsAmong: the system row is never returned, alone or beside live principals (control)', async () => {
  const school = await readSchoolAccount();
  // The system row's role is `trainer` (rs3 M5.26), so this is the claim a socket would carry.
  const system: MirrorPrincipal = { kind: 'staff', id: school.id, role: 'trainer' };
  assert.deepEqual(await livePrincipalsAmong([system]), []);

  const rachel: MirrorPrincipal = { kind: 'staff', id: RACHEL, role: 'trainer' };
  const owner: MirrorPrincipal = { kind: 'owner', id: OWNER_A };
  assert.deepEqual(
    byKey(await livePrincipalsAmong([system, rachel, owner])),
    byKey([rachel, owner]),
  );
});
