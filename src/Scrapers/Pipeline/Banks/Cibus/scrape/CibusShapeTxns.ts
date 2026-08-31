/**
 * Cibus (Pluxee) scrape shape — the transactions step.
 *
 * Walks `[startDate, today]` month by month, cursor = chunk index, posting the
 * purchase-feed verb once per chunk. Chunked regardless of whether the endpoint
 * paginates: it is cheap, it makes truncation self-limiting, and it removes a
 * dependency on an assumption whose failure would be silent.
 *
 * Uses the shared `generateMonthChunks` rather than a bank-local windowing
 * helper, so this bank inherits the same window semantics every other
 * month-chunked bank is tested against.
 *
 * PACED BY THE DRIVER. An earlier revision fanned every window out through
 * `Promise.all`, putting a burst of simultaneous requests on a provider that
 * scores request behaviour. Chunk-at-a-time is sequential by construction.
 */

import {
  generateMonthChunks,
  type IMonthChunk,
} from '../../../Mediator/Scrape/ScrapeReplay/MonthChunking.js';
import { scrapeWindowEnd } from '../../../Mediator/Scrape/ScrapeWindowEnd.js';
import type {
  IApiDirectScrapeTxnsStep,
  IExtractPageArgs,
  VarsMap,
} from '../../../Phases/ApiDirectScrape/IApiDirectScrapeShape.js';
import type { IPage } from '../../../Strategy/Fetch/Pagination.js';
import type { IActionContext } from '../../../Types/PipelineContext.js';
import type { ICibusDataResponse, ICibusDeal } from './CibusMapping.js';
import { partitionByActivity } from './CibusMapping.js';
import {
  assertNotRefused,
  CIBUS_DATA_HEADERS,
  dataUrl,
  type ICibusAcct,
  VERB_DEALS,
} from './CibusShapeHelpers.js';

/** The provider's own date format, which its filters expect. */
const PROVIDER_DATE_FORMAT = 'DD/MM/YYYY';

/**
 * Render a date the way this provider's filters expect it.
 * @param iso - An ISO date string.
 * @returns The same day in the provider's format.
 */
function toProviderDate(iso: string): string {
  const date = new Date(iso);
  const dayOfMonth = date.getUTCDate();
  const monthIndex = date.getUTCMonth() + 1;
  const day = String(dayOfMonth).padStart(2, '0');
  const month = String(monthIndex).padStart(2, '0');
  const fullYear = date.getUTCFullYear();
  const year = String(fullYear);
  return `${day}/${month}/${year}`;
}

/**
 * Month chunks spanning `[startDate, today]` — never empty, so a degenerate
 * future startDate still issues one request rather than none.
 * @param ctx - Action context (carries startDate).
 * @returns Ordered month chunks.
 */
function scrapeChunks(ctx: IActionContext): readonly IMonthChunk[] {
  const start = new Date(ctx.options.startDate);
  const end = scrapeWindowEnd(ctx);
  const chunks = generateMonthChunks(start, end);
  return chunks.length > 0 ? chunks : [{ start: end.toISOString(), end: end.toISOString() }];
}

/**
 * The chunk at a cursor index (first chunk when the cursor is unset).
 * @param chunks - Ordered month chunks.
 * @param cursor - Chunk index, or false on the first call.
 * @returns The selected chunk.
 */
function chunkAt(chunks: readonly IMonthChunk[], cursor: number | false): IMonthChunk {
  const idx = cursor === false ? 0 : cursor;
  const safe = Math.min(idx, chunks.length - 1);
  return chunks[safe];
}

/**
 * Transactions request body — the purchase verb plus one month's date filter.
 * @param _acct - Resolved account; the provider serves one and does not key on it.
 * @param cursor - Chunk index, or false on the first call.
 * @param ctx - Action context (carries startDate).
 * @returns Variables map POSTed as the JSON body.
 */
export function txnsVars(_acct: ICibusAcct, cursor: number | false, ctx: IActionContext): VarsMap {
  const chunks = scrapeChunks(ctx);
  const chunk = chunkAt(chunks, cursor);
  const fromDate = toProviderDate(chunk.start);
  const toDate = toProviderDate(chunk.end);
  return { type: VERB_DEALS, from_date: fromDate, to_date: toDate };
}

/**
 * Extract one month's rows and advance to the next chunk.
 *
 * Rows the provider marked inactive are dropped HERE rather than downstream,
 * because the provider's own flag is the only thing that knows they should not
 * count; a later filter would have to re-derive it from the amount.
 * @param args - Bundle carrying the response body + chunk cursor.
 * @returns Page rows + the next chunk cursor (false when the last chunk is done).
 */
export function txnsExtractPage(args: IExtractPageArgs<ICibusAcct, number>): IPage<object, number> {
  const chunks = scrapeChunks(args.ctx);
  const idx = args.cursor === false ? 0 : args.cursor;
  const nextCursor = idx + 1 < chunks.length ? idx + 1 : false;
  const checked = assertNotRefused(args.body, 'transactions');
  const envelope = checked as ICibusDataResponse;
  const partition = partitionByActivity(envelope.list ?? []);
  return { items: partition.countable.map(toMappableRow), nextCursor };
}

/**
 * Restate one provider row under the names the shared mapper looks for.
 *
 * The auto-mapper populates a field only when the row carries a key the
 * Well-Known dictionary lists for it. This provider names its own: `price`,
 * `rest_name`, `deal_id` — and of those the dictionary knows NONE. Only `date`
 * aliased, so a row mapped clean and arrived with amount 0, no description and
 * no identifier, on a scrape that reported success and the right row count.
 *
 * Restated here rather than by widening the dictionary: `price`, and to a
 * lesser extent `id`-shaped keys, are generic enough that adding them globally
 * would change how rows map for every other institution that happens to carry
 * one. The provider's own fields are kept alongside, so the funding split still
 * reads off the same row.
 *
 * The amount is NEGATED: this provider reports a purchase as a positive
 * magnitude, while a transaction records spend as negative. `isCardIssuer` is
 * not set for this bank, so nothing downstream flips the sign for us.
 * @param deal - One countable purchase row.
 * @returns The row, plus the aliases the mapper resolves against.
 */
function toMappableRow(deal: ICibusDeal): object {
  const wk = { chargedAmount: -deal.price, description: deal.rest_name ?? '' };
  return { ...deal, ...wk, identifier: deal.deal_id };
}

/** Transactions step — one purchase-feed POST per month chunk. */
export const CIBUS_TXNS: IApiDirectScrapeTxnsStep<ICibusAcct, number> = {
  buildVars: txnsVars,
  extractPage: txnsExtractPage,
  windowNarrowing: 'windowEnd',
  urlTag: dataUrl,
  method: 'POST',
  extraHeaders: CIBUS_DATA_HEADERS,
};

export { PROVIDER_DATE_FORMAT, toProviderDate };
