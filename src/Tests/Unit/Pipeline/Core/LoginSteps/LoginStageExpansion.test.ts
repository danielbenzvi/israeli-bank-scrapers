/**
 * Staged login — expansion into ordinary login passes.
 *
 * The property that carries the whole design is that a pass is INDISTINGUISHABLE
 * from an ordinary login: nothing downstream — discovery, the submit resolver,
 * the action executor — can tell it came from a stage. If that stops being true
 * the expansion has become a second login mechanism, which is the thing it
 * exists to avoid.
 */

import type { ILoginConfig } from '../../../../../Scrapers/Base/Interfaces/Config/LoginConfig.js';
import { expandLoginStages } from '../../../../../Scrapers/Pipeline/Core/LoginSteps/LoginStageExpansion.js';

/**
 * A two-field login config, with the given stages.
 * @param stages - Stages to declare, or undefined for an ordinary login.
 * @returns A login config.
 */
function configWith(stages?: ILoginConfig['stages']): ILoginConfig {
  return {
    loginUrl: 'https://provider.example/login',
    fields: [
      { credentialKey: 'username', selectors: [] },
      { credentialKey: 'password', selectors: [] },
    ],
    submit: [],
    possibleResults: { success: [] },
    ...(stages === undefined ? {} : { stages }),
  };
}

describe('staged login — expansion', () => {
  it('leaves a bank that declares no stages exactly as it was', () => {
    // Every bank in the tree today. The cost of getting this wrong is paid by
    // all of them at once, so it is asserted rather than assumed.
    const config = configWith(undefined);
    const passes = expandLoginStages(config);
    expect(passes).toHaveLength(1);
    expect(passes[0]).toBe(config);
  });

  it('emits one pass per stage, in order', () => {
    const config = configWith([
      { credentialKeys: ['username'] },
      { credentialKeys: ['password'] },
    ]);
    const passes = expandLoginStages(config);
    const keys = passes.map((p): string[] => p.fields.map((f): string => f.credentialKey));
    expect(keys).toEqual([['username'], ['password']]);
  });

  it('narrows each pass to the fields its own page carries', () => {
    // The point of the whole contract: `password` is never looked for on the
    // page that only has the identifier, because it does not exist there yet.
    const config = configWith([
      { credentialKeys: ['username'] },
      { credentialKeys: ['password'] },
    ]);
    const passes = expandLoginStages(config);
    const first = passes[0]?.fields.map((f): string => f.credentialKey) ?? [];
    expect(first).not.toContain('password');
  });

  it('gives a pass its own submit, falling back to the config default', () => {
    // A stage's advance control and a login's submit are the same thing to
    // everything downstream, which is why both are spelled `submit`.
    const advance = [{ text: 'continue' }] as unknown as ILoginConfig['submit'];
    const config = configWith([
      { credentialKeys: ['username'], submit: advance },
      { credentialKeys: ['password'] },
    ]);
    const passes = expandLoginStages(config);
    expect(passes[0]?.submit).toBe(advance);
    expect(passes[1]?.submit).toBe(config.submit);
  });

  it('produces passes that cannot be expanded again', () => {
    // A pass IS an ordinary login. Leaving `stages` on it would make that
    // false, and would let a second expansion multiply the passes.
    const config = configWith([
      { credentialKeys: ['username'] },
      { credentialKeys: ['password'] },
    ]);
    const passes = expandLoginStages(config);
    const reexpanded = expandLoginStages(passes[0]);
    expect(passes[0]?.stages).toBeUndefined();
    expect(reexpanded).toHaveLength(1);
  });

  it('carries every other setting through untouched', () => {
    const config = configWith([
      { credentialKeys: ['username'] },
      { credentialKeys: ['password'] },
    ]);
    const passes = expandLoginStages(config);
    expect(passes[0]?.loginUrl).toBe(config.loginUrl);
    expect(passes[1]?.possibleResults).toBe(config.possibleResults);
  });
});
