import type { FastifyInstance } from 'fastify';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  agreementDocuments,
  agreementSignatures,
  type serviceCategory,
} from '../db/schema/schema.js';
import { requirePrincipal, resolveAuthHook, type AuthRouteOptions } from '../auth/plugin.js';
import { live } from '../db/softExpire.js';
import { pgTimestampToIso } from '../lib/pgTimestamp.js';

/**
 * `GET /agreements` `[auth]` — the catalog of required waivers/policies plus
 * a per-owner derivation of whether the owner has signed the **current
 * version** of each (DATA-CONTRACT §C agreements + §H agreement gate).
 *
 * Query: live `agreement_documents` LEFT JOIN `agreement_signatures` ON
 * `(document_key, version, owner_id) = (key, current_version, principal)`.
 * The join is to `current_version` specifically — an older signature exists
 * but doesn't satisfy the gate; the wire reflects that as
 * `signed_version: null`. Signatures are append-only (`agreement_documents`'s
 * `current_version` bumps create a new requirement; the old signature stays
 * on disk for the audit trail but the wire surfaces only the current-version
 * status).
 *
 * Wire shape (locked Day 4b — §C describes the semantics but does not
 * byte-freeze):
 *   { key, label, current_version, required, applies_to: ServiceCategory[],
 *     signed_version: number | null, signed_at: ISO | null }
 *
 * Staff principals get an empty list. The catalog is owner-facing (waiver
 * signing is an owner action); the Day-19 staff portal's 4 verbs don't
 * touch it. Revisit if the portal adds a "see who hasn't signed" view.
 */

type ServiceCategory = (typeof serviceCategory.enumValues)[number];

interface AgreementWire {
  key: string;
  label: string;
  current_version: number;
  required: boolean;
  applies_to: ServiceCategory[];
  signed_version: number | null;
  signed_at: string | null;
}

export function registerAgreementsRoute(app: FastifyInstance, opts: AuthRouteOptions = {}): void {
  const authHook = resolveAuthHook(opts);

  app.get('/agreements', { preHandler: [authHook] }, async (request): Promise<AgreementWire[]> => {
    const principal = requirePrincipal(request);
    if (principal.kind !== 'owner') {
      return [];
    }

    const rows = await db
      .select({ doc: agreementDocuments, sig: agreementSignatures })
      .from(agreementDocuments)
      .leftJoin(
        agreementSignatures,
        and(
          eq(agreementSignatures.documentKey, agreementDocuments.key),
          eq(agreementSignatures.version, agreementDocuments.currentVersion),
          eq(agreementSignatures.ownerId, principal.ownerId),
        ),
      )
      .where(live(agreementDocuments))
      .orderBy(asc(agreementDocuments.key));

    return rows.map(({ doc, sig }) => ({
      key: doc.key,
      label: doc.label,
      current_version: doc.currentVersion,
      required: doc.required,
      applies_to: doc.appliesTo,
      signed_version: sig ? sig.version : null,
      signed_at: sig ? pgTimestampToIso(sig.signedAt) : null,
    }));
  });
}
