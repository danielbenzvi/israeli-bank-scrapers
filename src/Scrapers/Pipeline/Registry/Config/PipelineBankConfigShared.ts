/**
 * Shared vocabulary for the bank registry.
 *
 * Extracted so a bank needing more than the plain shape can live in its own
 * file without importing back through the registry that lists it — which
 * would be a cycle. The registry keeps the index; this keeps the words.
 */

import type {
  AuthStrategyKind,
  BalanceKind,
  IPipelineBankConfig,
} from './PipelineBankConfigTypes.js';

/** Billing-cycle banks (credit-card companies) expose no account balance. */
export const CARD_CYCLE = 'card-cycle';

/** Deposit/checking banks expose a real account balance resolved live. */
export const ACCOUNT = 'account';

/** Banks whose completed login yields a discovered Bearer/JWT token. */
export const TOKEN = 'token';

/** Banks whose completed login is carried by first-party session cookies. */
export const SESSION_COOKIE = 'session-cookie';

/** API-native banks -- headless identity strategy, no browser AUTH-DISCOVERY. */
export const API_DIRECT = 'api-direct';

/**
 * Build a plain bank config — base URL + balance/auth kinds, no
 * headless/OTP/poll blocks. Banks needing extra wiring stay object-literal.
 * @param base - Official website URL (HOME phase navigates here).
 * @param balanceKind - Balance semantics (account vs card-cycle).
 * @param authStrategyKind - Auth-completion family.
 * @returns A pipeline bank config.
 */
export function defineBank(
  base: string,
  balanceKind: BalanceKind,
  authStrategyKind: AuthStrategyKind,
): IPipelineBankConfig {
  return { urls: { base }, balanceKind, authStrategyKind };
}
