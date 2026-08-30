/**
 * Cibus (Pluxee) scrape shape — shared constants and the account type.
 *
 * This provider multiplexes everything post-login through ONE endpoint,
 * dispatched by a `type` verb in the request body. There is no per-resource
 * URL to resolve, so every step here shares `dataUrl()` and differs only in
 * the verb it names.
 */

import { literalUrl, type WKUrlOrLiteral } from '../../../Registry/WK/UrlsWK.js';

/** The provider's single verb-dispatched data endpoint. */
const CIBUS_DATA_URL = 'https://api.consumers.pluxee.co.il/api/main.py';

/** Verb naming the purchase feed. */
export const VERB_DEALS = 'prx_user_deals';

/** Verb naming the benefit budget, which is a separate call from the feed. */
export const VERB_BUDGETS = 'prx_get_budgets';

/**
 * The one benefit account this provider exposes.
 *
 * A literal rather than anything read from the payload: the provider serves a
 * single benefit account per login and exposes no account list, so there is
 * nothing to discover. The id is a stable synthetic label, never the provider's
 * own card identifier, which is sensitive and which a consumer does not key on.
 */
export interface ICibusAcct {
  readonly id: string;
}

/** The single account, resolved without asking the provider. */
export const CIBUS_ACCOUNT: ICibusAcct = { id: 'cibus' };

/**
 * The fixed data endpoint every step posts to.
 * @returns Literal data URL.
 */
export function dataUrl(): WKUrlOrLiteral {
  return literalUrl(CIBUS_DATA_URL);
}

export { CIBUS_DATA_URL };
