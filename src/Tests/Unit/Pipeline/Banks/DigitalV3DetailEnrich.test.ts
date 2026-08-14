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

import {
  enrichCardDetail,
  type ICardDetailDeps,
  type ICardDetailOptions,
} from '../../../../Scrapers/Pipeline/Banks/DigitalV3/DetailEnrich.js';
import { fail, succeed } from '../../../../Scrapers/Pipeline/Types/Procedure.js';
import { ScraperErrorTypes } from '../../../../Scrapers/Base/ErrorTypes.js';

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

const rows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ seqVoucherNumber: String(1000 + i), merchantName: 'M' }));

/** Response shaped as the endpoint's success envelope. */
const okResponse = (data: Record<string, unknown>) =>
  succeed({
    http: { status: 200, contentType: 'application/json', redirected: false, sameOrigin: true },
    envelope: { isSuccess: true, data },
  });

function makeDeps(over: Partial<ICardDetailDeps> = {}, options: Partial<ICardDetailOptions> = {}): ICardDetailDeps {
  return {
    post: async () => okResponse({ businessName: 'M', branchDescription: 'CATEGORY' }),
    options: { ...OPTIONS, ...options },
    account: { cardSuffix: '4821', companyCode: 7 },
    now: () => 0,
    sleep: async () => {},
    jitter: () => 0,
    ...over,
  };
}

/** Alias table entry matching the fixture card, so a canonical id resolves. */
async function withResolvableCard(over: Partial<ICardDetailDeps> = {}, options: Partial<ICardDetailOptions> = {}) {
  // Derive the observed fingerprint the way the loop does, by letting it run
  // once with an empty table and reading which rows it left untouched — instead
  // the alias is supplied via a helper that mirrors the production shape.
  const { createHmac } = await import('node:crypto');
  const observed = createHmac('sha256', HMAC_KEY)
    .update([IDENTITY.owner, IDENTITY.provider, IDENTITY.credentialSetId, '4821'].join(''))
    .digest('hex');
  return makeDeps(over, {
    cardAliases: [{ observedAccountFingerprint: observed, canonicalCardId: 'card-1' }],
    ...options,
  });
}

describe('enrichCardDetail — never subtracts from a scrape', () => {
  it('returns every row when enrichment is disabled', async () => {
    const input = rows(3);
    const out = await enrichCardDetail(input, makeDeps({}, { enabled: false }));
    expect(out).toHaveLength(3);
    expect(out).toEqual(input);
  });

  it('returns every row when no HMAC key is configured', async () => {
    const input = rows(3);
    expect(await enrichCardDetail(input, makeDeps({}, { hmacKey: undefined }))).toEqual(input);
  });

  it('returns every row when the card identity is unusable', async () => {
    const input = rows(3);
    const out = await enrichCardDetail(input, makeDeps({ account: { cardSuffix: 'nope', companyCode: 7 } }));
    expect(out).toHaveLength(3);
    // Recorded rather than skipped silently, so "never asked" stays
    // distinguishable from "asked and learned nothing".
    expect(out.every((r: Record<string, unknown>) => (r as Record<string, unknown>)['__detailOutcome'] !== undefined)).toBe(true);
  });

  it('returns every row when the card cannot be resolved to a canonical id', async () => {
    const input = rows(4);
    expect(await enrichCardDetail(input, makeDeps())).toHaveLength(4);
  });

  it('returns every row when every request fails', async () => {
    const deps = await withResolvableCard({ post: async () => fail(ScraperErrorTypes.Generic, 'down') });
    const input = rows(3);
    const out = await enrichCardDetail(input, deps);
    expect(out).toHaveLength(3);
  });

  it('preserves order and every provider field', async () => {
    const deps = await withResolvableCard();
    const input = rows(3);
    const out = await enrichCardDetail(input, deps);
    expect(out.map((r: Record<string, unknown>) => (r as Record<string, unknown>)['seqVoucherNumber'])).toEqual(['1000', '1001', '1002']);
    expect(out.every((r: Record<string, unknown>) => (r as Record<string, unknown>)['merchantName'] === 'M')).toBe(true);
  });
});

