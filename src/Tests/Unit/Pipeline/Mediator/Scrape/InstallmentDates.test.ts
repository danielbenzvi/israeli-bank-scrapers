/**
 * Instalment dates — payment N of a plan moves to its own billing month, in the
 * bank's calendar, before the start-date window runs.
 *
 * Expected instants below are written from the calendar, not from the code:
 * local midnight on 20 Oct 2026 in Israel is 21:00Z the day before (summer
 * time, UTC+3); local midnight on 20 Nov and 20 Dec is 22:00Z the day before
 * (winter time, UTC+2). No PII: synthetic rows.
 */

import { shiftInstallmentDates } from '../../../../../Scrapers/Pipeline/Mediator/Scrape/InstallmentDates.js';
import { applyStartWindow } from '../../../../../Scrapers/Pipeline/Mediator/Scrape/StartWindow.js';
import type { ITransaction } from '../../../../../Transactions.js';
import { TransactionTypes } from '../../../../../Transactions.js';

/**
 * Build a synthetic instalment payment.
 * @param date - ISO instant as the mapper emits it.
 * @param num - Payment ordinal.
 * @param total - Payments in the plan.
 * @returns Transaction shaped enough for the shift.
 */
function payment(date: string, num: number, total: number): ITransaction {
  return {
    type: TransactionTypes.Installments,
    date,
    processedDate: date,
    installments: { number: num, total },
    description: 'plan',
    chargedAmount: -100,
  } as unknown as ITransaction;
}

/**
 * Build a synthetic ordinary row.
 * @param date - ISO instant.
 * @returns Transaction of type normal.
 */
function ordinary(date: string): ITransaction {
  return {
    type: TransactionTypes.Normal,
    date,
    description: 'row',
    chargedAmount: -1,
  } as unknown as ITransaction;
}

/**
 * Dates of a shifted list, in order.
 * @param txns - Rows to shift.
 * @returns Their dates after the shift.
 */
function datesAfter(txns: readonly ITransaction[]): readonly string[] {
  return shiftInstallmentDates(txns).map((t): string => t.date);
}

const PURCHASE = '2026-10-19T21:00:00.000Z';

describe('Scrape/shiftInstallmentDates', () => {
  it('moves payment N forward N-1 months and keeps the local day across the DST change', () => {
    const plan = [payment(PURCHASE, 1, 3), payment(PURCHASE, 2, 3), payment(PURCHASE, 3, 3)];
    const dates = datesAfter(plan);
    expect(dates).toStrictEqual([PURCHASE, '2026-11-19T22:00:00.000Z', '2026-12-19T22:00:00.000Z']);
  });

  it('leaves ordinary rows untouched', () => {
    const dates = datesAfter([ordinary(PURCHASE)]);
    expect(dates).toStrictEqual([PURCHASE]);
  });

  it('does not touch processedDate', () => {
    const shifted = shiftInstallmentDates([payment(PURCHASE, 2, 3)]);
    expect(shifted[0].processedDate).toBe(PURCHASE);
  });

  it('clamps to the last day of a shorter month', () => {
    // 31 Jan 2026 local midnight (UTC+2) -> 28 Feb 2026 local midnight.
    const dates = datesAfter([payment('2026-01-30T22:00:00.000Z', 2, 2)]);
    expect(dates).toStrictEqual(['2026-02-27T22:00:00.000Z']);
  });

  it('keeps the local wall time of a Cal-shaped instant', () => {
    // 25 Mar 2026 15:00 local (UTC+2) -> 25 Apr 2026 15:00 local (UTC+3).
    const dates = datesAfter([payment('2026-03-25T13:00:00.000Z', 2, 10)]);
    expect(dates).toStrictEqual(['2026-04-25T12:00:00.000Z']);
  });

  it('passes a row with an unreadable date through unchanged', () => {
    const dates = datesAfter([payment('not-a-date', 2, 3)]);
    expect(dates).toStrictEqual(['not-a-date']);
  });

  it('makes the payments of an evenly divided plan distinct', () => {
    const plan = [payment(PURCHASE, 1, 3), payment(PURCHASE, 2, 3), payment(PURCHASE, 3, 3)];
    const distinct = new Set(datesAfter(plan));
    expect(distinct.size).toBe(3);
  });

  it('lets a payment of a purchase older than startDate survive the window once shifted', () => {
    // Purchase Feb 2026, 10 payments; window opens 2026-05-02. Payment 8 is
    // billed in September and must be kept — unshifted, it would be dropped.
    const startDate = new Date('2026-05-02');
    const p8 = payment('2026-02-24T22:00:00.000Z', 8, 10);
    expect(applyStartWindow({ txns: [p8], startDate, label: 'test/txns' }).dropped).toBe(1);
    const shifted = shiftInstallmentDates([p8]);
    expect(applyStartWindow({ txns: shifted, startDate, label: 'test/txns' }).dropped).toBe(0);
  });
});
