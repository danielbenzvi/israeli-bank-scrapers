/**
 * Functions evaluated INSIDE the provider's page.
 *
 * Kept in their own module because they run in the browser realm, not Node's:
 * they may not close over anything from this project, and the repository's
 * source rules (no manual timers, explicit returns, small functions) describe
 * Node-side code. Isolating them makes that boundary visible rather than
 * implicit, and keeps the scraper itself free of `globalThis` handling.
 *
 * Neither function takes or returns a credential. The reCAPTCHA token is a
 * short-lived, single-use anti-abuse artifact bound to one request — it is not
 * a session, and it authorises nothing on its own.
 */

/** Shape of the reCAPTCHA v3 global, as far as this project uses it. */
interface IGrecaptcha {
  ready?: (cb: () => void) => void;
  execute?: (siteKey: string, opts: { action: string }) => Promise<string>;
  enterprise?: unknown;
}

/**
 * Mint a reCAPTCHA v3 token using the page's own script and site key.
 *
 * The site key is read from the provider's own script tag rather than pinned
 * here: it is theirs to rotate, and a stale copy would fail as an opaque 401
 * indistinguishable from a wrong password.
 *
 * @param action - The v3 action name to bind the token to.
 * @returns The token, or null when the API or key is unavailable.
 */
export const MINT_RECAPTCHA_TOKEN = (action: string): Promise<string | null> => {
  const scope = globalThis as unknown as { grecaptcha?: IGrecaptcha; document: Document };
  const api = scope.grecaptcha;
  if (!api?.ready || !api.execute) return Promise.resolve(null);

  const tags = Array.from(scope.document.querySelectorAll('script[src*="recaptcha"]'));
  const keys = tags.map(tag => new URL((tag as HTMLScriptElement).src).searchParams.get('render'));
  const siteKey = keys.find(key => key !== null && key !== 'explicit');
  if (!siteKey) return Promise.resolve(null);

  const ready = api.ready.bind(api);
  const execute = api.execute.bind(api);
  return new Promise<string | null>(resolve => {
    ready(() => {
      execute(siteKey, { action }).then(resolve, () => resolve(null));
    });
  });
};

/**
 * Report whether the page exposes the reCAPTCHA Enterprise namespace.
 *
 * Enterprise mints through `grecaptcha.enterprise.execute`, so its presence
 * means {@link MINT_RECAPTCHA_TOKEN} no longer describes how this provider
 * issues tokens.
 *
 * @returns True when the Enterprise namespace exists.
 */
export const READ_ENTERPRISE_FLAG = (): boolean => {
  const scope = globalThis as unknown as { grecaptcha?: IGrecaptcha };
  return typeof scope.grecaptcha?.enterprise !== 'undefined';
};
