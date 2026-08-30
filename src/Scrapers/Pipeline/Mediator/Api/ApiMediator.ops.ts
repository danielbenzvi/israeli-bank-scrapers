/**
 * High-level apiPost / apiGet / apiQuery operations.
 * Each call wraps URL/query resolution, builds fireOnce, and runs retry-on-401.
 */

import { resolveWkQuery } from '../../Registry/WK/QueriesWK.js';
import type { WKUrlOrLiteral } from '../../Registry/WK/UrlsWK.js';
import { resolveWkUrl } from '../../Registry/WK/UrlsWK.js';
import type { IPostWithMetadata } from '../../Strategy/Fetch/FetchStrategy.js';
import type { Procedure } from '../../Types/Procedure.js';
import { isOk } from '../../Types/Procedure.js';
import { buildHmacHeaders } from './ApiMediator.hmacHeaders.js';
import { retryOn401Op } from './ApiMediator.retry.js';
import {
  fireGet,
  firePost,
  firePostWithMetadata,
  fireQuery,
  NO_EXTRA_HEADERS,
} from './ApiMediator.transport.js';
import type {
  IFirePostArgs,
  IFireQueryArgs,
} from './ApiMediator.transport.types.js';
import type {
  IApiCallContext,
  IApiPostOpArgs,
  IApiQueryOpArgs,
} from './ApiMediator.types.js';

/**
 * Build the optional extras subset of firePost args.
 * @param args - apiPost op args.
 * @returns Optional extras subset.
 */
function buildFirePostExtras(args: IApiPostOpArgs): FirePostExtras {
  return {
    extraHeaders: args.opts?.extraHeaders ?? NO_EXTRA_HEADERS,
    query: args.opts?.query ?? NO_EXTRA_HEADERS,
    onSetCookie: args.opts?.onSetCookie,
    timeoutMs: args.opts?.timeoutMs,
    firstPartyContract: args.opts?.firstPartyContract,
  };
}

/**
 * Optional-extras subset merged into firePost args.
 *
 * Carries the per-request deadline and first-party contract alongside the
 * headers, so a caller that needs either does not have to reach past this
 * bundle to the transport.
 */
type FirePostExtras = Pick<
  IFirePostArgs,
  'extraHeaders' | 'query' | 'onSetCookie' | 'timeoutMs' | 'firstPartyContract'
>;

/**
 * Merge the per-request HMAC signature headers into the POST extras.
 * @param args - apiPost op args (carries session context + body).
 * @param url - Resolved POST URL.
 * @param extras - Base optional-extras subset.
 * @returns Extras with HMAC headers folded into `extraHeaders`.
 */
function withHmacExtras(args: IApiPostOpArgs, url: string, extras: FirePostExtras): FirePostExtras {
  const hmac = buildHmacHeaders({
    session: args.ctx.state.sessionContext,
    method: 'POST',
    url,
    body: args.body,
  });
  return { ...extras, extraHeaders: { ...extras.extraHeaders, ...hmac } };
}

/**
 * Build the per-attempt firePost args so retry-on-401 can re-read
 * `state.rawAuth` after a refresh installs a new header. HMAC signature
 * headers are (re)computed here so each attempt carries a fresh
 * timestamp + nonce.
 * @param args - apiPost op args.
 * @param urlValue - Resolved URL.
 * @returns Fresh firePost args.
 */
function buildFirePostArgs(args: IApiPostOpArgs, urlValue: string): IFirePostArgs {
  const baseExtras = buildFirePostExtras(args);
  const extras = withHmacExtras(args, urlValue, baseExtras);
  const { ctx, body } = args;
  return { deps: ctx.deps, url: urlValue, body, rawAuth: ctx.state.rawAuth, ...extras };
}

/**
 * Build the per-attempt fireOnce for `apiPost`.
 * @param args - apiPost op args.
 * @param urlValue - Resolved URL.
 * @returns Async fire-once callable.
 */
function makeApiPostFireOnce<T>(
  args: IApiPostOpArgs,
  urlValue: string,
): () => Promise<Procedure<T>> {
  return async (): Promise<Procedure<T>> => {
    const firePostArgs = buildFirePostArgs(args, urlValue);
    return firePost<T>(firePostArgs);
  };
}

/**
 * Build the per-attempt fireOnce for `apiPostWithMetadata`.
 * @param args - apiPost op args.
 * @param urlValue - Resolved POST URL.
 * @returns A thunk performing one metadata-preserving POST attempt.
 */
function makeApiPostWithMetadataFireOnce(
  args: IApiPostOpArgs,
  urlValue: string,
): () => Promise<Procedure<IPostWithMetadata>> {
  return async (): Promise<Procedure<IPostWithMetadata>> => {
    const firePostArgs = buildFirePostArgs(args, urlValue);
    return firePostWithMetadata(firePostArgs);
  };
}

