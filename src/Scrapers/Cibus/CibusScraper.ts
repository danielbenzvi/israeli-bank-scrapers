import moment from 'moment';

import { waitUntil } from '../../Common/Waiting.js';
import {
  type ITransaction,
  type ITransactionsAccount,
  TransactionStatuses,
  TransactionTypes,
} from '../../Transactions.js';
import { BaseScraperWithBrowser } from '../Base/BaseScraperWithBrowser.js';
import ScraperErrorTypes from '../Base/ErrorTypes.js';
import { createGenericError, createTimeoutError } from '../Base/Errors.js';
import { type IScraperScrapingResult, type ScraperOptions } from '../Base/Interface.js';
import { fetchPostWithinPageWithMetadata } from '../Pipeline/Mediator/Network/Fetch/index.js';
import {
  AUTH_TOKEN_URL,
  DATA_URL,
  DEVICE_COOKIE_PREFIX,
  DEVICE_COOKIE_TIMEOUT_MS,
  isAllowedUrl,
  OTP_REQUIRED_STATUS,
  PORTAL_URL,
  RECAPTCHA_ACTION,
  SESSION_COOKIE_NAME,
  SHOW_COMPANY_FIELD_URL,
} from './Config/CibusApiConfig.js';
import { MINT_RECAPTCHA_TOKEN, READ_ENTERPRISE_FLAG } from './CibusPageScripts.js';

/**
 * Credentials this scraper accepts — the Cibus member of `ScraperCredentials`.
 *
 * `company` is required only by employers whose accounts use it, which the
 * provider's own pre-auth call decides. `otpLongTermToken` is a previously
 * issued ~30-day device token; supplying it suppresses the code challenge.
 */
interface ICibusCredentials {
  username: string;
  password: string;
  company?: string;
  otpLongTermToken?: string;
}

/**
 * One row of the provider's purchase feed, passed through with **no derived
 * fields**.
 *
 * Every value is exactly what the provider sent. `date` in particular stays the
 * provider's `DD/MM/YYYY` string rather than being reformatted: the consumer
 * owns the single parser for it, and a second parser here would disagree
 * silently for every day <= 12.
 */
