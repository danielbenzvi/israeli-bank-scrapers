import { TransactionStatuses } from '../../../../../Transactions.js';
import type { ITransaction } from '../../../../../Transactions.js';
import { type ApiRecord } from '../AutoMapperFacade/AutoMapperTypes.js';

/**
 * Provider fields the shared auto-mapper drops.
 *
 * Every institution routes through `autoMapTransaction`, which builds an
 * {@link ITransaction} from the WK alias hits alone. Five optional fields on
 * that interface therefore never get populated, even though the provider
 * payload carries them and the per-institution scrapers in the original
 * `israeli-bank-scrapers` do populate them:
 *
 * | Field             | Consequence of dropping it                          |
 * |-------------------|-----------------------------------------------------|
 * | `memo`            | for some banks the only counterparty signal at all   |
 * | `category`        | the issuer's own classification hint                 |
 * | `chargedCurrency` | absent is indistinguishable from "no conversion"     |
 * | `status`          | a pending row is stored as settled                   |
 * | `installments`    | changes the identifier some providers derive from it |
 *
 * The last two are correctness rather than enrichment. `status` decides
 * whether a provisional row is treated as final, and `installments` feeds the
 * `${arn}_${number}` identifier shape, so dropping it makes two payments of the
 * same plan indistinguishable.
 *
 * Each read below is keyed on a field name specific enough that it cannot fire
 * for a provider that does not have it, which is what allows one shared helper
 * to serve all of them.
 */

/** Instalment ordinals, in the shape {@link ITransaction} declares. */
interface IInstallments {
  readonly number: number;
  readonly total: number;
}

/** Hebrew keyword marking an instalment memo on the Isracard/Amex payloads. */
const INSTALLMENTS_KEYWORD = 'תשלום';

/** Cal transaction-type codes that are NOT instalment plans. */
const CAL_NON_INSTALLMENT_TRN_TYPES = new Set(['5', '9']);

/**
 * Read a non-empty string field, or `undefined`.
 *
 * @param value - Candidate raw value.
 * @returns The trimmed-to-truthy string, or `undefined`.
 */
function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Parse the leading two integers out of a free-text instalment note.
 *
 * @param text - Provider comment/note text.
 * @returns Ordinals, or `undefined` when the text carries fewer than two.
 */
function twoOrdinals(text: string): IInstallments | undefined {
  const matches = text.match(/\d+/g);
  if (matches === null || matches.length < 2) return undefined;
  const number = Number.parseInt(matches[0] as string, 10);
  const total = Number.parseInt(matches[1] as string, 10);
  if (!Number.isFinite(number) || !Number.isFinite(total)) return undefined;
  if (number <= 0 || total <= 0) return undefined;
  return { number, total };
}

/**
 * Flatten the nested beneficiary block some bank payloads carry into the
 * single-line memo the per-institution scrapers produce.
 *
 * @param raw - Provider record.
 * @returns The flattened memo, or `undefined` when the block is absent.
 */
function beneficiaryMemo(raw: ApiRecord): string | undefined {
  const block = raw['beneficiaryDetailsData'];
  if (typeof block !== 'object' || block === null) return undefined;
  const parts: string[] = [];
  const details = block as Record<string, unknown>;
  const headline = asText(details['partyHeadline']);
  const name = asText(details['partyName']);
  const messageHeadline = asText(details['messageHeadline']);
  const messageDetail = asText(details['messageDetail']);
  if (headline !== undefined) parts.push(headline);
  if (name !== undefined) parts.push(`${name}.`);
  if (messageHeadline !== undefined) parts.push(messageHeadline);
  if (messageDetail !== undefined) parts.push(`${messageDetail}.`);
  return parts.length === 0 ? undefined : parts.join(' ');
}

/**
 * Resolve the memo from whichever field this provider supplies it in.
 *
 * @param raw - Provider record.
 * @returns Memo text, or `undefined`.
 */
