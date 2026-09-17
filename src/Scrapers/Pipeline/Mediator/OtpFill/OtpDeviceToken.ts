/**
 * Device-token capture on the browser login path.
 *
 * <p>WHAT THIS EXISTS FOR. A provider that offers "remember this device"
 * issues a long-lived token as a COOKIE, and only when the trust choice
 * reached the server on the one-time-code step. The api-direct-call path has
 * its own token plumbing; the browser path had none, so the token was minted
 * and then dropped on the floor. Every later run was challenged again, which
 * is the difference between a scrape a person must attend and one that can be
 * scheduled at all.
 *
 * <p>THE TOKEN IS A CREDENTIAL. It leaves through `onAuthFlowComplete` and
 * never through the scraping result, which is persisted and logged. Nothing
 * here logs a cookie VALUE — only whether one was found, and under what name
 * prefix, because a leaked device token is a login without a password.
 *
 * <p>A callback that throws is logged and swallowed: the scrape succeeded, and
 * a consumer's storage problem must not retroactively fail it.
 */

import { toErrorMessage } from '../../Types/ErrorUtils.js';
import type { IPipelineContext } from '../../Types/PipelineContext.js';
import type { ICookieSnapshot, IElementMediator } from '../Elements/ElementMediator.js';

/** What a provider's device cookie looks like, as the bank config declares it. */
export interface IDeviceTokenSpec {
  readonly namePrefix: string;
  readonly domainMatch: string;
  readonly cookieDomain: string;
}

/** The payload `onAuthFlowComplete` receives. */
interface IAuthFlowPayload {
  readonly longTermToken: string;
  readonly bearer: string;
}

/** The callback shape, as a consumer supplies it. */
export type AuthFlowCallback = (info: IAuthFlowPayload) => Promise<void> | void;

/**
 * Serialise cookies into a request header value.
 * @param cookies - Provider-scoped cookies.
 * @returns A `name=value; …` header string.
 */
function toCookieHeader(cookies: readonly ICookieSnapshot[]): string {
  const pairs = cookies.map((c): string => `${c.name}=${c.value}`);
  return pairs.join('; ');
}

/** Bundled args for {@link captureDeviceToken}. */
export interface ICaptureDeviceTokenArgs {
  readonly input: IPipelineContext;
  readonly mediator: IElementMediator;
  readonly spec: IDeviceTokenSpec;
  readonly callback: AuthFlowCallback;
}

/**
 * Hand the device token to the consumer, if the provider issued one.
 *
 * Its absence is NORMAL, not an error: the provider only issues one when the
 * challenge was answered with the trust choice set, so most runs legitimately
 * return none and must not be failed for it.
 * @param args - Context, mediator, the bank's spec, and the callback.
 * @returns True when a token was handed over, false when none was issued.
 */
export async function captureDeviceToken(args: ICaptureDeviceTokenArgs): Promise<boolean> {
  const { input, mediator, spec, callback } = args;
  const all = await mediator.getCookies();
  const scoped = all.filter((c): boolean => c.domain.includes(spec.domainMatch));
  const device = scoped.find((c): boolean => c.name.startsWith(spec.namePrefix));
  if (device === undefined) return reportNoToken(input, spec);
  const longTermToken = `${device.name}=${device.value}`;
  const bearer = toCookieHeader(scoped);
  return invokeCallback({ input, callback, payload: { longTermToken, bearer } });
}

/**
 * Note that no device token was issued, which is an ordinary outcome.
 * @param input - Pipeline context (for the logger).
 * @param spec - The bank's device-cookie spec.
 * @returns False, meaning nothing was handed over.
 */
function reportNoToken(input: IPipelineContext, spec: IDeviceTokenSpec): boolean {
  input.logger.debug({ message: `no device cookie under "${spec.namePrefix}" — not remembered` });
  return false;
}

/** Bundled args for {@link invokeCallback}. */
interface IInvokeArgs {
  readonly input: IPipelineContext;
  readonly callback: AuthFlowCallback;
  readonly payload: IAuthFlowPayload;
}

/**
 * Invoke the consumer's callback, swallowing a throw.
 * @param args - Context, callback and payload.
 * @returns True once the callback has been given the token.
 */
async function invokeCallback(args: IInvokeArgs): Promise<boolean> {
  try {
    await args.callback(args.payload);
    // Names and booleans only — a cookie value is a credential.
    args.input.logger.info({ message: 'device token handed to consumer' });
    return true;
  } catch (error) {
    return logCallbackThrow(args.input, error);
  }
}


/**
 * Log a callback throw without raising it.
 *
 * The scrape succeeded; a consumer's storage fault must not retroactively
 * fail it. The consumer verifies its own write — see its read-back.
 * @param input - Pipeline context (for the logger).
 * @param error - Whatever the callback threw.
 * @returns False, meaning the token was not accepted.
 */
function logCallbackThrow(input: IPipelineContext, error: unknown): false {
  const detail = toErrorMessage(error as Error);
  input.logger.warn({ message: `onAuthFlowComplete threw: ${detail}` });
  return false;
}
