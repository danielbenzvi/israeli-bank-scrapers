/**
 * Direction marked by a numeric code rather than a word.
 *
 * Hapoalim reports `eventAmount` as a positive MAGNITUDE and marks direction
 * with `eventActivityTypeCode`: 1 inbound, 2 outbound. The direction check
 * matched only the string "debit", and a number never matches — so every
 * payment, card settlement and mortgage instalment mapped positive: money
 * leaving the account recorded as money arriving.
 *
 * Found by replaying a real scrape against stored rows: 177 of 257 rows
 * differed, every one of them the same magnitude with the opposite sign.
 * Nothing failed, and both signs were present in the result, so it did not
 * even look like a blanket inversion.
 */

import { autoMapTransaction } from '../../../../Scrapers/Pipeline/Mediator/Scrape/ScrapeAutoMapper.js';

const BASE = { date: '2026-08-09', description: 'MERCHANT' };

function amountOf(raw: Record<string, unknown>): number {
  const result = autoMapTransaction(raw);
  if (result === false) throw new Error('record was rejected by the mapper');
  return result.chargedAmount;
}

describe('numeric outbound direction', () => {
  it('treats the outbound code as money leaving, despite a positive magnitude', () => {
    expect(amountOf({ ...BASE, eventAmount: 9387.21, eventActivityTypeCode: 2 })).toBe(-9387.21);
  });

  it('leaves an inbound row positive', () => {
    // Both directions occur in real data — 82 of 286 stored rows are inbound —
    // so this must not become a blanket inversion.
    expect(amountOf({ ...BASE, eventAmount: 5000, eventActivityTypeCode: 1 })).toBe(5000);
  });

  it('accepts the code as a string, since JSON payloads are inconsistent about it', () => {
    expect(amountOf({ ...BASE, eventAmount: 100, eventActivityTypeCode: '2' })).toBe(-100);
  });

  it('leaves a row with no direction marker alone', () => {
    expect(amountOf({ ...BASE, eventAmount: 100 })).toBe(100);
  });

  it('still honours a word-based direction, which other banks use', () => {
    expect(amountOf({ ...BASE, amount: 100, creditDebit: 'debit' })).toBe(-100);
    expect(amountOf({ ...BASE, amount: 100, creditDebit: 'credit' })).toBe(100);
  });

  it('does not flip on an unrelated numeric code', () => {
    // Only the outbound value counts; any other code leaves the sign alone.
    expect(amountOf({ ...BASE, eventAmount: 100, eventActivityTypeCode: 7 })).toBe(100);
  });
});
