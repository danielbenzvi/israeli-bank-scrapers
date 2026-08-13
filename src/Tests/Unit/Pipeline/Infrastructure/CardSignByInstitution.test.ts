/**
 * Charge sign: decided by the institution, not by a payload sniff.
 *
 * Card issuers report a charge as a positive number; banks report the same
 * movement as negative. The mapper used to infer which it was from the
 * presence of a `dealSumType` field, which only some issuers send — so every
 * other card issuer was treated as a bank and its charges came out positive,
 * recorded as money received rather than spent.
 *
 * The failure is invisible in a successful scrape: no row is dropped, no error
 * is raised, and every amount looks like a plausible number. Only the sign is
 * wrong. These tests pin it.
 */

import { autoMapTransaction } from '../../../../Scrapers/Pipeline/Mediator/Scrape/ScrapeAutoMapper.js';

/** A charge as a card issuer reports it: positive, meaning "you owe this". */
const CHARGE = { date: '2026-02-03', amount: 122.17, description: 'MERCHANT' };

function mapped(raw: Record<string, unknown>, isCardIssuer?: boolean) {
  const result = autoMapTransaction(raw, isCardIssuer);
  if (result === false) throw new Error('record was rejected by the mapper');
  return result;
}

describe('charge sign by declared institution', () => {
  it('flips a card issuer charge to negative when the institution says it is a card', () => {
    expect(mapped(CHARGE, true).chargedAmount).toBe(-122.17);
  });

  it('leaves a bank amount untouched when the institution says it is not a card', () => {
    expect(mapped(CHARGE, false).chargedAmount).toBe(122.17);
  });

  it('flips a card issuer that sends NO dealSumType — the regression itself', () => {
    // This is the whole bug. Before the declaration existed, this row mapped to
    // +122.17: a spend recorded as income, in a scrape that reported success.
    const withoutTheSniffField = { ...CHARGE };
    expect(withoutTheSniffField).not.toHaveProperty('dealSumType');
    expect(mapped(withoutTheSniffField, true).chargedAmount).toBe(-122.17);
  });

  it('still infers from the payload when the caller declares nothing', () => {
    // Backwards compatibility for callers that pass no declaration: the old
    // inference is preserved exactly, including its blind spot.
    expect(mapped({ ...CHARGE, dealSumType: '2' }).chargedAmount).toBe(-122.17);
    expect(mapped({ ...CHARGE }).chargedAmount).toBe(122.17);
  });

  it('lets an explicit declaration override the payload sniff in both directions', () => {
    // A bank that happens to carry a dealSumType-shaped field must not have its
    // amounts flipped just because the field is present.
    expect(mapped({ ...CHARGE, dealSumType: '2' }, false).chargedAmount).toBe(122.17);
    expect(mapped({ ...CHARGE }, true).chargedAmount).toBe(-122.17);
  });

  it('leaves a zero amount alone rather than producing negative zero', () => {
    expect(Object.is(mapped({ ...CHARGE, amount: 0 }, true).chargedAmount, -0)).toBe(false);
  });

  it('turns a refund back into money returned, rather than another charge', () => {
    // This test previously asserted the opposite, and was wrong. An issuer
    // reports a refund as a negative number; forcing the sign with
    // `-Math.abs()` made it a charge, so a purchase and its refund both counted
    // as spend and the money never came back in any total. Caught on a real Max
    // statement carrying a charge and its later refund for the same amount.
    expect(mapped({ ...CHARGE, amount: -401.55 }, true).chargedAmount).toBe(401.55);
  });
});
