/**
 * DigitalV3 transaction-details enrichment — one request, and the identity it
 * is made under.
 *
 * Owns everything about asking for a single transaction's detail: which row key
 * identifies it, which card the question is asked about, the request body, and
 * the single bounded retry. The pass-level sequencing lives next door in
 * `enrichCardDetail`; this file never decides whether to ask, only how.
 */

import { createHmac } from 'node:crypto';

import { isOk } from '../../../Types/Procedure.js';
import { retryFits } from './TransactionDetailBudget.js';
import {
  DIGITALV3_DETAIL_SCHEMA_VERSION,
  type IDetailOutcome,
  interpretDetailEnvelope,
} from './TransactionDetailInterpret.js';
import type { IDetailTransport } from './TransactionDetailTransport.js';
import { classifyDetailTransport } from './TransactionDetailTransport.js';
import type { AmexRow, ICardDetailDeps, ICardDetailOptions } from './TransactionDetailTypes.js';

/**
 * Field separator for fingerprint inputs.
 *
 * ASCII unit separator: outside the character set of every part, so no
 * combination of values can collide by shifting the boundary between them.
 * Written as an escape rather than a literal, which would be invisible here.
 */
const FIELD_SEPARATOR = '\u001f';

/** A four-digit card suffix, the only shape the detail endpoint accepts. */
export const CARD_SUFFIX = /^\d{4}$/;

/**
 * Voucher-number keys across the two DigitalV3 banks, most specific first.
 *
 * Amex uses `seqVoucherNumber`; Isracard uses `voucherNumberRatz`, and
 * `...Outbound` on an outbound-currency row. Reading only Amex's names left the
 * majority of Isracard rows with no voucher, so they were recorded as
 * unfetchable and no category was ever requested for them — a quiet loss of
 * most of the enrichment, with nothing failing to show for it.
 */
const VOUCHER_FIELDS = [
  'seqVoucherNumber',
  'voucherNumber',
  'voucherNumberRatz',
  'voucherNumberRatzOutbound',
] as const;

/** All-zeros is this provider's "no voucher" sentinel, not an identifier. */
const VOUCHER_SENTINEL = /^0+$/;

/** A run of digits, the only voucher shape the endpoint accepts. */
const VOUCHER_DIGITS = /^\d+$/;

/**
 * Attach an outcome without disturbing any provider field.
 * @param raw - The row as the provider returned it.
 * @param outcome - What the detail attempt concluded.
 * @returns The same row, carrying its outcome under a reserved key.
 */
export function withOutcome(raw: AmexRow, outcome: IDetailOutcome): AmexRow {
  return { ...raw, __detailOutcome: outcome };
}

/**
 * An outcome for a row that was never requested.
 * @param code - Why no request was made.
 * @returns A terminal outcome recording zero attempts.
 */
export function notAttempted(code: IDetailOutcome['outcomeCode']): IDetailOutcome {
  return {
    state: 'terminal-failure',
    outcomeCode: code,
    detailSchemaVersion: DIGITALV3_DETAIL_SCHEMA_VERSION,
    attemptCount: 0,
  };
}

/**
 * Stable fingerprint over the given parts.
 *
 * Keyed, so a fingerprint is meaningless without the caller's secret and cannot
 * be recomputed from a stored value.
 * @param key - HMAC key.
 * @param parts - Ordered inputs.
 * @returns Hex digest.
 */
export function fingerprint(key: string, parts: readonly string[]): string {
  const joined = parts.join(FIELD_SEPARATOR);
  return createHmac('sha256', key).update(joined).digest('hex');
}

/**
 * Resolve the caller's canonical id for this card, via its alias table.
 *
 * Requires EXACTLY one matching alias. Zero means the caller does not know this
 * card; more than one means its mapping is ambiguous, and guessing would attach
 * one card's detail to another's history.
 * @param options - Pass options carrying the key and alias table.
 * @param cardSuffix - Four-digit suffix of the card being scraped.
 * @returns The canonical id, or `false` when it cannot be resolved uniquely.
 */
export function canonicalCardId(options: ICardDetailOptions, cardSuffix: string): string | false {
  const { hmacKey, identityContext } = options;
  if (hmacKey === undefined || identityContext === undefined) return false;
  const observed = fingerprint(hmacKey, [
    identityContext.owner,
    identityContext.provider,
    identityContext.credentialSetId,
    cardSuffix,
  ]);
  const aliases = options.cardAliases ?? [];
  const matches = aliases.filter((a): boolean => a.observedAccountFingerprint === observed);
  if (matches.length !== 1) return false;
  return matches[0]?.canonicalCardId ?? false;
}

/**
 * The text of a voucher field, for the shapes the provider actually sends.
 * @param value - The raw field value.
 * @returns Its text, or the empty string when it is not a usable primitive.
 */
function asVoucherText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return '';
}

