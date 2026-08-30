/**
 * In-page POST: request timeout and response metadata.
 *
 * The property worth testing is not that metadata is returned — it is that a
 * bounced response is distinguishable from an empty one. A WAF challenge and an
 * expired session both commonly arrive as a 200 carrying HTML, or as a redirect
 * to a login origin; parsed as JSON both yield null, exactly like a genuinely
 * empty account. These tests pin the cases where the body must NOT be parsed.
 */

import {
  fetchPostWithinPageWithMetadata,
  type IFetchPostOptions,
} from '../../../../Scrapers/Pipeline/Mediator/Network/Fetch/PageFetchPost.js';
import { NETWORK_FETCH_PAGE_TIMEOUT_MS } from '../../../../Scrapers/Pipeline/Mediator/Network/FetchConfig.js';

/**
 * Stands in for a Playwright page: runs the serialised fn against a fake fetch.
 * @param response
 * @param response.body
 * @param response.status
 * @param response.contentType
 * @param response.redirected
 * @param response.finalUrl
 */
function pageReturning(response: {
  body?: string;
  status?: number;
  contentType?: string;
  redirected?: boolean;
  finalUrl?: string;
}) {
  const {
    body = '{"ok":true}',
    status = 200,
    contentType = 'application/json',
    redirected = false,
    finalUrl = 'https://provider.example/api',
  } = response;
  return {
    /**
     *
     * @param _fn
     * @param args
     * @param args.timeoutMs
     */
    evaluate: async (_fn: unknown, args: { timeoutMs?: number }) => {
      lastArgs = args;
      if (status === 204) return ['', 204, contentType, redirected, finalUrl] as const;
      return [body, status, contentType, redirected, finalUrl] as const;
    },
  } as never;
}

let lastArgs: { timeoutMs?: number } | undefined;

const OPTS: IFetchPostOptions = { data: { q: 1 } };
const URL_UNDER_TEST = 'https://provider.example/api';

describe('fetchPostWithinPageWithMetadata', () => {
  beforeEach(() => {
    lastArgs = undefined;
  });

  it('parses a clean JSON response and reports the transport facts', async () => {
    const result = await fetchPostWithinPageWithMetadata(pageReturning({}), URL_UNDER_TEST, OPTS);
    expect(result.envelope).toEqual({ ok: true });
    expect(result.http.status).toBe(200);
    expect(result.http.redirected).toBe(false);
    expect(result.http.sameOrigin).toBe(true);
  });

  it('does NOT parse a redirected response, even at 200', async () => {
    // The login-page bounce. Parsing it would produce the same null a genuinely
    // empty account gives, erasing the only signal that anything went wrong.
    const result = await fetchPostWithinPageWithMetadata(
      pageReturning({ redirected: true, finalUrl: 'https://login.example/signin' }),
      URL_UNDER_TEST,
      OPTS,
    );
    expect(result.envelope).toBeNull();
    expect(result.http.redirected).toBe(true);
    expect(result.http.sameOrigin).toBe(false);
  });

  it('does NOT parse an HTML body served with a 200', async () => {
    // The WAF-challenge shape.
    const result = await fetchPostWithinPageWithMetadata(
      pageReturning({ body: '<html>checking your browser</html>', contentType: 'text/html' }),
      URL_UNDER_TEST,
      OPTS,
    );
    expect(result.envelope).toBeNull();
    expect(result.http.contentType).toBe('text/html');
  });

  it('reports a non-2xx status without throwing', async () => {
    const result = await fetchPostWithinPageWithMetadata(
      pageReturning({ status: 403, body: 'forbidden', contentType: 'text/plain' }),
      URL_UNDER_TEST,
      OPTS,
    );
    expect(result.http.status).toBe(403);
    expect(result.envelope).toBeNull();
  });

  it('treats an empty 204 as an empty envelope, not a failure', async () => {
    const result = await fetchPostWithinPageWithMetadata(
      pageReturning({ status: 204, contentType: '' }),
      URL_UNDER_TEST,
      OPTS,
    );
    expect(result.http.status).toBe(204);
    // `{}`, not null: the request succeeded and carried no content. Collapsing
    // it to null would put it in the same bucket as a WAF bounce. Asserted with
    // an absent content-type because servers routinely omit one on a 204.
    expect(result.envelope).toEqual({});
  });

  it('survives a body that claims JSON and is not', async () => {
    const result = await fetchPostWithinPageWithMetadata(
      pageReturning({ body: 'not json at all' }),
      URL_UNDER_TEST,
      OPTS,
    );
    expect(result.envelope).toBeNull();
    expect(result.http.status).toBe(200);
  });

  it('flags a cross-origin response even when it was not a redirect', async () => {
    const result = await fetchPostWithinPageWithMetadata(
      pageReturning({ finalUrl: 'https://other.example/api' }),
      URL_UNDER_TEST,
      OPTS,
    );
    expect(result.http.sameOrigin).toBe(false);
  });

  it('narrows the in-page deadline to the caller budget', async () => {
    await fetchPostWithinPageWithMetadata(pageReturning({}), URL_UNDER_TEST, {
      ...OPTS,
      timeoutMs: 15_000,
    });
    expect(lastArgs?.timeoutMs).toBe(15_000);
  });

  it('falls back to the library deadline when the caller sets none', async () => {
    await fetchPostWithinPageWithMetadata(pageReturning({}), URL_UNDER_TEST, OPTS);
    expect(lastArgs?.timeoutMs).toBe(NETWORK_FETCH_PAGE_TIMEOUT_MS);
  });

  it('clamps a caller budget larger than the library deadline', async () => {
    // The option may only NARROW the deadline. Honouring a larger value would
    // let one caller lift the ceiling every other request is held to, so a
    // stalled provider could hold the scrape past the point the session dies —
    // the exact failure the library-wide deadline exists to bound.
    await fetchPostWithinPageWithMetadata(pageReturning({}), URL_UNDER_TEST, {
      ...OPTS,
      timeoutMs: NETWORK_FETCH_PAGE_TIMEOUT_MS * 10,
    });
    expect(lastArgs?.timeoutMs).toBe(NETWORK_FETCH_PAGE_TIMEOUT_MS);
  });

  it('ignores a non-positive caller budget', async () => {
    await fetchPostWithinPageWithMetadata(pageReturning({}), URL_UNDER_TEST, { ...OPTS, timeoutMs: 0 });
    expect(lastArgs?.timeoutMs).toBe(NETWORK_FETCH_PAGE_TIMEOUT_MS);
  });
});
