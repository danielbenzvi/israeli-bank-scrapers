import { CompanyTypes } from '../../Definitions.js';
import ScraperErrorTypes from '../../Scrapers/Base/ErrorTypes.js';
import {
  authFailureFor,
  type ICibusDeal,
  isCountable,
  partitionByActivity,
  readActivity,
  toIsoDate,
} from '../../Scrapers/Cibus/CibusMapping.js';
import {
  ALLOWED_URLS,
  AUTH_TOKEN_URL,
  DATA_URL,
  isAllowedUrl,
  OTP_REQUIRED_STATUS,
  PORTAL_URL,
  SHOW_COMPANY_FIELD_URL,
  SITE_KEY_PATTERN,
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

/**
 * Build a purchase row carrying one particular activity value.
 * @param isActive - The provider's `is_active` value for this row.
 * @returns A minimal row, valid apart from the field under test.
 */
function dealWithActivity(isActive: unknown): ICibusDeal {
  const row = { deal_id: 1, date: '05/08/2026', price: 10, etc_company_price: 10, otl_price: 0 };
  return { ...row, is_active: isActive } as ICibusDeal;
}

describe('Cibus — which rows count', () => {
  /**
   * WRITTEN FROM THE PROVIDER'S VOCABULARY, NOT FROM THE IMPLEMENTATION.
   *
   * The provider declares this field a string and sends numbers, so both forms
   * are legitimate. Anything else is a value nobody has seen, and the only
   * safe reading of an unseen value is that we do not know what it means.
   */
  it('counts a live row in either form the provider may send it', () => {
    const numericRow = dealWithActivity(1);
    const stringRow = dealWithActivity('1');
    const asNumber = readActivity(1);
    const asString = readActivity('1');
    const isNumericCounted = isCountable(numericRow);
    const isStringCounted = isCountable(stringRow);
    expect(asNumber).toBe('live');
    expect(asString).toBe('live');
    expect(isNumericCounted).toBe(true);
    expect(isStringCounted).toBe(true);
  });

  it('excludes a row the provider has cancelled, in either form', () => {
    const numericRow = dealWithActivity(0);
    const stringRow = dealWithActivity('0');
    const asNumber = readActivity(0);
    const asString = readActivity('0');
    const isNumericCounted = isCountable(numericRow);
    const isStringCounted = isCountable(stringRow);
    expect(asNumber).toBe('excluded');
    expect(asString).toBe('excluded');
    expect(isNumericCounted).toBe(false);
    expect(isStringCounted).toBe(false);
  });

  /**
   * The case the previous implementation got wrong, and the reason this guard
   * was rewritten. `Number('Y')` is `NaN`, `NaN !== 0` is true, so a row whose
   * status nobody can read was counted as a live purchase. An exclusion that
   * fails open is silent, and silence here is indistinguishable from having
   * nothing to exclude.
   */
  it('refuses to count a value the provider has never been seen to send', () => {
    const letter = readActivity('Y');
    const otherNumber = readActivity(2);
    const absent = readActivity(undefined);
    const nothing = readActivity(null);
    const letterRow = dealWithActivity('Y');
    const isLetterCounted = isCountable(letterRow);
    expect(letter).toBe('unknown');
    expect(otherNumber).toBe('unknown');
    expect(absent).toBe('unknown');
    expect(nothing).toBe('unknown');
    expect(isLetterCounted).toBe(false);
  });

  it('reports how many rows it dropped, and why', () => {
    const live = dealWithActivity(1);
    const liveAsString = dealWithActivity('1');
    const cancelled = dealWithActivity(0);
    const unreadable = dealWithActivity('Y');
    const partition = partitionByActivity([live, liveAsString, cancelled, unreadable]);
    expect(partition.countable).toHaveLength(2);
    expect(partition.excluded).toBe(1);
    expect(partition.unknown).toBe(1);
  });
});

describe('Cibus — what a rejected login is allowed to claim', () => {
  /**
   * The provider returns an identical 401 for a wrong password and for a
   * reCAPTCHA score it judged too low — the score never reaches any client, by
   * Google's design. Claiming `InvalidPassword` therefore asserts a
   * distinction the response cannot support, and the verdict is acted on: it
   * sends a person to re-enter a password that may have been correct.
   */
  it('does not call an ambiguous rejection a credential failure', () => {
    const failure = authFailureFor(401);
    expect(failure.success).toBe(false);
    expect(failure.errorType).toBe(ScraperErrorTypes.Generic);
    expect(failure.errorType).not.toBe(ScraperErrorTypes.InvalidPassword);
  });

  /**
   * A rate limit must not reach a consumer looking like a bad password, or
   * being throttled ends up asking a person to re-enter a credential that was
   * never wrong. Typed as a transport condition — which is what a 429 is —
   * rather than by widening the error enum thirteen scrapers share.
   */
  it('types a rate limit as a transport condition, not a credential one', () => {
    const failure = authFailureFor(429);
    expect(failure.errorType).toBe(ScraperErrorTypes.NetworkError);
    expect(failure.errorType).not.toBe(ScraperErrorTypes.InvalidPassword);
    expect(failure.errorMessage).toContain('rate limiting');
    expect(failure.errorMessage).toContain('not a credential failure');
  });

  it('reads a blocked account as blocked, not as a bad password', () => {
    const forbidden = authFailureFor(403);
    const blocked = authFailureFor(311);
    expect(forbidden.errorType).toBe(ScraperErrorTypes.AccountBlocked);
    expect(blocked.errorType).toBe(ScraperErrorTypes.AccountBlocked);
  });

  /**
   * A status outside the provider's known vocabulary must stay visibly
   * unknown. Folding it into the nearest familiar verdict is how a change on
   * their side becomes a confident wrong answer on ours.
   */
  it('reports an unrecognised status as unrecognised, and names it', () => {
    const failure = authFailureFor(418);
    expect(failure.errorMessage).toContain('unrecognised');
    expect(failure.errorMessage).toContain('418');
  });
});

describe('Cibus — the site key is validated, not trusted', () => {
  it('accepts a key of the shape the provider actually uses', () => {
    const isWellFormed = SITE_KEY_PATTERN.test('6LddY28jAAAAALbiEdodIdIYiM563_AgOW4LMcmu');
    expect(isWellFormed).toBe(true);
  });

  /**
   * The key is read from a page we do not control and then interpolated into a
   * script URL. Without this check a stray quote throws inside the page, the
   * caller's catch swallows it, and the login dies of a timeout thirty seconds
   * later naming nothing.
   */
  it('rejects values that would break the script URL, or are not keys at all', () => {
    const overlong = '6'.repeat(61);
    const hasQuote = SITE_KEY_PATTERN.test('6Ldd"onerror="alert(1)');
    const isEmptyOk = SITE_KEY_PATTERN.test('');
    const isShortOk = SITE_KEY_PATTERN.test('short');
    const isLongOk = SITE_KEY_PATTERN.test(overlong);
    expect(hasQuote).toBe(false);
    expect(isEmptyOk).toBe(false);
    expect(isShortOk).toBe(false);
    expect(isLongOk).toBe(false);
  });
});
