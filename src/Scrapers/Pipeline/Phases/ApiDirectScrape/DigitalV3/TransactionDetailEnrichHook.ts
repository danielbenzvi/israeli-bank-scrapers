/**
 * DigitalV3 transaction-details enrichment — the `enrichRows` hook.
 *
 * Adapts the generic hook the driver calls to the detail loop's injected
 * collaborators: a POST bound to this scrape's mediator, the clock, the sleep,
 * and the pacing jitter. Kept out of each bank's Shape.ts to hold the file-size
 * cap, and out of TransactionDetailEnrich.ts so that file stays free of
 * pipeline types and remains testable without any of them.
 *
 * <p>Lives under `Phases/ApiDirectScrape/**` rather than in either bank,
 * because Amex and Isracard are two brands on one issuer's DigitalV3 backbone
 * and both need this identical loop. That is the same shape as the FIBI group,
 * and it takes the same answer: brands sharing a wire contract share it
 * through a neutral module here, never by one bank importing its sibling. The
 * `BankSiblingIndependence` gate enforces that direction.
 */

import { ScraperErrorTypes } from '../../../../Base/ErrorTypes.js';
import type { IApiMediator } from '../../../Mediator/Api/ApiMediator.types.js';
import { humanDelay } from '../../../Mediator/Timing/TimingActions.js';
import { literalUrl } from '../../../Registry/WK/UrlsWK.js';
import type { IPostWithMetadata } from '../../../Strategy/Fetch/FetchStrategy.js';
import type { Procedure } from '../../../Types/Procedure.js';
import { fail } from '../../../Types/Procedure.js';
import type { IEnrichRowsContext } from '../IApiDirectScrapeShape.js';
import { enrichCardDetail } from './TransactionDetailEnrich.js';
import type { ICardDetailDeps, ICardDetailOptions } from './TransactionDetailTypes.js';

/** A card as both DigitalV3 banks describe it — the shapes are identical. */
export interface IDigitalV3Card {
  readonly cardSuffix: string;
  readonly companyCode: string;
}

/**
 * The per-transaction detail endpoint for a DigitalV3 host.
 *
 * Isracard and Amex are one company and share this backbone, differing only
 * by domain — which is why this whole module is host-parameterised rather than
 * duplicated per bank.
 *
 * @param apiHost - The bank's API origin.
 * @returns The detail endpoint, branded as an inline literal URL.
 */
function detailUrl(apiHost: string): ReturnType<typeof literalUrl> {
  const route = 'ocp/transactiondetails/DigitalV3.TransactionDetails/GetTransactionDetails';
  return literalUrl(`${apiHost}/${route}`);
}

/** Reported when the mediator cannot return the transport facts the loop reads. */
const NEEDS_METADATA = 'detail enrichment needs a metadata-capable mediator';

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
 * @param apiHost - The bank's API origin.
 * @returns A POST callable for the detail loop.
 */
function bindDetailPost(
  bus: IApiMediator,
  apiHost: string,
): (body: Record<string, unknown>, timeoutMs: number) => Promise<Procedure<IPostWithMetadata>> {
  const url = detailUrl(apiHost);
  return async (body, timeoutMs): Promise<Procedure<IPostWithMetadata>> => {
    const post = bus.apiPostWithMetadata;
    if (post === undefined) return fail(ScraperErrorTypes.Generic, NEEDS_METADATA);
    // The endpoint answers a bare replayed POST with a challenge even on a
    // valid session; it wants the request to look like the site's own SPA.
    const opts = { extraHeaders: DETAIL_HEADERS, timeoutMs, firstPartyContract: true };
    return post(url, body, opts);
  };
}

/**
 * Wall-clock source for the pass, injected so the loop is testable.
 * @returns The current epoch milliseconds.
 */
function nowMs(): number {
  return Date.now();
}

/**
 * Pause between paced requests.
 *
 * Routed through {@link humanDelay} rather than a bare timer: it is the
 * pipeline's own scheduler, and the timer-leak invariants are written against
 * it. The range is a single point because the jitter has already been applied
 * — `nextDetailRequest` picks the exact delay, so choosing again here would
 * spread the pacing the budget just decided.
 * @param ms - How long to wait.
 * @returns A promise resolving once the delay has elapsed.
 */
async function pause(ms: number): Promise<void> {
  await humanDelay(ms, ms);
}

/**
 * Pacing jitter, so requests do not arrive on a fixed cadence.
 * @returns A value in [0, 1) selecting a delay within the configured range.
 */
function pacingJitter(): number {
  return Math.random();
}

/**
 * Assemble the collaborators the detail pass needs from the driver's context.
 * @param context - Account, action context and mediator from the driver.
 * @param apiHost - The bank's API origin.
 * @param options - The caller's enrichment configuration.
 * @returns The dependency bundle for {@link enrichCardDetail}.
 */
function buildDetailDeps(
  context: IEnrichRowsContext<IDigitalV3Card>,
  apiHost: string,
  options: ICardDetailOptions,
): ICardDetailDeps {
  return {
    post: bindDetailPost(context.bus, apiHost),
    options,
    account: { cardSuffix: context.acct.cardSuffix, companyCode: context.acct.companyCode },
    now: nowMs,
    sleep: pause,
    jitter: pacingJitter,
  };
}

/**
 * The shape's `enrichRows` hook — fetch per-transaction detail for one card.
 *
 * Returns the rows untouched when the caller configured no enrichment, so the
 * default path costs nothing.
 * @param apiHost - The bank's API origin.
 * @returns The `enrichRows` hook a shape declares.
 */
export function buildDetailEnrichHook(
  apiHost: string,
): (
  rows: readonly object[],
  context: IEnrichRowsContext<IDigitalV3Card>,
) => Promise<readonly object[]> {
  return async (rows, context): Promise<readonly object[]> => {
    const options = context.ctx.options.cardDetail;
    if (!options?.enabled) return rows;
    const deps = buildDetailDeps(context, apiHost, options);
    return enrichCardDetail(rows as readonly Record<string, unknown>[], deps);
  };
}
