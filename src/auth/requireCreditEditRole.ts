import type { FastifyRequest } from 'fastify';
import { settingsRepository } from '../db/repositories/settingsRepository.js';
import { ApiError } from '../lib/errors.js';
import { passesRoleList } from '../lib/staffCapabilities.js';

/**
 * The guard on the credit editors, whose roles are data (STAFF-U07; design §2.1:2074,
 * §2.4:3079-3083): a role passes when it is `owner` or on
 * `staff.credit_hand_edit_role_list`, read at the verb so an owner's edit of the list
 * binds the next request. Any other role is 403 `credit_edit_role_required`, and a
 * non-staff principal the plain 403 `forbidden`. `capabilities.edit_credits` mirrors it
 * through the same `passesRoleList`.
 */
export async function requireCreditEditRole(request: FastifyRequest): Promise<void> {
  if (!request.principal) {
    throw new ApiError('unauthenticated', 'requireCreditEditRole used without authenticate');
  }
  if (request.principal.kind !== 'staff') {
    throw new ApiError('forbidden', 'staff role required');
  }
  const { credit_hand_edit_roles: roles } = await settingsRepository.staff();
  if (!passesRoleList(request.principal.role, roles)) {
    throw new ApiError(
      'credit_edit_role_required',
      `the ${request.principal.role} role is not on the credit edit list`,
    );
  }
}
