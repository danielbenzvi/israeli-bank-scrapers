/**
 * Cibus (Pluxee) pipeline — browser login + OTP, then a hard-model api-direct
 * scrape against the provider's single verb-dispatched data endpoint.
 *
 * WHY THE FORM IS DRIVEN RATHER THAN BYPASSED. The auth endpoint enforces
 * reCAPTCHA v3, and the legacy scraper reached it by loading the page purely so
 * the provider's script would run, minting a token through their API, and
 * posting JSON itself. Driving the real form removes that entirely: the page
 * mints and attaches its own token on submit, exactly as it does for any
 * visitor, so this bank needs no captcha handling of its own — no site-key
 * resolution, no script injection, no token plumbing.
 *
 * Login fields carry NO bank-specific selectors: each resolves through the
 * shared visible-text WellKnown (LoginWK). Zero CSS, per the repository rule.
 *
 * THE DEVICE TOKEN IS THE POINT OF THE OTP STEP. The provider issues a ~30-day
 * cookie that suppresses the challenge on later logins, and issues it only when
 * the trust-device choice reaches the server on the one-time-code step — not
 * the password step. It leaves through `onAuthFlowComplete`, never through the
 * scraping result: a credential must not ride the data path.
 */

import type { ScraperOptions } from '../../../Base/Interface.js';
import type { ILoginConfig } from '../../../Base/Interfaces/Config/LoginConfig.js';
import { createPipelineBuilder } from '../../Core/Builder/PipelineBuilderFactory.js';
import type { IPipelineDescriptor } from '../../Core/PipelineDescriptor.js';
import type { Procedure } from '../../Types/Procedure.js';
import { CIBUS_SHAPE } from './scrape/CibusShape.js';

/**
 * Cibus login fields — resolved entirely via shared WellKnown (no CSS).
 *
 * `company` is deliberately absent. Only some employers require it, the
 * provider is asked which before the field is shown, and a field the form does
 * not render cannot be filled — so it is supplied as a credential and consumed
 * by the form only when present.
 */
const CIBUS_LOGIN: ILoginConfig = {
  loginUrl: 'https://consumers.pluxee.co.il',
  fields: [
    { credentialKey: 'username', selectors: [] },
    { credentialKey: 'password', selectors: [] },
  ],
  submit: [],
  possibleResults: { success: [] },
};

/**
 * Build the Cibus pipeline descriptor.
 * @param options - Scraper options from the user.
 * @returns Pipeline descriptor (browser + declarative login + OTP + api-direct scrape).
 */
function buildCibusPipeline(options: ScraperOptions): Procedure<IPipelineDescriptor> {
  return createPipelineBuilder()
    .withOptions(options)
    .withBrowser()
    .withDeclarativeLogin(CIBUS_LOGIN)
    .withOtpTrigger()
    .withOtpFill()
    .withBrowserApiDirect(CIBUS_SHAPE)
    .build();
}

export default buildCibusPipeline;
export { buildCibusPipeline, CIBUS_LOGIN };
