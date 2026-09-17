/**
 * Split OTP code fields — one box per digit.
 *
 * <p>WHAT THIS EXISTS FOR. Many providers render the one-time code as N
 * single-character boxes. `fillInput` already has a PIN-buffer path for these:
 * it clears the first box, focuses it, and re-types the WHOLE code with real
 * keypresses, relying on the component to advance focus box to box.
 *
 * <p>WHY THAT IS NOT ENOUGH. Some components do not advance. Measured against
 * a real provider: after that path ran, `otp-input-0` was `ng-dirty` and boxes
 * 1..5 were still `ng-pristine ng-untouched`, with the submit button still
 * disabled. `maxlength="1"` had swallowed every character after the first, and
 * nothing moved focus, so the component's model never filled and its submit
 * stayed inert. The keypresses were real; the auto-advance was the assumption.
 *
 * <p>THE OBSERVATION THIS RESTS ON. A split field is not a new kind of input.
 * It is N ORDINARY ONES, each taking a single character — the same shape as a
 * staged login being N ordinary logins. Expressed that way it needs no new
 * mediator capability: PRE discovers the boxes, where discovery is allowed,
 * and ACTION fills each through the existing sealed `fillInput`, where it is
 * not. The sealed `IActionMediator` invariant is respected, not worked around.
 *
 * <p>Addressing every box also removes the dependence on auto-advance entirely,
 * which is the part that varies between components.
 *
 * <p>A bank whose code field is a single input resolves ZERO boxes here and
 * keeps the original single-fill path untouched — the N=1 case, unchanged.
 */

import type { Page } from 'playwright-core';

import type { SelectorCandidate } from '../../../Base/Config/LoginConfigTypes.js';
import {
  WK_OTP_CONSENT_ACCEPT,
  WK_OTP_REMEMBER_DEVICE,
  WK_OTP_SPLIT_BOXES,
} from '../../Registry/WK/OtpFillWK.js';
import type { IActionContext, IResolvedTarget } from '../../Types/PipelineContext.js';
import { raceResultToTarget } from '../Elements/ActionExecutors.js';
import type { IActionMediator, IElementMediator } from '../Elements/ElementMediator.js';
import { OTP_SPLIT_BOX_PROBE_TIMEOUT_MS } from '../Timing/OtpTimingConfig.js';

/** Fewer boxes than this is a single input that merely looks indexed. */
const MIN_SPLIT_BOXES = 2;

/** Bundled args for {@link discoverSplitBoxes}. */
export interface IDiscoverSplitArgs {
  readonly mediator: IElementMediator;
  readonly page: Page;
}

/**
 * Resolve one indexed box, or false when that position does not exist.
 * @param args - Mediator + page for target derivation.
 * @param candidate - The indexed well-known candidate.
 * @returns The resolved target, or false.
 */
async function resolveBox(
  args: IDiscoverSplitArgs,
  candidate: SelectorCandidate,
): Promise<IResolvedTarget | false> {
  const result = await args.mediator
    .resolveVisible([candidate], OTP_SPLIT_BOX_PROBE_TIMEOUT_MS)
    .catch((): false => false);
  if (result === false) return false;
  return raceResultToTarget(result, args.page);
}

/**
 * Probe indexed positions in order, stopping at the first miss.
 *
 * Recursive rather than a loop: the Pipeline overlay forbids `await` inside
 * one, and the probes are sequential by intent — a gap ends the field, so
 * there is nothing to gain by asking for later positions.
 * @param args - Mediator + page.
 * @param candidates - Indexed candidates, in order.
 * @param acc - Boxes resolved so far.
 * @returns The accumulated boxes.
 */
async function collectBoxes(
  args: IDiscoverSplitArgs,
  candidates: readonly SelectorCandidate[],
  acc: readonly IResolvedTarget[],
): Promise<readonly IResolvedTarget[]> {
  if (acc.length >= candidates.length) return acc;
  const box = await resolveBox(args, candidates[acc.length]);
  if (box === false) return acc;
  return collectBoxes(args, candidates, [...acc, box]);
}

/**
 * Everything PRE needs off the OTP screen besides the code field itself.
 *
 * One discovery rather than two because both are found in the same passive
 * pass and consumed by the same ACTION.
 */
export interface IOtpFormTargets {
  /** Per-digit boxes, in code order; empty when the field is a single input. */
  readonly boxes: readonly IResolvedTarget[];
  /** The remember-this-device control, or false when the screen has none. */
  readonly remember: IResolvedTarget | false;
  /**
   * The consent-banner accept control, or false when no banner is up.
   *
   * The banner is dismissed at HOME, but the popup probe does not run for this
   * phase, so one still standing here has nothing else to clear it — and it
   * sits over the submit, where it swallowed the click and left a filled code
   * that was never sent.
   */
  readonly consent: IResolvedTarget | false;
}

/**
 * Resolve one optional control on the code screen.
 *
 * Absence is the normal case for both callers — most providers offer neither a
 * remember-device control nor a banner still standing here — so a miss is a
 * `false`, never a failure.
 * @param args - Mediator + page.
 * @param list - Well-known candidates to race for this control.
 * @returns The control, or false.
 */
