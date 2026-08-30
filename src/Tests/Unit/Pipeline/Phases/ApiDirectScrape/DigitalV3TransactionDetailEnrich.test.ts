/**
 * The DigitalV3 detail request loop, shared by Isracard and Amex.
 *
 * The property tested hardest is that enrichment cannot SUBTRACT from a scrape:
 * every row goes in and every row comes out, in order, whatever happens to its
 * detail request. Enrichment is an addition, and a bug here would silently
 * delete transactions from a scrape that still reports success.
 *
 * Field names and shapes only; no real values.
 */

import { ScraperErrorTypes } from '../../../../../Scrapers/Base/ErrorTypes.js';
import {
  enrichCardDetail,
  type ICardDetailDeps,
  type ICardDetailOptions,
} from '../../../../../Scrapers/Pipeline/Phases/ApiDirectScrape/DigitalV3/TransactionDetailEnrich.js';
import { fail, succeed } from '../../../../../Scrapers/Pipeline/Types/Procedure.js';

/** The ASCII unit separator the loop joins fingerprint parts with. */
const SEPARATOR = String.fromCodePoint(0x1f);

const HMAC_KEY = 'k'.repeat(32);
const IDENTITY = { owner: 'owner', provider: 'amex', credentialSetId: 'cs-1' };

const OPTIONS: ICardDetailOptions = {
  enabled: true,
  backfillEnabled: false,
  maxRows: 10,
  maxWallMs: 600_000,
  timeoutMs: 5_000,
  minDelayMs: 0,
  maxDelayMs: 0,
  hmacKey: HMAC_KEY,
  identityContext: IDENTITY,
  cardAliases: [],
};

/** A response as the endpoint's success envelope carries it. */
type DetailResponse = ReturnType<typeof succeed<{ http: IDetailHttp; envelope: unknown }>>;

/** Transport facts the loop reads off a response. */
interface IDetailHttp {
  status: number;
  contentType: string;
  redirected: boolean;
  sameOrigin: boolean;
}

/** A clean 200 carrying JSON — the shape every happy-path test starts from. */
const OK_HTTP: IDetailHttp = {
  status: 200,
  contentType: 'application/json',
  redirected: false,
  sameOrigin: true,
};

/**
 * A page of rows, each with a distinct voucher.
 * @param n - How many rows to build.
 * @returns Rows shaped as the transactions response returns them.
 */
function rows(n: number): Record<string, unknown>[] {
  return Array.from({ length: n }, (_unused, i): Record<string, unknown> => ({
    seqVoucherNumber: String(1000 + i),
    merchantName: 'M',
  }));
}

/**
 * Response shaped as the endpoint's success envelope.
 * @param data - The detail fields the provider would return.
 * @returns A successful procedure carrying that envelope.
 */
function okResponse(data: Record<string, unknown>): DetailResponse {
  return succeed({ http: OK_HTTP, envelope: { isSuccess: true, data } });
}

/** The detail fields a successful response carries in most of these tests. */
const CATEGORY_DETAIL = { businessName: 'M', branchDescription: 'CATEGORY' };

/** A shorter category payload, where only the presence of one matters. */
const CATEGORY_C = { businessName: 'M', branchDescription: 'C' };

/**
 * The default POST: always answers with a usable category.
 * @returns A successful detail response.
 */
function defaultPost(): Promise<DetailResponse> {
  const answer = okResponse(CATEGORY_DETAIL);
  return Promise.resolve(answer);
}

/**
 * A clock frozen at zero, so no test depends on real elapsed time.
 * @returns Always zero.
 */
function frozenNow(): number {
  return 0;
}

/**
 * Pacing that never actually waits.
 * @returns A promise resolving immediately.
 */
function noPause(): Promise<void> {
  return Promise.resolve();
}

/**
 * Jitter pinned to the bottom of the range, so delays are deterministic.
 * @returns Always zero.
 */
function noJitter(): number {
  return 0;
}

/**
 * Assemble the loop's collaborators, with per-test overrides.
 * @param over - Collaborators to replace.
 * @param options - Pass options to merge over the defaults.
 * @returns The dependency bundle.
 */
function makeDeps(
  over: Partial<ICardDetailDeps> = {},
  options: Partial<ICardDetailOptions> = {},
): ICardDetailDeps {
  return {
    post: defaultPost,
    options: { ...OPTIONS, ...options },
    account: { cardSuffix: '4821', companyCode: 7 },
    now: frozenNow,
    sleep: noPause,
    jitter: noJitter,
    ...over,
  };
}

/** A live tally of how many times the fake endpoint was asked. */
interface IPostLog {
  calls: number;
}

