/**
 * Fetch sub-module barrel — explicit re-export surface.
 *
 * Mirrors the named-export set of the legacy `Mediator/Network/Fetch.ts`
 * monolith so the back-compat shim + every external caller compile
 * unchanged. Per CR cycle-1 directive: barrels are EXPLICIT (not
 * `export *`) so newly-introduced internal helpers never leak through.
 */

export type { JsonValue } from './Headers.js';
export { fetchGet, fetchGraphql, fetchPost, type IFetchGraphqlOptions } from './NativeFetch.js';
export { fetchGetWithinPage, fetchGetWithinPageWithHeaders } from './PageFetchGet.js';
export {
  fetchPostWithinPage,
  // Exposed for callers that must branch on the HTTP STATUS rather than only
  // the body — e.g. a provider signalling "one-time code required" with a
  // non-standard status, where treating an unexpected status as failure would
  // misread the challenge as a credential rejection.
  fetchPostWithinPageWithMetadata,
  type IFetchPostOptions,
  type IPostWithMetadata,
} from './PageFetchPost.js';
export type { IParseGetOpts, IParsePostOpts } from './ParseResult.js';
export { detectWafBlock } from './WafDetection.js';
