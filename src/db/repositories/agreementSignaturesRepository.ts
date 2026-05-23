import { sql } from 'drizzle-orm';
import { agreementDocuments, agreementSignatures } from '../schema/schema.js';
import type { ServiceCategory } from '../../lib/bookingBucket.js';
import type { Tx } from '../tx.js';

/**
 * Data-access seam for `agreement_signatures` (schema.sql:813). Append-
 * only by design — re-signing a new version creates a new row; no edits,
 * no soft-expire, no `expired_at` column, intentionally excluded from
 * the audit trigger (the row IS the audit trail).
 *
 * Day 10 introduces the first read here — the agreement-gate pre-check
 * during `bookSession`. The trigger `bookings_agreement_guard`
 * (schema.sql:1272) is the unbypassable floor; this pre-check exists so
 * the typical "owner hasn't signed the waiver" path surfaces a friendly
 * `agreement_unsigned` 422 with structured `details.missing` from the
 * route layer instead of a generic check_violation 422.
 *
 * The unique-write side (POST /agreements/:key/sign) lives in a
 * different layer (Day 4b read-only `agreements.ts` route gains its
 * write-half later). Today: read-only access to support the gate.
 */

export const agreementSignaturesRepository = {
  /**
   * Return the list of required `agreement_documents` rows that apply to
   * `category` for which the owner does NOT have a signature at the
   * document's `current_version`. Empty array ⇒ all required agreements
   * are signed.
   *
   * Mirrors `assert_agreements_signed` (schema.sql:1242-1270): live docs
   * only, required=true only, `applies_to` filter is "empty array = all
   * categories OR includes this category." The route consumes the result
   * to build typed `AgreementGap[]` entries.
   *
   * Owner-scoped — no dog axis. Agreement signatures are an owner-level
   * legal fact; signing once covers every dog the owner books.
   */
  async findMissingForOwnerCategory(
    tx: Tx,
    ownerId: string,
    category: ServiceCategory,
  ): Promise<{ document_key: string; label: string }[]> {
    const rows = await tx.execute(sql`
      SELECT ad.key AS document_key, ad.label AS label
      FROM ${agreementDocuments} ad
      WHERE ad.expired_at IS NULL
        AND ad.required = true
        AND (
          cardinality(ad.applies_to) = 0
          OR ${category}::service_category = ANY (ad.applies_to)
        )
        AND NOT EXISTS (
          SELECT 1
          FROM ${agreementSignatures} s
          WHERE s.owner_id = ${ownerId}
            AND s.document_key = ad.key
            AND s.version = ad.current_version
        )
      ORDER BY ad.key ASC
    `);
    return (rows.rows as { document_key: string; label: string }[]).map((r) => ({
      document_key: r.document_key,
      label: r.label,
    }));
  },
};
