/**
 * Amex per-transaction detail — interpreting one GetTransactionDetails
 * response.
 *
 * Everything here is pure. The request loop that decides WHETHER to ask lives
 * in AmexDetailEnrich.ts; this file only answers "given a response, what did we
 * learn". Split that way because the interpretation carries the correctness
 * risk and is the part worth testing exhaustively, while the loop is mostly
 * budget arithmetic.
 *
 * Two useful things can come back, and they are independent:
 *   - the issuer's own category for the merchant, and
 *   - for a peer-to-peer transfer, the counterparty's name, which the
 *     transaction list itself reports only as a generic wallet label.
 */

/** Version stamp on every outcome, so a stored result can be re-read safely after a shape change. */
export const AMEX_DETAIL_SCHEMA_VERSION = 'amex-detail-v3';

/**
 * Wallet labels the transaction list uses for peer-to-peer transfers. A row
 * carrying one of these has no merchant of its own — the useful name is the
 * transfer counterparty, which only the detail response carries.
 */
const WALLET_LABELS = new Set(['BIT', 'העברה בBIT', 'העברה ב-BIT']);

/** Longest counterparty name treated as real rather than as an error string. */
const MAX_COUNTERPARTY_NAME = 160;

/** Detail fields worth keeping verbatim. Anything not listed is discarded. */
const CAPTURE_FIELDS = [
  'businessNumber',
  'parentBranchCode',
  'parentBranchDescription',
  'branchCode',
  'branchDescription',
  'secondBranchCode',
  'secondBranchDescription',
  'numberOfPayments',
  'paymentNumber',
  'country',
  'countryCode',
  'isWalletTransaction',
  'walletDescription',
  'transactionTypeDescription',
  'transactionExecuteDescription',
  'tranzakDescription',
  'originalToUsdExchangeDate',
  'originalToUsdExchangeRate',
  'usdToIlsExchangeDate',
  'usdToIlsExchangeRate',
  'originalToEurExchangeDate',
  'originalToEurExchangeRate',
  'eurToIlsExchangeDate',
  'eurToIlsExchangeRate',
  'originalToIlsExchangeDate',
  'originalToIlsExchangeRate',
] as const;

/** How a detail attempt ended. */
export type DetailState = 'succeeded' | 'terminal-failure' | 'retryable-failure' | 'schema-mismatch';

/** Why it ended that way. */
export type DetailOutcomeCode =
  | 'succeeded'
  | 'empty-useful-detail'
  | 'shape-mismatch'
  | 'not-found'
  | 'throttled'
  | 'auth-expired'
  | 'transient-failure';

/** The record of one detail attempt, stored whether or not it produced anything. */
export interface IDetailOutcome {
  readonly state: DetailState;
  readonly outcomeCode: DetailOutcomeCode;
  readonly detailSchemaVersion: string;
  readonly attemptCount: number;
  /** The issuer's own category for the merchant. */
  readonly sourceCategory?: string;
  /** Whitelisted detail fields, kept verbatim. */
  readonly detailPayload?: Record<string, unknown>;
  /** For a peer-to-peer transfer, the counterparty's name. */
  readonly counterpartyDisplayName?: string;
  /** Present when the response carried a category but no counterparty. */
  readonly detailKind?: 'issuer-category';
}