async function resolveOne(
  args: IDiscoverSplitArgs,
  list: readonly unknown[],
): Promise<IResolvedTarget | false> {
  const candidates = list as readonly SelectorCandidate[];
  const probe = args.mediator.resolveVisible(candidates, OTP_SPLIT_BOX_PROBE_TIMEOUT_MS);
  const result = await probe.catch((): false => false);
  return result === false ? false : raceResultToTarget(result, args.page);
}

/**
 * Discover the per-digit boxes and the remember-device control.
 * @param args - Mediator + page.
 * @returns Boxes in code order (empty when not a split field) and the control.
 */
export async function discoverSplitBoxes(args: IDiscoverSplitArgs): Promise<IOtpFormTargets> {
  const candidates = WK_OTP_SPLIT_BOXES as unknown as readonly SelectorCandidate[];
  const found = await collectBoxes(args, candidates, []);
  const remember = await resolveOne(args, WK_OTP_REMEMBER_DEVICE);
  const consent = await resolveOne(args, WK_OTP_CONSENT_ACCEPT);
  const boxes = found.length >= MIN_SPLIT_BOXES ? found : [];
  return { boxes, remember, consent };
}

/**
 * The ONE capability writing a code needs.
 *
 * Narrower than `IActionMediator` on purpose: it states in the type that this
 * module fills and does nothing else — no navigation, no clicking, and above
 * all no discovery, which is the sealed-mediator invariant.
 */
export interface IOtpBoxWriter {
  fillInput(contextId: string, selector: string, value: string): Promise<true>;
}

/** Bundled args for {@link fillSplitBoxes}. */
export interface IFillSplitArgs {
  readonly executor: IOtpBoxWriter;
  readonly boxes: readonly IResolvedTarget[];
  readonly code: string;
}

/**
 * The reduce step: wait for the previous box, then write this one.
 * @param args - Executor + ordered boxes + the code.
 * @returns A reducer chaining one write after the last.
 */
function writeDigitAfter(
  args: IFillSplitArgs,
): (prev: Promise<void>, box: IResolvedTarget, index: number) => Promise<void> {
  return async (prev: Promise<void>, box: IResolvedTarget, index: number): Promise<void> => {
    await prev;
    const digit = args.code[index] ?? '';
    await args.executor.fillInput(box.contextId, box.selector, digit);
  };
}

/**
 * Fill each box with its own character, in order.
 *
 * Sequential by construction: these components move focus on input, and a
 * parallel write would race that movement and interleave the digits.
 * @param args - Executor + ordered boxes + the code.
 * @returns True once every box has been written.
 */
export async function fillSplitBoxes(args: IFillSplitArgs): Promise<true> {
  const seed: Promise<void> = Promise.resolve();
  const step = writeDigitAfter(args);
  const chain = args.boxes.reduce(step, seed);
  await chain;
  return true;
}

/** Diagnostics key carrying the discovered targets from PRE to ACTION. */
export const OTP_SPLIT_BOXES_KEY = 'otpSplitBoxTargets';

/** What a screen PRE never inspected yields. */
const NO_TARGETS: IOtpFormTargets = { boxes: [], remember: false, consent: false };

/**
 * Read the targets PRE stamped, if any.
 * @param diag - Diagnostics state.
 * @returns The targets, or an empty set.
 */
export function readSplitBoxes(diag: IActionContext['diagnostics']): IOtpFormTargets {
  const bag = diag as unknown as Readonly<Record<string, IOtpFormTargets>>;
  return bag[OTP_SPLIT_BOXES_KEY] ?? NO_TARGETS;
}

/** Bundled args for {@link tickRememberIfOffered}. */
export interface ITickRememberArgs {
  readonly executor: IActionMediator;
  readonly diagnostics: IActionContext['diagnostics'];
}

/**
 * Tick "remember this device" before submitting, when the screen offers it.
 *
 * Before, never after: the provider reads the box as part of the code step, so
 * a tick landing after submit mints nothing and every later run is challenged.
 * @param args - Executor + the diagnostics PRE stamped.
 * @returns True when a control was ticked, false when the screen had none.
 */
export async function tickRememberIfOffered(args: ITickRememberArgs): Promise<boolean> {
  const target = readSplitBoxes(args.diagnostics).remember;
  if (target === false) return false;
  const selRef = { contextId: target.contextId, selector: target.selector };
  await args.executor.clickElement(selRef).catch((): false => false);
  return true;
}

/**
 * Clear a consent banner still standing over the code screen.
 *
 * Called BEFORE the fill, not just before the submit: the banner overlays the
 * boxes as well, and a click it swallows is indistinguishable from one that
 * landed — the phase reports a filled, submitted code and the provider never
 * receives one.
 *
 * The popup probe runs for `home`, `account-resolve` and `dashboard` only, so
 * nothing else clears a banner that is still up by this phase. Only the
 * consent control is clicked here, never the generic dismissal list, which
 * carries a `ביטול` that would cancel the form itself.
 * @param args - Executor + the diagnostics PRE stamped.
 * @returns True when a banner was dismissed, false when none was up.
 */
export async function dismissConsentIfPresent(args: ITickRememberArgs): Promise<boolean> {
  const target = readSplitBoxes(args.diagnostics).consent;
  if (target === false) return false;
  const selRef = { contextId: target.contextId, selector: target.selector };
  await args.executor.clickElement(selRef).catch((): false => false);
  return true;
}
