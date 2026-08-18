import type { ITransaction } from '../../../../../Transactions.js';
import { TransactionStatuses, TransactionTypes } from '../../../../../Transactions.js';
import { type ApiRecord } from '../AutoMapperFacade/AutoMapperTypes.js';

/**
 * Provider fields the shared auto-mapper drops.
 *
 * Every institution routes through `autoMapTransaction`, which populates an
 * {@link ITransaction} field only when the payload carries a key listed for it
 * in the Well-Known dictionary (`Registry/WK/ScrapeFieldMappings.ts`). Five
 * optional fields on that interface have no entry there at all, so they never
 * get populated — even though the provider payload carries them, and even
 * though the per-institution scrapers in the original `israeli-bank-scrapers`
 * do populate them:
 *
 * | Field             | Consequence of dropping it                        |
 * |-------------------|---------------------------------------------------|
 * | `memo`            | for some banks the only counterparty signal at all |
 * | `category`        | the issuer's own classification hint               |
 * | `chargedCurrency` | absent is indistinguishable from "no conversion"   |
 * | `status`          | a pending row is stored as settled                 |
 * | `installments`    | two payments of one plan look identical            |
 *
 * The last two are correctness rather than enrichment. `status` decides
 * whether a provisional row is treated as final, and `installments` carries
 * the ordinals that tell one payment of a plan from the next — without them,
 * two charges of the same plan are identical in every field.
 *
 * Each read below is keyed on a field name specific enough that it cannot fire
 * for a provider that does not have it, which is what allows one shared helper
 * to serve all of them. Misses are reported as `false` rather than `undefined`,
 * per the pipeline's own miss-sentinel convention.
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
 * Read a non-empty string field.
 *
 * @param value - Candidate raw value.
 * @returns The string, or `false` when absent or empty.
 */
function asText(value: unknown): string | false {
  if (typeof value !== 'string') return false;
  return value === '' ? false : value;
}

/**
 * Parse the leading two integers out of a free-text instalment note.
 *
 * @param text - Provider comment/note text.
 * @returns Ordinals, or `false` when the text carries fewer than two.
 */
function twoOrdinals(text: string): IInstallments | false {
  const matches = text.match(/\d+/g);
  if (matches === null || matches.length < 2) return false;
  const number = Number.parseInt(matches[0], 10);
  const total = Number.parseInt(matches[1], 10);
  if (!Number.isFinite(number) || !Number.isFinite(total)) return false;
  if (number <= 0 || total <= 0) return false;
  return { number, total };
}

/**
 * Render one beneficiary part, with its trailing punctuation.
 *
 * @param value - Candidate raw value from the beneficiary block.
 * @param suffix - Punctuation the per-institution scrapers append.
 * @returns The rendered part, or an empty string when absent.
 */
function beneficiaryPart(value: unknown, suffix: string): string {
  const text = asText(value);
  return text === false ? '' : `${text}${suffix}`;
}

/**
 * Collect the present parts of a beneficiary block, in scraper order.
 *
 * @param details - The beneficiary block.
 * @returns Rendered parts, absent ones dropped.
 */
function beneficiaryParts(details: Record<string, unknown>): readonly string[] {
  const parts = [
    beneficiaryPart(details.partyHeadline, ''),
    beneficiaryPart(details.partyName, '.'),
    beneficiaryPart(details.messageHeadline, ''),
    beneficiaryPart(details.messageDetail, '.'),
  ];
  return parts.filter((p): boolean => p !== '');
}

/**
 * Flatten the nested beneficiary block some bank payloads carry into the
 * single-line memo the per-institution scrapers produce.
 *
 * @param raw - Provider record.
 * @returns The flattened memo, or `false` when the block is absent.
 */
function beneficiaryMemo(raw: ApiRecord): string | false {
  const block = raw.beneficiaryDetailsData;
  if (typeof block !== 'object' || block === null) return false;
  const details = block as Record<string, unknown>;
  const parts = beneficiaryParts(details);
  if (parts.length === 0) return false;
  return parts.join(' ');
}

/**
 * Read the memo out of the comment field, which arrives as either a list or a
 * single string depending on the provider.
 *
 * @param raw - Provider record.
 * @returns Memo text, or `false`.
 */
function commentMemo(raw: ApiRecord): string | false {
  const comment = raw.transTypeCommentDetails;
  if (Array.isArray(comment)) {
    const joined = comment.join(', ');
    return joined === '' ? false : joined;
  }
  return asText(comment);
}

/**
 * Resolve the memo from whichever field this provider supplies it in.
 *
 * @param raw - Provider record.
 * @returns Memo text, or `false`.
 */
function resolveMemo(raw: ApiRecord): string | false {
  const beneficiary = beneficiaryMemo(raw);
  if (beneficiary !== false) return beneficiary;
  const info = asText(raw.moreInfo);
  if (info !== false) return info;
  const additional = asText(raw.AdditionalData);
  if (additional !== false) return additional;
  return commentMemo(raw);
}

/**
 * Read instalment ordinals from the explicit numeric fields.
 *
 * @param raw - Provider record.
 * @returns Ordinals, or `false` when the fields are absent or unusable.
 */
