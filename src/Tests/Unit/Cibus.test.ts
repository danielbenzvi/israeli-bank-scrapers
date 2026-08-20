import { CompanyTypes } from '../../Definitions.js';
import { toIsoDate } from '../../Scrapers/Cibus/CibusMapping.js';
import {
  ALLOWED_URLS,
  AUTH_TOKEN_URL,
  DATA_URL,
  isAllowedUrl,
  OTP_REQUIRED_STATUS,
  PORTAL_URL,
  SHOW_COMPANY_FIELD_URL,
} from '../../Scrapers/Cibus/Config/CibusApiConfig.js';
import { SCRAPER_CONFIGURATION } from '../../Scrapers/Registry/Config/ScraperConfig.js';

describe('Cibus — read-only guarantee', () => {
  /**
   * THIS TEST IS THE GUARANTEE, not a description of it.
   *
   * Cibus is a benefit portal, so an authenticated session against it can in
   * principle spend. The scraper may only read. Rather than trusting that no
   * future edit adds a mutating call, the reachable URL set is frozen and
   * asserted here: adding an endpoint without updating this list fails the
   * build, which is what makes "read-only" structural rather than intended.
   */
  it('can reach exactly four URLs, and no others', () => {
    const reachable = [...ALLOWED_URLS].sort();
    const expected = [PORTAL_URL, SHOW_COMPANY_FIELD_URL, AUTH_TOKEN_URL, DATA_URL].sort();
    expect(reachable).toEqual(expected);
    expect(ALLOWED_URLS).toHaveLength(4);
  });

  it('refuses any URL outside the allow-list', () => {
    const isAuthAllowed = isAllowedUrl(AUTH_TOKEN_URL);
    const isDataAllowed = isAllowedUrl(DATA_URL);
    expect(isAuthAllowed).toBe(true);
    expect(isDataAllowed).toBe(true);

    // Plausible neighbours a careless edit might reach for.
    const isLogoutAllowed = isAllowedUrl('https://api.capir.pluxee.co.il/auth/logout');
    const isOrderAllowed = isAllowedUrl('https://api.consumers.pluxee.co.il/api/order.py');
    const isQueryAllowed = isAllowedUrl(`${AUTH_TOKEN_URL}?x=1`);
    expect(isLogoutAllowed).toBe(false);
    expect(isOrderAllowed).toBe(false);
    expect(isQueryAllowed).toBe(false);
  });

  it('every allow-listed URL is https and on a pluxee host', () => {
    for (const url of ALLOWED_URLS) {
      const parsed = new URL(url);
      const isPluxeeHost = parsed.hostname.endsWith('pluxee.co.il');
      expect(parsed.protocol).toBe('https:');
      expect(isPluxeeHost).toBe(true);
    }
  });
});

describe('Cibus — registry wiring', () => {
  it('is a first-class company with its own config entry', () => {
    expect(CompanyTypes.Cibus).toBe('cibus');
    const cfg = SCRAPER_CONFIGURATION.banks[CompanyTypes.Cibus];
    expect(cfg.urls.base).toBe('https://consumers.pluxee.co.il');
    expect(cfg.api.base).toBe('https://api.capir.pluxee.co.il');
  });

  it('declares no selectors — the login drives no form', () => {
    // R-029: the reCAPTCHA token needs only a page context, so nothing here
    // navigates a multi-step form. A selector appearing in this config would
    // mean someone reintroduced the SPA driving this migration deleted.
    expect(SCRAPER_CONFIGURATION.banks[CompanyTypes.Cibus].selectors).toEqual({});
  });
});

describe('Cibus — the one-time-code status', () => {
  it('treats 210 as a challenge, not a failure', () => {
    // The provider signals "code required" with a non-standard 210. A client
    // treating any unexpected status as failure misreads the challenge as a
    // credential rejection and sends the household to fix a password that was
    // never wrong.
    expect(OTP_REQUIRED_STATUS).toBe(210);
    expect(OTP_REQUIRED_STATUS).not.toBe(200);
    expect(OTP_REQUIRED_STATUS).not.toBe(401);
  });
});

/**
 * Parse attempt that reports a refusal instead of throwing, so assertions can
 * compare a value rather than wrap a call.
 * @param value - Candidate provider date string.
 * @returns The ISO date, or the literal 'REJECTED' when toIsoDate refused it.
 */
const TRY_PARSE = (value: string): string => {
  try {
    return toIsoDate(value);
  } catch {
    return 'REJECTED';
  }
};

describe('Cibus — the provider date', () => {
  it('converts DD/MM/YYYY to the ISO date ITransaction.date declares', () => {
    const midMonth = TRY_PARSE('20/07/2026');
    const yearEnd = TRY_PARSE('31/12/2026');
    expect(midMonth).toBe('2026-07-20');
    expect(yearEnd).toBe('2026-12-31');
  });

  /**
   * THE REASON THIS FUNCTION EXISTS.
   *
   * When the day is <= 12 the string is also a valid US MM/DD, so `new Date()`
   * accepts it and returns the WRONG calendar day without erroring — for
   * roughly half of any real feed. `date` is part of the consumer's dedup key,
   * so a wrong day there re-imports the row as a new purchase forever.
   */
  it('reads the day first even when the value is a valid US MM/DD', () => {
    const fifthOfAugust = TRY_PARSE('05/08/2026');
    const firstOfFebruary = TRY_PARSE('01/02/2026');
    expect(fifthOfAugust).toBe('2026-08-05');
    expect(firstOfFebruary).toBe('2026-02-01');

    // What the naive parse produces, asserted so this test documents the bug
    // it prevents rather than merely asserting the fix.
    const naive = new Date('05/08/2026');
    const naiveMonth = naive.getMonth();
    expect(naiveMonth).toBe(4); // May — wrong.
  });

  it('throws rather than guessing when the format changes', () => {
    const alreadyIso = TRY_PARSE('2026-07-20');
    const monthOutOfRange = TRY_PARSE('20/13/2026');
    const dayIsZero = TRY_PARSE('00/07/2026');
    const empty = TRY_PARSE('');
    expect(alreadyIso).toBe('REJECTED');
    expect(monthOutOfRange).toBe('REJECTED');
    expect(dayIsZero).toBe('REJECTED');
    expect(empty).toBe('REJECTED');
  });
});
