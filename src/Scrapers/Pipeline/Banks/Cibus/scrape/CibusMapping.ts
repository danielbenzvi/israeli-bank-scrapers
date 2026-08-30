/**
 * Cibus (Pluxee) row and budget mapping onto the canonical transaction shape.
 *
 * Pure: no browser, no mediator, no provider requests. Everything here is a
 * function of a response body, which is what makes the scrape shape testable
 * without a page.
 *
 * NOTHING RIDES AN ESCAPE HATCH. An earlier revision carried the employer /
 * out-of-pocket split and the benefit allowance on a `providerExtra` bag added
 * to the shared transaction types. That widened the canonical schema for one
 * source, so it is gone: the split is already present verbatim on the provider
 * row and reaches a caller through `rawTransaction`, and the allowance is
 * reported through `balance`.
 */

import moment from 'moment';

import type { ITransaction, ITransactionsAccount } from '../../../../../Transactions.js';
import { TransactionStatuses, TransactionTypes } from '../../../../../Transactions.js';
import type { ScraperOptions } from '../../../../Base/Interface.js';
import ScraperError from '../../../../Base/ScraperError.js';

/** The provider's own date format, which it uses for every row. */
const PROVIDER_DATE_RE = /^(\d{2})\/(\d{2})\/(\d{4})$/;

/** Every amount this provider reports is in shekels; it exposes no other currency. */
const ILS = { originalCurrency: 'ILS', chargedCurrency: 'ILS' } as const;

/** A single purchase row from the benefit portal. */
export interface ICibusDeal {
  deal_id: number;
  date: string;
  time?: string;
  rest_name?: string;
  price: number;
  etc_company_price: number;
  otl_price: number;
  is_active: number | string;
}

/** Budget block the provider returns from its own endpoint. */
export interface ICibusBudget {
  CurrBudget?: string;
  CreatioBudget?: string;
  ExpirationDate?: string;
}

/**
 * Envelope of the purchase feed.
 *
 * Rows arrive under `list` at the TOP level — not nested under `data`, and not
 * called `deals`. `head` carries the provider's own row count, which is the
 * only truncation signal this payload offers; silent truncation in a backfill
 * reads as a quiet month rather than as missing data.
 */
export interface ICibusDataResponse {
  list?: ICibusDeal[];
  head?: { count?: number };
}

/**
 * Envelope of the budget endpoint.
 *
 * `data` is an ARRAY; the current period is its first entry. An absent or empty
 * array is the provider saying the period is not provisioned, which is a
 * legitimate state rather than a failure.
 */
export interface ICibusBudgetResponse {
  data?: ICibusBudget[];
}

/**
 * Convert the provider's `DD/MM/YYYY` into the ISO date `ITransaction.date`
 * declares.
 *
 * Parsed by explicit field position, never by `new Date(...)`: that reads
 * `05/08/2026` as a US MM/DD and returns the wrong calendar day for roughly
 * half of any real feed — silently, since the result is still a valid date.
 * Throws on anything unrecognised, because a provider that changed its date
 * format is a real breakage and a row carrying a guessed date is worse than a
 * scrape that fails and says so.
 * @param raw - The provider's date string.
 * @returns The same day as an ISO date string.
 */
export function toIsoDate(raw: string): string {
  const value = raw.trim();
  const match = PROVIDER_DATE_RE.exec(value);
  if (!match) throw new ScraperError(`Cibus: unrecognised date format '${value}'`);
  const [, day, month, year] = match;
  const iso = `${year}-${month}-${day}`;
  const parsed = moment(iso, 'YYYY-MM-DD', true);
  if (!parsed.isValid()) throw new ScraperError(`Cibus: date out of calendar range '${value}'`);
  return parsed.toISOString();
}

/** How the provider marks a row that should not count toward spend. */
export type DealActivity = 'live' | 'excluded' | 'unknown';

/**
 * Read the provider's activity flag.
 *
 * Both spellings the provider is known to send are accepted, and everything
 * else is `unknown` rather than being coerced. An earlier revision read this
 * through `Number()`, so any value that did not parse became `NaN`, compared
 * unequal to 0, and counted — an exclusion that failed open, which is silent
 * and indistinguishable from having nothing to exclude.
 * @param value - The raw `is_active` field.
 * @returns Whether the row counts, does not count, or was not recognised.
 */
export function readActivity(value: unknown): DealActivity {
  if (value === 1 || value === '1') return 'live';
  if (value === 0 || value === '0') return 'excluded';
  return 'unknown';
}

