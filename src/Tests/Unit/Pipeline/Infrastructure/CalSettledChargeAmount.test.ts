/**
 * Which field is a settled Cal charge read from?
 *
 * `trnAmt` is the original deal total. On a settled row the amount actually
 * charged is `amtBeforeConvAndIndex`, and the two differ in three ways that all
 * matter:
 *
 *   - an instalment plan: trnAmt is the WHOLE plan, so a 10-payment purchase
 *     would be recorded at ten times its payment, on every one of the ten rows;
 *   - an index-linked or converted charge: trnAmt is the pre-adjustment figure;
 *   - a fee billed elsewhere: charged 0 here, while trnAmt still carries a
 *     value.
 *
 * All three were observed against real stored data before this was fixed. None
 * of them fails or drops a row — they simply record the wrong money.
 */

import { autoMapTransaction } from '../../../../Scrapers/Pipeline/Mediator/Scrape/ScrapeAutoMapper.js';

/** Settled rows carry a debit/credit date; pending rows do not. */
const SETTLED = { date: '2026-02-25', description: 'MERCHANT', debCrdDate: '2026-03-02' };

function amountOf(raw: Record<string, unknown>): number {
  const result = autoMapTransaction(raw, true);
  if (result === false) throw new Error('record was rejected by the mapper');
  return result.chargedAmount;
}

describe('settled Cal charge amount', () => {
  it('reads the charged amount, not the deal total, on an instalment payment', () => {
    // One payment of a ten-payment plan: 161.5 charged, 1615 total.
    expect(amountOf({ ...SETTLED, trnAmt: 1615, amtBeforeConvAndIndex: 161.5 })).toBe(-161.5);
  });

  it('reads the post-adjustment amount on an index-linked charge', () => {
    expect(amountOf({ ...SETTLED, trnAmt: 760, amtBeforeConvAndIndex: 800 })).toBe(-800);
  });

  it('records a fee billed elsewhere as zero rather than inventing a charge', () => {
    expect(amountOf({ ...SETTLED, trnAmt: 22.29, amtBeforeConvAndIndex: 0 })).toBe(0);
  });

  it('falls back to the deal total on a pending row, which has no settled amount', () => {
    // The ordering does the pending/settled split for free: the settled field
    // simply is not there yet.
    expect(amountOf({ date: '2026-02-25', description: 'MERCHANT', trnAmt: 500 })).toBe(-500);
  });

  it('is unchanged for the ordinary case where the two agree', () => {
    // Why most rows matched even while this was broken — and why a spot check
    // would have missed it.
    expect(amountOf({ ...SETTLED, trnAmt: 51.77, amtBeforeConvAndIndex: 51.77 })).toBe(-51.77);
  });

  it('does not disturb an institution that sends neither field', () => {
    expect(amountOf({ date: '2026-02-25', description: 'MERCHANT', amount: 42 })).toBe(-42);
  });
});
