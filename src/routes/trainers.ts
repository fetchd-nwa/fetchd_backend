import type { FastifyInstance } from 'fastify';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import type { GetTrainersResponse, TrainerWire } from '../contracts/wire.js';
import { staffRepository } from '../db/repositories/staffRepository.js';

/**
 * `GET /trainers` `[any principal]` (wire 9.0.0; plan unit P49; design request-services-v1
 * §2.2 A9, §4.3; PL-10, PL-24, PL-27, BT-15): the trainers a family may name, or staff may
 * assign, for a private lesson or a Board & Train. Every live staffer with a lesson price
 * or Board & Train eligibility, ordered by name; `[]` when none. A staffer with neither is
 * absent: having a price is what "teaches lessons" means. Read only; the two fields are
 * written by `npm run staff:provision`'s roster (and the dev seed), never on a screen. It
 * replaces the owner app's hard-coded trainer strips.
 */
export function registerTrainersRoute(app: FastifyInstance, opts: AuthRouteOptions = {}): void {
  const authHook = resolveAuthHook(opts);

  app.get('/trainers', { preHandler: [authHook] }, async (request): Promise<GetTrainersResponse> => {
    requirePrincipal(request);
    const rows = await staffRepository.listTrainers();
    return rows.map((row): TrainerWire => ({
      staff_id: row.id,
      name: row.name,
      ...(row.lessonPriceCents !== null ? { private_lesson_price_cents: row.lessonPriceCents } : {}),
      board_and_train: row.boardTrainEligible,
    }));
  });
}
