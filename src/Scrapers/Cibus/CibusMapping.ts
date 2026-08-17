import {
  type ITransaction,
  type ITransactionsAccount,
  TransactionStatuses,
  TransactionTypes,
} from '../../Transactions.js';
import { type ScraperOptions } from '../Base/Interface.js';
import { DEVICE_COOKIE_PREFIX } from './Config/CibusApiConfig.js';

/**
 * One row of the provider's purchase feed, passed through with **no derived
 * fields**.
 *
 * Every value is exactly what the provider sent. `date` in particular stays the
 * provider's `DD/MM/YYYY` string rather than being reformatted: the consumer
 * owns the single parser for it, and a second parser here would disagree
 * silently for every day <= 12.
 */
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

/** Budget block the data endpoint returns alongside the rows. */
export interface ICibusBudget {
  CurrBudget?: string;
  CreatioBudget?: string;
  ExpirationDate?: string;
}

/**
 * Envelope of the purchase feed.
 *
 * Rows arrive under `list` at the TOP level — not nested under `data`, and not
 * called `deals`. `head` carries the provider's own column declaration and a
 * row count; the count is the ONLY truncation signal this payload offers, and
 * silent truncation in a backfill is precisely the shape that reads as a quiet
 * month rather than as missing data.
 */
export interface ICibusDataResponse {
  list?: ICibusDeal[];
  head?: { count?: number };
}

/**
 * Envelope of the budget endpoint — a SEPARATE call from the purchase feed.
 *
 * `data` is an ARRAY; the current period is its first entry. An absent or empty
 * array is the provider saying the period has not been provisioned, which is a
 * legitimate state rather than a failure.
 */
export interface ICibusBudgetResponse {
  data?: ICibusBudget[];
}

/** A cookie as the browser context reports it. */
export interface IBrowserCookie {
  name: string;
  value: string;
  domain: string;
}

/** The only currency this provider deals in. */
const ILS = { originalCurrency: 'ILS', chargedCurrency: 'ILS' } as const;

/** Statuses the provider uses for "authenticated". */
const OK_STATUSES: readonly number[] = [200, 201];

/**
 * True when the provider accepted an auth request.
 * @param status - HTTP status of the auth response.
 * @returns True when authenticated.
 */
export function isAuthenticated(status: number): boolean {
  return OK_STATUSES.includes(status);
}

/**
 * Rows the provider has excluded (cancelled/refunded) must not count.
 * @param deal - A raw purchase row.
 * @returns True when the row represents a live purchase.
 */
export function isCountable(deal: ICibusDeal): boolean {
  const active = Number(deal.is_active);
  return active !== 0;
}

/**
 * True when a cookie belongs to the provider's domain.
 * @param cookie - A browser cookie.
 * @returns True when the cookie is provider-scoped.
 */
export function isProviderCookie(cookie: IBrowserCookie): boolean {
  return cookie.domain.includes('pluxee');
}

/**
 * True when a cookie is the ~30-day device token.
 * @param cookie - A browser cookie.
 * @returns True when it is the device token.
 */
export function isDeviceCookie(cookie: IBrowserCookie): boolean {
  return cookie.name.startsWith(DEVICE_COOKIE_PREFIX);
}

/**
 * Serialise provider cookies into a request header value.
 * @param cookies - Provider-scoped cookies.
 * @returns A `name=value; …` header string.
 */
export function toCookieHeader(cookies: IBrowserCookie[]): string {
  const pairs = cookies.map(cookie => `${cookie.name}=${cookie.value}`);
  return pairs.join('; ');
}

/**
 * Parse a numeric provider field that arrives as a string.
 *
 * Absent and present-but-zero are different facts here — a benefit balance of 0
 * is real — so this reports presence separately rather than collapsing both
 * into one sentinel.
 * @param raw - The provider's string value, or '' when the field was absent.
 * @returns Whether a value was present, and the parsed number when it was.
 */
export function toNumber(raw: string): { present: boolean; value: number } {
  if (raw === '') return { present: false, value: 0 };
  return { present: true, value: Number(raw) };
}

/**
 * Split a serialised `name=value` cookie.
 * @param token - The serialised cookie.
 * @returns Whether the string parsed, and its parts when it did.
 */
export function splitCookie(token: string): { ok: boolean; name: string; value: string } {
  const separator = token.indexOf('=');
  if (separator <= 0) return { ok: false, name: '', value: '' };
  const name = token.slice(0, separator);
  const value = token.slice(separator + 1);
  return { ok: true, name, value };
}

/**
 * Map a provider row onto the common transaction shape.
 *
 * `chargedAmount` carries the FULL order value, not the household's own share.
 * That is deliberate: the consumer matches this row against a marketplace order
 * recorded at full value, and using the out-of-pocket share would silently stop
 * that match from ever succeeding. The split rides `providerExtra` and is typed
 * again at the consumer's boundary.
 * @param deal - A raw purchase row.
 * @param options - Scraper options, for raw-transaction inclusion.
 * @returns A standard transaction.
 */
export function toTransaction(deal: ICibusDeal, options: ScraperOptions): ITransaction {
  const amount = -deal.price;
  const raw = options.includeRawTransaction ? deal : undefined;
  const money = { originalAmount: amount, chargedAmount: amount, ...ILS };
  const dates = { date: deal.date, processedDate: deal.date }; // VERBATIM — see ICibusDeal.
  const core = { type: TransactionTypes.Normal, identifier: deal.deal_id, ...dates };
  const body = { description: deal.rest_name ?? '', status: TransactionStatuses.Completed };
  const extras = { providerExtra: toDealExtra(deal), rawTransaction: raw };
  return { ...core, ...money, ...body, ...extras };
}

/**
 * The employer/out-of-pocket split, which `chargedAmount` cannot express.
 * @param deal - A raw purchase row.
 * @returns The funding split, for the transaction's providerExtra.
 */
function toDealExtra(deal: ICibusDeal): Readonly<Record<string, unknown>> {
  return { companyPrice: deal.etc_company_price, otlPrice: deal.otl_price, time: deal.time };
}

/**
 * Build the single benefit account this provider exposes.
 *
 * `accountNumber` is a stable synthetic label, never the provider's own card
 * identifier: the consumer keys stored rows on its own account id, and the real
 * identifier is sensitive.
 * @param deals - Every purchase row fetched.
 * @param budget - The budget block from the last response that carried one.
 * @param options - Scraper options, threaded to the row mapper.
 * @returns One account with its transactions.
 */
export function toAccount(
  deals: ICibusDeal[],
  budget: ICibusBudget,
  options: ScraperOptions,
): ITransactionsAccount {
  const countable = deals.filter(isCountable);
  const txns = countable.map(deal => toTransaction(deal, options));
  const balance = toAccountBalance(budget);
  return { accountNumber: 'cibus', ...balance, providerExtra: toAccountExtra(budget), txns };
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
function toAccountBalance(budget: ICibusBudget): { balance?: number } {
  const current = toNumber(budget.CurrBudget ?? '');
  return current.present ? { balance: current.value } : {};
}

/**
 * The two budget values `balance` cannot carry.
 *
 * "Remaining allowance that expires on a date" is not the quantity `balance`
 * names, and flattening them into it is how a field acquires two meanings.
 * @param budget - The provider's budget block.
 * @returns Allowance and expiry, for the account's providerExtra.
 */
function toAccountExtra(budget: ICibusBudget): Readonly<Record<string, unknown>> {
  const declared = toNumber(budget.CreatioBudget ?? '');
  const allowance = declared.present ? declared.value : undefined;
  return { allowance, expiresOn: budget.ExpirationDate };
}
