/**
 * Amex scrape shape — the `enrichRows` hook.
 *
 * Adapts the generic hook the driver calls to the detail loop's injected
 * collaborators: a POST bound to this scrape's mediator, the clock, the sleep,
 * and the pacing jitter. Kept out of AmexShape.ts to hold the file-size cap,
 * and out of AmexDetailEnrich.ts so that file stays free of pipeline types and
 * remains testable without any of them.
 */

import type { IEnrichRowsContext } from '../../../Phases/ApiDirectScrape/IApiDirectScrapeShape.js';
import type { IApiMediator } from '../../../Mediator/Api/ApiMediator.types.js';
import type { IPostWithMetadata } from '../../../Strategy/Fetch/FetchStrategy.js';
import type { Procedure } from '../../../Types/Procedure.js';
import { fail } from '../../../Types/Procedure.js';
import { ScraperErrorTypes } from '../../../../Base/ErrorTypes.js';
import { enrichAmexDetail } from './AmexDetailEnrich.js';
import { literalUrl } from '../../../Registry/WK/UrlsWK.js';
import { AMEX_API, type IAmexCard } from './AmexShapeHelpers.js';

/** The per-transaction detail endpoint, branded as an inline literal URL. */
const DETAIL_URL = literalUrl(
  `${AMEX_API}/ocp/transactiondetails/DigitalV3.TransactionDetails/GetTransactionDetails`,
);

/** JSON content negotiation for the detail POST. */
const DETAIL_HEADERS: Record<string, string> = {
  'content-type': 'application/json',
  accept: 'application/json',
};

/**
 * Bind a metadata-preserving POST to this scrape's mediator.
 *
 * Fails rather than degrading when the mediator cannot provide metadata: the
 * loop's stop conditions are read from transport facts, so without them it
 * could not tell an expired session from an empty answer and would keep
 * spending its budget against a session that is already gone.
 *
 * @param bus - This scrape's API mediator.
 * @returns A POST callable for the detail loop.
 */
function bindDetailPost(
  bus: IApiMediator,
): (body: Record<string, unknown>, timeoutMs: number) => Promise<Procedure<IPostWithMetadata>> {
  return async (body, timeoutMs): Promise<Procedure<IPostWithMetadata>> => {
    const post = bus.apiPostWithMetadata;
    if (post === undefined) {
      return fail(ScraperErrorTypes.Generic, 'detail enrichment needs a metadata-capable mediator');
    }
    return post(DETAIL_URL, body, {
      extraHeaders: DETAIL_HEADERS,
      timeoutMs,
      // The endpoint answers a bare replayed POST with a challenge even on a
      // valid session; it wants the request to look like the site's own SPA.
      firstPartyContract: true,
    });
  };
}

/**
 * The shape's `enrichRows` hook — fetch per-transaction detail for one card.
 *
 * Returns the rows untouched when the caller configured no enrichment, so the
 * default path costs nothing.
 *
 * @param rows - Extracted transaction rows for this page.
 * @param context - Account, action context and mediator from the driver.
 * @returns The same rows, some carrying a detail outcome.
 */
export async function enrichAmexRows(
  rows: readonly object[],
  context: IEnrichRowsContext<IAmexCard>,
): Promise<readonly object[]> {
  const options = context.ctx.options.amexDetail;
  if (options === undefined || !options.enabled) return rows;

  return enrichAmexDetail(rows as readonly Record<string, unknown>[], {
    post: bindDetailPost(context.bus),
    options,
    account: { cardSuffix: context.acct.cardSuffix, companyCode: context.acct.companyCode },
    now: () => Date.now(),
    sleep: async (ms): Promise<void> => {
      await new Promise((resolve): NodeJS.Timeout => setTimeout(resolve, ms));
    },
    jitter: () => Math.random(),
  });
}
