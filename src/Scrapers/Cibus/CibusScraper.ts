import moment from 'moment';

import { waitUntil } from '../../Common/Waiting.js';
import { BaseScraperWithBrowser } from '../Base/BaseScraperWithBrowser.js';
import { createGenericError, createTimeoutError } from '../Base/Errors.js';
import ScraperErrorTypes from '../Base/ErrorTypes.js';
import { type IScraperScrapingResult } from '../Base/Interface.js';
import ScraperError from '../Base/ScraperError.js';
import {
  type IBrowserCookie,
  type ICibusBudget,
  type ICibusBudgetResponse,
  type ICibusDataResponse,
  isAuthenticated,
  isDeviceCookie,
  isProviderCookie,
  splitCookie,
  toAccount,
  toCookieHeader,
} from './CibusMapping.js';
import {
  ENSURE_RECAPTCHA,
  MINT_WITH_KEY,
  READ_ENTERPRISE_FLAG,
  READ_SITE_KEY,
} from './CibusPageScripts.js';
import cibusPostInPage, { type ICibusPostOptions } from './CibusPost.js';
import {
  APPLICATION_ID,
  AUTH_TOKEN_URL,
  DATA_URL,
  DEVICE_COOKIE_TIMEOUT_MS,
  FALLBACK_SITE_KEY,
  isAllowedUrl,
  OTP_REQUIRED_STATUS,
  PORTAL_URL,
  RECAPTCHA_ACTION_LOGIN,
  RECAPTCHA_ACTION_PRECHECK,
  RECAPTCHA_READY_TIMEOUT_MS,
  SESSION_COOKIE_NAME,
  SHOW_COMPANY_FIELD_URL,
} from './Config/CibusApiConfig.js';

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

/** Result of an auth step: authenticated, or challenged for a code. */
interface IAuthOutcome {
  status: number;
  maskedInput?: string;
  userInput1?: string;
}

/** A date range in the provider's own format. */
interface IDateWindow {
  from: string;
  to: string;
}

/**
 * Build the in-page POST options every request shares.
 * @param data - JSON body.
 * @returns Options for the in-page fetch helper.
 */
function postOptions(data: Record<string, unknown>): ICibusPostOptions {
  // Sent the way the provider's own front end sends them. `application-id` in
  // particular is not optional: without it the API answers a valid session with
  // an empty result rather than an error, which reads as "no transactions".
  const extraHeaders = {
    'Content-Type': 'application/json',
    accept: 'application/json, text/plain, */*',
    'accept-language': 'he',
    'application-id': APPLICATION_ID,
  };
  return { data, extraHeaders };
}

/**
 * Clamp one calendar month to the configured scrape range.
 * @param cursor - The month being emitted.
 * @param start - Earliest date the caller asked for.
 * @param end - Latest date the caller asked for.
 * @returns The clamped window, in the provider's date format.
 */
function toWindow(cursor: moment.Moment, start: moment.Moment, end: moment.Moment): IDateWindow {
  const monthStart = cursor.clone().startOf('month');
  const monthEnd = cursor.clone().endOf('month');
  const from = moment.max(monthStart, start);
  const to = moment.min(monthEnd, end);
  return { from: from.format('DD/MM/YYYY'), to: to.format('DD/MM/YYYY') };
}

/**
 * Walk the configured range one calendar month at a time.
 * @param start - Earliest date the caller asked for.
 * @param end - Latest date the caller asked for.
 * @returns One window per month, clamped to the range.
 */
function collectWindows(start: moment.Moment, end: moment.Moment): IDateWindow[] {
  const cursor = start.clone().startOf('month');
  const windows: IDateWindow[] = [];
  while (cursor.isSameOrBefore(end, 'month')) {
    const window = toWindow(cursor, start, end);
    windows.push(window);
    cursor.add(1, 'month');
  }
  return windows;
}

/**
 * Sentinel for "the provider's script has not loaded yet", which the poller
 * treats as keep-waiting. A named constant rather than a bare `undefined`, so
 * the intent is legible at both the producer and the poller.
 */