/**
 * A POST that tallies its calls and answers the same way every time.
 *
 * A named factory rather than an inline arrow at each call site: the loop's
 * contract is about HOW MANY requests it makes, so the tally is the assertion
 * in most of these tests and deserves to be spelled once.
 * @param log - The tally to increment.
 * @param answer - What to answer on every call.
 * @returns A POST for the dependency bundle.
 */
function countingPost(log: IPostLog, answer: DetailResponse): ICardDetailDeps['post'] {
  return (): Promise<DetailResponse> => {
    log.calls += 1;
    return Promise.resolve(answer);
  };
}

/**
 * A POST that always reports the request never landed.
 * @returns A failed procedure.
 */
function alwaysFailingPost(): Promise<ReturnType<typeof fail>> {
  const failure = fail(ScraperErrorTypes.Generic, 'down');
  return Promise.resolve(failure);
}

/**
 * The fingerprint the loop derives for one row of the fixture card.
 * @param voucher - The row's voucher number.
 * @returns The fingerprint the caller would have stored.
 */
async function rowFingerprintFor(voucher: string): Promise<string> {
  const { createHmac } = await import('node:crypto');
  const parts = ['card-1', 'voucher', voucher].join(SEPARATOR);
  return createHmac('sha256', HMAC_KEY).update(parts).digest('hex');
}

/**
 * The fingerprint the loop derives for the fixture card itself.
 * @returns The observed account fingerprint.
 */
async function observedCardFingerprint(): Promise<string> {
  const { createHmac } = await import('node:crypto');
  const parts = [IDENTITY.owner, IDENTITY.provider, IDENTITY.credentialSetId, '4821'];
  const joined = parts.join(SEPARATOR);
  return createHmac('sha256', HMAC_KEY).update(joined).digest('hex');
}

/**
 * Deps whose alias table matches the fixture card, so a canonical id resolves.
 *
 * The observed fingerprint is derived exactly as the loop derives it, including
 * the ASCII unit separator between parts — written as an escape here because a
 * literal control character in a test fixture is invisible and easy to break.
 * @param over - Collaborators to replace.
 * @param options - Pass options to merge over the defaults.
 * @returns The dependency bundle, with the card resolvable.
 */
async function withResolvableCard(
  over: Partial<ICardDetailDeps> = {},
  options: Partial<ICardDetailOptions> = {},
): Promise<ICardDetailDeps> {
  const observed = await observedCardFingerprint();
  return makeDeps(over, {
    cardAliases: [{ observedAccountFingerprint: observed, canonicalCardId: 'card-1' }],
    ...options,
  });
}

describe('enrichCardDetail — never subtracts from a scrape', () => {
  it('returns every row when enrichment is disabled', async () => {
    const input = rows(3);
    const deps = makeDeps({}, { enabled: false });
    const out = await enrichCardDetail(input, deps);
    expect(out).toHaveLength(3);
    expect(out).toEqual(input);
  });

  it('returns every row when no HMAC key is configured', async () => {
    const input = rows(3);
    const deps = makeDeps({}, { hmacKey: undefined });
    const out = await enrichCardDetail(input, deps);
    expect(out).toEqual(input);
  });

  it('returns every row when the card identity is unusable', async () => {
    const input = rows(3);
    const deps = makeDeps({ account: { cardSuffix: 'nope', companyCode: 7 } });
    const out = await enrichCardDetail(input, deps);
    expect(out).toHaveLength(3);
    // Recorded rather than skipped silently, so "never asked" stays
    // distinguishable from "asked and learned nothing".
    const hasOutcomeEverywhere = out.every((r: Record<string, unknown>): boolean => r.__detailOutcome !== undefined);
    expect(hasOutcomeEverywhere).toBe(true);
  });

  it('returns every row when the card cannot be resolved to a canonical id', async () => {
    const input = rows(4);
    const deps = makeDeps();
    const out = await enrichCardDetail(input, deps);
    expect(out).toHaveLength(4);
  });

  it('returns every row when every request fails', async () => {
    const deps = await withResolvableCard({ post: alwaysFailingPost });
    const input = rows(3);
    const out = await enrichCardDetail(input, deps);
    expect(out).toHaveLength(3);
  });

  it('preserves order and every provider field', async () => {
    const deps = await withResolvableCard();
    const input = rows(3);
    const out = await enrichCardDetail(input, deps);
    const vouchers = out.map((r: Record<string, unknown>): unknown => r.seqVoucherNumber);
    const didKeepMerchant = out.every((r: Record<string, unknown>): boolean => r.merchantName === 'M');
    expect(vouchers).toEqual(['1000', '1001', '1002']);
    expect(didKeepMerchant).toBe(true);
  });
});

