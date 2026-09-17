/**
 * DigitalV3 transaction-details enrichment — interpreting one
 * GetTransactionDetails response.
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

/**
 * Version stamp on every outcome, so a stored result can be re-read safely
 * after a shape change.
 *
 * The VALUE is frozen at its original Amex-era spelling on purpose. Consumers
 * persist it beside each enriched row and query on equality to decide what
 * still needs fetching, so changing the string would make every already-
 * enriched transaction look unenriched and trigger a full re-fetch. Bump it
 * only when the outcome shape genuinely changes.
 */
export const DIGITALV3_DETAIL_SCHEMA_VERSION = 'amex-detail-v3';

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

/**
 * Collapse runs of whitespace so comparisons do not turn on formatting.
 * @param value - Any provider field; non-strings collapse to the empty string.
 * @returns The trimmed, single-spaced text.
 */
function tidy(value: unknown): string {
  return typeof value === 'string' ? value.trim().replaceAll(/\s+/g, ' ') : '';
}

/** The captured subset of a detail body: an issuer category and kept fields. */
interface ICapturedDetail {
  sourceCategory?: string;
  detailPayload?: Record<string, unknown>;
}

/**
 * Copy the whitelisted detail fields that carry a value.
 *
 * An allow-list rather than the whole body: this is stored, and a provider that
 * starts returning a new field should not silently widen what is persisted.
 * @param data - The response's `data` object.
 * @returns The kept fields, empty when none carried a value.
 */
function capturePayload(data: Record<string, unknown>): Record<string, unknown> {
  const kept = CAPTURE_FIELDS.map((field): readonly [string, unknown] => [field, data[field]]);
  const present = kept.filter(([, value]): boolean => value !== undefined && value !== null);
  return Object.fromEntries(present);
}

/**
 * Fields worth keeping from a detail response body.
 * @param data - The response's `data` object.
 * @returns The issuer category and kept payload, each absent when empty.
 */
function captureFields(data: Record<string, unknown>): ICapturedDetail {
  const payload = capturePayload(data);
  const category = tidy(data.branchDescription);
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
 * @param data - The response's `data` object.
 * @returns True when a counterparty name is worth extracting.
 */
function isWalletTransfer(data: Record<string, unknown>): boolean {
  if (typeof data.transferBeneficiary !== 'string') return false;
  const label = tidy(data.businessName).toUpperCase();
  return WALLET_LABELS.has(label);
}

/** Every outcome carries the schema version and the attempt that produced it. */
const OUTCOME_BASE = {
  detailSchemaVersion: DIGITALV3_DETAIL_SCHEMA_VERSION,
  attemptCount: 1,
} as const;

/** The response no longer looks like what this code understands. */
const SHAPE_MISMATCH = { state: 'schema-mismatch', outcomeCode: 'shape-mismatch' } as const;

/** The state shared by every outcome a retry could not improve on. */
const TERMINAL: DetailState = 'terminal-failure';

/** The response parsed and carried nothing this code can use. */
const NOTHING_USEFUL = { state: TERMINAL, outcomeCode: 'empty-useful-detail' } as const;

/** The response carried something worth storing. */
const SUCCEEDED = { state: 'succeeded', outcomeCode: 'succeeded' } as const;

/**
 * The `data` object of a well-formed detail response.
 *
 * `isSuccess` is checked here rather than downstream because a body that says
 * it failed can still carry a `data` object, and reading it would store the
 * provider's own error shape as though it were detail.
 * @param envelope - Parsed response body, or null when it did not parse.
 * @returns The `data` object, or `false` when the envelope is not usable.
 */
function detailFieldsOf(envelope: unknown): Record<string, unknown> | false {
  if (typeof envelope !== 'object' || envelope === null) return false;
  const body = envelope as Record<string, unknown>;
  const data = body.data;
  if (body.isSuccess !== true) return false;
  if (typeof data !== 'object' || data === null) return false;
  return data as Record<string, unknown>;
}

/**
 * The outcome for a row whose detail is an issuer category, or nothing at all.
 * @param captured - Fields captured from the response.
 * @returns A succeeded outcome carrying the category, or a terminal failure.
 */
function categoryOutcome(captured: ICapturedDetail): IDetailOutcome {
  if (captured.sourceCategory === undefined) {
    return { ...OUTCOME_BASE, ...captured, ...NOTHING_USEFUL };
  }
  return { ...OUTCOME_BASE, ...captured, ...SUCCEEDED, detailKind: 'issuer-category' };
}

/**
 * The outcome for a peer-to-peer transfer, judged on the name it reported.
 *
 * A name that is itself the wallet label carries no more information than the
 * row already had, and an implausibly long one is an error string rather than a
 * person. Both are failures, not names — recorded as such rather than written
 * to a display field.
 * @param captured - Fields captured from the response.
 * @param name - The counterparty name, already tidied.
 * @returns A succeeded outcome carrying the name, or a terminal failure.
 */
function counterpartyOutcome(captured: ICapturedDetail, name: string): IDetailOutcome {
  const isUnusable = name === '' || name.length > MAX_COUNTERPARTY_NAME;
  const upper = name.toUpperCase();
  if (isUnusable || WALLET_LABELS.has(upper)) {
    return { ...OUTCOME_BASE, ...captured, ...NOTHING_USEFUL };
  }
  return { ...OUTCOME_BASE, ...captured, ...SUCCEEDED, counterpartyDisplayName: name };
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
  const fields = detailFieldsOf(envelope);
  if (fields === false) return { ...OUTCOME_BASE, ...SHAPE_MISMATCH };
  const captured = captureFields(fields);
  if (!isWalletTransfer(fields)) return categoryOutcome(captured);
  const name = tidy(fields.transferBeneficiary);
  return counterpartyOutcome(captured, name);
}
