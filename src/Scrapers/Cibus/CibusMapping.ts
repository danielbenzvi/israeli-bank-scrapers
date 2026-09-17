import {
  type ITransaction,
  type ITransactionsAccount,
  TransactionStatuses,
  TransactionTypes,
} from '../../Transactions.js';
import ScraperErrorTypes from '../Base/ErrorTypes.js';
import { type IScraperScrapingResult, type ScraperOptions } from '../Base/Interface.js';
import ScraperError from '../Base/ScraperError.js';
import {
  BLOCKED_STATUSES,
  DEVICE_COOKIE_PREFIX,
  RATE_LIMITED_STATUS,
  REJECTED_STATUS,
} from './Config/CibusApiConfig.js';

/**
 * One row of the provider's purchase feed, as the provider sent it.
 *
 * `date` arrives as `DD/MM/YYYY` and is the ONE field this module converts:
 * {@link ITransaction.date} declares an ISO date string, and a scraper that
 * puts something else there is lying to every consumer — including this
 * library's own logging, which renders such a row as `Invalid Date`. The
 * conversion is explicit and strict; see {@link toIsoDate}.
 *
 * Converting here loses nothing: the untouched row still reaches the consumer
 * as `rawTransaction` whenever `includeRawTransaction` is set.
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

/** `DD/MM/YYYY` — the only shape the provider's purchase feed uses. */
const PROVIDER_DATE_RE = /^(\d{2})\/(\d{2})\/(\d{4})$/;

/**
 * Convert the provider's `DD/MM/YYYY` into the ISO date `ITransaction.date`
 * declares.
 *
 * Parsed by explicit field position, never by `new Date(...)`: that reads
 * `05/08/2026` as a US MM/DD and would silently return the wrong calendar day
 * for every day <= 12 — roughly half of any real feed, and wrong in a way that
 * still looks like a valid date. The range checks catch a provider that
 * switches to MM/DD, which the regex alone cannot see.
 *
 * Throws rather than passing an unrecognised value through. A provider that
 * changed its date format is a real breakage, and a row carrying a guessed
 * date is worse than a scrape that fails and says so.
 * @param raw - The provider's date string.
 * @returns The same calendar day as `YYYY-MM-DD`.
 */
export function toIsoDate(raw: string): string {
  const value = raw.trim();
  const match = PROVIDER_DATE_RE.exec(value);
  if (!match) throw new ScraperError(`Cibus: unrecognised date format '${value}'`);
  const [, day, month, year] = match;
  const isInRange = isCalendarRange(day, month);
  if (!isInRange) throw new ScraperError(`Cibus: date out of calendar range '${value}'`);
  return `${year}-${month}-${day}`;
}

/**
 * Whether the two leading fields fall inside the calendar.
 *
 * The regex alone accepts `20/13/2026` — which is exactly what a switch to
 * MM/DD looks like on any day past the 12th, and the one shape that betrays
 * such a change instead of silently transposing.
 * @param day - The first field of the provider's date.
 * @param month - The second field.
 * @returns True when both fields are in range.
 */
function isCalendarRange(day: string, month: string): boolean {
  const isMonthValid = Number(month) >= 1 && Number(month) <= 12;
  const isDayValid = Number(day) >= 1 && Number(day) <= 31;
  return isMonthValid && isDayValid;
}

/**
 * Both date fields, from the provider's single date value.
 *
 * The feed carries no separate settlement date, so `processedDate` mirrors
 * `date` rather than being invented.
 * @param raw - The provider's `DD/MM/YYYY` string.
 * @returns The transaction's two date fields, both ISO.
 */
function toDates(raw: string): { date: string; processedDate: string } {
  const iso = toIsoDate(raw);
  return { date: iso, processedDate: iso };
}

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
 * Turn a rejected auth status into the most specific verdict it supports.
 *
 * THE 401 IS AMBIGUOUS, AND IS REPORTED AS SUCH. A reCAPTCHA v3 score is
 * returned only to the site owner's own backend, never to the page, so a token
 * scored too low arrives as exactly the 401 a wrong password gives. Calling
 * that `InvalidPassword` asserts a distinction nothing here can make — and the
 * verdict is acted on downstream, where it asks a person to re-enter a
 * password that may have been right all along.
 *
 * THE OTHERS ARE NOT AMBIGUOUS, so they are read rather than folded into the
 * same answer. Declining to over-claim on the 401 is not a reason to discard
 * the signals that are unambiguous — a rate limit in particular is the
 * provider telling us to slow down, which no person needs to be woken for.
 *
 * AN UNKNOWN STATUS STAYS UNKNOWN. Mapping it to the nearest familiar verdict
 * is how a provider's change to its own vocabulary turns into a confident
 * wrong answer instead of a visible one.
 * @param status - The provider's HTTP status for the rejected step.
 * @returns The categorised failure.
 */
export function authFailureFor(status: number): IScraperScrapingResult {
  const isBlocked = BLOCKED_STATUSES.includes(status);
  if (isBlocked) {
    const errorMessage = 'provider reports this account as blocked';
    return { success: false, errorType: ScraperErrorTypes.AccountBlocked, errorMessage };
  }
  const errorMessage = authFailureMessage(status);
  const errorType = authFailureType(status);
  return { success: false, errorType, errorMessage };
}