interface ICibusDeal {
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
interface ICibusBudget {
  CurrBudget?: string;
  CreatioBudget?: string;
  ExpirationDate?: string;
}

/** Envelope shape of the data endpoint. */
interface ICibusDataResponse {
  data?: ICibusBudget & { deals?: ICibusDeal[] };
}

/** Result of the password step: authenticated, or challenged for a code. */
interface IAuthOutcome {
  status: number;
  maskedInput?: string;
  userInput1?: string;
}

/** A cookie as the browser context reports it. */
interface IBrowserCookie {
  name: string;
  value: string;
  domain: string;
}

/** Statuses the provider uses for "authenticated". */
const OK_STATUSES: readonly number[] = [200, 201];

/**
 * True when the provider accepted an auth request.
 * @param status - HTTP status of the auth response.
 * @returns True when authenticated.
 */
function isAuthenticated(status: number): boolean {
  return OK_STATUSES.includes(status);
}

/**
 * Rows the provider has excluded (cancelled/refunded) must not count.
 * @param deal - A raw purchase row.
 * @returns True when the row represents a live purchase.
 */
function isCountable(deal: ICibusDeal): boolean {
  return Number(deal.is_active) !== 0;
}

/**
 * True when a cookie belongs to the provider's domain.
 * @param cookie - A browser cookie.
 * @returns True when the cookie is provider-scoped.
 */
function isProviderCookie(cookie: IBrowserCookie): boolean {
  return cookie.domain.includes('pluxee');
}

/**
 * True when a cookie is the ~30-day device token.
 * @param cookie - A browser cookie.
 * @returns True when it is the device token.
 */
function isDeviceCookie(cookie: IBrowserCookie): boolean {
  return cookie.name.startsWith(DEVICE_COOKIE_PREFIX);
}

/**
 * Serialise provider cookies into a request header value.
 * @param cookies - Provider-scoped cookies.
 * @returns A `name=value; …` header string.
 */
function toCookieHeader(cookies: IBrowserCookie[]): string {
  const pairs = cookies.map(cookie => `${cookie.name}=${cookie.value}`);
  return pairs.join('; ');
}

/**
 * Parse a numeric provider field that arrives as a string.
 * @param raw - The provider's string value.
 * @returns The number, or undefined when absent.
 */
function toNumber(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  return Number(raw);
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
function toTransaction(deal: ICibusDeal, options: ScraperOptions): ITransaction {
  const amount = -deal.price;
  const extra = { companyPrice: deal.etc_company_price, otlPrice: deal.otl_price, time: deal.time };
  const raw = options.includeRawTransaction ? deal : undefined;
  return {
    type: TransactionTypes.Normal,
    identifier: deal.deal_id,
    date: deal.date, // VERBATIM — see ICibusDeal.
    processedDate: deal.date,
    originalAmount: amount,
    originalCurrency: 'ILS',
    chargedAmount: amount,
    chargedCurrency: 'ILS',
    description: deal.rest_name ?? '',
    status: TransactionStatuses.Completed,
    providerExtra: extra,
    rawTransaction: raw,
  };
}

/**
 * Cibus (Pluxee) — employer meal-benefit portal.
 *
 * WHY THIS IS NOT A FORM FILL. The auth endpoint enforces reCAPTCHA v3: a
 * request carrying valid credentials and no token is rejected 401, identically
 * to one with bad credentials. v3 is invisible and score-based, and — measured
 * against the live page under both Chromium and this library's own browser — a
 * token can be minted from a bare page context with no form driven at all. So
 * this scraper loads the provider's page purely so their script runs, mints a
 * token through their own API, then posts JSON. Nothing navigates a form,
 * clicks a control, or parses rendered HTML.
 *
 * We do not solve a captcha or work around one; we let the page do what it
 * already does for any visitor.
 *
 * READ-ONLY IS STRUCTURAL. Every request goes through {@link post}, which
 * refuses any URL off the frozen allow-list, and a unit test asserts the
 * reachable set equals that list. See `Config/CibusApiConfig.ts`.
 *
 * THE DEVICE TOKEN IS THE POINT OF THE OTP DANCE. The provider issues a ~30-day
 * cookie that suppresses the challenge on later logins, and issues it only when
 * `trustDevice` reaches the server **on the one-time-code step** — not the
 * password step. It also arrives *after* the auth response, so it is polled for
 * rather than read once: reading immediately yields a working session with no
 * device token, which silently turns a monthly challenge into a per-run one and
 * looks exactly like success. It leaves through `onAuthFlowComplete`, never
 * through the scraping result — a credential must not ride the data path.
 */
class CibusScraper extends BaseScraperWithBrowser<ICibusCredentials> {
  /**
   * Authenticate against the provider and establish a session.
   * @param credentials - Username, password, optional company and device token.
   * @returns Success, or a categorised failure.
   */
  public async login(credentials: ICibusCredentials): Promise<IScraperScrapingResult> {
    const prepared = await this.prepareLoginPage(credentials);
    if (prepared !== undefined) return prepared;

    const token = await this.mintRecaptchaToken();
    if (token === undefined) return createTimeoutError('reCAPTCHA token could not be minted');

    await this.postShowCompanyField(credentials, token);
    const outcome = await this.submitPassword(credentials, token);
    const resolved = await this.resolveAuthOutcome(outcome);
    if (resolved !== undefined) return resolved;
    return this.captureSession();
  }

  /**
   * Fetch the benefit account and its purchases.
   * @returns Accounts with transactions.
   */
  protected async fetchData(): Promise<IScraperScrapingResult> {
    const windows = this.monthWindows();
    const pages = await this.fetchWindows(windows);
    const deals = pages.flatMap(page => page?.data?.deals ?? []);
    const budget = pages.reduce<ICibusBudget>((acc, page) => page?.data ?? acc, {});
    this.bankLog.debug('fetched %d rows', deals.length);
    return { success: true, accounts: [this.buildAccount(deals, budget)] };
  }

  /**
   * Navigate to the portal, replay any device token, and reject Enterprise.
   * @param credentials - The scraper credentials.
   * @returns A failure result when the page cannot be used, else undefined.
   */
  private async prepareLoginPage(
    credentials: ICibusCredentials,
  ): Promise<IScraperScrapingResult | undefined> {
    await this.page.goto(PORTAL_URL, { waitUntil: 'domcontentloaded' });
    const stored = credentials.otpLongTermToken;
    if (stored !== undefined) await this.replayDeviceToken(stored);
    const isEnterprise = await this.detectEnterpriseRecaptcha();
    if (!isEnterprise) return undefined;
    return createGenericError('provider moved to reCAPTCHA Enterprise — minting path is invalid');
  }

  /**
   * Decide what a password-step outcome means.
   * @param outcome - The password step's status and challenge metadata.
   * @returns A failure result when login cannot continue, else undefined.
   */
  private async resolveAuthOutcome(
    outcome: IAuthOutcome,
  ): Promise<IScraperScrapingResult | undefined> {
    if (outcome.status === OTP_REQUIRED_STATUS) return this.answerChallenge(outcome);
    if (isAuthenticated(outcome.status)) return undefined;
    // Deliberately NOT distinguishing "wrong password" from "captcha score too
    // low": the provider returns an identical 401 for both, and guessing
    // between them would be a claim the response cannot support.
    const message = 'authentication rejected — credentials or captcha score';
    return { success: false, errorType: ScraperErrorTypes.InvalidPassword, errorMessage: message };
  }

  /**
   * POST to an allow-listed URL from inside the page context.
   * @param url - Absolute URL; must be on the allow-list.
   * @param data - JSON body.
   * @returns Parsed body, or null when the response was not usable JSON.
   */
  private async post<T>(url: string, data: Record<string, unknown>): Promise<T | null> {
    if (!isAllowedUrl(url)) throw new Error(`CibusScraper refused a non-allow-listed URL: ${url}`);
    const headers = { 'Content-Type': 'application/json' };
    const opts = { data: data as never, extraHeaders: headers, shouldIgnoreErrors: true };
    const res = await fetchPostWithinPageWithMetadata(this.page, url, opts);
    return (res.envelope ?? null) as T | null;
  }

  /**
   * Ask the provider whether this employer needs the `company` field.
   * @param credentials - The scraper credentials.
   * @param token - A freshly minted reCAPTCHA token.
   */
  private async postShowCompanyField(credentials: ICibusCredentials, token: string): Promise<void> {
    const body = { userLoginName: credentials.username, reCAPTCHAToken: token };
    await this.post(SHOW_COMPANY_FIELD_URL, body);
  }

  /**
   * Submit the password step.
   * @param credentials - The scraper credentials.
   * @param token - A freshly minted reCAPTCHA token.
   * @returns The status and any challenge metadata.
   */
  private async submitPassword(
    credentials: ICibusCredentials,
    token: string,
  ): Promise<IAuthOutcome> {
    const data = {
      username: credentials.username,
      password: credentials.password,
      company: credentials.company ?? '',
      reCAPTCHAToken: token,
    };
    return this.postAuth(data);
  }

  /**
   * POST the auth endpoint and read the status plus challenge metadata.
   * @param data - The JSON body for this auth step.
   * @returns The status and any challenge metadata.
   */
  private async postAuth(data: Record<string, unknown>): Promise<IAuthOutcome> {
    const headers = { 'Content-Type': 'application/json' };
    const opts = { data: data as never, extraHeaders: headers, shouldIgnoreErrors: true };
    const res = await fetchPostWithinPageWithMetadata(this.page, AUTH_TOKEN_URL, opts);
    const body = (res.envelope ?? {}) as { data?: IAuthOutcome };
    const inner = body.data;
    return {
      status: res.http.status,
      maskedInput: inner?.maskedInput,
      userInput1: inner?.userInput1,
    };
  }

  /**
   * Answer a one-time-code challenge, if a retriever is available.
   *
   * With no retriever this returns `TwoFactorRetrieverMissing` WITHOUT
   * completing the challenge — correct for an unattended run, and not only for
   * security reasons: the provider's code expires in minutes, so one minted at
   * 03:00 is dead by morning. The caller re-runs the whole login when a person
   * actually engages, which mints a fresh code.
   * @param challenge - Metadata from the password step.
   * @returns A failure result, or undefined once the code is accepted.
   */
  private async answerChallenge(
    challenge: IAuthOutcome,
  ): Promise<IScraperScrapingResult | undefined> {
    const retriever = this.options.otpCodeRetriever;
    if (retriever === undefined) return this.abandonChallenge();
    const code = await retriever(challenge.maskedInput ?? '');
    const token = await this.mintRecaptchaToken();
    if (token === undefined) return createTimeoutError('token could not be minted for the code');
    const outcome = await this.submitOtp(challenge, code, token);
    if (isAuthenticated(outcome.status)) return undefined;
    return this.rejectedOtp();
  }

  /**
   * Abandon an unattended run that hit a challenge.
   * @returns The typed missing-retriever failure.
   */
  private abandonChallenge(): IScraperScrapingResult {
    this.bankLog.debug('otp challenge raised and no retriever supplied — abandoning');
    const errorMessage = 'Cibus raised a one-time-code challenge and no otpCodeRetriever was set';
    return { success: false, errorType: ScraperErrorTypes.TwoFactorRetrieverMissing, errorMessage };
  }

  /**
   * Report a code the provider declined.
   * @returns The typed invalid-code failure.
   */
  private rejectedOtp(): IScraperScrapingResult {
    const errorMessage = 'the provider did not accept the one-time code';
    return { success: false, errorType: ScraperErrorTypes.InvalidOtp, errorMessage };
  }

  /**
   * Submit the one-time code, asking to be remembered.
   * @param challenge - Metadata from the password step.
   * @param code - The code a household member supplied.
   * @param token - A freshly minted reCAPTCHA token.
   * @returns The status of the code step.
   */
  private async submitOtp(
    challenge: IAuthOutcome,
    code: string,
    token: string,
  ): Promise<IAuthOutcome> {
    return this.postAuth({
      otpPin: code,
      userInput1: challenge.userInput1 ?? '',
      reCAPTCHAToken: token,
      // Measured, not assumed: the provider honours trustDevice on THIS step,
      // not the password step. Getting it wrong costs a challenge every run.
      trustDevice: true,
    });
  }

  /**
   * Read the session cookie and hand the device token to the caller.
   * @returns Success once a session cookie exists, otherwise a failure.
   */
  private async captureSession(): Promise<IScraperScrapingResult> {
    const cookies = await this.waitForDeviceCookie();
    const scoped = cookies.filter(isProviderCookie);
    const hasSession = scoped.some(cookie => cookie.name === SESSION_COOKIE_NAME);
    if (!hasSession) return createGenericError('no session cookie was issued');
    const device = scoped.find(isDeviceCookie);
    // Names and booleans only — a cookie value is a credential.
    this.bankLog.debug('login ok (cookies=%d, device=%s)', scoped.length, device !== undefined);
    await this.emitAuthFlow(device, scoped);
    return { success: true };
  }

  /**
   * Hand the device token out on the callback channel.
   *
   * The ONLY channel a credential leaves this scraper by. Never the scraping
   * result, which the caller persists and logs. Fires only when a token was
   * actually issued, so a caller never receives an empty value it would
   * faithfully persist as a wipe.
   * @param device - The device cookie, when one was issued.
   * @param scoped - All provider-scoped cookies.
   */
  private async emitAuthFlow(
    device: IBrowserCookie | undefined,
    scoped: IBrowserCookie[],
  ): Promise<void> {
    const callback = this.options.onAuthFlowComplete;
    if (device === undefined || callback === undefined) return;
    const longTermToken = `${device.name}=${device.value}`;
    await callback({ longTermToken, bearer: toCookieHeader(scoped) });
  }

  /**
   * Poll briefly for the ~30-day device token.
   *
   * Deliberately not fatal if it never arrives: a session without one still
   * works, it just costs a challenge next time. Failing the run over it would
   * trade a minor recurring annoyance for a hard outage.
   * @returns Whatever cookies exist once it appears or the window closes.
   */
  private async waitForDeviceCookie(): Promise<IBrowserCookie[]> {
    const opts = { timeout: DEVICE_COOKIE_TIMEOUT_MS, interval: 750 };
    const found = await waitUntil(() => this.cookiesWithDeviceToken(), 'device token', opts).catch(
      () => undefined,
    );
    if (found !== undefined) return found;
    this.bankLog.debug('device token absent — the next run will be challenged again');
    return this.page.context().cookies();
  }

  /**
   * Read cookies, returning them only once the device token is present.
   * @returns The cookie jar, or undefined while the token is still missing.
   */
  private async cookiesWithDeviceToken(): Promise<IBrowserCookie[] | undefined> {
    const cookies = await this.page.context().cookies();
    const hasDevice = cookies.some(isDeviceCookie);
    return hasDevice ? cookies : undefined;
  }

  /**
   * Replay a previously issued device token before authenticating.
   * @param token - Serialised `name=value` device cookie.
   */
  private async replayDeviceToken(token: string): Promise<void> {
    const separator = token.indexOf('=');
    if (separator <= 0) return;
    const name = token.slice(0, separator);
    const value = token.slice(separator + 1);
    const cookie = {
      name,
      value,
      domain: '.pluxee.co.il',
      path: '/',
      secure: true,
      httpOnly: true,
    };
    await this.page.context().addCookies([cookie]);
  }

  /**
   * Mint a reCAPTCHA v3 token from the page's own script.
   * @returns The token, or undefined when the API never became available.
   */
  private async mintRecaptchaToken(): Promise<string | undefined> {
    const minted = await this.page
      .evaluate(MINT_RECAPTCHA_TOKEN, RECAPTCHA_ACTION)
      .catch(() => undefined);
    return minted ?? undefined;
  }

  /**
   * Detect a migration to reCAPTCHA Enterprise.
   *
   * Enterprise mints through a different namespace, so the path above would
   * stop working. Surfaced as its own error rather than as an unexplained rise
   * in 401s.
   * @returns True when the Enterprise namespace is present.
   */
  private async detectEnterpriseRecaptcha(): Promise<boolean> {
    const isEnterprise = await this.page.evaluate(READ_ENTERPRISE_FLAG).catch(() => false);
    return isEnterprise;
  }

  /**
   * Month-sized windows covering the configured scrape range.
   *
   * Chunked regardless of whether the endpoint paginates. Cheap, makes
   * truncation self-limiting, and removes a dependency on an assumption whose
   * failure would be silent.
   * @returns One `[from, to]` pair per calendar month.
   */
  private monthWindows(): { from: string; to: string }[] {
    const start = moment(this.options.startDate);
    const end = moment();
    const cursor = start.clone().startOf('month');
    const windows: { from: string; to: string }[] = [];
    while (cursor.isSameOrBefore(end, 'month')) {
      const from = moment.max(cursor.clone().startOf('month'), start);
      const to = moment.min(cursor.clone().endOf('month'), end);
      windows.push({ from: from.format('DD/MM/YYYY'), to: to.format('DD/MM/YYYY') });
      cursor.add(1, 'month');
    }
    return windows;
  }

  /**
   * Fetch every month window.
   * @param windows - Month-sized date ranges.
   * @returns One response per window.
   */
  private async fetchWindows(
    windows: { from: string; to: string }[],
  ): Promise<(ICibusDataResponse | null)[]> {
    const requests = windows.map(window => this.fetchWindow(window));
    return Promise.all(requests);
  }

  /**
   * Fetch one month window.
   * @param window - A date range in the provider's own format.
   * @returns The response body, or null when it was not usable JSON.
   */
  private async fetchWindow(window: {
    from: string;
    to: string;
  }): Promise<ICibusDataResponse | null> {
    const body = { type: 'prx_user_deals', from_date: window.from, to_date: window.to };
    return this.post<ICibusDataResponse>(DATA_URL, body);
  }

  /**
   * Build the single benefit account this provider exposes.
   * @param deals - Every purchase row fetched.
   * @param budget - The budget block from the last response that carried one.
   * @returns One account with its transactions.
   */
  private buildAccount(deals: ICibusDeal[], budget: ICibusBudget): ITransactionsAccount {
    const countable = deals.filter(isCountable);
    const txns = countable.map(deal => toTransaction(deal, this.options));
    const extra = { allowance: toNumber(budget.CreatioBudget), expiresOn: budget.ExpirationDate };
    return {
      // Deliberately a stable synthetic label, never the provider's own card
      // identifier: the consumer keys stored rows on its own account id, and
      // the real identifier is sensitive.
      accountNumber: 'cibus',
      balance: toNumber(budget.CurrBudget),
      providerExtra: extra,
      txns,
    };
  }
}

export default CibusScraper;
