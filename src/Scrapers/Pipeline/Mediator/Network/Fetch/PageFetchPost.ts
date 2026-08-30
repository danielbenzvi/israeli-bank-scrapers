/**
 * Fetch sub-module — in-page POST requests (Playwright page.evaluate).
 *
 * Cookies + CORS handled by the browser context. The SPA pivot in
 * ScrapePhase.PRE ensures the page is on the correct origin.
 */

import { randomUUID } from 'node:crypto';

import type { Frame, Page } from 'playwright-core';

import type { Nullable } from '../../../../Base/Interfaces/CallbackTypes.js';
import { redactUrlFull } from '../../../Types/PiiRedactor.js';
import { timeoutPromise } from '../../Timing/TimingActions.js';
import {
  JSON_CONTENT_TYPE,
  NETWORK_FETCH_PAGE_TIMEOUT_MS,
  NETWORK_FETCH_TIMEOUT_MS,
} from '../FetchConfig.js';
import type { PageFetchTuple } from './Bounce.js';
import { assertNotBounced, toResponseFacts } from './Bounce.js';
import type { JsonValue } from './Headers.js';
import { LOG, logApiCall, logResponseIssues } from './Logging.js';
import { parsePostResult } from './ParseResult.js';

/** Options for fetchPostWithinPage. */
export interface IFetchPostOptions {
  data: Record<string, JsonValue> | readonly JsonValue[];
  extraHeaders?: Record<string, string>;
  shouldIgnoreErrors?: boolean;
  /**
   * Override the in-page request deadline, in milliseconds.
   *
   * Every in-page POST is already bounded by `NETWORK_FETCH_PAGE_TIMEOUT_MS`;
   * this narrows that budget for a caller that issues many requests under one
   * wall-clock ceiling and must know what each one may cost. Omitted or
   * non-positive keeps the library-wide default.
   */
  timeoutMs?: number;
  /**
   * Send the request the way the site's own SPA would.
   *
   * Adds a per-request trace identifier and, when absent, the client
   * correlation cookie the front end sets on first load. Some endpoints answer
   * a bare replayed POST with a challenge or a redirect even on a valid
   * session, because the request does not look like it came from their own
   * front end.
   */
  firstPartyContract?: boolean;
}

/** Arguments for POST requests via Playwright's API client. */
export interface IPostEvaluateArgs {
  innerUrl: string;
  innerDataJson: string;
  innerExtraHeaders: Record<string, string>;
  timeoutMs: number;
  /**
   * Candidate value for the SPA's client-correlation cookie, minted Node-side.
   *
   * Present only when the caller asked for the first-party contract. The cookie
   * is planted by {@link primeFirstPartyCookie} before the POST rather than
   * inside it, so the serialised in-page function stays exactly what it was.
   */
  innerCorrelationId?: string;
}

/**
 * POST fetch inside the browser context (cookies + CORS handled by browser).
 *
 * Serialised into the page, so it may reference only its argument and browser
 * globals; the timeout arrives as data rather than a closed-over import.
 * @param args - The URL, data, extra headers, and abort budget.
 * @returns [responseText, statusCode, contentType, redirected, finalUrl].
 */
async function doPostFetch(args: IPostEvaluateArgs): Promise<PageFetchTuple> {
  // No hardcoded headers: `args.innerExtraHeaders` (built by
  // `buildDiscoveredHeaders` from captured SPA traffic) is the
  // single source of truth for Content-Type / Referer / X-XSRF-
  // TOKEN / pageUuid / etc. Hapoalim rejects (302) any mismatch
  // between the SPA's captured shape and the replayed POST —
  // live evidence: run 15-05-2026 — hardcoded `Content-Type`
  // value collided with captured `content-type`; only the
  // captured value gets the API to 200.
  const headers = { ...args.innerExtraHeaders };
  const signal = AbortSignal.timeout(args.timeoutMs);
  const init = { method: 'POST', body: args.innerDataJson, credentials: 'include' as const };
  const response = await fetch(args.innerUrl, { ...init, headers, signal });
  const text = response.status === 204 ? '' : await response.text();
  const type = response.headers.get('content-type') ?? '';
  return [text, response.status, type, response.redirected, response.url] as const;
}

/** Pino payload shape for the doPostFetch.headers diagnostic. */
interface IDoPostFetchHeadersPayload {
  event: string;
  url: string;
  headerNames: string[];
  bodyLen: number;
}

/**
 * Sort header names alphabetically — pulled out so the payload builder
 * fits the 10-LoC cap.
 * @param headers - Captured extra-headers map.
 * @returns Alphabetically sorted header names.
 */
function sortHeaderNames(headers: Record<string, string>): string[] {
  return Object.keys(headers).sort((a, b): number => a.localeCompare(b));
}

/**
 * Build the doPostFetch.headers diagnostic payload — pulled out so
 * {@link logDoPostFetchHeaders} fits the 10-LoC cap.
 * @param args - Post-evaluate args (url + headers + body).
 * @returns Pino debug payload.
 */
