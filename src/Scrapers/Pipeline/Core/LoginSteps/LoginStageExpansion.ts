/**
 * Staged login — expansion into ordinary login passes.
 *
 * <p>WHAT THIS EXISTS FOR. The declarative login assumes every credential input
 * is on the page at once. Some providers ask for an identifier, take a server
 * round-trip on it, and only then render the rest: the later input is not
 * hidden, it is ABSENT from the DOM. `PRE-LOGIN` cannot help — it clicks to
 * reveal, and there is nothing yet to reveal — and no harvester recipe can
 * capture what the server has not been asked to render.
 *
 * <p>THE OBSERVATION THIS RESTS ON. A stage's "advance to the next step"
 * control and a login's "submit" control are the same thing to everything
 * downstream: something to click once this page's fields are filled. So a
 * staged login is not a new kind of login — it is N ORDINARY ONES, each with a
 * subset of the fields and its own submit.
 *
 * <p>WHY THAT MATTERS. Expressed this way it needs no new capability anywhere.
 * Each pass discovers in its own `PRE`, where discovery is allowed, and fills
 * in its own `ACTION`, where it is not — so the sealed `IActionMediator`
 * invariant ("the compiler rejects any discovery call through this interface")
 * is respected rather than worked around. `LoginPhase`, the field discovery,
 * the submit resolver and the action executor are all untouched: each one sees
 * a perfectly ordinary `ILoginConfig` and cannot tell it came from a stage.
 */

import type { ILoginConfig } from '../../../Base/Interfaces/Config/LoginConfig.js';

/**
 * Expand a login config into one ordinary config per stage.
 *
 * A bank that declares no stages expands to itself — a single pass, unchanged,
 * which is every bank in the tree today.
 * @param config - The bank's login config.
 * @returns One config per pass, in order.
 */
function expandLoginStages(config: ILoginConfig): readonly ILoginConfig[] {
  const stages = config.stages ?? [];
  if (stages.length === 0) return [config];
  return stages.map((_stage, index): ILoginConfig => stageConfig(config, index));
}

/**
 * The ordinary login config for one stage.
 *
 * `fields` narrows to the keys this stage's page actually carries, which is
 * what stops a later stage's input being looked for in an earlier stage's page.
 * `stages` is dropped so the result cannot be expanded again.
 * @param config - The bank's login config.
 * @param index - Which stage to build.
 * @returns A single-pass login config.
 */
function stageConfig(config: ILoginConfig, index: number): ILoginConfig {
  const stage = config.stages?.[index];
  const keys = new Set(stage?.credentialKeys ?? []);
  const fields = config.fields.filter((f): boolean => keys.has(f.credentialKey));
  const submit = stage?.submit ?? config.submit;
  const pass: ILoginConfig = { ...config, fields, submit };
  delete pass.stages;
  return pass;
}

export default expandLoginStages;
export { expandLoginStages };
