/**
 * OTP-FILL ACTION — putting the code into whatever shape the field takes.
 *
 * Split from `OtpFillPhaseActions.Fill.ts` to keep it inside the Mediator
 * overlay's line ceiling. Fill.ts still owns the retriever, the timeout race
 * and the submit; this owns only the writing.
 */


import type { IActionContext } from '../../Types/PipelineContext.js';
import type { IActionMediator } from '../Elements/ElementMediator.js';
import { readDiagTarget } from '../Otp/OtpShared.js';
import { dismissConsentIfPresent, fillSplitBoxes, readSplitBoxes } from './OtpSplitBoxes.js';

/** Bundled args for {@link writeCodeIntoForm}. */
export interface IWriteCodeArgs {
  readonly input: IActionContext;
  readonly executor: IActionMediator;
  readonly code: string;
}

/**
 * Write the code, by whichever shape this provider's field takes.
 *
 * Per-digit boxes win over a single target when both resolved. Measured: the
 * whole code in the first box left boxes 1..5 `ng-pristine` and the submit
 * disabled, because that component never advanced focus.
 *
 * A consent banner is cleared first. It overlays the boxes as well as the
 * submit, and a click it swallows is indistinguishable from one that landed —
 * the phase reports a filled, submitted code the provider never received.
 * @param args - Bundled input/executor/code.
 * @returns True once written, false when PRE resolved no target at all.
 */
export async function writeCodeIntoForm(args: IWriteCodeArgs): Promise<boolean> {
  const { input, executor, code } = args;
  await dismissConsentIfPresent({ executor, diagnostics: input.diagnostics });
  const boxes = readSplitBoxes(input.diagnostics).boxes;
  if (boxes.length > 0) return fillSplitBoxes({ executor, boxes, code });
  const inputTarget = readDiagTarget(input.diagnostics, 'otpInputTarget');
  if (!inputTarget) return false;
  await executor.fillInput(inputTarget.contextId, inputTarget.selector, code);
  return true;
}



export {ScraperErrorTypes} from '../../../Base/ErrorTypes.js';