const NOT_YET = undefined;

/**
 * Report a code the provider declined.
 * @returns The typed invalid-code failure.
 */
function rejectedOtp(): IScraperScrapingResult {
  const errorMessage = 'the provider did not accept the one-time code';
  return { success: false, errorType: ScraperErrorTypes.InvalidOtp, errorMessage };
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
    if (!prepared.success) return prepared;
    const authed = await this.authenticate(credentials);
    if (!authed.success) return authed;
    return this.captureSession();
  }

  /**
   * Fetch the benefit account and its purchases.
   * @returns Accounts with transactions.
   */
  protected async fetchData(): Promise<IScraperScrapingResult> {
    const windows = this.monthWindows();
    const requests = windows.map(async window => this.fetchWindow(window));
    const pages = await Promise.all(requests);
    const deals = pages.flatMap(page => page?.list ?? []);
    const budget = await this.fetchBudget();
    this.bankLog.debug('fetched %d rows', deals.length);
    const account = toAccount(deals, budget, this.options);
    return { success: true, accounts: [account] };
  }

  /**
   * Fetch the benefit budget — its own endpoint, not part of the purchase feed.
   * @returns The current period's budget, or an empty object when unprovisioned.
   */
  private async fetchBudget(): Promise<ICibusBudget> {
    const body = { type: 'prx_get_budgets' };
    const res = await this.post<ICibusBudgetResponse>(DATA_URL, body);
    return res?.data?.[0] ?? {};
  }

  /**
   * Mint a token and run both auth steps.
   * @param credentials - The scraper credentials.
   * @returns Success once authenticated, else a categorised failure.
   */
  private async authenticate(credentials: ICibusCredentials): Promise<IScraperScrapingResult> {
    const precheck = await this.mintRecaptchaToken(RECAPTCHA_ACTION_PRECHECK);
    if (precheck === '') return createTimeoutError('reCAPTCHA token could not be minted');
    await this.postShowCompanyField(credentials, precheck);
    // A SECOND token, freshly minted and bound to the login action. Not an
    // optimisation to skip: v3 tokens are single-use and the precheck above has
    // already spent that one.
    const loginToken = await this.mintRecaptchaToken(RECAPTCHA_ACTION_LOGIN);
    if (loginToken === '') return createTimeoutError('reCAPTCHA token could not be minted');
    const outcome = await this.submitPassword(credentials, loginToken);
    return this.resolveAuthOutcome(outcome);
  }

  /**
   * Navigate to the portal, replay any device token, and reject Enterprise.
   * @param credentials - The scraper credentials.
   * @returns Success when the page is usable, else a categorised failure.
   */
  private async prepareLoginPage(credentials: ICibusCredentials): Promise<IScraperScrapingResult> {
    await this.page.goto(PORTAL_URL, { waitUntil: 'domcontentloaded' });
    const stored = credentials.otpLongTermToken;
    if (stored !== undefined) await this.replayDeviceToken(stored);
    const isEnterprise = await this.detectEnterpriseRecaptcha();
    if (!isEnterprise) return { success: true };
    return createGenericError('provider moved to reCAPTCHA Enterprise — minting path is invalid');
  }

  /**
   * Decide what a password-step outcome means.
   * @param outcome - The password step's status and challenge metadata.
   * @returns Success when authenticated, else a categorised failure.
   */
  private async resolveAuthOutcome(outcome: IAuthOutcome): Promise<IScraperScrapingResult> {
    if (outcome.status === OTP_REQUIRED_STATUS) return this.answerChallenge(outcome);
    const isAuthed = isAuthenticated(outcome.status);
    if (isAuthed) return { success: true };
    // Deliberately NOT distinguishing "wrong password" from "captcha score too
    // low": the provider returns an identical 401 for both, and guessing
    // between them would be a claim the response cannot support.
    const errorMessage = 'authentication rejected — credentials or captcha score';
    return { success: false, errorType: ScraperErrorTypes.InvalidPassword, errorMessage };
  }

  /**
   * POST to an allow-listed URL from inside the page context.
   * @param url - Absolute URL; must be on the allow-list.
   * @param data - JSON body.
   * @returns Parsed body, or undefined when the response was not usable JSON.
   */
  private async post<T>(url: string, data: Record<string, unknown>): Promise<T | undefined> {
    const isUrlAllowed = isAllowedUrl(url);
    if (!isUrlAllowed) throw new ScraperError(`Cibus refused a non-allow-listed URL: ${url}`);
    const opts = postOptions(data);
    const res = await cibusPostInPage(this.page, url, opts);
    return (res.envelope ?? undefined) as T | undefined;
  }

  /**
   * Ask the provider whether this employer needs the `company` field.
   * @param credentials - The scraper credentials.
   * @param token - A freshly minted reCAPTCHA token.
   * @returns True once the call has been made.
   */
  private async postShowCompanyField(
    credentials: ICibusCredentials,
    token: string,
  ): Promise<boolean> {
    const body = { userLoginName: credentials.username, reCAPTCHAToken: token };
    await this.post(SHOW_COMPANY_FIELD_URL, body);
    return true;
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
    const company = credentials.company ?? '';
    const identity = { username: credentials.username, password: credentials.password, company };
    return this.postAuth({ ...identity, reCAPTCHAToken: token });
  }

  /**
   * POST the auth endpoint and read the status plus challenge metadata.
   * @param data - The JSON body for this auth step.
   * @returns The status and any challenge metadata.
   */
  private async postAuth(data: Record<string, unknown>): Promise<IAuthOutcome> {
    const opts = postOptions(data);
    const res = await cibusPostInPage(this.page, AUTH_TOKEN_URL, opts);
    const body = (res.envelope ?? {}) as { data?: IAuthOutcome };
    const inner = body.data;
    const status = res.status;
    return { status, maskedInput: inner?.maskedInput, userInput1: inner?.userInput1 };
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
   * @returns Success once the code is accepted, else a categorised failure.
   */
  private async answerChallenge(challenge: IAuthOutcome): Promise<IScraperScrapingResult> {
    const retriever = this.options.otpCodeRetriever;
    if (retriever === undefined) return this.abandonChallenge();
    const hint = challenge.maskedInput ?? '';
    const code = await retriever(hint);
    return this.submitAndVerifyOtp(challenge, code);
  }

  /**
   * Mint a fresh token, submit the code, and read the verdict.
   * @param challenge - Metadata from the password step.
   * @param code - The code a household member supplied.
   * @returns Success when accepted, else a categorised failure.
   */
  private async submitAndVerifyOtp(
    challenge: IAuthOutcome,
    code: string,
  ): Promise<IScraperScrapingResult> {
    const token = await this.mintRecaptchaToken(RECAPTCHA_ACTION_LOGIN);
    if (token === '') return createTimeoutError('token could not be minted for the code');
    const outcome = await this.submitOtp(challenge, code, token);
    const isAccepted = isAuthenticated(outcome.status);
    return isAccepted ? { success: true } : rejectedOtp();
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
    const userInput1 = challenge.userInput1 ?? '';
    // Measured, not assumed: the provider honours trustDevice on THIS step, not
    // the password step. Getting it wrong costs a challenge on every run.
    return this.postAuth({ otpPin: code, userInput1, reCAPTCHAToken: token, trustDevice: true });
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
   * @returns True when a token was handed over.
   */
  private async emitAuthFlow(
    device: IBrowserCookie | undefined,
    scoped: IBrowserCookie[],
  ): Promise<boolean> {
    const callback = this.options.onAuthFlowComplete;
    if (device === undefined || callback === undefined) return false;
    const bearer = toCookieHeader(scoped);
    await callback({ longTermToken: `${device.name}=${device.value}`, bearer });
    return true;
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
    const poll = this.cookiesWithDeviceToken.bind(this);
    const found = await waitUntil(poll, 'cibus device token', opts).catch(() => undefined);
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
   * @returns True when a cookie was installed.
   */
  private async replayDeviceToken(token: string): Promise<boolean> {
    const parts = splitCookie(token);
    if (!parts.ok) return false;
    const scope = { domain: '.pluxee.co.il', path: '/', secure: true, httpOnly: true };
    const cookie = { name: parts.name, value: parts.value, ...scope };
    await this.page.context().addCookies([cookie]);
    return true;
  }

  /**
   * Mint a reCAPTCHA v3 token from the page's own script.
   * @param action - The v3 action to bind this token to. One token per request:
   *   a v3 token is single-use, so reusing one across two calls gets the second
   *   rejected as an opaque 401.
   * @returns The token, or '' when the API never became available.
   */
  private async mintRecaptchaToken(action: string): Promise<string> {
    // POLLED, because the page is opened at `domcontentloaded` and the
    // provider's reCAPTCHA script arrives after it. An earlier revision read
    // the key once, immediately, and reported "token could not be minted" on a
    // page that was merely still loading — a live run caught it. `ready()`
    // would be the library's own answer, but its callback form cannot be
    // expressed without a promise executor, so this polls the whole mint
    // instead and gets the same guarantee without the banned shape.
    const opts = { timeout: RECAPTCHA_READY_TIMEOUT_MS, interval: 500 };
    /**
     * One poll attempt, bound to the action this mint is for.
     * @returns The token, or the keep-waiting sentinel.
     */
    const poll = async (): Promise<typeof NOT_YET | string> => this.tryMintToken(action);
    const minted = await waitUntil(poll, 'cibus recaptcha token', opts).catch(() => '');
    return minted;
  }

  /**
   * One attempt at minting, for the poller above.
   * @param action - The v3 action to bind this token to.
   * @returns The token, or undefined while the provider's script is absent.
   */
  private async tryMintToken(action: string): Promise<typeof NOT_YET | string> {
    const siteKey = await this.resolveSiteKey();
    const isReady = await this.page.evaluate(ENSURE_RECAPTCHA, siteKey).catch(() => false);
    if (!isReady) return NOT_YET;
    // Tab-joined rather than an object: the argument crosses into the page
    // realm, and a primitive is the least there is to go wrong in transit.
    const pair = `${siteKey}\t${action}`;
    const minted = await this.page.evaluate(MINT_WITH_KEY, pair).catch(() => '');
    return minted === '' ? NOT_YET : minted;
  }

  /**
   * The provider's public site key — from the live page when its application
   * has loaded, otherwise the pinned fallback.
   *
   * Reading it first means a rotation is picked up automatically; falling back
   * means a page whose application never boots is still usable. The fallback is
   * logged every time, so a rotation cannot hide behind it.
   * @returns The site key to mint against.
   */
  private async resolveSiteKey(): Promise<string> {
    const fromPage = await this.page.evaluate(READ_SITE_KEY).catch(() => '');
    if (fromPage !== '') return fromPage;
    this.bankLog.debug('site key not present in page — using pinned fallback');
    return FALLBACK_SITE_KEY;
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
    const evaluated = this.page.evaluate(READ_ENTERPRISE_FLAG);
    return evaluated.catch(() => false);
  }

  /**
   * Month-sized windows covering the configured scrape range.
   *
   * Chunked regardless of whether the endpoint paginates. Cheap, makes
   * truncation self-limiting, and removes a dependency on an assumption whose
   * failure would be silent.
   * @returns One window per calendar month.
   */
  private monthWindows(): IDateWindow[] {
    const start = moment(this.options.startDate);
    const end = moment();
    return collectWindows(start, end);
  }

  /**
   * Fetch one month window.
   * @param window - A date range in the provider's own format.
   * @returns The response body, or undefined when it was not usable JSON.
   */
  private async fetchWindow(window: IDateWindow): Promise<ICibusDataResponse | undefined> {
    const body = { type: 'prx_user_deals', from_date: window.from, to_date: window.to };
    return this.post<ICibusDataResponse>(DATA_URL, body);
  }
}

export default CibusScraper;
export type { ICibusCredentials };