/** Collapse runs of whitespace so comparisons do not turn on formatting. */
function tidy(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

/** Fields worth keeping from a detail response body. */
function captureFields(data: Record<string, unknown>): {
  sourceCategory?: string;
  detailPayload?: Record<string, unknown>;
} {
  const payload: Record<string, unknown> = {};
  for (const field of CAPTURE_FIELDS) {
    const value = data[field];
    if (value !== undefined && value !== null) payload[field] = value;
  }
  const category = tidy(data['branchDescription']);
  return {
    sourceCategory: category === '' ? undefined : category,
    detailPayload: Object.keys(payload).length === 0 ? undefined : payload,
  };
}

/**
 * Whether this detail response describes a peer-to-peer transfer whose
 * counterparty name is worth extracting.
 *
 * Requires BOTH the wallet label and a counterparty field: the label alone
 * appears on rows that carry no name, and treating those as transfers would
 * produce an outcome claiming a name it does not have.
 */
function isWalletTransfer(data: Record<string, unknown>): boolean {
  if (typeof data['transferBeneficiary'] !== 'string') return false;
  return WALLET_LABELS.has(tidy(data['businessName']).toUpperCase());
}

/**
 * Interpret one GetTransactionDetails envelope.
 *
 * A response that parsed but carried nothing useful is a `terminal-failure`,
 * not a success with empty fields — the distinction is what stops the caller
 * re-requesting a transaction whose detail will never say anything, on every
 * subsequent run.
 *
 * @param envelope - Parsed response body, or null when it did not parse.
 * @returns The outcome to store against the transaction.
 */
export function interpretDetailEnvelope(envelope: unknown): IDetailOutcome {
  const base = { detailSchemaVersion: AMEX_DETAIL_SCHEMA_VERSION, attemptCount: 1 } as const;

  if (typeof envelope !== 'object' || envelope === null) {
    return { ...base, state: 'schema-mismatch', outcomeCode: 'shape-mismatch' };
  }
  const body = envelope as Record<string, unknown>;
  const data = body['data'];
  if (body['isSuccess'] !== true || typeof data !== 'object' || data === null) {
    return { ...base, state: 'schema-mismatch', outcomeCode: 'shape-mismatch' };
  }

  const fields = data as Record<string, unknown>;
  const captured = captureFields(fields);

  if (!isWalletTransfer(fields)) {
    if (captured.sourceCategory === undefined) {
      return { ...base, ...captured, state: 'terminal-failure', outcomeCode: 'empty-useful-detail' };
    }
    return {
      ...base,
      ...captured,
      state: 'succeeded',
      outcomeCode: 'succeeded',
      detailKind: 'issuer-category',
    };
  }

  const name = tidy(fields['transferBeneficiary']);
  // A name that is itself the wallet label carries no more information than the
  // row already had, and an implausibly long one is an error string rather than
  // a person. Both are failures, not names.
  if (name === '' || name.length > MAX_COUNTERPARTY_NAME || WALLET_LABELS.has(name.toUpperCase())) {
    return { ...base, ...captured, state: 'terminal-failure', outcomeCode: 'empty-useful-detail' };
  }
  return { ...base, ...captured, state: 'succeeded', outcomeCode: 'succeeded', counterpartyDisplayName: name };
}

/** Transport facts needed to judge whether a response is worth interpreting. */
export interface IDetailTransport {
  readonly status: number;
  readonly contentType: string;
  readonly redirected: boolean;
  readonly sameOrigin: boolean;
}

/**
 * Classify a response by its transport facts alone, before its body is read.
 *
 * Returns `undefined` when the response is worth interpreting. Otherwise it
 * names the failure — and whether it should stop the whole enrichment pass.
 *
 * Auth expiry and throttling stop the pass: continuing would spend the
 * remaining budget on requests that cannot succeed, against an endpoint behind
 * the same protections as login.
 *
 * @param meta - Transport metadata, or undefined when the request never landed.
 * @returns The failure classification, or undefined when the body is usable.
 */
export function classifyDetailTransport(
  meta: IDetailTransport | undefined,
): { code: DetailOutcomeCode; state: DetailState; stopPass: boolean } | undefined {
  if (meta === undefined) {
    return { code: 'transient-failure', state: 'retryable-failure', stopPass: false };
  }
  if (meta.status === 429) return { code: 'throttled', state: 'terminal-failure', stopPass: true };
  if (meta.status === 401 || meta.status === 403) {
    return { code: 'auth-expired', state: 'terminal-failure', stopPass: true };
  }
  // A redirect or a cross-origin answer means we were bounced somewhere else
  // entirely — indistinguishable in effect from an expired session.
  if (meta.redirected || !meta.sameOrigin) {
    return { code: 'auth-expired', state: 'terminal-failure', stopPass: true };
  }
  if (!meta.contentType.toLowerCase().includes('application/json')) {
    return { code: 'auth-expired', state: 'terminal-failure', stopPass: true };
  }
  if (meta.status >= 500) return { code: 'transient-failure', state: 'retryable-failure', stopPass: false };
  if (meta.status < 200 || meta.status >= 300) {
    return { code: 'transient-failure', state: 'retryable-failure', stopPass: false };
  }
  return undefined;
}
