/**
 * Pluggable fetch strategy — abstracts how HTTP calls are made.
 * Returns Procedure<T> (never null/undefined).
 */

import type { IPostWithMetadata } from '../../Mediator/Network/Fetch/PageFetchPost.js';
import type { Procedure } from '../../Types/Procedure.js';

/**
 * Callback receiving the raw Set-Cookie header lines from a response.
 * Returns a count of entries the consumer chose to keep (or 0 when
 * the caller did not ingest anything). Non-void per Rule #15.
 */
type OnSetCookie = (setCookies: readonly string[]) => number;

/** Optional fetch configuration. */
interface IFetchOpts {
  /** Additional HTTP headers to include in the request. */
  readonly extraHeaders: Record<string, string>;
  /**
   * Optional hook — invoked once per response with the array of raw
   * Set-Cookie header lines. Absent when the caller doesn't care
   * about cookies (the non-Pepper default).
   */
  readonly onSetCookie?: OnSetCookie;
  /**
   * Abort the request after this many milliseconds. Absent or non-positive
   * means no timeout — the previous behaviour for every caller.
   */
  readonly timeoutMs?: number;
  /**
   * Send the request the way the site's own SPA would: a per-request trace
   * identifier and the client-correlation cookie it sets on first load.
   *
   * Some endpoints answer a bare replayed POST with a challenge or a redirect
   * even on a valid session, because the request does not look like it came
   * from their own front end.
   */
  readonly firstPartyContract?: boolean;
}

/** Default fetch options — no extra headers. */
const DEFAULT_FETCH_OPTS: IFetchOpts = { extraHeaders: {} };

/** JSON-serializable POST body — strings, arrays, or nested objects. */
type PostData = Record<string, string | string[] | object>;

/** Fetch strategy interface — all fetches return strong-typed Procedure. */
interface IFetchStrategy {
  /** POST with optional extra headers. */
  fetchPost<T>(url: string, data: PostData, opts: IFetchOpts): Promise<Procedure<T>>;

  /** GET with optional extra headers. */
  fetchGet<T>(url: string, opts: IFetchOpts): Promise<Procedure<T>>;

  /**
   * POST returning transport metadata alongside the body.
   *
   * Optional because only an in-page strategy can observe redirects, the final
   * URL and the content type — a caller must therefore handle its absence
   * rather than assume it. Present, it lets a caller tell a challenge or an
   * expired session (a 200 carrying HTML, or a bounce to a login origin) apart
   * from a genuinely empty result, which `fetchPost` collapses to the same
   * value.
   */
  fetchPostWithMetadata?(
    url: string,
    data: PostData,
    opts: IFetchOpts,
  ): Promise<Procedure<IPostWithMetadata>>;
}

export type { IFetchOpts, IFetchStrategy,  OnSetCookie, PostData };
export { DEFAULT_FETCH_OPTS };

export {type IPostWithMetadata} from '../../Mediator/Network/Fetch/PageFetchPost.js';