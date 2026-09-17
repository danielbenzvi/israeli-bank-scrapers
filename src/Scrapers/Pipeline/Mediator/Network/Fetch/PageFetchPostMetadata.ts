/**
 * Fetch sub-module — an in-page POST that keeps its transport facts.
 *
 * {@link fetchPostWithinPage} returns the parsed body, so every unusable
 * response collapses to `null`: a WAF challenge, an expired session and a
 * genuinely empty account become one value. The first two commonly arrive as a
 * 200 carrying HTML, or as a redirect to a login origin — exactly the cases a
 * caller most needs to tell apart from "no data".
 *
 * Kept beside {@link fetchPostWithinPage} rather than folded into it as a flag,
 * so the two return types stay honest: this one never collapses a failure into
 * `null`, which is the entire reason to call it.
 */

import type { Frame, Page } from 'playwright-core';

import { redactUrlFull } from '../../../Types/PiiRedactor.js';
import type { PageFetchTuple } from './Bounce.js';
import { logApiCall, logResponseIssues } from './Logging.js';
import type { IFetchPostOptions } from './PageFetchPost.js';
import { buildPostArgs, runPostEvaluate } from './PageFetchPost.js';

/**
 * Transport-level facts about a response, independent of its body.
 *
 * These are the signals that distinguish "the provider returned no data" from
 * "we were bounced": parsed as JSON both yield `null` — the same value a
 * genuinely empty result gives — so without them a caller cannot tell an
 * authentication failure from an empty account.
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

/**
 * True when a response is worth attempting to parse as JSON.
 *
 * A redirected response is excluded even at 2xx: landing on a login or
 * challenge origin is the single most common way a scrape "succeeds" while
 * returning nothing usable, and parsing it would erase that distinction.
 * @param meta - Transport metadata for the response.
 * @returns True when the body should be parsed.
 */
function isParseableJson(meta: IResponseMetadata): boolean {
  if (meta.redirected) return false;
  if (meta.status < 200 || meta.status >= 300) return false;
  return meta.contentType.toLowerCase().includes('application/json');
}

/** The evaluator tuple plus the URL it was requested from. */
interface IMetadataInput {
  readonly tuple: PageFetchTuple;
  readonly url: string;
}

/**
 * Read the evaluator tuple into transport metadata.
 *
 * The shared `PageFetchTuple` marks its last three slots optional, because
 * other in-page evaluators report only body and status. The POST evaluator
 * always fills all five, so these defaults describe an evaluator that reported
 * nothing rather than a response that was genuinely plain and same-origin: an
 * absent content-type is not JSON and fails the parse gate anyway, and an
 * unreported redirect means the response came from the URL we asked for.
 * @param input - The evaluator tuple and the requested URL.
 * @returns Transport facts for the response.
 */
function toResponseMetadata(input: IMetadataInput): IResponseMetadata {
  const [, status, contentType, isRedirected, finalUrl] = input.tuple;
  const landed = new URL(finalUrl ?? input.url).origin;
  return {
    status,
    contentType: contentType ?? '',
    redirected: isRedirected ?? false,
    sameOrigin: landed === new URL(input.url).origin,
  };
}

/**
 * Parse a body already known to be worth parsing.
 *
 * A body that claimed JSON and was not is a transport-level anomaly rather than
 * a parse error to raise: the metadata already records what happened.
 * @param http - Transport facts for the response.
 * @param text - The raw response body.
 * @returns Metadata plus the parsed body, or a null body when it did not parse.
 */
function parseEnvelope(http: IResponseMetadata, text: string): IPostWithMetadata {
  if (text === '') return { http, envelope: {} };
  try {
    return { http, envelope: JSON.parse(text) };
  } catch {
    return { http, envelope: null };
  }
}

/**
 * Decide what a response's body is worth, given its transport facts.
 *
 * 204 is answered before the JSON gate: it is a successful empty response and
 * servers routinely omit a content-type on it, so folding it in with the
 * unparseable would destroy the very distinction this module exists to keep.
 * @param http - Transport facts for the response.
 * @param text - The raw response body.
 * @returns Metadata plus the body, parsed when the response allowed it.
 */
function readEnvelope(http: IResponseMetadata, text: string): IPostWithMetadata {
  if (http.status === 204) return { http, envelope: {} };
  if (!isParseableJson(http)) return { http, envelope: null };
  return parseEnvelope(http, text);
}

/** What {@link logPostOutcome} needs to describe one completed request. */
interface IPostOutcomeLog {
  readonly url: string;
  readonly status: number;
  readonly text: string;
  readonly startMs: number;
}

/**
 * Emit the same two log lines the plain in-page POST does.
 *
 * Shared shape rather than a shared function: the plain path folds logging into
 * its own tail, which also parses, and this path must not parse.
 * @param out - URL, status, body and start time for the completed request.
 * @returns True after both lines are emitted.
 */
function logPostOutcome(out: IPostOutcomeLog): boolean {
  const label = `POST(page) ${redactUrlFull(out.url).slice(-100)}`;
  logApiCall(label, out.status, Date.now() - out.startMs);
  logResponseIssues(out.status, out.text, out.url);
  return true;
}

/** Bundled args for {@link finaliseMetadataPost} — keeps the sig under max-params. */
interface IFinaliseMetadataArgs {
  readonly tuple: PageFetchTuple;
  readonly url: string;
  readonly startMs: number;
}

/**
 * Common tail — log the request, then read the body its transport allows.
 *
 * Mirrors `finalisePagePost` on the plain path, minus the bounce assertion:
 * being bounced is a fact this function must REPORT, not throw on, which is
 * the whole reason a caller reaches for this variant.
 * @param args - Evaluator tuple, requested URL, and request start time.
 * @returns Transport metadata plus the body, parsed when allowed.
 */
function finaliseMetadataPost(args: IFinaliseMetadataArgs): IPostWithMetadata {
  const { tuple, url, startMs } = args;
  const [text, status] = tuple;
  logPostOutcome({ url, status, text, startMs });
  const http = toResponseMetadata({ tuple, url });
  return readEnvelope(http, text);
}

/**
 * Perform a POST inside the page and return transport metadata alongside the
 * body, instead of the body alone.
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
  const tuple = await runPostEvaluate(page, postArgs);
  return finaliseMetadataPost({ tuple, url, startMs });
}
