/**
 * Instalment dates — put each payment of a plan in the month it is billed.
 *
 * Card issuers list every payment of an instalment plan under the PURCHASE
 * date. Payment 3 of a purchase made on 20 October arrives dated 20 October,
 * not 20 December. The Legacy scrapers corrected this with `fixInstallments`
 * (`Common/Transactions.ts`) before filtering by date; the Pipeline never
 * called it, so every Pipeline bank emitted plans with all payments on one day.
 *
 * <p>Three consequences, all measured in a consumer's stored data: payments
 * counted in the purchase month instead of their own; payments of an evenly
 * divided plan arriving as identical rows, so a consumer keyed on
 * (date, amount, description) merged them into one; and payments of a
 * purchase older than `startDate` dropped by {@link applyStartWindow}, which
 * filters on `date` — so it must run AFTER this shift, the order the Legacy
 * path used.
 *
 * <p>The shift is done in the bank's calendar, not the host's. Adding a month
 * to a UTC instant moves the wall-clock hour across a daylight-saving change:
 * a purchase at local midnight in summer, shifted into winter, would land on
 * the previous day. `fixInstallments` has exactly that defect on a UTC host.
 * moment-timezone keeps the local wall time and clamps the day to the target
 * month's length (31 January + 1 month = 28/29 February).
 */

import type { ITransaction } from '../../../../Transactions.js';
import { TransactionTypes } from '../../../../Transactions.js';
import { bankMomentOfInstant } from './BankCalendar.js';

/**
 * Months a row's date must move forward, or 0 when it must not move.
 * @param txn - Mapped transaction.
 * @returns Whole months to add.
 */
function monthsToShift(txn: ITransaction): number {
  if (txn.type !== TransactionTypes.Installments) return 0;
  const ordinal = txn.installments?.number ?? 0;
  if (!Number.isInteger(ordinal) || ordinal <= 1) return 0;
  return ordinal - 1;
}

/**
 * Re-date one row into its billing month; unreadable dates pass unchanged.
 * @param txn - Mapped transaction.
 * @returns The same row, or a copy with its `date` moved.
 */
function shiftOne(txn: ITransaction): ITransaction {
  const months = monthsToShift(txn);
  if (months === 0) return txn;
  const inZone = bankMomentOfInstant(txn.date);
  if (!inZone.isValid()) return txn;
  const shifted = inZone.add(months, 'months').toISOString();
  return { ...txn, date: shifted };
}

/**
 * Move payment N of every instalment plan forward by N − 1 months.
 * Payment 1, ordinary rows and rows with an unreadable date are untouched.
 * @param txns - Mapped transactions, before the start-date window.
 * @returns Transactions with instalment payments in their billing month.
 */
export function shiftInstallmentDates(txns: readonly ITransaction[]): readonly ITransaction[] {
  return txns.map(shiftOne);
}

export default shiftInstallmentDates;
