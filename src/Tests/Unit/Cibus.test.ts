import { CompanyTypes } from '../../Definitions.js';
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