function buildDoPostFetchHeadersPayload(args: IPostEvaluateArgs): IDoPostFetchHeadersPayload {
  return {
    event: 'doPostFetch.headers',
    url: args.innerUrl,
    headerNames: sortHeaderNames(args.innerExtraHeaders),
    bodyLen: args.innerDataJson.length,
  };
}

/**
 * Emit the doPostFetch.headers diagnostic line for VisaCal/Hapoalim debug.
 * @param args - Post-evaluate args (url + headers + body).
 * @returns True after emission completes.
 */
function logDoPostFetchHeaders(args: IPostEvaluateArgs): boolean {
  const payload = buildDoPostFetchHeadersPayload(args);
  LOG.debug(payload);
  return true;
}

/**
 * In-page: plant the SPA's client-correlation cookie when the page has none.
 *
 * Serialised into the page, so it may reference only its argument and browser
 * globals — the candidate value is minted Node-side and arrives as data.
 * @param candidate - Cookie value to plant when none is already present.
 * @returns True when the page already carried the cookie, false when planted.
 */
function doEnsureCorrelationCookie(candidate: string): boolean {
  const parts = document.cookie.split(';');
  const wasPresent = parts.some((part): boolean => part.trim().startsWith('bckey='));
  if (wasPresent) return true;
  document.cookie = `bckey=${candidate}; Max-Age=1800; Path=/; SameSite=Lax; Secure`;
  return false;
}

/**
 * Plant the correlation cookie, then POST.
 *
 * @param context - The Playwright page or frame to evaluate in.
 * @param args - Post-evaluate args; carries the candidate cookie value.
 * @param candidate - The cookie value to plant when the page carries none.
 * @returns The evaluator response tuple.
 */
async function primeThenPost(
  context: Page | Frame,
  args: IPostEvaluateArgs,
  candidate: string,
): Promise<PageFetchTuple> {
  await context.evaluate(doEnsureCorrelationCookie, candidate);
  return context.evaluate(doPostFetch, args);
}

/**
 * Start the in-page POST, giving the page the client-correlation cookie its own
 * front end sets on first load when the caller asked for the first-party
 * contract.
 *
 * The cookie is planted by its own evaluate rather than inside
 * {@link doPostFetch}, so that function stays byte for byte what it was: an
 * in-page conditional would have had to run on every request to serve the few
 * that need it.
 *
 * Deliberately NOT `async`: a caller that wants no cookie must reach
 * `context.evaluate` in the same turn it always did. An `await` here would cost
 * every request a microtask before the request is even issued, which is enough
 * to reorder it against an abort raised by the caller.
 * @param context - The Playwright page or frame to evaluate in.
 * @param args - Post-evaluate args.
 * @returns The pending evaluator response tuple.
 */
function startPostEvaluate(
  context: Page | Frame,
  args: IPostEvaluateArgs,
): Promise<PageFetchTuple> {
  const candidate = args.innerCorrelationId;
  if (candidate === undefined) return context.evaluate(doPostFetch, args);
  return primeThenPost(context, args, candidate);
}

/**
 * POST request via page.evaluate — runs inside the browser context.
 * The SPA pivot in ScrapePhase.PRE ensures the page is on the correct origin.
 * @param context - The Playwright page or frame to execute the fetch in.
 * @param args - The URL, data, and extra headers.
 * @returns The evaluator response tuple.
 */
export async function runPostEvaluate(
  context: Page | Frame,
  args: IPostEvaluateArgs,
): Promise<PageFetchTuple> {
  logDoPostFetchHeaders(args);
  const pending = startPostEvaluate(context, args);
  const description = `in-page POST ${redactUrlFull(args.innerUrl)}`;
  return timeoutPromise(NETWORK_FETCH_TIMEOUT_MS, pending, description);
}

/** Conservative defaults used ONLY when the caller omitted `extraHeaders`. */
const DEFAULT_JSON_HEADERS: Record<string, string> = {
  'content-type': JSON_CONTENT_TYPE,
  accept: JSON_CONTENT_TYPE,
};

/**
 * True when the header map already declares a Content-Type (any casing) — so a
 * captured SPA value (Hapoalim rejects a mismatched Content-Type) is never
 * shadowed by the JSON default filled in below.
 * @param headers - Caller-supplied header map.
 * @returns True when a content-type key (any casing) is present.
 */
function hasContentType(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((k): boolean => k.toLowerCase() === 'content-type');
}

/**
 * Guarantee a POST — whose body is ALWAYS JSON-stringified below — advertises a
 * JSON Content-Type. Captured SPA headers stay the source of truth: an omitted
 * header set falls back to the minimal JSON default; a partial set WITHOUT a
 * Content-Type (FIBI `appsng` BFF, which otherwise serves the SPA shell at 200)
 * gains only `application/json`; an already-present Content-Type (Hapoalim) is
 * forwarded verbatim.
 * @param extraHeaders - Caller-supplied headers, or undefined.
 * @returns Header map guaranteed to carry a Content-Type.
 */
