/**
 * Staged login — the contract for a form that reveals its later inputs only
 * after an earlier one has been submitted.
 *
 * The property that matters is that a bank declaring NO stages is completely
 * unaffected: that is every bank in the tree today, so the cost of being wrong
 * here is paid by all of them at once.
 */

import type { ILoginConfig } from '../../../../../Scrapers/Base/Interfaces/Config/LoginConfig.js';
import {
  leadingStages,
  runLeadingStages,
} from '../../../../../Scrapers/Pipeline/Mediator/Login/LoginStages.js';
import type { ILoginFieldDiscovery } from '../../../../../Scrapers/Pipeline/Types/Domain/LoginTypes.js';
import type { IActionContext } from '../../../../../Scrapers/Pipeline/Types/PipelineContext.js';
import type { Procedure } from '../../../../../Scrapers/Pipeline/Types/Procedure.js';
import { succeed } from '../../../../../Scrapers/Pipeline/Types/Procedure.js';

/**
 * A login config with the given stages, and nothing else that matters here.
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

/**
 * A discovery stand-in, distinguishable by its target count.
 * @param count - How many resolved targets it should report.
 * @returns A discovery stand-in.
 */
function discoveryOf(count: number): ILoginFieldDiscovery {
  const targets = new Map<string, unknown>();
  for (let i = 0; i < count; i += 1) targets.set(`f${String(i)}`, {});
  return { targets } as unknown as ILoginFieldDiscovery;
}

/** Records what the runner asked for, so order and scoping can be asserted. */
interface ICallLog {
  filled: string[][];
  advanced: number;
  rediscovered: number;
}

/**
 * Build runner args over a call log.
 * @param config - The login config under test.
 * @param log - The log to record into.
 * @returns Args for {@link runLeadingStages}.
 */
function argsOver(config: ILoginConfig, log: ICallLog): Parameters<typeof runLeadingStages>[0] {
  return {
    config,
    input: {} as IActionContext,
    discovery: discoveryOf(1),
    /**
     * Record which keys a stage asked to fill.
     * @param keys - The stage's credential keys.
     * @returns Success.
     */
    fillKeys: (keys): Promise<Procedure<boolean>> => {
      log.filled.push([...keys]);
      const ok = succeed(true);
      return Promise.resolve(ok);
    },
    /**
     * Record that a stage advanced.
     * @returns Success.
     */
    advance: (): Promise<Procedure<boolean>> => {
      log.advanced += 1;
      const ok = succeed(true);
      return Promise.resolve(ok);
    },
    /**
     * Record that discovery was taken again, and widen it so the carry is visible.
     * @returns A discovery with more targets than the one before it.
     */
    rediscover: (): Promise<ILoginFieldDiscovery> => {
      log.rediscovered += 1;
      const wider = discoveryOf(2);
      return Promise.resolve(wider);
    },
  };
}

describe('staged login — leadingStages', () => {
  it('is empty for a bank that declares no stages — every bank today', () => {
    const config = configWith(undefined);
    const leading = leadingStages(config);
    expect(leading).toEqual([]);
  });

  it('is empty for a single stage, which is just an ordinary login', () => {
    const config = configWith([{ credentialKeys: ['username', 'password'] }]);
    const leading = leadingStages(config);
    expect(leading).toEqual([]);
  });

  it('excludes the final stage, which the ordinary submit path owns', () => {
    const config = configWith([
      { credentialKeys: ['username'], advance: [] },
      { credentialKeys: ['password'] },
    ]);
    const leading = leadingStages(config);
    expect(leading).toHaveLength(1);
    expect(leading[0]?.credentialKeys).toEqual(['username']);
  });
});

describe('staged login — runLeadingStages', () => {
  it('does nothing at all when no stages are declared', async () => {
    const log: ICallLog = { filled: [], advanced: 0, rediscovered: 0 };
    const config = configWith(undefined);
    const args = argsOver(config, log);
    const result = await runLeadingStages(args);
    expect(result.success).toBe(true);
    expect(log).toEqual({ filled: [], advanced: 0, rediscovered: 0 });
  });

  it('fills only the stage keys, then advances, then takes discovery again', async () => {
    // Scoping is the whole point: filling `password` in the first stage is
    // impossible, because that input does not exist on the page yet.
    const log: ICallLog = { filled: [], advanced: 0, rediscovered: 0 };
    const config = configWith([
      { credentialKeys: ['username'], advance: [] },
      { credentialKeys: ['password'] },
    ]);
    const args = argsOver(config, log);
    const result = await runLeadingStages(args);
    expect(result.success).toBe(true);
    expect(log.filled).toEqual([['username']]);
    expect(log.advanced).toBe(1);
    expect(log.rediscovered).toBe(1);
  });

  it('carries the re-taken discovery forward to the final stage', async () => {
    // The targets PRE resolved describe the page before any stage ran, so the
    // final stage must fill from the discovery taken after the round-trip.
    const log: ICallLog = { filled: [], advanced: 0, rediscovered: 0 };
    const config = configWith([
      { credentialKeys: ['username'], advance: [] },
      { credentialKeys: ['password'] },
    ]);
    const args = argsOver(config, log);
    const result = await runLeadingStages(args);
    expect(result.success).toBe(true);
    const carried = result.success ? result.value.targets.size : 0;
    expect(carried).toBe(2);
  });

  it('refuses a non-final stage that names no way to advance', async () => {
    const log: ICallLog = { filled: [], advanced: 0, rediscovered: 0 };
    const config = configWith([
      { credentialKeys: ['username'] },
      { credentialKeys: ['password'] },
    ]);
    const args = argsOver(config, log);
    const result = await runLeadingStages(args);
    expect(result.success).toBe(false);
    expect(log.advanced).toBe(0);
  });
});
