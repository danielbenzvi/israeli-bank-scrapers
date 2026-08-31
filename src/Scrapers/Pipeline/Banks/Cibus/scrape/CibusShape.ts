/**
 * Cibus (Pluxee) scrape shape — the single `IApiDirectScrapeShape` the browser
 * Cibus pipeline plugs into the ApiDirectScrape driver.
 *
 * Zero logic here: the customer step resolves the one benefit account locally,
 * the balance step reads the allowance from its own verb, and the transactions
 * step walks the scrape window month by month. All three post to the provider's
 * single verb-dispatched endpoint.
 */

import type { IApiDirectScrapeShape } from '../../../Phases/ApiDirectScrape/IApiDirectScrapeShape.js';
import { type ICibusDeal, toDealExtra, toIsoDate } from './CibusMapping.js';
import { CIBUS_BALANCE, CIBUS_CUSTOMER } from './CibusShapeAccounts.js';
import type { ICibusAcct } from './CibusShapeHelpers.js';
import { CIBUS_TXNS } from './CibusShapeTxns.js';

/**
 * User-facing account number — the stable synthetic label, never the
 * provider's own card identifier.
 * @param acct - Resolved Cibus account.
 * @returns Account id string.
 */
function accountNumberOf(acct: ICibusAcct): string {
  return acct.id;
}

/** Cibus benefit-portal scrape shape. */
/**
 * The provider bag for one purchase row.
 *
 * Declared so the shared mapper carries the employer / out-of-pocket split
 * onto the transaction: no Well-Known alias can reach a per-provider bag.
 * @param row - One raw purchase row, as the shape extracted it.
 * @returns The funding split, for `providerExtra`.
 */
function dealExtraOf(row: object): Readonly<Record<string, unknown>> {
  return toDealExtra(row as ICibusDeal);
}

/**
 * The purchase day for one row, as the provider stated it.
 *
 * Converted here, where `DD/MM/YYYY` is known to be day-first — the shared
 * coercion would re-emit it as a UTC instant and lose the calendar day.
 * @param row - One raw purchase row.
 * @returns The purchase date as `YYYY-MM-DD`.
 */
function dealDateOf(row: object): string {
  return toIsoDate((row as ICibusDeal).date);
}

export const CIBUS_SHAPE: IApiDirectScrapeShape<ICibusAcct, number> = {
  stepName: 'CibusScrape',
  accountNumberOf,
  providerExtraOf: dealExtraOf,
  purchaseDateOf: dealDateOf,
  customer: CIBUS_CUSTOMER,
  balance: CIBUS_BALANCE,
  transactions: CIBUS_TXNS,
};

export default CIBUS_SHAPE;
