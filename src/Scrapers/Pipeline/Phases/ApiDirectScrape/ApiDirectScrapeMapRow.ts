/**
 * Per-row mapping for the api-direct scrape.
 *
 * Split from `ApiDirectScrapeActions.ts` to keep that file inside the phase
 * overlay's line ceiling. Owns one decision: how a raw provider row becomes an
 * `ITransaction`, and what the shape is allowed to add to it.
 */

import type { ITransaction } from '../../../../Transactions.js';
import { autoMapTransaction } from '../../Mediator/Scrape/ScrapeAutoMapper.js';

/** The four money fields a shape may resolve for itself. */
export interface IShapeAmounts {
  readonly chargedAmount: number;
  readonly originalAmount: number;
  /** `''` when the provider stated no billing currency. */
  readonly chargedCurrency: string;
  /** `''` when the provider stated no transaction currency. */
  readonly originalCurrency: string;
}

/** Bundled mapping options declared by the shape. */
export interface IMapTxnsOpts {
  readonly isCardIssuer?: boolean;
  readonly providerExtraOf?: (row: object) => Readonly<Record<string, unknown>>;
  readonly purchaseDateOf?: (row: object) => string;
  readonly amountsOf?: (row: object) => IShapeAmounts;
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
export function mapOne(raw: Record<string, unknown>, opts: IMapTxnsOpts): ITransaction | false {
  const mapped = autoMapTransaction(raw, opts.isCardIssuer);
  if (mapped === false) return false;
  const priced = withStatedAmounts(mapped, raw, opts);
  const txn = withStatedDate(priced, raw, opts);
  if (opts.providerExtraOf === undefined) return txn;
  return { ...txn, providerExtra: opts.providerExtraOf(raw) };
}

/**
 * Take the money fields the shape resolved, when it resolves them itself.
 *
 * All four move together on purpose. A provider whose billed and original
 * amounts come from different fields needs both replaced, and replacing only
 * one leaves the other resolving through the shared alias list — which, for at
 * least one provider, reads the very field the shape had just claimed for the
 * other role. One return value makes that mistake unexpressible.
 * @param txn - The mapped transaction.
 * @param raw - The row it was mapped from.
 * @param opts - Shape-declared mapping options.
 * @returns The transaction, with the shape's own amounts when declared.
 */
function withStatedAmounts(
  txn: ITransaction,
  raw: Record<string, unknown>,
  opts: IMapTxnsOpts,
): ITransaction {
  if (opts.amountsOf === undefined) return txn;
  const { chargedAmount, originalAmount, chargedCurrency, originalCurrency } = opts.amountsOf(raw);
  // An empty currency means the provider stated none, so the mapper's own value
  // stands rather than having one invented — inventing one is the class of
  // guess this hook exists to remove.
  const original = originalCurrency === '' ? {} : { originalCurrency };
  const charged = chargedCurrency === '' ? {} : { chargedCurrency };
  return { ...txn, chargedAmount, originalAmount, ...charged, ...original };
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