describe('enrichCardDetail — spending and stopping', () => {
  it('stops issuing requests once the row limit is reached, keeping later rows', async () => {
    const log = { calls: 0 };
    const answer = okResponse(CATEGORY_C);
    const deps = await withResolvableCard(
      { post: countingPost(log, answer) },
      { maxRows: 2 },
    );
    const input = rows(5);
    const out = await enrichCardDetail(input, deps);
    expect(log.calls).toBe(2);
    expect(out).toHaveLength(5);
  });

  it('abandons the pass on an expired session rather than spending the rest of the budget', async () => {
    const log = { calls: 0 };
    const answer = succeed({ http: { ...OK_HTTP, status: 401 }, envelope: null });
    const deps = await withResolvableCard({
      post: countingPost(log, answer),
    });
    const input = rows(5);
    const out = await enrichCardDetail(input, deps);
    expect(log.calls).toBe(1); // stopped, rather than 5 doomed requests
    expect(out).toHaveLength(5);
  });

  it('abandons the pass when the response shape is no longer understood', async () => {
    const log = { calls: 0 };
    const answer = succeed({ http: OK_HTTP, envelope: { unexpected: true } });
    const deps = await withResolvableCard({
      post: countingPost(log, answer),
    });
    const input = rows(4);
    await enrichCardDetail(input, deps);
    expect(log.calls).toBe(1);
  });

  it('skips a transaction whose detail the caller already holds', async () => {
    const log = { calls: 0 };
    const rowFp = await rowFingerprintFor('1000');
    const answer = okResponse(CATEGORY_C);
    const deps = await withResolvableCard(
      { post: countingPost(log, answer) },
      { existingFingerprints: [rowFp] },
    );
    const input = rows(2);
    const out = await enrichCardDetail(input, deps);
    expect(log.calls).toBe(1); // the second row only
    expect(out).toHaveLength(2);
  });

  it('re-fetches a known transaction when backfilling', async () => {
    const log = { calls: 0 };
    const rowFp = await rowFingerprintFor('1000');
    const answer = okResponse(CATEGORY_C);
    const deps = await withResolvableCard(
      { post: countingPost(log, answer) },
      { existingFingerprints: [rowFp], backfillEnabled: true },
    );
    const input = rows(2);
    await enrichCardDetail(input, deps);
    expect(log.calls).toBe(2);
  });

  it('never re-fetches a blocked transaction, even when backfilling', async () => {
    const log = { calls: 0 };
    const rowFp = await rowFingerprintFor('1000');
    const answer = okResponse(CATEGORY_C);
    const deps = await withResolvableCard(
      { post: countingPost(log, answer) },
      { blockedFingerprints: [rowFp], backfillEnabled: true },
    );
    const input = rows(2);
    await enrichCardDetail(input, deps);
    expect(log.calls).toBe(1);
  });

  it('refuses to guess when a card maps to more than one canonical id', async () => {
    // Guessing would attach one card's detail to another card's history.
    const observed = await observedCardFingerprint();
    const log = { calls: 0 };
    const answer = okResponse({});
    const deps = makeDeps(
      { post: countingPost(log, answer) },
      {
        cardAliases: [
          { observedAccountFingerprint: observed, canonicalCardId: 'card-1' },
          { observedAccountFingerprint: observed, canonicalCardId: 'card-2' },
        ],
      },
    );
    const input = rows(2);
    const out = await enrichCardDetail(input, deps);
    expect(log.calls).toBe(0);
    expect(out).toHaveLength(2);
  });
});

describe('enrichCardDetail — voucher identification across both banks', () => {
  it("reads Isracard's voucher field, not only Amex's", async () => {
    // Reading only Amex's names left most Isracard rows with no voucher, so
    // they were recorded as unfetchable and no category was ever requested —
    // most of the enrichment lost quietly, with nothing failing.
    const log = { calls: 0 };
    const answer = okResponse(CATEGORY_C);
    const deps = await withResolvableCard({ post: countingPost(log, answer) });
    await enrichCardDetail([{ voucherNumberRatz: '4242', merchantName: 'M' }], deps);
    expect(log.calls).toBe(1);
  });

  it('reads the outbound-currency voucher too', async () => {
    const log = { calls: 0 };
    const answer = okResponse(CATEGORY_C);
    const deps = await withResolvableCard({ post: countingPost(log, answer) });
    await enrichCardDetail([{ voucherNumberRatzOutbound: '4242', merchantName: 'M' }], deps);
    expect(log.calls).toBe(1);
  });

  it('treats the all-zeros sentinel as no voucher rather than an id', async () => {
    // This provider marks "no voucher" with all zeros; requesting detail for
    // it would spend a request against a rate-limited endpoint to learn
    // nothing.
    const log = { calls: 0 };
    const answer = okResponse({});
    const deps = await withResolvableCard({ post: countingPost(log, answer) });
    const out = await enrichCardDetail([{ voucherNumberRatz: '000000000', merchantName: 'M' }], deps);
    expect(log.calls).toBe(0);
    expect(out).toHaveLength(1);
  });
});
