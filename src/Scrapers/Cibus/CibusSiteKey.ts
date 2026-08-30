/**
 * Resolving the provider's reCAPTCHA site key, once per login.
 *
 * WHY THIS IS ITS OWN MODULE. Reading the key is a small decision with a long
 * justification, and it is the one part of this scraper that reads
 * externally-controlled state, may write into the page, and must never confuse
 * the two.
 *
 * RESOLVE ONCE, NEVER RE-READ. Every mint in a login uses one resolved value.
 * Re-reading per attempt is worse than wasteful: once our own script tag is in
 * the document carrying the pinned key, a later read matches that tag and
 * hands the pinned key back as though the page had supplied it — so the
 * mechanism meant to notice a key rotation would confirm our own copy instead.
 * A probe must not read back what it wrote.
 */
import type { Page } from 'playwright-core';

import { waitUntil } from '../Pipeline/Mediator/Timing/Waiting.js';
import { IS_RECAPTCHA_READY, READ_SITE_KEY } from './CibusPageScripts.js';
import {
  APP_BOOT_TIMEOUT_MS,
  FALLBACK_SITE_KEY,
  SITE_KEY_PATTERN,
} from './Config/CibusApiConfig.js';

/**
 * Sentinel for "not ready yet", which the poller treats as keep-waiting. A
 * named constant rather than a bare `undefined`, matching the shape used
 * elsewhere in this scraper so the intent is legible at the poller.
 */
const NOT_YET = undefined;

/** Where a site key came from. Reported, so the pinned path is never silent. */
export type SiteKeyProvenance = 'page' | 'pinned-fallback';

/** A resolved key, or a value that cannot safely be minted with. */
export type SiteKeyResolution =
  | { outcome: 'resolved'; key: string; provenance: SiteKeyProvenance }
  | { outcome: 'unusable'; provenance: SiteKeyProvenance };

/**
 * Wait, briefly, for the provider's own application to bring reCAPTCHA up.
 *
 * The key reaches the document only after their front end boots and its
 * captcha library appends Google's script — the served HTML is a bare shell
 * with no reCAPTCHA reference at all. So waiting is what makes the normal path
 * read a real, current key rather than our pinned copy.
 * @param page - The provider's page.
 * @returns True when the provider's own script became usable in time.
 */
async function waitForProviderScript(page: Page): Promise<boolean> {
  const opts = { timeout: APP_BOOT_TIMEOUT_MS, interval: 500 };
  /**
   * One poll attempt, bound to this page.
   * @returns True once usable, or the keep-waiting sentinel.
   */
  const poll = async (): Promise<typeof NOT_YET | true> => pollReadiness(page);
  return waitUntil(poll, 'cibus provider recaptcha', opts).then(
    () => true,
    () => false,
  );
}

/**
 * One readiness poll. Changes nothing in the page.
 * @param page - The provider's page.
 * @returns True once usable, or the keep-waiting sentinel.
 */
async function pollReadiness(page: Page): Promise<typeof NOT_YET | true> {
  const isReady = await page.evaluate(IS_RECAPTCHA_READY).catch(() => false);
  return isReady ? true : NOT_YET;
}

/**
 * Read the key the provider's own script is using, if it is there to read.
 * @param page - The provider's page.
 * @returns The key, or '' when the provider's script has not appeared.
 */
async function readProviderKey(page: Page): Promise<string> {
  const hasBooted = await waitForProviderScript(page);
  if (!hasBooted) return '';
  return page.evaluate(READ_SITE_KEY).catch(() => '');
}

/**
 * Resolve the site key for one login.
 *
 * Falling back is legitimate — a page whose application never boots still
 * mints fine with the pinned key — but it is never silent: the provenance
 * comes back with the key, so "the pinned copy is in use" is a fact in the
 * record rather than an assumption, and whether that branch ever fires can be
 * settled from logs instead of argued.
 * @param page - The provider's page.
 * @returns The resolved key and its provenance, or an unusable verdict.
 */
export async function resolveSiteKey(page: Page): Promise<SiteKeyResolution> {
  const fromPage = await readProviderKey(page);
  const provenance: SiteKeyProvenance = fromPage === '' ? 'pinned-fallback' : 'page';
  const key = fromPage === '' ? FALLBACK_SITE_KEY : fromPage;
  // Validated, not trusted: it may have come from a page we do not control and
  // it is about to be interpolated into a script URL. Unchecked, a stray quote
  // throws inside the page, the caller's catch swallows it, and the login dies
  // of a mint timeout thirty seconds later naming nothing.
  const isUsable = SITE_KEY_PATTERN.test(key);
  if (!isUsable) return { outcome: 'unusable', provenance };
  return { outcome: 'resolved', key, provenance };
}
