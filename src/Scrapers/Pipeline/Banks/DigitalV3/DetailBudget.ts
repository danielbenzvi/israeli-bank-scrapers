/**
 * Amex per-transaction detail — the spending budget for one scrape pass.
 *
 * Pure arithmetic, separated from the request loop so the rules that stop us
 * hammering a rate-limited endpoint are testable without a browser.
 *
 * The endpoint sits behind the same protections as login, so the cost of
 * overrunning is not a slow scrape — it is a blocked session. Every limit here
 * exists to make the pass stop early rather than discover the limit the hard
 * way.
 */

/** Caller-supplied limits for one enrichment pass. */
export interface IDetailBudgetLimits {
  /** Most detail requests to issue in one pass. */
  readonly maxRows: number;
  /** Wall-clock ceiling for the whole pass. */
  readonly maxWallMs: number;
  /** Per-request timeout, counted against the wall clock before committing. */
  readonly timeoutMs: number;
  /** Inclusive delay range between requests. */
  readonly minDelayMs: number;
  readonly maxDelayMs: number;
}

/** Why the budget refused another request. */
export type BudgetVerdict =
  | { readonly proceed: true; readonly delayMs: number }
  | { readonly proceed: false; readonly reason: 'row-limit' | 'wall-clock' };

/**
 * Decide whether one more detail request fits, and how long to wait first.
 *
 * The wall-clock check counts the delay AND the request's own timeout before
 * committing, rather than checking elapsed time alone. Checking only elapsed
 * time authorises a request that cannot possibly finish inside the budget,
 * which is how a pass overruns while every individual check passed.
 *
 * @param limits - The pass's limits.
 * @param callsMade - Requests already issued this pass.
 * @param elapsedMs - Wall-clock milliseconds already spent.
 * @param jitter - Value in [0, 1) selecting a delay within the range.
 * @returns Whether to proceed, and the delay to wait first.
 */
export function nextDetailRequest(
  limits: IDetailBudgetLimits,
  callsMade: number,
  elapsedMs: number,
  jitter: number,
): BudgetVerdict {
  if (callsMade >= limits.maxRows) return { proceed: false, reason: 'row-limit' };
  if (elapsedMs >= limits.maxWallMs) return { proceed: false, reason: 'wall-clock' };

  // No delay before the first request: the pass has not touched the endpoint
  // yet, so there is nothing to pace away from.
  const spread = Math.max(0, limits.maxDelayMs - limits.minDelayMs);
  const delayMs = callsMade === 0 ? 0 : limits.minDelayMs + Math.floor(jitter * (spread + 1));

  if (elapsedMs + delayMs + limits.timeoutMs > limits.maxWallMs) {
    return { proceed: false, reason: 'wall-clock' };
  }
  return { proceed: true, delayMs };
}

/**
 * Whether a retry still fits, after a request already failed.
 *
 * Deliberately stricter than {@link nextDetailRequest}: a retry only earns its
 * place if the delay AND another full timeout fit in what remains. Otherwise
 * the pass ends holding a session it can no longer use.
 *
 * @param limits - The pass's limits.
 * @param elapsedMs - Wall-clock milliseconds already spent.
 * @returns True when one more attempt fits.
 */
export function retryFits(limits: IDetailBudgetLimits, elapsedMs: number): boolean {
  return elapsedMs + limits.minDelayMs + limits.timeoutMs <= limits.maxWallMs;
}
