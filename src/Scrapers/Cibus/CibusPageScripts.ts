/**
 * Functions evaluated INSIDE the provider's page.
 *
 * Kept in their own module because they run in the browser realm, not Node's.
 * `page.evaluate` serialises the function and runs it there, so these may not
 * reference anything from this project — which is why each is self-contained
 * rather than composed from shared helpers.
 *
 * That constraint is also why the work is split across THREE small evaluations
 * rather than one large one: reading the site key, minting a token, and probing
 * for the Enterprise namespace are independent questions, and asking them
 * separately keeps each function small enough to read at a glance.
 *
 * None of these takes or returns a credential. A reCAPTCHA token is a
 * short-lived, single-use anti-abuse artifact bound to one request — it is not a
 * session and authorises nothing on its own.
 */

/** Shape of the reCAPTCHA v3 global, as far as this project uses it. */
interface IGrecaptcha {
  execute?: (siteKey: string, opts: { action: string }) => Promise<string>;
  enterprise?: unknown;
}

/** The page realm, narrowed to what these scripts touch. */
interface IPageScope {
  grecaptcha?: IGrecaptcha;
  document: Document;
}

/**
 * Read the provider's public reCAPTCHA site key from its own script tag.
 *
 * Read rather than pinned: the key is theirs to rotate, and a stale copy would
 * fail as an opaque 401 indistinguishable from a wrong password.
 * @returns The site key, or an empty string when the script is absent.
 */
export const READ_SITE_KEY = (): string => {
  const scope = globalThis as unknown as IPageScope;
  const nodes = scope.document.querySelectorAll('script[src*="recaptcha"]');
  const tags = Array.from(nodes);
  const sources = tags.map(tag => (tag as HTMLScriptElement).src);
  const keys = sources.map(READ_RENDER_PARAM);
  const found = keys.find(key => key !== '' && key !== 'explicit');
  return found ?? '';
};

/**
 * Read the `render` query parameter from one script URL.
 * @param source - The script tag's src.
 * @returns The parameter value, or '' when absent.
 */
const READ_RENDER_PARAM = (source: string): string => {
  const url = new URL(source);
  const value = url.searchParams.get('render');
  return value ?? '';
};

/**
 * Mint a reCAPTCHA v3 token, binding it to one action.
 *
 * Calls `execute` directly rather than waiting on `grecaptcha.ready`: the
 * caller has already established that `execute` is a function, which only
 * happens once the API has loaded, and the callback form cannot be expressed
 * without a promise executor. A miss returns '' and the caller retries the
 * whole login rather than this one call.
 * @param pair - Site key and action name, tab-joined.
 * @returns The token, or '' when the API is unavailable or declined.
 */
export const MINT_WITH_KEY = async (pair: string): Promise<string> => {
  const scope = globalThis as unknown as IPageScope;
  const api = scope.grecaptcha;
  if (!api?.execute) return '';
  const parts = pair.split('\t');
  const opts = { action: parts[1] ?? '' };
  const minted = await api.execute(parts[0] ?? '', opts).catch(() => '');
  return minted;
};

/**
 * Report whether the page exposes the reCAPTCHA Enterprise namespace.
 *
 * Enterprise mints through `grecaptcha.enterprise.execute`, so its presence
 * means {@link MINT_WITH_KEY} no longer describes how this provider issues
 * tokens — a change worth surfacing as itself rather than as a rise in 401s.
 * @returns True when the Enterprise namespace exists.
 */
export const READ_ENTERPRISE_FLAG = (): boolean => {
  const scope = globalThis as unknown as IPageScope;
  return typeof scope.grecaptcha?.enterprise !== 'undefined';
};
