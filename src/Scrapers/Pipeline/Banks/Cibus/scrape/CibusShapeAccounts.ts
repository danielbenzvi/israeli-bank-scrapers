/**
 * Cibus (Pluxee) scrape shape — the customer and balance steps.
 *
 * The customer step asks the provider nothing: this benefit portal serves a
 * single account per login and exposes no account list, so the step declares
 * `skipFetch` and resolves the one account locally. Inventing a discovery
 * request would spend a call to learn what the login already established.
 *
 * The balance step is a real call, because the benefit allowance lives behind
 * its own verb rather than riding the purchase feed.
 */

import type {
  ApiBody,
  IApiDirectScrapeBalanceStep,
  IApiDirectScrapeCustomerStep,
  VarsMap,
} from '../../../Phases/ApiDirectScrape/IApiDirectScrapeShape.js';
import type { ICibusBudgetResponse } from './CibusMapping.js';
import { toAccountBalance } from './CibusMapping.js';
import { CIBUS_ACCOUNT, CIBUS_DATA_HEADERS, dataUrl, type ICibusAcct, VERB_BUDGETS } from './CibusShapeHelpers.js';

/**
 * No request is made, so no variables are needed.
 * @returns An empty variables map.
 */
function customerVars(): VarsMap {
  return {};
}

/**
 * The single benefit account, resolved without a provider round-trip.
 *
 * The extract arguments are ignored because `skipFetch` means nothing was
 * fetched to read: the account is a fact about the provider, not about a
 * response.
 * @returns The one account this provider serves.
 */
function extractAccounts(): readonly ICibusAcct[] {
  return [CIBUS_ACCOUNT];
}

/** Customer step — local, because the provider has no account list to ask for. */
export const CIBUS_CUSTOMER: IApiDirectScrapeCustomerStep<ICibusAcct> = {
  buildVars: customerVars,
  extractAccounts,
  skipFetch: true,
};

/**
 * Body naming the budget verb.
 * @returns Variables map POSTed as the JSON body.
 */
function balanceVars(): VarsMap {
  return { type: VERB_BUDGETS };
}

/**
 * Read the remaining benefit from the budget envelope.
 *
 * `data` is an ARRAY and the current period is its first entry; an absent or
 * empty array is the provider saying the period is not provisioned, which is a
 * legitimate state. That resolves to 0 here because the step must return a
 * number — `fallbackOnFail` covers the case where the call itself failed, which
 * is a different thing and must stay distinguishable.
 * @param body - The budget response body.
 * @returns The current balance, or 0 when the period carries none.
 */
function extractBalance(body: ApiBody): number {
  const envelope = body as ICibusBudgetResponse;
  const current = envelope.data?.[0] ?? {};
  return toAccountBalance(current).balance ?? 0;
}

/** Balance step — the benefit allowance, behind its own verb. */
export const CIBUS_BALANCE: IApiDirectScrapeBalanceStep<ICibusAcct> = {
  buildVars: balanceVars,
  extract: extractBalance,
  urlTag: dataUrl,
  method: 'POST',
  extraHeaders: CIBUS_DATA_HEADERS,
  fallbackOnFail: 0,
};