/**
 * Execute apiPostWithMetadata after URL resolution has succeeded.
 *
 * A sibling of {@link apiPostOp} rather than an option on it: the two differ in
 * return type, and collapsing them would put the metadata behind a cast. The
 * retry-on-401 wrapper is the same — an expired token is a transport concern,
 * refreshed identically whether or not the caller wanted metadata back.
 * @param args - apiPost op args.
 * @returns Procedure carrying transport metadata plus the parsed body.
 */
async function apiPostWithMetadataOp(args: IApiPostOpArgs): Promise<Procedure<IPostWithMetadata>> {
  const urlProc = resolveWkUrl(args.wkUrl, args.ctx.bankHint);
  if (!isOk(urlProc)) return urlProc;
  const fire = makeApiPostWithMetadataFireOnce(args, urlProc.value);
  return retryOn401Op<IPostWithMetadata>({ state: args.ctx.state, fire });
}

/**
 * Execute apiPost after URL resolution has succeeded.
 * @param args - apiPost op args.
 * @returns Procedure with typed payload.
 */
async function apiPostOp<T>(args: IApiPostOpArgs): Promise<Procedure<T>> {
  const urlProc = resolveWkUrl(args.wkUrl, args.ctx.bankHint);
  if (!isOk(urlProc)) return urlProc;
  const fire = makeApiPostFireOnce<T>(args, urlProc.value);
  return retryOn401Op<T>({ state: args.ctx.state, fire });
}

/**
 * Build the empty-body HMAC headers for a GET attempt.
 * @param ctx - Per-call context.
 * @param url - Resolved GET URL.
 * @returns HMAC header map (empty when no key is set).
 */
function buildGetHmacHeaders(ctx: IApiCallContext, url: string): Record<string, string> {
  return buildHmacHeaders({ session: ctx.state.sessionContext, method: 'GET', url });
}

/**
 * Build the per-attempt fireOnce for `apiGet`. GET bodies are empty, so
 * the HMAC body hash is the empty-body constant.
 * @param ctx - Per-call context.
 * @param urlValue - Resolved URL.
 * @returns Async fire-once callable.
 */
function makeApiGetFireOnce<T>(
  ctx: IApiCallContext,
  urlValue: string,
): () => Promise<Procedure<T>> {
  return async (): Promise<Procedure<T>> => {
    const extraHeaders = buildGetHmacHeaders(ctx, urlValue);
    return fireGet<T>({ deps: ctx.deps, url: urlValue, rawAuth: ctx.state.rawAuth, extraHeaders });
  };
}

/**
 * GET with auth-header injection and WK URL resolution. Retries once on 401.
 * @param ctx - Per-call context.
 * @param wkUrl - WK URL group to resolve.
 * @returns Procedure with typed payload.
 */
async function apiGetOp<T>(ctx: IApiCallContext, wkUrl: WKUrlOrLiteral): Promise<Procedure<T>> {
  const urlProc = resolveWkUrl(wkUrl, ctx.bankHint);
  if (!isOk(urlProc)) return urlProc;
  const fire = makeApiGetFireOnce<T>(ctx, urlProc.value);
  return retryOn401Op<T>({ state: ctx.state, fire });
}

/**
 * Build the per-attempt fireQuery args so retry-on-401 can re-read
 * `state.rawAuth` after a refresh installs a new header.
 * @param args - apiQuery op args.
 * @param queryString - Resolved GraphQL query string.
 * @returns Fresh fireQuery args.
 */
function buildFireQueryArgs(args: IApiQueryOpArgs, queryString: string): IFireQueryArgs {
  const { ctx, variables, opts } = args;
  return {
    deps: ctx.deps,
    queryString,
    variables,
    rawAuth: ctx.state.rawAuth,
    extraHeaders: opts?.extraHeaders ?? NO_EXTRA_HEADERS,
  };
}

/**
 * Build the per-attempt fireOnce for `apiQuery`.
 * @param args - apiQuery op args.
 * @param queryString - Resolved GraphQL query string.
 * @returns Async fire-once callable.
 */
function makeApiQueryFireOnce<T>(
  args: IApiQueryOpArgs,
  queryString: string,
): () => Promise<Procedure<T>> {
  return async (): Promise<Procedure<T>> => {
    const fireQueryArgs = buildFireQueryArgs(args, queryString);
    return fireQuery<T>(fireQueryArgs);
  };
}

/**
 * GraphQL query with WK query resolution + envelope unwrap. Retries once on 401.
 * @param args - apiQuery op args.
 * @returns Procedure with unwrapped GraphQL data.
 */
async function apiQueryOp<T>(args: IApiQueryOpArgs): Promise<Procedure<T>> {
  const queryProc = resolveWkQuery(args.wkQuery, args.ctx.bankHint);
  if (!isOk(queryProc)) return queryProc;
  const fire = makeApiQueryFireOnce<T>(args, queryProc.value);
  return retryOn401Op<T>({ state: args.ctx.state, fire });
}

export { apiGetOp, apiPostOp, apiPostWithMetadataOp, apiQueryOp };
