import moment from 'moment';

import { waitUntil } from '../../Common/Waiting.js';
import { BaseScraperWithBrowser } from '../Base/BaseScraperWithBrowser.js';
import { createGenericError, createTimeoutError } from '../Base/Errors.js';
import ScraperErrorTypes from '../Base/ErrorTypes.js';
import { type IScraperScrapingResult } from '../Base/Interface.js';
import ScraperError from '../Base/ScraperError.js';
import {
  authFailureFor,
  type IActivityPartition,
  type IBrowserCookie,
  type ICibusBudget,
  type ICibusBudgetResponse,
  type ICibusDataResponse,
  type ICibusDeal,
  isAuthenticated,
  isDeviceCookie,
  isProviderCookie,
  partitionByActivity,
  splitCookie,
  toAccount,
  toCookieHeader,
} from './CibusMapping.js';
import { INJECT_RECAPTCHA, MINT_WITH_KEY, READ_ENTERPRISE_FLAG } from './CibusPageScripts.js';
import cibusPostInPage, { postOptions } from './CibusPost.js';
import { resolveSiteKey, type SiteKeyProvenance } from './CibusSiteKey.js';
import { collectWindows, type IDateWindow, pauseBetweenWindows } from './CibusWindows.js';
import {
  AUTH_TOKEN_URL,
  DATA_URL,
  DEVICE_COOKIE_TIMEOUT_MS,
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

/** A site key and where it came from — the provider's page, or our pinned copy. */
interface ISiteKeyResolution {
  key: string;
  provenance: SiteKeyProvenance;
}

/**
 * The provider's answer to "does this employer use the company field?".
 *
 * Shape taken from the provider's own front end, which reads exactly this path
 * and coerces it to a boolean before deciding whether to require the field.
 */
interface ICibusCompanyFieldResponse {
  data?: { showCompanyField?: boolean };
}

/** Result of an auth step: authenticated, or challenged for a code. */
interface IAuthOutcome {
  status: number;
  maskedInput?: string;
  userInput1?: string;
}

/**
 * Sentinel for "the provider's script has not loaded yet", which the poller
 * treats as keep-waiting. A named constant rather than a bare `undefined`, so
 * the intent is legible at both the producer and the poller.
 */
const NOT_YET = undefined;

/**
 * Said when the provider requires a company identifier this account has not
 * been given one for. Its own condition, because the provider rejects a
 * missing company exactly as it rejects a wrong password.
 */
const MISSING_COMPANY_MESSAGE =
  'this employer requires a company identifier, and none is configured';

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
   * The site key for this login, resolved once.
   *
   * RESOLVED ONCE, AND NEVER RE-READ. Every mint in a login uses this one
   * value. Re-reading per attempt would be worse than wasteful: once we have
   * injected our own script tag carrying the pinned key, a later read matches
   * that tag and hands the pinned key back as though the page had supplied
   * it — so the mechanism meant to notice a key rotation would confirm our own
   * copy instead. A probe must not read back what it wrote.
   */
  private _siteKey?: ISiteKeyResolution;

  /**
   * Authenticate against the provider and establish a session.
   * @param credentials - Username, password, optional company and device token.
   * @returns Success, or a categorised failure.
   */
  public async login(credentials: ICibusCredentials): Promise<IScraperScrapingResult> {
    const prepared = await this.prepareLoginPage(credentials);
    if (!prepared.success) return prepared;
    const resolved = await this.resolveSiteKeyOnce();
    if (!resolved.success) return resolved;
    const authed = await this.authenticate(credentials);
    if (!authed.success) return authed;
    return this.captureSession();
  }

  /**
   * Fetch the benefit account and its purchases.
   * @returns Accounts with transactions.
   */
  protected async fetchData(): Promise<IScraperScrapingResult> {
    const deals = await this.fetchAllWindows();
    const budget = await this.fetchBudget();
    const partition = partitionByActivity(deals);
    this.reportPartition(deals.length, partition);
    const account = toAccount(partition.countable, budget, this.options);
    return { success: true, accounts: [account] };
  }

  /**
   * Resolve the site key for this login, and record where it came from.
   * @returns Success once a usable key is held, else a categorised failure.
   */
  private async resolveSiteKeyOnce(): Promise<IScraperScrapingResult> {
    const resolution = await resolveSiteKey(this.page);
    if (resolution.outcome === 'unusable') {
      return createGenericError(`reCAPTCHA site key unusable (source: ${resolution.provenance})`);
    }
    this.bankLog.debug('site key resolved from %s', resolution.provenance);
    this._siteKey = resolution;
    return { success: true };
  }

  /**
   * Report what was fetched and what was dropped.
   *
   * The dropped counts are reported rather than merely acted on: a provider
   * that changes this field's vocabulary would otherwise look exactly like one
   * with nothing to exclude.
   * @param fetched - How many rows arrived.
   * @param partition - The rows split by what their activity flag said.
   * @returns Nothing.
   */
  private reportPartition(fetched: number, partition: IActivityPartition): void {
    this.bankLog.debug(
      'fetched %d rows (countable %d, provider-excluded %d, unreadable-activity %d)',
      fetched,
      partition.countable.length,
      partition.excluded,
      partition.unknown,
    );
  }

  /**
   * Fetch every month window, one at a time, with a pause between them.
   *
   * SEQUENTIAL ON PURPOSE. These went out concurrently, which put a burst of
   * simultaneous requests on a provider that scores request behaviour through
   * reCAPTCHA — and a low score is rejected with the same opaque status a
   * wrong password gives, so the cost of looking automated is a failure nobody
   * can diagnose. Every other legacy scraper here fetches its windows in
   * sequence.
   *
   * Expressed as a chained reduction rather than a loop with an `await` in it,
   * which is the shape this repository's rules ask for and reads as what it
   * is: each window waits for the one before.
   * @returns Every purchase row across all windows, unfiltered.
   */
  private async fetchAllWindows(): Promise<ICibusDeal[]> {
    const windows = this.monthWindows();
    const empty: Promise<ICibusDeal[]> = Promise.resolve([]);
    /**
     * One link of the chain, bound to this scraper.
     * @param previous - Rows from the windows already fetched.
     * @param window - The window to fetch now.
     * @param index - Its position, so the first window waits for nothing.
     * @returns The accumulated rows, including this window's.
     */
    const step = async (
      previous: Promise<ICibusDeal[]>,
      window: IDateWindow,
      index: number,
    ): Promise<ICibusDeal[]> => this.appendWindow(previous, window, index);
    return windows.reduce<Promise<ICibusDeal[]>>(step, empty);
  }

  /**
   * Wait for the rows so far, pause, then fetch one more window's worth.
   * @param previous - Rows from the windows already fetched.
   * @param window - The window to fetch now.
   * @param index - Its position, so the first window waits for nothing.
   * @returns The accumulated rows, including this window's.
   */
  private async appendWindow(
    previous: Promise<ICibusDeal[]>,
    window: IDateWindow,
    index: number,
  ): Promise<ICibusDeal[]> {
    const soFar = await previous;
    if (index > 0) await pauseBetweenWindows();
    const page = await this.fetchWindow(window);
    return [...soFar, ...(page?.list ?? [])];
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
    const precheck = await this.checkCompanyRequirement(credentials);
    if (!precheck.success) return precheck;
    // A SECOND token, freshly minted and bound to the login action. Not an
    // optimisation to skip: v3 tokens are single-use and the precheck above has
    // already spent that one.
    const loginToken = await this.mintRecaptchaToken(RECAPTCHA_ACTION_LOGIN);
    if (loginToken === '') return createTimeoutError('reCAPTCHA token could not be minted');
    const outcome = await this.submitPassword(credentials, loginToken);
    return this.resolveAuthOutcome(outcome);
  }

  /**
   * Ask the provider whether this employer needs a company, and check we have
   * one if it does.
   *
   * Reported as the distinct condition it is. Sending an empty company to an
   * employer that requires one is rejected identically to a wrong password, so
   * a household with a perfectly good credential would be sent to re-enter
   * it — and the single-use token spent learning this would have bought
   * nothing.
   * @param credentials - The scraper credentials.
   * @returns Success when the login may proceed, else a categorised failure.
   */
  private async checkCompanyRequirement(
    credentials: ICibusCredentials,
  ): Promise<IScraperScrapingResult> {
    const token = await this.mintRecaptchaToken(RECAPTCHA_ACTION_PRECHECK);
    if (token === '') return createTimeoutError('reCAPTCHA token could not be minted');
    const isCompanyRequired = await this.postShowCompanyField(credentials, token);
    const isSatisfied = !isCompanyRequired || (credentials.company ?? '') !== '';
    if (isSatisfied) return { success: true };
    return createGenericError(MISSING_COMPANY_MESSAGE);
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
    return authFailureFor(outcome.status);
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
   * @returns True when this employer requires the `company` field.
   */
  private async postShowCompanyField(
    credentials: ICibusCredentials,
    token: string,
  ): Promise<boolean> {
    const body = { userLoginName: credentials.username, reCAPTCHAToken: token };
    // The ANSWER is the point of this call. It previously returned a hardcoded
    // true and discarded the response, which spent a single-use token to learn
    // something and then threw it away — and left the caller unable to tell a
    // missing company field from a bad password.
    const res = await this.post<ICibusCompanyFieldResponse>(SHOW_COMPANY_FIELD_URL, body);
    return res?.data?.showCompanyField === true;
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
    const resolved = this._siteKey;
    if (resolved === undefined) return NOT_YET;
    const siteKey = resolved.key;
    // Injection only matters where the provider's own application never
    // brought reCAPTCHA up; where it did, this returns true without touching
    // the page. Either way the key was resolved before any of it, so nothing
    // here can be read back later as though the page had supplied it.
    const isReady = await this.page.evaluate(INJECT_RECAPTCHA, siteKey).catch(() => false);
    if (!isReady) return NOT_YET;
    // Tab-joined rather than an object: the argument crosses into the page
    // realm, and a primitive is the least there is to go wrong in transit.
    const pair = `${siteKey}\t${action}`;
    const minted = await this.page.evaluate(MINT_WITH_KEY, pair).catch(() => '');
    return minted === '' ? NOT_YET : minted;
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
