/**
 * Device-token replay.
 *
 * A token that is stored but never presented buys nothing: the provider
 * challenges again on every run, and an unattended scrape can never complete.
 * The failure is silent — a cookie on the wrong domain, or truncated, is
 * simply not sent, and the run looks like an ordinary cold login.
 */

import {
  type IReplayLogger,
  replayDeviceToken,
} from '../../../../../Scrapers/Pipeline/Mediator/Init/DeviceTokenReplay.js';
import type { IDeviceTokenSpec } from '../../../../../Scrapers/Pipeline/Mediator/OtpFill/OtpDeviceToken.js';

/** One injected cookie, as recorded. */
interface IInjected {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
}

const SPEC: IDeviceTokenSpec = {
  namePrefix: 'device_',
  domainMatch: 'provider',
  cookieDomain: '.provider.example',
};

/** A recorder standing in for the browser's cookie jar. */
interface IRecorder {
  readonly injected: IInjected[];
  addCookies(cookies: readonly IInjected[]): Promise<void>;
}

/**
 * Collect injections instead of driving a browser.
 * @returns A recorder.
 */
function recorder(): IRecorder {
  const injected: IInjected[] = [];
  return {
    injected,
    /**
     * Record an injection.
     * @param cookies - Cookies the caller wants set.
     * @returns Nothing.
     */
    addCookies: (cookies: readonly IInjected[]): Promise<void> => {
      injected.push(...cookies);
      return Promise.resolve();
    },
  };
}

/**
 * Discard one log line.
 * @returns True, which the void-returning logger interface accepts.
 */
function ignoreLine(): true {
  return true;
}

/** A logger that discards — these tests assert on injections, not on lines. */
const LOGGER: IReplayLogger = { debug: ignoreLine, warn: ignoreLine };

describe('device-token replay', () => {
  it('sets the token on the domain the bank stated', () => {
    const rec = recorder();
    const args = { injector: rec, spec: SPEC, token: 'device_abc=xyz', logger: LOGGER };
    return replayDeviceToken(args).then((): void => {
      expect(rec.injected[0]?.domain).toBe('.provider.example');
      expect(rec.injected[0]?.name).toBe('device_abc');
    });
  });

  it('keeps a value containing "=", splitting only on the first', () => {
    // Base64 padding puts `=` inside the VALUE. Splitting on every separator
    // truncates the token, and the provider rejects a login that otherwise
    // looks correct — with nothing in the run to say why.
    const rec = recorder();
    const token = 'device_abc=aGVsbG8=';
    const args = { injector: rec, spec: SPEC, token, logger: LOGGER };
    return replayDeviceToken(args).then((): void => {
      expect(rec.injected[0]?.value).toBe('aGVsbG8=');
    });
  });

  it('injects nothing when the stored token is not name=value', () => {
    const rec = recorder();
    const args = { injector: rec, spec: SPEC, token: 'garbage', logger: LOGGER };
    return replayDeviceToken(args).then((did): void => {
      expect(did).toBe(false);
      expect(rec.injected).toHaveLength(0);
    });
  });
});
