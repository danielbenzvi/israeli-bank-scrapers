import { CompanyTypes } from '../../../Definitions.js';
import { SCRAPER_CONFIGURATION } from '../../Registry/Config/ScraperConfig.js';

const CFG = SCRAPER_CONFIGURATION.banks[CompanyTypes.Cibus];

/** Auth host. Non-null by construction — see the Cibus entry in ScraperConfig. */
const AUTH_BASE: string = CFG.api.base;

/** Consumer portal. Loaded only so the provider's own reCAPTCHA script runs. */
export const PORTAL_URL = CFG.urls.base;

/** Pre-auth: decides whether this employer requires the `company` field. */
export const SHOW_COMPANY_FIELD_URL = `${AUTH_BASE}/auth/showCompanyField`;

/** Password step and one-time-code step both post here. */
export const AUTH_TOKEN_URL = `${AUTH_BASE}/auth/authToken`;

/** Data endpoint. Verb-dispatched by a `type` field in the body. */
export const DATA_URL: string = CFG.api.purchaseHistory;

/**
 * Every URL this scraper is permitted to contact — the read-only guarantee,
 * expressed structurally rather than as an intention.
 *
 * Cibus is a benefit portal, so an authenticated browser session against it can
 * in principle *spend*. This scraper must only ever read. Rather than trusting
 * that no future edit adds a mutating call, every request goes through
 * {@link isAllowedUrl} and a unit test asserts that the set of URLs the scraper
 * can reach equals this list exactly. A new endpoint cannot be introduced
 * without that test failing, which is what makes the guarantee structural.
 *
 * Only the three `/auth/*` posts write anything server-side, and what they write
 * is a session. The data call is a read.
 */
export const ALLOWED_URLS: readonly string[] = Object.freeze([
  PORTAL_URL,
  SHOW_COMPANY_FIELD_URL,
  AUTH_TOKEN_URL,
  DATA_URL,
]);

/**
 * Guard every outbound request against {@link ALLOWED_URLS}.
 * @param url - Absolute URL a caller intends to request.
 * @returns True when the URL is on the allow-list.
 */
export function isAllowedUrl(url: string): boolean {
  return ALLOWED_URLS.includes(url);
}

/**
 * Non-standard HTTP status the provider returns to mean "one-time code
 * required". A client treating any unexpected status as failure misreads the
 * challenge as a credential rejection — the same class of mistake documented
 * for another issuer's numeric login status.
 */
export const OTP_REQUIRED_STATUS = 210;

/**
 * reCAPTCHA v3 action name the provider's own front end uses.
 *
 * v3 binds a token to an action and the server may verify it. A wrong value is
 * rejected with the same opaque 401 as a wrong password, so this is pinned
 * rather than guessed, and must be re-read from the SPA if login starts failing
 * for no visible reason.
 */
export const RECAPTCHA_ACTION = 'login';

/**
 * How long to wait for the provider's reCAPTCHA script to load and mint.
 *
 * The page is opened at `domcontentloaded`, so the script is routinely absent
 * for the first moment. Generous rather than tight: a miss here is reported as
 * a timeout and fails the whole login, so it must not fire on an ordinary slow
 * load.
 */
export const RECAPTCHA_READY_TIMEOUT_MS = 30_000;

/** How long to wait for the ~30-day device token to appear after auth. */
export const DEVICE_COOKIE_TIMEOUT_MS = 15_000;

/** Cookie whose value authorises the JSON calls. Never logged. */
export const SESSION_COOKIE_NAME = 'token';

/** Prefix of the ~30-day cookie that suppresses the OTP challenge. Never logged. */
export const DEVICE_COOKIE_PREFIX = 'device_';
