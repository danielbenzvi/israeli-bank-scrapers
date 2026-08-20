/**
 * Amex scrape shape — response row extraction. One GetTransactionsList
 * response carries transaction rows across THREE containers:
 * data.approvals.approvedTransactions[] (pending authorisations),
 * data.israelAbroadVouchers.vouchers.israelAbroadVouchersList[] (settled
 * charges + installments), and
 * data.israelAbroadVouchers.outOfStatementChargeDateVouchers[]
 *   .immediateVouchersCurrencyDate[] — charges posting OUTSIDE the current
 * statement cycle, where recurring international merchants land.
 * data.currentTransactionsList is NOT a row list —
 * it is a per-currency cycle-summary object
 * (currentTransactionsBillingMonth[].totalTransactionsCurrency[] = totals
 * only), so it is intentionally excluded (grounded in the Amex scrape
 * trace 0095). Rows are merged untouched; the downstream Data Mapper
 * normalises fields (purchaseDate, ilsBillingAmount/billingAmount,
 * seqVoucherNumber…). Split from AmexShapeTxns.ts for the 150-LOC cap.
 */

type AmexTxn = Record<string, unknown>;

interface IApprovals {
  readonly approvedTransactions?: readonly AmexTxn[];
}
interface IVouchers {
  readonly israelAbroadVouchersList?: readonly AmexTxn[];
}
/**
 * One out-of-statement group. Rows sit a level deeper than the settled list,
 * under a per-currency-date wrapper, but carry the identical voucher shape.
 */
interface IOutOfStatementGroup {
  readonly immediateVouchersCurrencyDate?: readonly AmexTxn[] | null;
}
interface IIsraelAbroadVouchers {
  readonly vouchers?: IVouchers | null;
  readonly outOfStatementChargeDateVouchers?: readonly IOutOfStatementGroup[] | null;
}
interface ITxnsData {
  readonly approvals?: IApprovals | null;
  readonly israelAbroadVouchers?: IIsraelAbroadVouchers | null;
}
interface ITxnsResp {
  readonly data?: ITxnsData | null;
}

/**
 * Pending authorisation rows (data.approvals.approvedTransactions[]).
 * @param data - Unwrapped response data.
 * @returns Approved-transaction rows (empty when absent).
 */
function approvedRows(data: ITxnsData): readonly AmexTxn[] {
  return data.approvals?.approvedTransactions ?? [];
}

/**
 * Settled voucher rows
 * (data.israelAbroadVouchers.vouchers.israelAbroadVouchersList[]).
 * @param data - Unwrapped response data.
 * @returns Voucher rows (empty when absent).
 */
function voucherRows(data: ITxnsData): readonly AmexTxn[] {
  return data.israelAbroadVouchers?.vouchers?.israelAbroadVouchersList ?? [];
}

/** Which container a row was merged from. */
export type AmexRowClass = 'approval' | 'voucher';

/**
 * Where a merged row came from, and which field its amount was read out of.
 *
 * Once the two containers are concatenated this distinction is otherwise
 * unrecoverable, and it is load-bearing: an approval is a pending
 * authorisation while a voucher is a settled charge, and the containers do not
 * agree on which key carries the amount. A consumer reasoning about direction
 * or settlement state cannot do so from the merged row alone.
 */
export interface IAmexRowProvenance {
  readonly rowClass: AmexRowClass;
  /** The amount key present on this row, if any known one was. */
  readonly amountField?: string;
  /** That key's value, before any normalisation. */
  readonly rawAmount?: unknown;
  /**
   * Fields a consumer needs to judge direction and settlement for itself,
   * carried verbatim because the merged row is otherwise the only place they
   * exist and mapping discards them.
   */
  readonly dealSumType?: unknown;
  readonly rawStatus?: unknown;
  readonly rawDirection?: unknown;
}

/** Row shape after {@link mergeAmexRows}, carrying its own provenance. */
export type AmexRowWithProvenance = AmexTxn & { readonly __rowProvenance: IAmexRowProvenance };

/**
 * Amount keys the two containers use, most specific first: ILS billing wins
 * over the generic billing amount, which wins over the deal/payment sums.
 */
const AMOUNT_FIELDS = [
  'ilsBillingAmount',
  'billingAmount',
  'dealSum',
  'dealSumOutbound',
  'paymentSum',
  'paymentSumOutbound',
] as const;

/**
 * Attach provenance to one row without altering any of its own fields.
 * @param raw - Row as the provider returned it.
 * @param rowClass - Container the row came from.
 * @returns The row plus its provenance.
 */
function withProvenance(raw: AmexTxn, rowClass: AmexRowClass): AmexRowWithProvenance {
  const amountField = AMOUNT_FIELDS.find((key): boolean => key in raw);
  // Amount keys are spread in only when found, so a row with no recognised
  // amount field carries `{ rowClass }` alone rather than two undefined keys.
  return {
    ...raw,
    __rowProvenance: {
      rowClass,
      ...(amountField === undefined ? {} : { amountField, rawAmount: raw[amountField] }),
      dealSumType: raw['dealSumType'],
      rawStatus: raw['status'],
      rawDirection: raw['creditDebit'] ?? raw['direction'] ?? raw['debitCreditIndicator'],
    },
  };
}

/**
 * Merge both transaction containers from one GetTransactionsList response
 * into a single row list. Tolerates a null/absent data block.
 *
 * Rows are otherwise untouched — provenance is added under a reserved key
 * rather than by rewriting any provider field.
 *
 * @param body - Raw GetTransactionsList response body.
 * @returns Merged transaction rows, each carrying its provenance.
 */
/**
 * Charges whose charge-date falls outside the current statement cycle.
 *
 * Omitting these silently dropped real spend: recurring international
 * merchants post here almost exclusively, so the loss read as a quiet month
 * rather than a bug. Verified against 16 live responses — 77 rows, sharing no
 * seqVoucherNumber with the settled list.
 *
 * Classed as `voucher` rather than given a class of their own: they come from
 * the same `israelAbroadVouchers` parent and carry the identical row shape, and
 * a new class would be discarded by consumers that match on the existing two.
 *
 * @param data - Unwrapped response data.
 * @returns Out-of-statement rows (empty when absent).
 */
function outOfStatementRows(data: ITxnsData): readonly AmexTxn[] {
  const groups = data.israelAbroadVouchers?.outOfStatementChargeDateVouchers ?? [];
  return groups.flatMap((group) => group.immediateVouchersCurrencyDate ?? []);
}

export function mergeAmexRows(body: object): readonly AmexRowWithProvenance[] {
  const data = (body as ITxnsResp).data;
  if (!data) return [];
  const approved = approvedRows(data).map((r): AmexRowWithProvenance => withProvenance(r, 'approval'));
  const vouchers = voucherRows(data).map((r): AmexRowWithProvenance => withProvenance(r, 'voucher'));
  const outOfStatement = outOfStatementRows(data).map(
    (r): AmexRowWithProvenance => withProvenance(r, 'voucher'),
  );
  return [...approved, ...vouchers, ...outOfStatement];
}

export default mergeAmexRows;