/**
 * A row counts only when the provider positively said it is live.
 * @param deal - A raw purchase row.
 * @returns True when the row should count toward spend.
 */
export function isCountable(deal: ICibusDeal): boolean {
  return readActivity(deal.is_active) === 'live';
}

/** Rows split by whether they count, with the unrecognised ones counted separately. */
export interface IActivityPartition {
  readonly countable: ICibusDeal[];
  readonly excluded: number;
  readonly unknown: number;
}

/**
 * Split rows by activity, reporting how many were dropped and why.
 *
 * The counts are returned rather than logged and forgotten: a change in the
 * provider's vocabulary shows up as a rising `unknown` instead of as a month
 * that quietly got cheaper.
 * @param deals - Rows as the provider returned them.
 * @returns The countable rows, plus the two drop counts.
 */
export function partitionByActivity(deals: readonly ICibusDeal[]): IActivityPartition {
  const countable = deals.filter(isCountable);
  const excluded = deals.filter(d => readActivity(d.is_active) === 'excluded').length;
  return { countable, excluded, unknown: deals.length - countable.length - excluded };
}

/**
 * Read one of the provider's numeric strings.
 * @param raw - The provider's value.
 * @returns Whether a number was present, and its value.
 */
export function toNumber(raw: string): { present: boolean; value: number } {
  const trimmed = raw.trim();
  if (trimmed === '') return { present: false, value: 0 };
  const value = Number(trimmed);
  return Number.isFinite(value) ? { present: true, value } : { present: false, value: 0 };
}

/**
 * Both date fields, from the provider's single date value.
 *
 * The feed carries no separate settlement date, so `processedDate` mirrors
 * `date` rather than being invented.
 * @param raw - The provider's date string.
 * @returns The transaction's two date fields, both ISO.
 */
function toDates(raw: string): { date: string; processedDate: string } {
  const iso = toIsoDate(raw);
  return { date: iso, processedDate: iso };
}

/**
 * Map a provider row onto the common transaction shape.
 *
 * `chargedAmount` carries the FULL order value, not the household's own share.
 * That is deliberate: a consumer matches this row against a marketplace order
 * recorded at full value, and using the out-of-pocket share would silently stop
 * that match from ever succeeding. The employer / out-of-pocket split is on the
 * provider row itself and reaches a caller through `rawTransaction`.
 * @param deal - A raw purchase row.
 * @param options - Scraper options, for raw-transaction inclusion.
 * @returns A standard transaction.
 */
export function toTransaction(deal: ICibusDeal, options: ScraperOptions): ITransaction {
  const amount = -deal.price;
  const money = { originalAmount: amount, chargedAmount: amount, ...ILS };
  const dates = toDates(deal.date);
  const core = { type: TransactionTypes.Normal, identifier: deal.deal_id, ...dates };
  const body = { description: deal.rest_name ?? '', status: TransactionStatuses.Completed };
  const raw = options.includeRawTransaction === true ? { rawTransaction: deal } : {};
  return { ...core, ...money, ...body, ...raw };
}

/**
 * Remaining benefit, when the provider reported one.
 *
 * `ITransactionsAccount.balance` is itself optional, so an absent field is
 * expressed by omitting the key rather than by a sentinel number — a benefit
 * balance of 0 is a real, reportable state.
 * @param budget - The provider's budget block.
 * @returns An object carrying `balance` only when the field was present.
 */
export function toAccountBalance(budget: ICibusBudget): { balance?: number } {
  const current = toNumber(budget.CurrBudget ?? '');
  return current.present ? { balance: current.value } : {};
}

/**
 * Build the single benefit account this provider exposes.
 *
 * `accountNumber` is a stable synthetic label, never the provider's own card
 * identifier: a consumer keys stored rows on its own account id, and the real
 * identifier is sensitive.
 * @param deals - The countable purchase rows, already partitioned by activity.
 * @param budget - The budget block from the endpoint that carries one.
 * @param options - Scraper options, threaded to the row mapper.
 * @returns One account with its transactions.
 */
export function toAccount(
  deals: readonly ICibusDeal[],
  budget: ICibusBudget,
  options: ScraperOptions,
): ITransactionsAccount {
  // Already partitioned by the caller, which is what lets it report how many
  // rows it had to drop. Filtering here as well would hide that count behind a
  // second, silent pass.
  const txns = deals.map(deal => toTransaction(deal, options));
  return { accountNumber: 'cibus', ...toAccountBalance(budget), txns };
}
