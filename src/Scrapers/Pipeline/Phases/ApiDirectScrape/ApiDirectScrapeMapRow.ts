/**
 * Per-row mapping for the api-direct scrape.
 *
 * Split from `ApiDirectScrapeActions.ts` to keep that file inside the phase
 * overlay's line ceiling. Owns one decision: how a raw provider row becomes an
 * `ITransaction`, and what the shape is allowed to add to it.
 */

import type { ITransaction } from '../../../../Transactions.js';
import { autoMapTransaction } from '../../Mediator/Scrape/ScrapeAutoMapper.js';

/** Bundled mapping options declared by the shape. */
export interface IMapTxnsOpts {
  readonly isCardIssuer?: boolean;
  readonly providerExtraOf?: (row: object) => Readonly<Record<string, unknown>>;
  readonly purchaseDateOf?: (row: object) => string;
}

/**
 * Map one row, attaching the shape's provider bag when it declared one.
 *
 * The bag is applied to the MAPPED transaction, so it cannot overwrite a field
 * the auto-mapper owns.
 * @param raw - One raw provider row.
 * @param opts - Shape-declared mapping options.
 * @returns The transaction, or false when the mapper refused the row.
 */
export function mapOne(
  raw: Record<string, unknown>,
  opts: IMapTxnsOpts,
): ITransaction | false {
  const mapped = autoMapTransaction(raw, opts.isCardIssuer);
  if (mapped === false) return false;
  const txn = withStatedDate(mapped, raw, opts);
  if (opts.providerExtraOf === undefined) return txn;
  return { ...txn, providerExtra: opts.providerExtraOf(raw) };
}

/**
 * Restore the calendar day the shape stated, when it stated one.
 *
 * Both `date` and `processedDate` are set: a shape that knows the purchase day
 * knows it for both, and leaving one coerced would key the row two ways.
 * @param txn - The mapped transaction.
 * @param raw - The row it was mapped from.
 * @param opts - Shape-declared mapping options.
 * @returns The transaction, with the stated date when declared.
 */
function withStatedDate(
  txn: ITransaction,
  raw: Record<string, unknown>,
  opts: IMapTxnsOpts,
): ITransaction {
  if (opts.purchaseDateOf === undefined) return txn;
  const stated = opts.purchaseDateOf(raw);
  return { ...txn, date: stated, processedDate: stated };
}