function explicitInstallments(raw: ApiRecord): IInstallments | false {
  const explicitTotal = raw.numOfPayments ?? raw.numberOfPayments;
  if (explicitTotal === undefined || explicitTotal === null) return false;
  const total = Number(explicitTotal);
  // A pending row carries only the total, and the per-institution scraper
  // treats it as payment 1.
  const number = raw.numOfPayments === undefined ? 1 : Number(raw.curPaymentNum);
  if (!Number.isFinite(total) || !Number.isFinite(number)) return false;
  if (total <= 0 || number <= 0) return false;
  return { number, total };
}

/**
 * Read instalment ordinals from a free-text note.
 *
 * Guarded by the keyword so an unrelated two-number memo cannot be read as an
 * instalment plan.
 *
 * @param raw - Provider record.
 * @returns Ordinals, or `false` when the note is absent or unkeyed.
 */
function noteInstallments(raw: ApiRecord): IInstallments | false {
  const note = asText(raw.moreInfo);
  if (note === false) return false;
  if (!note.includes(INSTALLMENTS_KEYWORD)) return false;
  return twoOrdinals(note);
}

/**
 * Resolve instalment ordinals from whichever shape this provider uses.
 *
 * @param raw - Provider record.
 * @returns Ordinals, or `false` when this is not an instalment row.
 */
function resolveInstallments(raw: ApiRecord): IInstallments | false {
  const explicit = explicitInstallments(raw);
  if (explicit !== false) return explicit;
  return noteInstallments(raw);
}

/**
 * Resolve the settlement status, defaulting to the mapper's own `Completed`.
 *
 * @param raw - Provider record.
 * @returns `Pending` where the payload says so, otherwise `false`.
 */
function resolvePending(raw: ApiRecord): TransactionStatuses | false {
  if (raw.serialNumber === 0) return TransactionStatuses.Pending;
  // A purchase row that has not yet been assigned a debit date.
  const isUnbilledPurchase = 'trnPurchaseDate' in raw && raw.debCrdDate === undefined;
  if (isUnbilledPurchase) return TransactionStatuses.Pending;
  return false;
}

/**
 * Resolve the currency the account was actually billed in.
 *
 * Absent is indistinguishable at read time from "billed in the account's own
 * currency", so a missing value silently mis-converts a foreign charge.
 *
 * @param raw - Provider record.
 * @returns Currency code, or `false` when no field carries one.
 */
function resolveChargedCurrency(raw: ApiRecord): string | false {
  const charged = raw.debCrdCurrencySymbol ?? raw.paymentCurrency ?? raw.currencyId;
  if (typeof charged === 'number') return String(charged);
  return asText(charged);
}

/**
 * The fields describing what the row says about the purchase.
 *
 * @param raw - Provider record.
 * @returns Partial carrying only the text fields actually found.
 */
function textFields(raw: ApiRecord): Partial<ITransaction> {
  const restored: Partial<ITransaction> = {};
  const memo = resolveMemo(raw);
  if (memo !== false) restored.memo = memo;
  const category = asText(raw.branchCodeDesc);
  if (category !== false) restored.category = category;
  const charged = resolveChargedCurrency(raw);
  if (charged !== false) restored.chargedCurrency = charged;
  return restored;
}

/**
 * The fields changing how a row is interpreted, rather than what it says.
 *
 * @param raw - Provider record.
 * @returns Partial carrying only the state fields actually found.
 */
function rowState(raw: ApiRecord): Partial<ITransaction> {
  const restored: Partial<ITransaction> = {};
  const status = resolvePending(raw);
  if (status !== false) restored.status = status;
  const installments = resolveInstallments(raw);
  if (installments !== false) restored.installments = installments;
  return restored;
}

/**
 * Whether a provider's transaction-type code declares an instalment plan.
 *
 * @param raw - Provider record carrying `trnTypeCode`.
 * @returns True unless the code is one of the regular-charge codes.
 */
function isPlanByTypeCode(raw: ApiRecord): boolean {
  const code = String(raw.trnTypeCode);
  return !CAL_NON_INSTALLMENT_TRN_TYPES.has(code);
}

/**
 * Decide the transaction type, for providers that declare an instalment plan
 * with a transaction-type code rather than through the ordinals themselves.
 *
 * The code wins where it is present: a regular-charge code means a regular
 * charge even if ordinals happened to resolve.
 *
 * @param raw - Provider record.
 * @param installments - Ordinals already resolved for this row, if any.
 * @param fallback - The type the mapper resolved on its own.
 * @returns The instalment type where the row is a plan, else the fallback.
 */
function resolveType(
  raw: ApiRecord,
  installments: ITransaction['installments'],
  fallback: TransactionTypes,
): TransactionTypes {
  const hasTypeCode = 'trnTypeCode' in raw;
  const isPlan = hasTypeCode ? isPlanByTypeCode(raw) : installments !== undefined;
  return isPlan ? TransactionTypes.Installments : fallback;
}

/**
 * Fields the auto-mapper can recover from the provider record.
 *
 * Spread over the mapped transaction, so every key it omits leaves the
 * mapper's own value untouched.
 *
 * @param raw - Provider record backing this transaction.
 * @param fallbackType - The type the mapper resolved on its own.
 * @returns Partial transaction carrying only the fields actually found.
 */
export default function restoreProviderFields(
  raw: ApiRecord,
  fallbackType: TransactionTypes,
): Partial<ITransaction> {
  const text = textFields(raw);
  const state = rowState(raw);
  const type = resolveType(raw, state.installments, fallbackType);
  return { ...text, ...state, type };
}
