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
export const CIBUS_SHAPE: IApiDirectScrapeShape<ICibusAcct, number> = {
  stepName: 'CibusScrape',
  accountNumberOf,
  customer: CIBUS_CUSTOMER,
  balance: CIBUS_BALANCE,
  transactions: CIBUS_TXNS,
};

export default CIBUS_SHAPE;