/**
 * True when a candidate voucher is a real identifier rather than a placeholder.
 * @param text - The candidate value, already coerced to a string.
 * @returns True when it should be used to request detail.
 */
function isUsableVoucher(text: string): boolean {
  if (!VOUCHER_DIGITS.test(text)) return false;
  return !VOUCHER_SENTINEL.test(text);
}

/**
 * The voucher number identifying one transaction, when it has a usable one.
 * @param raw - The row as the provider returned it.
 * @returns The voucher number, or `false` when the row carries none.
 */
export function voucherOf(raw: AmexRow): string | false {
  // Coerced from the primitive the provider sends, never from an object: a
  // nested value would stringify to '[object Object]' and then fail the digit
  // test anyway, but silently and for the wrong reason.
  const candidates = VOUCHER_FIELDS.map((field): string => asVoucherText(raw[field]));
  const usable = candidates.find(isUsableVoucher);
  return usable ?? false;
}

/** The identity one detail request is made under. */
export interface IDetailRequestIdentity {
  readonly cardSuffix: string;
  readonly companyCode: number;
  readonly voucher: string;
}

/**
 * Request body for one transaction's detail.
 * @param raw - The row as the provider returned it.
 * @param identity - Card suffix, company code and voucher for this row.
 * @returns The POST body.
 */
export function detailBody(
  raw: AmexRow,
  identity: IDetailRequestIdentity,
): Record<string, unknown> {
  return {
    cardSuffix: identity.cardSuffix,
    companyCode: identity.companyCode,
    isIsraelDeal: raw.isIsraelDeal !== false,
    seqVoucherNumber: identity.voucher,
    isPartner: raw.isPartner === true,
  };
}

/** One detail attempt: what was concluded, and whether the pass should stop. */
export interface IDetailAttempt {
  readonly outcome: IDetailOutcome;
  readonly stopPass: boolean;
}

/**
 * The outcome for a request that never landed.
 * @param attemptCount - How many attempts were spent.
 * @param stopPass - Whether the pass should stop here.
 * @returns The attempt result.
 */
function transportFailure(attemptCount: number, stopPass: boolean): IDetailAttempt {
  const base = notAttempted('transient-failure');
  return { outcome: { ...base, state: 'retryable-failure', attemptCount }, stopPass };
}

/**
 * Judge one landed response: transport first, then its body.
 *
 * A shape mismatch stops the pass — the response no longer looks like what this
 * code understands, and continuing would spend the budget re-learning that on
 * every remaining row.
 * @param http - Transport facts for the response.
 * @param envelope - The parsed body, or null when it did not parse.
 * @returns The outcome, and whether the pass should stop.
 */
function readAttempt(http: IDetailTransport, envelope: unknown): IDetailAttempt {
  const verdict = classifyDetailTransport(http);
  if (verdict === false) {
    const interpreted = interpretDetailEnvelope(envelope);
    return { outcome: interpreted, stopPass: interpreted.state === 'schema-mismatch' };
  }
  const outcome: IDetailOutcome = {
    state: verdict.state,
    outcomeCode: verdict.code,
    detailSchemaVersion: DIGITALV3_DETAIL_SCHEMA_VERSION,
    attemptCount: 1,
  };
  return { outcome, stopPass: verdict.stopPass };
}
/**
 * Retry a request that never landed, once, if the budget still allows it.
 *
 * A full delay plus another timeout must still fit — otherwise the pass ends
 * holding a session it can no longer use, which is worse than the missing row.
 * @param deps - Injected collaborators.
 * @param body - Request body for this transaction.
 * @param startedAt - When the pass began, for the retry budget.
 * @returns The attempt result once the retry has been judged.
 */
async function retryOnce(
  deps: ICardDetailDeps,
  body: Record<string, unknown>,
  startedAt: number,
): Promise<IDetailAttempt> {
  const elapsed = deps.now() - startedAt;
  if (!retryFits(deps.options, elapsed)) return transportFailure(1, true);
  await deps.sleep(deps.options.minDelayMs);
  const second = await deps.post(body, deps.options.timeoutMs);
  if (!isOk(second)) return transportFailure(2, false);
  return readAttempt(second.value.http, second.value.envelope);
}

/**
 * Fetch and interpret one transaction's detail, with a single bounded retry.
 *
 * A transport-level failure — the request never landed — is the only thing
 * retried. Everything else is an answer, even when the answer is a refusal.
 * @param deps - Injected collaborators.
 * @param body - Request body for this transaction.
 * @param startedAt - When the pass began, for the retry budget.
 * @returns The outcome, and whether the pass should stop.
 */
export async function fetchOneDetail(
  deps: ICardDetailDeps,
  body: Record<string, unknown>,
  startedAt: number,
): Promise<IDetailAttempt> {
  const first = await deps.post(body, deps.options.timeoutMs);
  if (isOk(first)) return readAttempt(first.value.http, first.value.envelope);
  return retryOnce(deps, body, startedAt);
}
