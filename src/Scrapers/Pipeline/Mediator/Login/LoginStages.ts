/**
 * Staged login — the steps before the last one.
 *
 * <p>WHAT THIS EXISTS FOR. The declarative login assumes every credential input
 * is on the page at once: discovery resolves them all, they are filled, and
 * `submit` is clicked. Some providers ask for an identifier first, take a
 * server round-trip on it, and only then render the remaining inputs. The later
 * input is not hidden — it is absent from the DOM — so no reveal click surfaces
 * it, and no static capture contains it. `PRE-LOGIN` cannot help either: it
 * clicks to reveal, and there is nothing yet to reveal.
 *
 * <p>WHY DISCOVERY RE-RUNS. The targets `PRE` resolved describe the page as it
 * was before any stage ran. The next stage's inputs did not exist then, so its
 * targets cannot be in that map — the discovery has to be taken again against
 * the page as it now stands.
 *
 * <p>WHERE THAT RE-DISCOVERY HAS TO HAPPEN, AND WHY NOT HERE. Not in the LOGIN
 * ACTION. `IActionMediator` is sealed against discovery on purpose — "NO
 * resolveField, resolveVisible, discoverForm, resolveClickable. The compiler
 * rejects any discovery call through this interface" — and `IActionContext`
 * carries neither the page nor an element mediator, so the seal is structural
 * rather than advisory. Threading discovery into ACTION would break an
 * invariant this codebase enforces at the type level.
 *
 * <p>The shape that respects it is a REPEATED PRE/ACTION pair: each stage
 * discovers in its own PRE, where discovery is allowed, and fills in its own
 * ACTION, where it is not. A phase runs its four stages once, so expressing
 * that is a phase-level question — the builder emitting one LOGIN pass per
 * stage is the smallest form of it, and needs no new capability. That decision
 * belongs to this project, which is why this module stops at the contract and
 * the per-stage walk, and takes its collaborators as arguments.
 *
 * <p>WHAT THIS DELIBERATELY DOES NOT DO. It never submits. The final stage is
 * left to the ordinary fill-and-submit path, so the submit decision, its
 * benign-rejection handling and its diagnostics stay in exactly one place.
 */

import { ScraperErrorTypes } from '../../../Base/ErrorTypes.js';
import type { ILoginConfig, ILoginStage } from '../../../Base/Interfaces/Config/LoginConfig.js';
import type { ILoginFieldDiscovery } from '../../Types/Domain/LoginTypes.js';
import type { IActionContext } from '../../Types/PipelineContext.js';
import type { Procedure } from '../../Types/Procedure.js';
import { fail, isOk, succeed } from '../../Types/Procedure.js';

/** What one stage needs to run: the page, the current targets, and the executor. */
export interface IRunStagesArgs {
  readonly config: ILoginConfig;
  readonly input: IActionContext;
  readonly discovery: ILoginFieldDiscovery;
  /** Fills the named keys from the current discovery. */
  readonly fillKeys: (
    keys: readonly string[],
    found: ILoginFieldDiscovery,
  ) => Promise<Procedure<boolean>>;
  /** Clicks a stage's advance control. */
  readonly advance: (stage: ILoginStage) => Promise<Procedure<boolean>>;
  /** Re-runs field discovery against the page as it now stands. */
  readonly rediscover: () => Promise<ILoginFieldDiscovery>;
}

/**
 * The stages that run before the final one.
 *
 * The last stage is excluded on purpose: it is the ordinary fill-and-submit,
 * and routing it through here would duplicate the submit path.
 * @param config - The bank's login config.
 * @returns Every stage but the last, or an empty list when the bank declares none.
 */
export function leadingStages(config: ILoginConfig): readonly ILoginStage[] {
  const stages = config.stages ?? [];
  if (stages.length <= 1) return [];
  return stages.slice(0, -1);
}

/** Reported when a non-final stage names no way to reach the next one. */
const NO_ADVANCE = 'login stage has no advance control';

/**
 * Fill a stage's fields and click its advance control.
 * @param args - Collaborators plus the discovery this stage starts from.
 * @param stage - The stage to run.
 * @returns Success once advanced, or the failure that stopped it.
 */
async function fillAndAdvance(
  args: IRunStagesArgs,
  stage: ILoginStage,
): Promise<Procedure<boolean>> {
  if (stage.advance === undefined) return fail(ScraperErrorTypes.Generic, NO_ADVANCE);
  const filled = await args.fillKeys(stage.credentialKeys, args.discovery);
  if (!isOk(filled)) return filled;
  return args.advance(stage);
}

/**
 * Run one stage: fill and advance, then take discovery again.
 * @param args - Collaborators plus the discovery this stage starts from.
 * @param stage - The stage to run.
 * @returns The discovery for the next stage, or the failure that stopped it.
 */
async function runOneStage(
  args: IRunStagesArgs,
  stage: ILoginStage,
): Promise<Procedure<ILoginFieldDiscovery>> {
  const done = await fillAndAdvance(args, stage);
  if (!isOk(done)) return done;
  const next = await args.rediscover();
  return succeed(next);
}

/** Reducer carrying the discovery from one stage to the next. */
type StageReducer = (
  prev: Promise<Procedure<ILoginFieldDiscovery>>,
  stage: ILoginStage,
) => Promise<Procedure<ILoginFieldDiscovery>>;

/**
 * One reduce step: carry the discovery forward, short-circuiting on failure.
 * @param args - Collaborators shared by every stage.
 * @returns A reducer over the leading stages.
 */
function stepStage(args: IRunStagesArgs): StageReducer {
  return async (prev, stage): Promise<Procedure<ILoginFieldDiscovery>> => {
    const acc = await prev;
    if (!isOk(acc)) return acc;
    return runOneStage({ ...args, discovery: acc.value }, stage);
  };
}

/**
 * Walk the leading stages in order, carrying the discovery forward.
 *
 * Sequential by construction — each stage's inputs are created by the previous
 * stage's round-trip, so they cannot be run concurrently. Expressed as a reduce
 * over a promise chain, which is the shape the pipeline uses elsewhere for the
 * same reason.
 * @param args - Collaborators plus the discovery the first stage starts from.
 * @returns The discovery the final stage should fill from.
 */
export async function runLeadingStages(
  args: IRunStagesArgs,
): Promise<Procedure<ILoginFieldDiscovery>> {
  const stages = leadingStages(args.config);
  const seed: Procedure<ILoginFieldDiscovery> = succeed(args.discovery);
  const start: Promise<Procedure<ILoginFieldDiscovery>> = Promise.resolve(seed);
  const step = stepStage(args);
  return stages.reduce(step, start);
}