/**
 * The error type for a rejected auth status that is not an account block.
 *
 * A RATE LIMIT IS A TRANSPORT CONDITION, NOT A CREDENTIAL ONE, and it is typed
 * as such. `NetworkError` is the existing type whose meaning is "the request
 * did not get through; try later", which is exactly what a 429 says — and
 * consumers already route that away from anything that troubles a person.
 * Reporting it generically instead would leave a rate limit indistinguishable
 * from a rejected password to every consumer, which is how being throttled
 * ends up asking someone to re-enter a password that was never wrong.
 *
 * Deliberately NOT a new member on the shared error enum. Thirteen scrapers
 * share that type, and one source's needs do not justify widening a surface
 * they all consume — particularly in a fork whose intended path is upstream.
 * @param status - The provider's HTTP status for the rejected step.
 * @returns The type that carries the most meaning this status supports.
 */
function authFailureType(status: number): ScraperErrorTypes {
  if (status === RATE_LIMITED_STATUS) return ScraperErrorTypes.NetworkError;
  return ScraperErrorTypes.Generic;
}

/**
 * The message for a rejected auth status that is not an account block.
 * @param status - The provider's HTTP status for the rejected step.
 * @returns A message naming what is known, and what is not.
 */
function authFailureMessage(status: number): string {
  if (status === RATE_LIMITED_STATUS) {
    return 'provider is rate limiting this account — not a credential failure';
  }
  if (status === REJECTED_STATUS) {
    return 'authentication rejected — credentials or captcha score, indistinguishable here';
  }
  return `authentication failed with an unrecognised provider status (${String(status)})`;
}

/** The provider's own values for `is_active`, in both forms it may send them. */
const LIVE_VALUES: readonly unknown[] = [1, '1'];
const EXCLUDED_VALUES: readonly unknown[] = [0, '0'];

/** What the provider's `is_active` field says about one row. */
export type DealActivity = 'live' | 'excluded' | 'unknown';

/**
 * Read the provider's activity flag, refusing to guess at a value it has never
 * sent.
 *
 * BOTH FORMS ARE ACCEPTED ON PURPOSE. The provider's own schema declares this
 * field a string and its rows carry numbers, so either could arrive without
 * the provider considering anything to have changed. A guard written against
 * the declared type would reject correct data; one written against the
 * observed type breaks the day they ship what their schema promises.
 *
 * WHY NOT `Number(value) !== 0`. That is what this replaces, and it fails
 * OPEN: any value that will not parse becomes `NaN`, `NaN !== 0` is true, and
 * a row the provider may have excluded is counted instead. An exclusion that
 * fails open is the more dangerous direction — it is silent, and it is
 * indistinguishable from having nothing to exclude.
 * @param value - The provider's raw field value.
 * @returns Whether the row is live, excluded, or carries a value we do not know.
 */
export function readActivity(value: unknown): DealActivity {
  if (LIVE_VALUES.includes(value)) return 'live';
  if (EXCLUDED_VALUES.includes(value)) return 'excluded';
  return 'unknown';
}

/**
 * Rows the provider has excluded (cancelled/refunded) must not count, and
 * neither must rows whose flag we cannot read.
 * @param deal - A raw purchase row.
 * @returns True when the row represents a live purchase.
 */
export function isCountable(deal: ICibusDeal): boolean {
  return readActivity(deal.is_active) === 'live';
}

/** Purchase rows split by what the provider's activity flag says about them. */
export interface IActivityPartition {
  countable: ICibusDeal[];
  excluded: number;
  unknown: number;
}

/**
 * Split rows by activity, counting what was dropped.
 *
 * The counts are the point. Dropping an unreadable row silently would leave
 * "the provider changed this field" looking exactly like "there was nothing to
 * exclude" — so the caller reports how many rows it could not read, and a
 * change in the provider's vocabulary surfaces as itself.
 * @param deals - Every purchase row fetched.
 * @returns The countable rows, and how many were dropped for each reason.
 */
export function partitionByActivity(deals: ICibusDeal[]): IActivityPartition {
  const countable = deals.filter(deal => readActivity(deal.is_active) === 'live');
  const excluded = deals.filter(deal => readActivity(deal.is_active) === 'excluded').length;
  const unknown = deals.length - countable.length - excluded;
  return { countable, excluded, unknown };
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
  const dates = toDates(deal.date);
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
 * @param deals - The countable purchase rows, already partitioned by activity.
 * @param budget - The budget block from the last response that carried one.
 * @param options - Scraper options, threaded to the row mapper.
 * @returns One account with its transactions.
 */
export function toAccount(
  deals: ICibusDeal[],
  budget: ICibusBudget,
  options: ScraperOptions,
): ITransactionsAccount {
  // Already partitioned by the caller, which is what lets it report how many
  // rows it had to drop. Filtering here as well would hide that count behind a
  // second, silent pass.
  const txns = deals.map(deal => toTransaction(deal, options));
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
