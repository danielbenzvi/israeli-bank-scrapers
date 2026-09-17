/**
 * In-page POST: response metadata and the narrowable deadline.
 *
 * The property worth testing is not that metadata is returned — it is that a
 * bounced response is distinguishable from an empty one. A WAF challenge and an
 * expired session both commonly arrive as a 200 carrying HTML, or as a redirect
 * to a login origin; parsed as JSON both yield null, exactly like a genuinely
 * empty account. These tests pin the cases where the body must NOT be parsed.
 */

import { jest } from '@jest/globals';
import type { Page } from 'playwright-core';

import type { IFetchPostOptions } from '../../../../Scrapers/Pipeline/Mediator/Network/Fetch/PageFetchPost.js';
import { fetchPostWithinPageWithMetadata } from '../../../../Scrapers/Pipeline/Mediator/Network/Fetch/PageFetchPostMetadata.js';
import { NETWORK_FETCH_PAGE_TIMEOUT_MS } from '../../../../Scrapers/Pipeline/Mediator/Network/FetchConfig.js';
import { createMockPage } from '../../../MockPage.js';

/** The response a faked page should answer the in-page POST with. */
interface IFakeResponse {
  readonly body?: string;
  readonly status?: number;
  readonly contentType?: string;
  readonly isRedirected?: boolean;
  readonly finalUrl?: string;
}

/** The evaluate-args the fake page last received, for the deadline assertions. */
let lastArgs: { timeoutMs?: number } | undefined;

/**
 * A page whose `evaluate` answers with one fixed response tuple.
 *
 * Built on the shared {@link createMockPage} so the fake satisfies `Page`
 * structurally rather than being cast through `never`.
 * @param response - The status, body, content type and final URL to answer with.
 * @returns A mock page the POST helper can be driven against.
 */
function pageReturning(response: IFakeResponse): Page {
  const {
    body = '{"ok":true}',
    status = 200,
    contentType = 'application/json',
    isRedirected = false,
    finalUrl = 'https://provider.example/api',
  } = response;
  const text = status === 204 ? '' : body;
  const tuple = [text, status, contentType, isRedirected, finalUrl] as const;
  const evaluate = jest.fn((_fn: unknown, args: { timeoutMs?: number }) => {
    lastArgs = args;
    return Promise.resolve(tuple);
  });
  return createMockPage({ evaluate });
}

const OPTS: IFetchPostOptions = { data: { q: 1 } };
const URL_UNDER_TEST = 'https://provider.example/api';

describe('fetchPostWithinPageWithMetadata', () => {
  beforeEach((): void => {
    lastArgs = undefined;
  });

  it('parses a clean JSON response and reports the transport facts', async () => {
    const page = pageReturning({});
    const result = await fetchPostWithinPageWithMetadata(page, URL_UNDER_TEST, OPTS);
    expect(result.envelope).toEqual({ ok: true });
    expect(result.http.status).toBe(200);
    expect(result.http.redirected).toBe(false);
    expect(result.http.sameOrigin).toBe(true);
  });

  it('does NOT parse a redirected response, even at 200', async () => {
    // The login-page bounce. Parsing it would produce the same null a genuinely
    // empty account gives, erasing the only signal that anything went wrong.
    const page = pageReturning({ isRedirected: true, finalUrl: 'https://login.example/signin' });
    const result = await fetchPostWithinPageWithMetadata(page, URL_UNDER_TEST, OPTS);
    expect(result.envelope).toBeNull();
    expect(result.http.redirected).toBe(true);
    expect(result.http.sameOrigin).toBe(false);
  });

  it('does NOT parse an HTML body served with a 200', async () => {
    // The WAF-challenge shape.
    const page = pageReturning({ body: '<html>checking</html>', contentType: 'text/html' });
    const result = await fetchPostWithinPageWithMetadata(page, URL_UNDER_TEST, OPTS);
    expect(result.envelope).toBeNull();
    expect(result.http.contentType).toBe('text/html');
  });

  it('reports a non-2xx status without throwing', async () => {
    const page = pageReturning({ status: 403, body: 'forbidden', contentType: 'text/plain' });
    const result = await fetchPostWithinPageWithMetadata(page, URL_UNDER_TEST, OPTS);
    expect(result.http.status).toBe(403);
    expect(result.envelope).toBeNull();
  });

  it('treats an empty 204 as an empty envelope, not a failure', async () => {
    // `{}`, not null: the request succeeded and carried no content. Collapsing
    // it to null would put it in the same bucket as a WAF bounce. Asserted with
    // an absent content-type because servers routinely omit one on a 204.
    const page = pageReturning({ status: 204, contentType: '' });
    const result = await fetchPostWithinPageWithMetadata(page, URL_UNDER_TEST, OPTS);
    expect(result.http.status).toBe(204);
    expect(result.envelope).toEqual({});
  });

  it('survives a body that claims JSON and is not', async () => {
    const page = pageReturning({ body: 'not json at all' });
    const result = await fetchPostWithinPageWithMetadata(page, URL_UNDER_TEST, OPTS);
    expect(result.envelope).toBeNull();
    expect(result.http.status).toBe(200);
  });

  it('flags a cross-origin response even when it was not a redirect', async () => {
    const page = pageReturning({ finalUrl: 'https://other.example/api' });
    const result = await fetchPostWithinPageWithMetadata(page, URL_UNDER_TEST, OPTS);
    expect(result.http.sameOrigin).toBe(false);
  });

  it('narrows the in-page deadline to the caller budget', async () => {
    const page = pageReturning({});
    await fetchPostWithinPageWithMetadata(page, URL_UNDER_TEST, { ...OPTS, timeoutMs: 15_000 });
    expect(lastArgs?.timeoutMs).toBe(15_000);
  });

  it('falls back to the library deadline when the caller sets none', async () => {
    const page = pageReturning({});
    await fetchPostWithinPageWithMetadata(page, URL_UNDER_TEST, OPTS);
    expect(lastArgs?.timeoutMs).toBe(NETWORK_FETCH_PAGE_TIMEOUT_MS);
  });

  it('clamps a caller budget larger than the library deadline', async () => {
    // The option may only NARROW the deadline. Honouring a larger value would
    // let one caller lift the ceiling every other request is held to, so a
    // stalled provider could hold the scrape past the point the session dies —
    // the exact failure the library-wide deadline exists to bound.
    const page = pageReturning({});
    const generous = NETWORK_FETCH_PAGE_TIMEOUT_MS * 10;
    await fetchPostWithinPageWithMetadata(page, URL_UNDER_TEST, { ...OPTS, timeoutMs: generous });
    expect(lastArgs?.timeoutMs).toBe(NETWORK_FETCH_PAGE_TIMEOUT_MS);
  });

  it('ignores a non-positive caller budget', async () => {
    const page = pageReturning({});
    await fetchPostWithinPageWithMetadata(page, URL_UNDER_TEST, { ...OPTS, timeoutMs: 0 });
    expect(lastArgs?.timeoutMs).toBe(NETWORK_FETCH_PAGE_TIMEOUT_MS);
  });
});
