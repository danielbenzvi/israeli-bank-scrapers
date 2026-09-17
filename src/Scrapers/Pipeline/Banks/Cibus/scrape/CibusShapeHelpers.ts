/**
 * Cibus (Pluxee) scrape shape — shared constants and the account type.
 *
 * This provider multiplexes everything post-login through ONE endpoint,
 * dispatched by a `type` verb in the request body. There is no per-resource
 * URL to resolve, so every step here shares `dataUrl()` and differs only in
 * the verb it names.
 */

import ScraperError from '../../../../Base/ScraperError.js';
import { literalUrl, type WKUrlOrLiteral } from '../../../Registry/WK/UrlsWK.js';
import type { ICibusRefusal } from './CibusMapping.js';

/** The provider's single verb-dispatched data endpoint. */
const CIBUS_DATA_URL = 'https://api.consumers.pluxee.co.il/api/main.py';

/**
 * Client identifier the provider's own front end sends on every data call.
 *
 * NOT optional, and its absence does not fail loudly: without it the API
 * answers a valid session with an empty result rather than an error, which
 * reads as "no transactions" — a scrape that reports success and silently
 * carries nothing. Public by construction; it identifies the web client, not
 * the account.
 */
const APPLICATION_ID = 'E5D5FEF5-A05E-4C64-AEBA-BA0CECA0E402';

/**
 * Headers the provider's own front end sends on every data call.
 *
 * Sent the same way for the same reason: this endpoint answers a request that
 * merely looks unfamiliar with an empty body rather than a refusal.
 */
export const CIBUS_DATA_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Content-Type': 'application/json',
  accept: 'application/json, text/plain, */*',
  'accept-language': 'he',
  'application-id': APPLICATION_ID,
});

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
 * Reject a refused call instead of reading it as an empty payload.
 *
 * WHY A THROW AND NOT AN EMPTY PAGE. This provider answers an absent or expired
 * session with `{code, msg}` and no payload key. Read as a payload, that is
 * byte-for-byte what "this month had no purchases" looks like — so a dead
 * session reports success carrying nothing. That is the one failure the
 * household cannot see, because a month that silently went missing is
 * indistinguishable from a month that was genuinely quiet, and the spend it
 * carried is simply absent from every total.
 *
 * A zero or absent `code` is NOT a refusal: a genuinely empty month still
 * returns an empty page, exactly as before.
 *
 * The code alone is reported. The accompanying `msg` is the provider's own
 * prose about the session and has no place in a log line.
 * @param body - The response body for one call.
 * @param step - Step name, so the message says which call was refused.
 * @returns The same body, once it is established not to be a refusal.
 * @throws ScraperError when the provider refused the call.
 */
export function assertNotRefused(body: unknown, step: string): ICibusRefusal {
  const envelope = (body ?? {}) as ICibusRefusal;
  const code = envelope.code ?? 0;
  if (code === 0) return envelope;
  const why = `Cibus refused the ${step} request (code ${String(code)});`;
  throw new ScraperError(`${why} no rows were returned.`);
}

/**
 * The fixed data endpoint every step posts to.
 * @returns Literal data URL.
 */
export function dataUrl(): WKUrlOrLiteral {
  return literalUrl(CIBUS_DATA_URL);
}

export { CIBUS_DATA_URL };