function withJsonContentType(extraHeaders?: Record<string, string>): Record<string, string> {
  if (!extraHeaders) return DEFAULT_JSON_HEADERS;
  if (hasContentType(extraHeaders)) return extraHeaders;
  return { ...extraHeaders, 'content-type': JSON_CONTENT_TYPE };
}

/**
 * Resolve the in-page deadline for one request.
 *
 * A caller's budget may only NARROW the library-wide deadline: it is clamped
 * with `Math.min`, so a request is never left unbounded and one caller cannot
 * lift the ceiling every other request is held to.
 * @param requested - The caller's budget in milliseconds, if it set one.
 * @returns The deadline to enforce in the page.
 */
function resolvePageTimeoutMs(requested?: number): number {
  if (requested === undefined || requested <= 0) return NETWORK_FETCH_PAGE_TIMEOUT_MS;
  return Math.min(requested, NETWORK_FETCH_PAGE_TIMEOUT_MS);
}

/**
 * The per-request headers the site's own front end would add.
 *
 * Only the trace identifier belongs in the header map; the correlation cookie
 * is a cookie, planted separately by {@link primeFirstPartyCookie}. Minted here
 * rather than in-page so the serialised evaluator needs no branch.
 * @param opts - Public fetch options; read for `firstPartyContract`.
 * @returns Headers to merge in, or an empty map when not requested.
 */
function firstPartyHeaders(opts: IFetchPostOptions): Record<string, string> {
  if (opts.firstPartyContract !== true) return {};
  return { TraceIdentifier: randomUUID() };
}

/**
 * The correlation-cookie candidate for this request, when one is wanted.
 * @param opts - Public fetch options; read for `firstPartyContract`.
 * @returns A fresh candidate value, or an empty bundle when not requested.
 */
function firstPartyCookieArg(opts: IFetchPostOptions): { innerCorrelationId?: string } {
  if (opts.firstPartyContract !== true) return {};
  return { innerCorrelationId: randomUUID() };
}

/**
 * Build the post-evaluate args bundle from the public options. Headers pass
 * through {@link withJsonContentType} so every JSON POST advertises a
 * Content-Type without shadowing a captured SPA value.
 * @param url - Target URL.
 * @param opts - Public fetch options.
 * @returns Args ready for runPostEvaluate.
 */
export function buildPostArgs(url: string, opts: IFetchPostOptions): IPostEvaluateArgs {
  const declared = withJsonContentType(opts.extraHeaders);
  const firstParty = firstPartyHeaders(opts);
  const innerExtraHeaders = { ...declared, ...firstParty };
  const innerDataJson = JSON.stringify(opts.data);
  const timeoutMs = resolvePageTimeoutMs(opts.timeoutMs);
  const cookieArg = firstPartyCookieArg(opts);
  return { innerUrl: url, innerDataJson, innerExtraHeaders, timeoutMs, ...cookieArg };
}

/** Bundled args for {@link finalisePagePost} — keeps the sig under max-params. */
interface IFinalisePagePostArgs {
  response: PageFetchTuple;
  url: string;
  startMs: number;
  opts: IFetchPostOptions;
}

/**
 * Common tail for {@link fetchPostWithinPage} — log, bounce-check, parse.
 *
 * The bounce check sits before the parser so a WAF interstitial or login
 * redirect is reported as a typed {@link WafBlockError} rather than as the
 * `Unexpected token '<'` parse failure it would otherwise become.
 * @param args - Bundled response tuple + url + start + opts.
 * @returns Parsed JSON or EMPTY_RESULT on swallowed parse error.
 */
function finalisePagePost<TResult>(args: IFinalisePagePostArgs): Nullable<TResult> {
  const { response, url, startMs, opts } = args;
  const [text, status] = response;
  logApiCall(`POST(page) ${redactUrlFull(url).slice(-100)}`, status, Date.now() - startMs);
  logResponseIssues(status, text, url);
  const facts = toResponseFacts(response, url);
  assertNotBounced(facts, opts.shouldIgnoreErrors === true);
  return parsePostResult({ text, status, url, opts }) as TResult;
}

/**
 * Perform a POST request inside a Playwright page context (with cookies).
 * @param page - The Playwright page or frame context.
 * @param url - The URL to post to.
 * @param opts - Request body, optional extra headers, and error handling.
 * @returns The parsed JSON response body, or null on failure when errors are ignored.
 */
export async function fetchPostWithinPage<TResult>(
  page: Page | Frame,
  url: string,
  opts: IFetchPostOptions,
): Promise<Nullable<TResult>> {
  const startMs = Date.now();
  const postArgs = buildPostArgs(url, opts);
  const response = await runPostEvaluate(page, postArgs);
  return finalisePagePost<TResult>({ response, url, startMs, opts });
}
