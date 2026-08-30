import type { Frame, Page } from 'playwright-core';

import type { WaitUntilState } from '../../../../Common/Navigation.js';
import type { OtpConfig, SelectorCandidate } from '../../Config/LoginConfigTypes.js';
import type { LifecyclePromise } from '../CallbackTypes.js';
import type { ILoginPossibleResults } from '../LoginPossibleResults.js';
import type { IFieldConfig } from './FieldConfig.js';

/** Async page lifecycle callback that performs side effects without returning a value. */
type PageLifecycleCallback = (page: Page) => LifecyclePromise;

/** Nullable frame result from a pre-login action (matches Playwright API). */
type NullableFrameResult = Promise<Frame | undefined>;

/**
 * Login-flow capability flags — mirrors the legacy
 * `SCRAPER_CONFIGURATION.banks[*].loginSetup` shape so a
 * `GenericBankScraper` instance can declare its own flow shape
 * without being indexed in the legacy registry.
 */
export interface ILoginSetup {
  isApiOnly: boolean;
  hasOtpConfirm: boolean;
  hasOtpCode: boolean;
}

/**
 * Declarative login configuration — the "input" format.
 * Converted to ILoginOptions at runtime after selectors are resolved.
 * Does NOT replace ILoginOptions; both coexist.
 */
/**
 * One step of a login whose later fields do not exist until earlier ones have
 * been submitted and answered.
 *
 * <p>The declarative default assumes every credential input is present at once:
 * discovery resolves them all, they are filled, and `submit` is clicked. Some
 * providers instead ask for an identifier, take a server round-trip, and only
 * then render the remaining inputs — the second field is not hidden, it does
 * not exist in the DOM, so no reveal click can surface it and no static capture
 * can contain it.
 *
 * <p>Declaring stages makes that shape expressible without a bank writing
 * procedural code: each stage names the credential keys expected to be present
 * at that point, plus the control that advances to the next. Field discovery is
 * re-run between stages, because the inputs the next stage needs did not exist
 * when the last discovery ran.
 */
export interface ILoginStage {
  /**
   * Credential keys expected to be resolvable at this stage.
   *
   * The resolution check is scoped to these rather than to every field the bank
   * declares — demanding a later stage's input be present in the first is
   * exactly the failure this contract exists to describe.
   */
  readonly credentialKeys: readonly string[];
  /**
   * Control that advances to the next stage.
   *
   * Absent on the final stage, which uses the config's own `submit`.
   */
  readonly advance?: SelectorCandidate | SelectorCandidate[];
}

export interface ILoginConfig {
  loginUrl: string;
  fields: IFieldConfig[];
  submit: SelectorCandidate | SelectorCandidate[];
  possibleResults: ILoginPossibleResults;
  otp?: OtpConfig;
  checkReadiness?: PageLifecycleCallback;
  preAction?: (page: Page) => NullableFrameResult;
  postAction?: PageLifecycleCallback;
  waitUntil?: WaitUntilState;
  /**
   * Optional override for the login-flow capability flags. When set,
   * `GenericBankScraper.resolveLoginSetup()` returns these flags and
   * skips the legacy bank registry lookup — required for
   * pipeline-only banks (Discount, Beinleumi, …) referenced from
   * synthetic test scrapers (`ConcreteGenericScraper`).
   */
  loginSetup?: ILoginSetup;
  /**
   * Ordered stages, for a login that reveals its later inputs only after an
   * earlier one has been submitted.
   *
   * Absent for every bank whose inputs are all present at once, which is the
   * default and is unchanged: with no stages the whole field list is resolved,
   * filled and submitted in one pass exactly as before.
   */
  stages?: readonly ILoginStage[];
}
