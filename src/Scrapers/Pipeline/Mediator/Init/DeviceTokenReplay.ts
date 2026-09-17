/**
 * Device-token replay on the browser login path.
 *
 * <p>The counterpart to capture: a token that is stored but never presented
 * buys nothing, and the provider challenges again on every run. It is replayed
 * as the cookie it was issued as, before the first navigation — a cookie set
 * after the page has loaded its login flow arrives too late to be read.
 *
 * <p>Injected only for a bank that DECLARES a device cookie, and only when the
 * caller supplied a token. Absent ⇒ nothing happens, which is every bank that
 * does not use one and every first, cold run of the one that does.
 *
 * <p>Nothing here logs the token. Its presence is a boolean; its value is a
 * login without a password.
 */

import type { IDeviceTokenSpec } from '../OtpFill/OtpDeviceToken.js';

/** The one capability replay needs — injection, and nothing else. */
export interface ICookieInjector {
  addCookies(cookies: readonly ICookieInjection[]): Promise<void>;
}

/** A cookie as the browser context accepts it. */
interface ICookieInjection {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
}

/**
 * The two lines replay ever writes.
 *
 * Narrower than the pipeline logger on purpose: it states that this module
 * reports and never reads, and it lets a test implement the real interface
 * rather than cast a partial one.
 */
export interface IReplayLogger {
  debug(event: { message: string }): void;
  warn(event: { message: string }): void;
}

/** Bundled args for {@link replayDeviceToken}. */
export interface IReplayArgs {
  readonly injector: ICookieInjector;
  readonly spec: IDeviceTokenSpec;
  readonly token: string;
  readonly logger: IReplayLogger;
}

/**
 * Split a stored `name=value` token into its parts.
 *
 * The value may itself contain `=` (base64 padding), so only the FIRST
 * separator divides them — splitting on all of them silently truncates the
 * token and the provider rejects a login that looks otherwise correct.
 * @param token - The stored token, as `name=value`.
 * @returns The parts, or false when the token is not in that shape.
 */
function splitToken(token: string): { name: string; value: string } | false {
  const at = token.indexOf('=');
  if (at <= 0) return false;
  const name = token.slice(0, at);
  const value = token.slice(at + 1);
  return value.length === 0 ? false : { name, value };
}

/**
 * Present a stored device token, so the provider does not challenge again.
 * @param args - Injector, the bank's spec, the stored token, and a logger.
 * @returns True when a token was injected.
 */
export async function replayDeviceToken(args: IReplayArgs): Promise<boolean> {
  const parts = splitToken(args.token);
  if (parts === false) return reportMalformed(args);
  const domain = args.spec.cookieDomain;
  await args.injector.addCookies([{ ...parts, domain, path: '/' }]);
  args.logger.debug({ message: 'device token replayed — challenge should be skipped' });
  return true;
}

/**
 * Note a stored token that is not in `name=value` shape.
 * @param args - Replay args, for the logger.
 * @returns False, meaning nothing was injected.
 */
function reportMalformed(args: IReplayArgs): false {
  args.logger.warn({ message: 'stored device token is not name=value — ignoring' });
  return false;
}
