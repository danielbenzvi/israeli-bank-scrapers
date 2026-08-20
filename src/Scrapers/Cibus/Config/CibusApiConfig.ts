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
 * Fixed application identifier the provider's own front end sends on every
 * call.
 *
 * Not a secret — it is visible to anyone who opens the site — but the API
 * rejects or empties responses without it, so omitting it makes a perfectly
 * good session look like an account with no transactions. That is exactly how
 * it presented the first time: authentication succeeded, cookies were issued,
 * and the data call returned zero rows.
 */
export const APPLICATION_ID = 'E5D5FEF5-A05E-4C64-AEBA-BA0CECA0E402';

/**
 * The provider's PUBLIC reCAPTCHA site key.
 *
 * Not a secret: it ships in the page source and in the script URL, and is
 * meaningless without the provider's own server-side secret. Pinned here as a
 * FALLBACK only — {@link READ_SITE_KEY} reads it from the live page first, and
 * this is used when the provider's application has not booted far enough to
 * have loaded its own script. Every use of the fallback is logged, so a key
 * rotation surfaces as itself rather than as an unexplained run of 401s.
 */
export const FALLBACK_SITE_KEY = '6LddY28jAAAAALbiEdodIdIYiM563_AgOW4LMcmu';

/**
 * reCAPTCHA v3 action names, read from the provider's own front end.
 *
 * A v3 token is bound to an action and the provider verifies it, so these are
 * observed rather than guessed — a wrong value is rejected with the same opaque
 * 401 as a wrong password. Captured by wrapping `grecaptcha.execute` in the
 * live page and driving the first login step with a fictitious user.
 *
 * TWO ACTIONS, AND ONE TOKEN EACH. The front end calls `execute` separately for
 * each request, which is not decoration: **a v3 token is single-use**. Minting
 * once and sending the same token to both endpoints spends it on the first and
 * gets the second rejected — again as an indistinguishable 401. Every request
 * that carries a token must mint its own.
 */
export const RECAPTCHA_ACTION_PRECHECK = 'checkUserCompany';
export const RECAPTCHA_ACTION_LOGIN = 'login';

/**
 * How long to wait for the provider's reCAPTCHA script to load and mint.
 *
 * The page is opened at `domcontentloaded`, so the script is routinely absent
 * for the first moment. Generous rather than tight: a miss here is reported as
 * a timeout and fails the whole login, so it must not fire on an ordinary slow
 * load.
 */
export const RECAPTCHA_READY_TIMEOUT_MS = 30_000;

/**
 * How long to wait for the provider's OWN application to boot before falling
 * back to the pinned key.
 *
 * The site key reaches the DOM only after the provider's front end boots and
 * its captcha library appends Google's script; the served HTML is a bare
 * application shell carrying no reCAPTCHA reference at all. A reader that runs
 * before boot therefore finds nothing — which is not the provider hiding the
 * key, only us looking too early.
 *
 * Deliberately shorter than {@link RECAPTCHA_READY_TIMEOUT_MS}: exhausting it
 * is not a failure, it means the pinned key is used, and the whole remaining
 * budget is still available for the mint itself.
 */
export const APP_BOOT_TIMEOUT_MS = 10_000;

/**
 * Shape a reCAPTCHA site key must have before this scraper will mint with it.
 *
 * The key is read from a page we do not control and is then interpolated into
 * a script URL, so it is validated rather than trusted. A value that fails
 * this is reported as its own condition — without the check, a stray quote
 * throws inside the page, the caller's `catch` swallows it, and the whole
 * login times out thirty seconds later naming nothing.
 */
export const SITE_KEY_PATTERN = /^[\w-]{20,60}$/;

/**
 * Pacing between the month-window requests.
 *
 * The provider scores request behaviour through reCAPTCHA v3, and a burst is
 * exactly the shape that scores badly. Every other legacy scraper here fetches
 * its windows one after another; this one fanned all of them out at once,
 * which made it the outlier among its own siblings.
 *
 * Declared here rather than imported from the Pipeline timing helpers: those
 * belong to a different architecture, and importing across that boundary would
 * couple the two in the direction this repository is migrating away from.
 */
export const WINDOW_DELAY_MIN_MS = 300;
export const WINDOW_DELAY_MAX_MS = 1_200;

/**
 * Provider statuses this scraper can tell apart — and the one it cannot.
 *
 * Read from the provider's own front end, which assigns its `errorCode`
 * straight from the HTTP status: `401` rejected credentials, `429` too many
 * requests, `311`/`403` user blocked.
 *
 * **The provider exposes no captcha-specific code.** A reCAPTCHA v3 score is
 * returned only to the site owner's own backend, never to the page, so a token
 * scored too low arrives as the same `401` a wrong password gives — for this
 * scraper and for the provider's own login screen alike. Anything not listed
 * here is reported as unrecognised rather than mapped to the nearest familiar
 * verdict.
 */
export const REJECTED_STATUS = 401;
export const RATE_LIMITED_STATUS = 429;
export const BLOCKED_STATUSES: readonly number[] = [311, 403];

/** How long to wait for the ~30-day device token to appear after auth. */
export const DEVICE_COOKIE_TIMEOUT_MS = 15_000;

/** Cookie whose value authorises the JSON calls. Never logged. */
export const SESSION_COOKIE_NAME = 'token';

/** Prefix of the ~30-day cookie that suppresses the OTP challenge. Never logged. */
export const DEVICE_COOKIE_PREFIX = 'device_';
