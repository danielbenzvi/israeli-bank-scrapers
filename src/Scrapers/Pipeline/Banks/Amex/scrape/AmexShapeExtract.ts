/**
 * Amex scrape shape — response row extraction. One GetTransactionsList
 * response carries transaction rows across two containers:
 * data.approvals.approvedTransactions[] (pending authorisations) and
 * data.israelAbroadVouchers.vouchers.israelAbroadVouchersList[] (settled
 * charges + installments). data.currentTransactionsList is NOT a row list —
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
interface IIsraelAbroadVouchers {
  readonly vouchers?: IVouchers | null;
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
export function mergeAmexRows(body: object): readonly AmexRowWithProvenance[] {
  const data = (body as ITxnsResp).data;
  if (!data) return [];
  const approved = approvedRows(data).map((r): AmexRowWithProvenance => withProvenance(r, 'approval'));
  const vouchers = voucherRows(data).map((r): AmexRowWithProvenance => withProvenance(r, 'voucher'));
  return [...approved, ...vouchers];
}

export default mergeAmexRows;
