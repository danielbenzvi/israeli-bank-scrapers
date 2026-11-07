/**
 * Pepper scrape shape — transactions helpers.
 *
 * Pepper paginates transactions via `oshTransactionsPagination`, walking back in
 * time with the cursor `nextTransactionSerialNumber` (the first page sends only
 * { accountId }). Amounts are already signed (debits negative).
 */

import moment from 'moment';

import type {
  IExtractPageArgs,
  VarsMap,
} from '../../../Phases/ApiDirectScrape/IApiDirectScrapeShape.js';
import type { IPage } from '../../../Strategy/Fetch/Pagination.js';
import type { IActionContext } from '../../../Types/PipelineContext.js';
import type { IPepperAcct } from './PepperShapeHelpers.js';

const ISO_DATE_FMT = 'YYYY-MM-DD';

type PepperTxn = Record<string, unknown>;

interface IOshBlock {
  readonly totalCount?: number;
  readonly nextTransactionSerialNumber?: number | null;
  readonly transactions?: readonly PepperTxn[];
  readonly pendingTransactions?: readonly PepperTxn[];
}
interface ITxnsResp {
  readonly accounts?: { readonly oshTransactionsPagination?: IOshBlock };
}

/**
 * Build txns variables for one page. First page: just the account id.
 * Later pages carry the serial-number cursor returned by the previous page.
 * @param acct - Pepper account.
 * @param cursor - Serial-number cursor (false on the first call).
 * @returns Variables map.
 */
export function txnsVars(acct: IPepperAcct, cursor: number | false): VarsMap {
  if (cursor === false) return { accountId: acct.accountId };
  return { accountId: acct.accountId, nextTransactionSerialNumber: cursor };
}

/** Merge posted + pending rows into one page (futures are not yet real). */
function mergeRows(osh?: IOshBlock): readonly PepperTxn[] {
  const posted = osh?.transactions ?? [];
  const pending = osh?.pendingTransactions ?? [];
  return [...posted, ...pending];
}

/** Earliest bookingDate on the page, or null when none parse. */
function oldestDate(rows: readonly PepperTxn[]): moment.Moment | null {
  const dates = rows
    .map((r) => moment(String(r.bookingDate ?? r.effectiveDate ?? '')))
    .filter((m) => m.isValid());
  if (dates.length === 0) return null;
  return moment.min(dates);
}

/**
 * Extract one page from the Transactions response and decide the next cursor.
 * Stops when the server returns no further cursor, the page is empty, or the
 * page has reached back past ScraperOptions.startDate.
 * @param args - Bundle carrying body + cursor + ctx.
 * @returns Page rows + nextCursor.
 */
export function txnsExtractPage(
  args: IExtractPageArgs<IPepperAcct, number>,
): IPage<object, number> {
  const resp = args.body as unknown as ITxnsResp;
  const osh = resp.accounts?.oshTransactionsPagination;
  const rows = mergeRows(osh);
  const nextSerial = osh?.nextTransactionSerialNumber;

  const ctx = args.ctx as IActionContext;
  const startDate = moment(ctx.options.startDate).format(ISO_DATE_FMT);
  const oldest = oldestDate(rows);
  const reachedStart = oldest !== null && oldest.format(ISO_DATE_FMT) < startDate;

  const hasNext = typeof nextSerial === 'number' && nextSerial > 0;
  const nextCursor: number | false =
    rows.length === 0 || reachedStart || !hasNext ? false : (nextSerial as number);
  return { items: rows, nextCursor };
}
