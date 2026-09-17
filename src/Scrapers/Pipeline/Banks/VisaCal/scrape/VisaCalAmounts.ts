/**
 * CAL money fields — resolved from what CAL states, not inferred from them.
 *
 * <p>CAL sends two amounts that mean different things, and they coincide only on
 * a shekel row. `amtBeforeConvAndIndex` is what was BILLED, in the card's
 * billing currency, on a settled row. `trnAmt` is the amount in the
 * TRANSACTION's original currency. On a foreign purchase those are different
 * numbers in different currencies; on a shekel purchase they are the same
 * number, which is why reading either one appears to work until it does not.
 *
 * <p>Two household patches previously disagreed about which was which, and
 * could not both be satisfied: the shared auto-mapper infers a credit by
 * comparing the two amounts' signs, which requires them to be independent
 * fields. Resolving both from the same one silently disabled that inference and
 * recorded a foreign amount as a shekel amount. See the household's P-045.
 *
 * <p>Nothing here is inferred. CAL states direction in `trnTypeCode`, states
 * settlement by the presence of `debCrdDate`, and names both currencies. This
 * is the same resolution the upstream `israeli-bank-scrapers` library has
 * applied to this provider for years.
 */

/** `trnTypeCode` values CAL uses. Only `credit` changes a sign. */
const TRN_TYPE_CREDIT = '6';

/** One CAL transaction row, in the fields this module reads. */
interface ICalAmountRow {
  readonly trnAmt?: unknown;
  readonly amtBeforeConvAndIndex?: unknown;
  readonly trnCurrencySymbol?: unknown;
  readonly debCrdCurrencySymbol?: unknown;
  readonly debCrdDate?: unknown;
  readonly trnTypeCode?: unknown;
}

/**
 * The four money fields, resolved together.
 *
 * A currency is `''` when CAL did not state one, never absent — this repository
 * forbids returning `undefined`, and an empty string carries the same meaning
 * without a second kind of nothing.
 */
export interface ICalAmounts {
  readonly chargedAmount: number;
  readonly originalAmount: number;
  readonly chargedCurrency: string;
  readonly originalCurrency: string;
}

/**
 * A finite number, or 0 when the provider sent something else.
 *
 * @param value - Raw field value.
 * @returns The number, or 0.
 */
function num(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * A trimmed string, empty when the provider sent nothing usable.
 *
 * @param value - Raw field value.
 * @returns The trimmed string, or `''`.
 */
function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Whether the row is still pending.
 *
 * `debCrdDate` is the debit date, which CAL fills in only once the charge has
 * settled — the same test the upstream library uses.
 * @param row - One CAL transaction row.
 * @returns True when the row has not settled.
 */
function isPending(row: ICalAmountRow): boolean {
  return str(row.debCrdDate) === '';
}

/**
 * Whether the row returns money to the household.
 *
 * CAL states this twice, in fields that carry it differently, and neither is
 * reliably present:
 *
 *   - `amtBeforeConvAndIndex` carries an explicit minus on a credit. Observed
 *     in a real payload (the repository's own card-sign fixture is
 *     `{ trnAmt: 250, amtBeforeConvAndIndex: -250 }`) — note that row has NO
 *     `trnTypeCode` at all.
 *   - `trnTypeCode` names the kind outright, `6` being a credit. `trnAmt` is an
 *     unsigned magnitude, so for that field the code is the only signal.
 *
 * Either one alone therefore misreads rows the other would get right, which is
 * why this reads both. **An explicit minus wins**: a sign CAL took the trouble
 * to send is stronger evidence than a code it may have omitted.
 *
 * <p>UNVERIFIED: no captured payload contains a real credit, so the case where
 * the two signals actively DISAGREE — a minus with `trnTypeCode` 5 — has never
 * been observed. It is resolved in favour of the minus on the reasoning above,
 * not on evidence, and a replay covering a real refund is what would settle it.
 * @param row - One CAL transaction row.
 * @returns True when the row is a credit.
 */
function isCredit(row: ICalAmountRow): boolean {
  const signedBilled = num(row.amtBeforeConvAndIndex);
  return signedBilled < 0 || str(row.trnTypeCode) === TRN_TYPE_CREDIT;
}

/**
 * Resolve CAL's four money fields from one row.
 *
 * A credit keeps its amounts positive; everything else is money leaving the
 * household and comes back negative. Direction is decided once, from both the
 * signals CAL sends, and applied to both amounts so they cannot disagree with
 * each other.
 * @param raw - One CAL transaction row.
 * @returns The four money fields.
 */
export function calAmounts(raw: object): ICalAmounts {
  const row = raw as ICalAmountRow;
  const isPendingRow = isPending(row);
  // A pending row has no billed amount yet, so the transaction amount is the
  // only figure CAL has stated.
  const billed = isPendingRow ? num(row.trnAmt) : num(row.amtBeforeConvAndIndex);
  const original = num(row.trnAmt);
  const sign = isCredit(row) ? 1 : -1;
  // A pending row has no billing currency yet. That is a fact about the row,
  // not a gap in what this shape knows, so it is stated as empty rather than
  // left for the shared mapper to guess at.
  const billingCurrency = isPendingRow ? '' : str(row.debCrdCurrencySymbol);
  return {
    chargedAmount: sign * Math.abs(billed),
    originalAmount: sign * Math.abs(original),
    chargedCurrency: billingCurrency,
    originalCurrency: str(row.trnCurrencySymbol),
  };
}

export default calAmounts;
