import type { vets } from '../db/schema/schema.js';

/**
 * Vet wire shape per DATA-CONTRACT §B Vet. Required keys (`id`, `name`)
 * always emit; optional keys (`phone`, `email`, `address`, `notes`) follow
 * the Day-4a wire-shape convention — omit when null/empty, never emit
 * `null` for a `?`-marked field.
 *
 * Used inline by `GET /dogs` (`Dog.vet?`) and standalone by `GET /vets?q=`.
 * Extracted Day-4b at the rule-of-two; was previously inline in
 * `routes/dogs.ts`.
 */
export interface VetWire {
  id: string;
  name: string;
  phone?: string;
  email?: string;
  address?: string;
  notes?: string;
}

export function toVetWire(row: typeof vets.$inferSelect): VetWire {
  const wire: VetWire = { id: row.id, name: row.name };
  if (row.phone !== null) wire.phone = row.phone;
  if (row.email !== null) wire.email = row.email;
  if (row.address !== null) wire.address = row.address;
  if (row.notes !== null) wire.notes = row.notes;
  return wire;
}
