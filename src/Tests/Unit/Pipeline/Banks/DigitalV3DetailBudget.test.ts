/**
 * The spending budget for one DigitalV3 detail pass.
 *
 * The endpoint sits behind the same protections as login, so overrunning does
 * not produce a slow scrape — it produces a blocked session. These tests pin
 * the rules that make a pass stop early.
 */

import {
  type IDetailBudgetLimits,
  nextDetailRequest,
  retryFits,
} from '../../../../Scrapers/Pipeline/Banks/DigitalV3/DetailBudget.js';

const LIMITS: IDetailBudgetLimits = {
  maxRows: 10,
  maxWallMs: 60_000,
  timeoutMs: 5_000,
  minDelayMs: 2_000,
  maxDelayMs: 4_000,
};

describe('nextDetailRequest', () => {
  it('allows the first request with no delay', () => {
    const verdict = nextDetailRequest(LIMITS, 0, 0, 0.5);
    expect(verdict).toEqual({ proceed: true, delayMs: 0 });
  });

  it('paces every request after the first, within the configured range', () => {
    for (const jitter of [0, 0.25, 0.5, 0.99]) {
      const verdict = nextDetailRequest(LIMITS, 1, 1_000, jitter);
      expect(verdict.proceed).toBe(true);
      if (!verdict.proceed) throw new Error('unreachable');
      expect(verdict.delayMs).toBeGreaterThanOrEqual(LIMITS.minDelayMs);
      expect(verdict.delayMs).toBeLessThanOrEqual(LIMITS.maxDelayMs);
    }
  });

  it('stops at the row limit', () => {
    expect(nextDetailRequest(LIMITS, 10, 0, 0.5)).toEqual({ proceed: false, reason: 'row-limit' });
  });

  it('stops once the wall clock is spent', () => {
    expect(nextDetailRequest(LIMITS, 1, 60_000, 0.5)).toEqual({ proceed: false, reason: 'wall-clock' });
  });

  it('refuses a request that could not finish inside the budget', () => {
    // 54s spent, +2s delay, +5s timeout = 61s > 60s. Elapsed time alone still
    // looks fine here, which is exactly how a pass overruns while every
    // individual check passes.
    const verdict = nextDetailRequest(LIMITS, 1, 54_000, 0);
    expect(verdict).toEqual({ proceed: false, reason: 'wall-clock' });
  });

  it('allows a request that fits with nothing to spare', () => {
    // 53s + 2s + 5s = 60s, exactly the ceiling.
    expect(nextDetailRequest(LIMITS, 1, 53_000, 0).proceed).toBe(true);
  });

  it('handles a zero-width delay range without going out of bounds', () => {
    const fixed = { ...LIMITS, minDelayMs: 3_000, maxDelayMs: 3_000 };
    const verdict = nextDetailRequest(fixed, 1, 0, 0.99);
    expect(verdict).toEqual({ proceed: true, delayMs: 3_000 });
  });

  it('never returns a negative delay when the range is inverted', () => {
    // Misconfiguration should not turn into time travel.
    const inverted = { ...LIMITS, minDelayMs: 4_000, maxDelayMs: 1_000 };
    const verdict = nextDetailRequest(inverted, 1, 0, 0.99);
    expect(verdict.proceed).toBe(true);
    if (!verdict.proceed) throw new Error('unreachable');
    expect(verdict.delayMs).toBeGreaterThanOrEqual(0);
  });
});

describe('retryFits', () => {
  it('allows a retry with room for the delay and another full timeout', () => {
    expect(retryFits(LIMITS, 50_000)).toBe(true);
  });

  it('refuses a retry that would overrun', () => {
    // 54s + 2s + 5s = 61s > 60s. Ending the pass beats ending it holding a
    // session that can no longer be used.
    expect(retryFits(LIMITS, 54_000)).toBe(false);
  });

  it('is stricter than starting a fresh request at the same point', () => {
    // Both refuse at the boundary; the retry must never be the more permissive
    // of the two, or a failing request could outlive a healthy one.
    const elapsed = 53_500;
    const fresh = nextDetailRequest(LIMITS, 1, elapsed, 0).proceed;
    expect(retryFits(LIMITS, elapsed)).toBe(fresh);
  });
});
