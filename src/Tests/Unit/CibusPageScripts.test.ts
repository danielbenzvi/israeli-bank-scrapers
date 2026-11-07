import {
  INJECT_RECAPTCHA,
  IS_RECAPTCHA_READY,
  MINT_WITH_KEY,
  READ_ENTERPRISE_FLAG,
} from '../../Scrapers/Cibus/CibusPageScripts.js';

/** The globals these scripts read, stubbed onto the test's own realm. */
interface IStubRealm {
  grecaptcha?: unknown;
  wrappedJSObject?: unknown;
}

const REALM = globalThis as unknown as IStubRealm;

/**
 * Build a stand-in for the page's reCAPTCHA API.
 * @param token - What execute resolves to.
 * @returns The API and the arguments it was called with.
 */
function stubApi(token: string): { api: unknown; calls: unknown[][] } {
  const calls: unknown[][] = [];
  /**
   * Record the call and resolve to the token.
   * @param args - What the script passed.
   * @returns The token.
   */
  const execute = (...args: unknown[]): Promise<string> => {
    calls.push(args);
    return Promise.resolve(token);
  };
  return { api: { execute, enterprise: {} }, calls };
}

describe('Cibus page scripts — finding reCAPTCHA', () => {
  afterEach(() => {
    delete REALM.grecaptcha;
    delete REALM.wrappedJSObject;
  });

  describe('isolated world, as on Camoufox 158: the API exists only on wrappedJSObject', () => {
    beforeEach(() => {
      REALM.wrappedJSObject = { grecaptcha: stubApi('from-page').api, JSON };
    });

    it('reports ready', () => {
      const isReady = IS_RECAPTCHA_READY();
      expect(isReady).toBe(true);
    });

    it('does not inject a second copy of the script', () => {
      const isLoaded = INJECT_RECAPTCHA('site-key');
      expect(isLoaded).toBe(true);
    });

    it('mints through the page API, binding the action', async () => {
      const { api, calls } = stubApi('from-page');
      REALM.wrappedJSObject = { grecaptcha: api, JSON };
      const minted = await MINT_WITH_KEY('site-key\tlogin');
      expect(minted).toBe('from-page');
      expect(calls).toEqual([['site-key', { action: 'login' }]]);
    });

    it('sees the Enterprise namespace', () => {
      const hasEnterprise = READ_ENTERPRISE_FLAG();
      expect(hasEnterprise).toBe(true);
    });
  });

  describe('main world, as on older Camoufox: no wrappedJSObject', () => {
    it('reads the API from globalThis', async () => {
      REALM.grecaptcha = stubApi('from-global').api;
      const isReady = IS_RECAPTCHA_READY();
      expect(isReady).toBe(true);
      const minted = await MINT_WITH_KEY('site-key\tlogin');
      expect(minted).toBe('from-global');
    });
  });

  describe('when reCAPTCHA has not loaded', () => {
    it('reports not ready and mints nothing, rather than throwing', async () => {
      REALM.wrappedJSObject = { JSON };
      const isReady = IS_RECAPTCHA_READY();
      expect(isReady).toBe(false);
      const minted = await MINT_WITH_KEY('site-key\tlogin');
      expect(minted).toBe('');
    });

    it('turns a rejected mint into an empty token', async () => {
      const declined = new Error('declined');
      /**
       * Reject, as reCAPTCHA does when it declines.
       * @returns A rejected promise.
       */
      const execute = (): Promise<string> => Promise.reject(declined);
      REALM.wrappedJSObject = { grecaptcha: { execute }, JSON };
      const minted = await MINT_WITH_KEY('site-key\tlogin');
      expect(minted).toBe('');
    });
  });
});
