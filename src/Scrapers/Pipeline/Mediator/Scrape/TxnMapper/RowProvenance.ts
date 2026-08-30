/**
 * Row provenance forwarding — what a shape recorded about a raw row.
 *
 * Extracted from TxnMapper for the same reason {@link TxnSign} was: the mapper
 * is left with pure field coercion, and each thing that decides what reaches
 * {@link ITransaction} owns its own module.
 */

import { type ApiRecord } from '../AutoMapperFacade/AutoMapperTypes.js';

/** The reserved key a shape attaches container provenance under. */
const ROW_PROVENANCE_KEY = '__rowProvenance';

/** The reserved key an enrichment attaches its per-row outcome under. */
const DETAIL_OUTCOME_KEY = '__detailOutcome';

/**
 * Forward whatever provenance a shape attached to a raw row.
 *
 * Surfaced generically: any shape that recorded where a row came from, or what
 * a per-transaction detail pass made of it, gets that back on the mapped
 * transaction. The mapper names no bank — it only forwards what it was given.
 *
 * <p>Gated on EITHER signal, never on provenance alone. Provenance is attached
 * while merging response containers, which only some shapes need; a detail
 * outcome is attached by enrichment, which any shape can run. Requiring
 * provenance silently discarded the outcome for every bank that does not
 * produce it — the enrichment ran, spent its requests against a rate-limited
 * endpoint, and its result was dropped one layer later with nothing to show
 * for it. Nothing failed and no row was lost; the work was simply invisible.
 *
 * @param raw - Raw transaction record.
 * @returns The provenance bundle, or `false` when the shape attached neither.
 */
export default function resolveRowProvenance(raw: ApiRecord): Record<string, unknown> | false {
  const provenance = raw[ROW_PROVENANCE_KEY];
  const detailOutcome = raw[DETAIL_OUTCOME_KEY];
  if (provenance === undefined && detailOutcome === undefined) return false;
  const attached = (provenance ?? {}) as Record<string, unknown>;
  return { ...attached, detailOutcome };
}
