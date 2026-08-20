/**
 * Fetch sub-module — in-page POST requests (Playwright page.evaluate).
 *
 * Cookies + CORS handled by the browser context. The SPA pivot in
 * ScrapePhase.PRE ensures the page is on the correct origin.
 */

import type { Frame, Page } from 'playwright-core';

import type { Nullable } from '../../../../Base/Interfaces/CallbackTypes.js';
import { redactUrlFull } from '../../../Types/PiiRedactor.js';
import { JSON_CONTENT_TYPE } from '../FetchConfig.js';
import type { JsonValue } from './Headers.js';
import { LOG, logApiCall, logResponseIssues } from './Logging.js';
import { parsePostResult } from './ParseResult.js';

/** Options for fetchPostWithinPage. */
export interface IFetchPostOptions {
  data: Record<string, JsonValue> | readonly JsonValue[];
  extraHeaders?: Record<string, string>;
  shouldIgnoreErrors?: boolean;
  /**
   * Abort the in-page request after this many milliseconds.
   *
   * The browser `fetch` has no timeout of its own, so a provider that accepts
   * the connection and never answers stalls the whole scrape until the outer
   * per-run timeout fires — by which point the session is usually gone. Omitted
   * or non-positive means no timeout, i.e. the previous behaviour.
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

/**
 * Transport-level facts about a response, independent of its body.
 *
 * These are the signals that distinguish "the provider returned no data" from
 * "we were bounced": a WAF challenge and an expired session both commonly
 * arrive as a 200 carrying HTML, or as a redirect to a login origin. Parsed as
 * JSON, both yield `null` — the same value a genuinely empty result gives —
 * so without this a caller cannot tell an authentication failure from an empty
 * account.
 */
export interface IResponseMetadata {
  status: number;
  contentType: string;
  redirected: boolean;
  /** False when the response came from a different origin than requested. */
  sameOrigin: boolean;
}

/** A response returned as transport metadata plus its body, if it parsed. */
export interface IPostWithMetadata {
  http: IResponseMetadata;
  /** Parsed JSON body, or null when the response was not usable JSON. */
  envelope: unknown;
}

/** Arguments for POST requests via Playwright's API client. */
interface IPostEvaluateArgs {
  innerUrl: string;
  innerDataJson: string;
  innerExtraHeaders: Record<string, string>;
  /** Omitted entirely when the caller set no timeout, so the args shape is unchanged for them. */
  innerTimeoutMs?: number;
  /** See IFetchPostOptions.firstPartyContract. */
  innerFirstParty?: boolean;
}

/** What {@link doPostFetch} hands back across the page boundary. */
type PostEvaluateResult = readonly [
  text: string,
  status: number,
  contentType: string,
  redirected: boolean,
  finalUrl: string,
];

/**
 * POST fetch inside the browser context (cookies + CORS handled by browser).
 *
 * Serialised into the page, so it may not reference anything outside its own
 * arguments.
 *
 * @param args - The URL, data, extra headers, and timeout.
 * @returns [responseText, statusCode, contentType, redirected, finalUrl].
 */
async function doPostFetch(args: IPostEvaluateArgs): Promise<PostEvaluateResult> {
  // No hardcoded headers: `args.innerExtraHeaders` (built by
  // `buildDiscoveredHeaders` from captured SPA traffic) is the
  // single source of truth for Content-Type / Referer / X-XSRF-
  // TOKEN / pageUuid / etc. Hapoalim rejects (302) any mismatch
  // between the SPA's captured shape and the replayed POST —
  // live evidence: run 15-05-2026 — hardcoded `Content-Type`
  // value collided with captured `content-type`; only the
  // captured value gets the API to 200.
  const headers: Record<string, string> = { ...args.innerExtraHeaders };
  if (args.innerFirstParty === true) {
    headers['TraceIdentifier'] = globalThis.crypto.randomUUID();
    const hasCorrelation = document.cookie.split(';').some((part): boolean => part.trim().startsWith('bckey='));
    if (!hasCorrelation) {
      document.cookie = `bckey=${globalThis.crypto.randomUUID()}; Max-Age=1800; Path=/; SameSite=Lax; Secure`;
    }
  }
  const response = await fetch(args.innerUrl, {
    method: 'POST',
    body: args.innerDataJson,
    credentials: 'include',
    headers,
    signal:
      args.innerTimeoutMs !== undefined && args.innerTimeoutMs > 0
        ? AbortSignal.timeout(args.innerTimeoutMs)
        : undefined,
  });
  // `redirected` and the final URL are read here rather than inferred later:
  // both are properties of the Response object and are unavailable once only
  // the body text has crossed back out of the page.
  const contentType = response.headers?.get('content-type') ?? '';
  if (response.status === 204) return ['', 204, contentType, response.redirected, response.url] as const;
  return [await response.text(), response.status, contentType, response.redirected, response.url] as const;
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
 * POST request via page.evaluate — runs inside the browser context.
 * The SPA pivot in ScrapePhase.PRE ensures the page is on the correct origin.
 * @param context - The Playwright page or frame to execute the fetch in.
 * @param args - The URL, data, and extra headers.
 * @returns A tuple of [responseBody, httpStatus, contentType, redirected, finalUrl].
 */
async function runPostEvaluate(
  context: Page | Frame,
  args: IPostEvaluateArgs,
): Promise<PostEvaluateResult> {
  logDoPostFetchHeaders(args);
  return context.evaluate(doPostFetch, args);
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
 * Build the post-evaluate args bundle from the public options. Headers pass
 * through {@link withJsonContentType} so every JSON POST advertises a
 * Content-Type without shadowing a captured SPA value.
 * @param url - Target URL.
 * @param opts - Public fetch options.
 * @returns Args ready for runPostEvaluate.
 */
function buildPostArgs(url: string, opts: IFetchPostOptions): IPostEvaluateArgs {
  const innerExtraHeaders = withJsonContentType(opts.extraHeaders);
  const timeoutMs = opts.timeoutMs;
  return {
    innerUrl: url,
    innerDataJson: JSON.stringify(opts.data),
    innerExtraHeaders,
    // Spread conditionally: a caller that sets no timeout gets exactly the
    // args object it got before this option existed.
    ...(timeoutMs !== undefined && timeoutMs > 0 ? { innerTimeoutMs: timeoutMs } : {}),
    ...(opts.firstPartyContract === true ? { innerFirstParty: true } : {}),
  };
}

/** Bundled args for {@link finalisePagePost} — keeps the sig under max-params. */
interface IFinalisePagePostArgs {
  text: string;
  status: number;
  url: string;
  startMs: number;
  opts: IFetchPostOptions;
}

/**
 * Common tail for {@link fetchPostWithinPage} — log + parse.
 * @param args - Bundled response text + status + url + start + opts.
 * @returns Parsed JSON or EMPTY_RESULT on swallowed parse error.
 */
function finalisePagePost<TResult>(args: IFinalisePagePostArgs): Nullable<TResult> {
  const { text, status, url, startMs, opts } = args;
  logApiCall(`POST(page) ${redactUrlFull(url).slice(-100)}`, status, Date.now() - startMs);
  logResponseIssues(status, text, url);
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
  const [text, status] = await runPostEvaluate(page, postArgs);
  return finalisePagePost<TResult>({ text, status, url, startMs, opts });
}

/**
 * True when a response is worth attempting to parse as JSON.
 *
 * A redirected response is excluded even at 2xx: landing on a login or
 * challenge origin is the single most common way a scrape "succeeds" while
 * returning nothing usable, and parsing it would erase that distinction.
 *
 * @param meta - Transport metadata for the response.
 * @returns True when the body should be parsed.
 */
function isParseableJson(meta: IResponseMetadata): boolean {
  if (meta.redirected) return false;
  if (meta.status < 200 || meta.status >= 300) return false;
  return meta.contentType.toLowerCase().includes('application/json');
}

/**
 * Perform a POST inside the page and return transport metadata alongside the
 * body, instead of the body alone.
 *
 * Separate from {@link fetchPostWithinPage} rather than a flag on it, so the
 * two return types stay honest: this one never collapses a failure into
 * `null`, which is the entire reason to call it.
 *
 * @param page - The Playwright page or frame context.
 * @param url - The URL to post to.
 * @param opts - Request body, optional extra headers, timeout.
 * @returns Transport metadata plus the parsed body, or a null body when the
 *   response was not usable JSON.
 */
export async function fetchPostWithinPageWithMetadata(
  page: Page | Frame,
  url: string,
  opts: IFetchPostOptions,
): Promise<IPostWithMetadata> {
  const startMs = Date.now();
  const postArgs = buildPostArgs(url, opts);
  const [text, status, contentType, redirected, finalUrl] = await runPostEvaluate(page, postArgs);
  logApiCall(`POST(page) ${redactUrlFull(url).slice(-100)}`, status, Date.now() - startMs);
  logResponseIssues(status, text, url);
  const http: IResponseMetadata = {
    status,
    contentType,
    redirected,
    sameOrigin: new URL(finalUrl).origin === new URL(url).origin,
  };
  // 204 is a successful empty response, and servers routinely omit a
  // content-type on it. Answered before the JSON gate so "succeeded with no
  // content" stays distinguishable from "could not be read" — which is the
  // distinction this whole function exists to preserve.
  if (status === 204) return { http, envelope: {} };
  if (!isParseableJson(http)) return { http, envelope: null };
  try {
    return { http, envelope: text === '' ? {} : JSON.parse(text) };
  } catch {
    // A body that claimed JSON and was not is a transport-level anomaly, not a
    // parse error to raise: the metadata already records what happened.
    return { http, envelope: null };
  }
}
