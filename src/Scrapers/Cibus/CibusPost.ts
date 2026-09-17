/**
 * Cibus's own in-page JSON POST.
 *
 * WHY THIS DOES NOT USE THE SHARED `fetchPostWithinPage`
 *
 * That helper returns the parsed body and nothing else. This provider signals
 * "one-time code required" with a NON-STANDARD HTTP 210 — a status that has to
 * reach the caller, because treating an unexpected status as failure misreads
 * the challenge as a credential rejection and sends a person off to fix a
 * password that was never wrong.
 *
 * WHY IT DOES NOT LIVE IN THE SHARED FETCH MODULE EITHER
 *
 * The function that performs the request is serialised into the page by
 * `page.evaluate`, so it cannot reference anything outside its own arguments —
 * it cannot call a shared helper, and two callers cannot share one. A
 * status-aware variant in the shared module would therefore duplicate the
 * fetch body regardless, while adding a public surface to a module every
 * browser bank depends on.
 *
 * Keeping it here costs a dozen lines of boilerplate and buys two things: this
 * scraper can be reviewed, merged or reverted on its own, and the shared
 * transport used by every other institution is untouched by it.
 *
 * READ-ONLY, LIKE EVERY REQUEST THIS SCRAPER MAKES. The caller checks each URL
 * against the allow-list in `Config/CibusApiConfig.ts` before calling in.
 */
import type { Frame, Page } from 'playwright-core';

import { APPLICATION_ID } from './Config/CibusApiConfig.js';

/** What the in-page fetch hands back across the boundary. */
type PostTuple = readonly [text: string, status: number];

/** A POST body plus the headers the provider's own front end sends. */
export interface ICibusPostOptions {
  data: Record<string, unknown>;
  extraHeaders: Record<string, string>;
}

/** Status and parsed body — the two things this provider's flow branches on. */
export interface ICibusPostResult {
  status: number;
  /** Parsed JSON body, or undefined when the response carried none. */
  envelope: unknown;
}

/**
 * Build the in-page POST options every request shares.
 * @param data - JSON body.
 * @returns Options for the in-page fetch helper.
 */
export function postOptions(data: Record<string, unknown>): ICibusPostOptions {
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

/** Arguments crossing into the page. Flat, because they are serialised. */
interface IEvaluateArgs {
  innerUrl: string;
  innerBody: string;
  innerHeaders: Record<string, string>;
}

/**
 * POST inside the browser context, returning the body text and the status.
 *
 * Serialised into the page, so it may reference nothing outside `args`.
 *
 * @param args - URL, JSON body, and headers.
 * @returns [responseText, httpStatus].
 */
async function doCibusPost(args: IEvaluateArgs): Promise<PostTuple> {
  const response = await fetch(args.innerUrl, {
    method: 'POST',
    body: args.innerBody,
    credentials: 'include',
    headers: args.innerHeaders,
  });
  const text = response.status === 204 ? '' : await response.text();
  return [text, response.status] as const;
}

/**
 * Parse a response body, treating unusable JSON as "no body" rather than as an
 * error.
 *
 * The provider answers some rejections with an empty or non-JSON payload, and
 * the STATUS is what distinguishes them. Throwing here would discard the one
 * value the caller needs.
 *
 * Misses report `false`, per this repository's own miss-sentinel convention.
 * The hit is WRAPPED rather than returned bare: a parsed JSON body is
 * `unknown`, and `unknown` absorbs every other member of a union, so
 * `unknown | false` would erase the sentinel it is trying to express.
 *
 * @param text - Raw response body.
 * @returns The parsed body wrapped in `value`, or `false` when there was none.
 */
function parseEnvelope(text: string): { value: unknown } | false {
  if (text === '') return false;
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return false;
  }
}

/**
 * Build the flat, serialisable argument bundle the page function receives.
 *
 * @param url - Target URL.
 * @param opts - Request body and headers.
 * @returns Args ready for `page.evaluate`.
 */
function buildArgs(url: string, opts: ICibusPostOptions): IEvaluateArgs {
  return {
    innerUrl: url,
    innerBody: JSON.stringify(opts.data),
    innerHeaders: { ...opts.extraHeaders },
  };
}

/**
 * Perform a JSON POST inside the page and return its status and body.
 *
 * @param page - The Playwright page or frame context.
 * @param url - Target URL, already checked against the allow-list.
 * @param opts - Request body and headers.
 * @returns The HTTP status and the parsed body, if any.
 */
export default async function cibusPostInPage(
  page: Page | Frame,
  url: string,
  opts: ICibusPostOptions,
): Promise<ICibusPostResult> {
  const args = buildArgs(url, opts);
  const [text, status] = await page.evaluate(doCibusPost, args);
  const parsed = parseEnvelope(text);
  return { status, envelope: parsed === false ? undefined : parsed.value };
}