describe('enrichCardDetail — spending and stopping', () => {
  it('stops issuing requests once the row limit is reached, keeping later rows', async () => {
    let calls = 0;
    const deps = await withResolvableCard(
      { post: async () => { calls++; return okResponse({ businessName: 'M', branchDescription: 'C' }); } },
      { maxRows: 2 },
    );
    const out = await enrichCardDetail(rows(5), deps);
    expect(calls).toBe(2);
    expect(out).toHaveLength(5);
  });

  it('abandons the pass on an expired session rather than spending the rest of the budget', async () => {
    let calls = 0;
    const deps = await withResolvableCard({
      post: async () => {
        calls++;
        return succeed({
          http: { status: 401, contentType: 'application/json', redirected: false, sameOrigin: true },
          envelope: null,
        });
      },
    });
    const out = await enrichCardDetail(rows(5), deps);
    expect(calls).toBe(1); // stopped, rather than 5 doomed requests
    expect(out).toHaveLength(5);
  });

  it('abandons the pass when the response shape is no longer understood', async () => {
    let calls = 0;
    const deps = await withResolvableCard({
      post: async () => { calls++; return succeed({ http: { status: 200, contentType: 'application/json', redirected: false, sameOrigin: true }, envelope: { unexpected: true } }); },
    });
    await enrichCardDetail(rows(4), deps);
    expect(calls).toBe(1);
  });

  it('skips a transaction whose detail the caller already holds', async () => {
    let calls = 0;
    const { createHmac } = await import('node:crypto');
    const rowFp = createHmac('sha256', HMAC_KEY).update(['card-1', 'voucher', '1000'].join('')).digest('hex');
    const deps = await withResolvableCard(
      { post: async () => { calls++; return okResponse({ businessName: 'M', branchDescription: 'C' }); } },
      { existingFingerprints: [rowFp] },
    );
    const out = await enrichCardDetail(rows(2), deps);
    expect(calls).toBe(1); // the second row only
    expect(out).toHaveLength(2);
  });

  it('re-fetches a known transaction when backfilling', async () => {
    let calls = 0;
    const { createHmac } = await import('node:crypto');
    const rowFp = createHmac('sha256', HMAC_KEY).update(['card-1', 'voucher', '1000'].join('')).digest('hex');
    const deps = await withResolvableCard(
      { post: async () => { calls++; return okResponse({ businessName: 'M', branchDescription: 'C' }); } },
      { existingFingerprints: [rowFp], backfillEnabled: true },
    );
    await enrichCardDetail(rows(2), deps);
    expect(calls).toBe(2);
  });

  it('never re-fetches a blocked transaction, even when backfilling', async () => {
    let calls = 0;
    const { createHmac } = await import('node:crypto');
    const rowFp = createHmac('sha256', HMAC_KEY).update(['card-1', 'voucher', '1000'].join('')).digest('hex');
    const deps = await withResolvableCard(
      { post: async () => { calls++; return okResponse({ businessName: 'M', branchDescription: 'C' }); } },
      { blockedFingerprints: [rowFp], backfillEnabled: true },
    );
    await enrichCardDetail(rows(2), deps);
    expect(calls).toBe(1);
  });

  it('refuses to guess when a card maps to more than one canonical id', async () => {
    // Guessing would attach one card's detail to another card's history.
    const { createHmac } = await import('node:crypto');
    const observed = createHmac('sha256', HMAC_KEY)
      .update([IDENTITY.owner, IDENTITY.provider, IDENTITY.credentialSetId, '4821'].join(''))
      .digest('hex');
    let calls = 0;
    const deps = makeDeps(
      { post: async () => { calls++; return okResponse({}); } },
      {
        cardAliases: [
          { observedAccountFingerprint: observed, canonicalCardId: 'card-1' },
          { observedAccountFingerprint: observed, canonicalCardId: 'card-2' },
        ],
      },
    );
    const out = await enrichCardDetail(rows(2), deps);
    expect(calls).toBe(0);
    expect(out).toHaveLength(2);
  });
});