function resolveMemo(raw: ApiRecord): string | undefined {
  const beneficiary = beneficiaryMemo(raw);
  if (beneficiary !== undefined) return beneficiary;
  const direct = asText(raw['moreInfo']) ?? asText(raw['AdditionalData']);
  if (direct !== undefined) return direct;
  const comment = raw['transTypeCommentDetails'];
  if (Array.isArray(comment)) {
    const joined = comment.join(', ');
    if (joined !== '') return joined;
  } else if (typeof comment === 'string' && comment !== '') {
    return comment;
  }
  return undefined;
}

/**
 * Resolve instalment ordinals from whichever shape this provider uses.
 *
 * @param raw - Provider record.
 * @returns Ordinals, or `undefined` when this is not an instalment row.
 */
function resolveInstallments(raw: ApiRecord): IInstallments | undefined {
  // Explicit numeric fields. A pending row carries only the total, and the
  // per-institution scraper treats it as payment 1.
  const explicitTotal = raw['numOfPayments'] ?? raw['numberOfPayments'];
  if (explicitTotal !== undefined && explicitTotal !== null) {
    const total = Number(explicitTotal);
    const number = raw['numOfPayments'] !== undefined ? Number(raw['curPaymentNum']) : 1;
    if (!Number.isFinite(total) || !Number.isFinite(number)) return undefined;
    if (total <= 0 || number <= 0) return undefined;
    return { number, total };
  }
  // A Hebrew note, guarded by the keyword so an unrelated two-number memo
  // cannot be read as an instalment plan.
  const note = asText(raw['moreInfo']);
  if (note !== undefined && note.includes(INSTALLMENTS_KEYWORD)) return twoOrdinals(note);
  return undefined;
}

/**
 * Resolve the settlement status, defaulting to the mapper's own `Completed`.
 *
 * @param raw - Provider record.
 * @returns `Pending` where the payload says so, otherwise `undefined`.
 */
function resolvePending(raw: ApiRecord): TransactionStatuses | undefined {
  if (raw['serialNumber'] === 0) return TransactionStatuses.Pending;
  // A purchase row that has not yet been assigned a debit date.
  if ('trnPurchaseDate' in raw && raw['debCrdDate'] === undefined) return TransactionStatuses.Pending;
  return undefined;
}

/**
 * Fields the auto-mapper can recover from the provider record.
 *
 * Spread over the mapped transaction, so every key it omits leaves the
 * mapper's own value untouched.
 *
 * @param raw - Provider record backing this transaction.
 * @returns Partial transaction carrying only the fields actually found.
 */
export function restoreProviderFields(raw: ApiRecord | undefined): Partial<ITransaction> {
  if (typeof raw !== 'object' || raw === null) return {};
  const restored: Partial<ITransaction> = {};

  const memo = resolveMemo(raw);
  if (memo !== undefined) restored.memo = memo;

  const category = asText(raw['branchCodeDesc']);
  if (category !== undefined) restored.category = category;

  // Absent is indistinguishable at read time from "billed in the account's own
  // currency", so a missing value silently mis-converts a foreign charge.
  const charged = raw['debCrdCurrencySymbol'] ?? raw['paymentCurrency'] ?? raw['currencyId'];
  if (charged !== undefined && charged !== null && String(charged) !== '') {
    restored.chargedCurrency = String(charged);
  }

  const status = resolvePending(raw);
  if (status !== undefined) restored.status = status;

  const installments = resolveInstallments(raw);
  if (installments !== undefined) restored.installments = installments;

  return restored;
}

/**
 * Whether this row is an instalment plan, for providers that declare it with a
 * transaction-type code rather than through the ordinals themselves.
 *
 * @param raw - Provider record.
 * @param installments - Ordinals already resolved for this row, if any.
 * @returns `true` when the row should map to the instalment transaction type.
 */
export function isInstallmentTransaction(
  raw: ApiRecord | undefined,
  installments: ITransaction['installments'],
): boolean {
  if (typeof raw !== 'object' || raw === null) return false;
  if ('trnTypeCode' in raw) return !CAL_NON_INSTALLMENT_TRN_TYPES.has(String(raw['trnTypeCode']));
  return installments !== undefined;
}
