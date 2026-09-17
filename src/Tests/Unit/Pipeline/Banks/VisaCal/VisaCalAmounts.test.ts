import calAmounts from '../../../../../Scrapers/Pipeline/Banks/VisaCal/scrape/VisaCalAmounts.js';

/**
 * CAL states its money in two amounts and two currencies. These cases are
 * written from what CAL sends, not from what the resolver does.
 *
 * Shapes 2-6 are synthetic: the only real CAL capture available is shekel-only
 * and settled-only, so the field VALUES below are invented while the field
 * SHAPES come from the provider's documented contract. They are evidence about
 * this function; they are not evidence about CAL. A live capture is the only
 * thing that settles what a real foreign row carries.
 */

/** A settled shekel charge — the ordinary case, and the only one really captured. */
const SETTLED_ILS = {
  trnAmt: 120.5,
  amtBeforeConvAndIndex: 120.5,
  trnCurrencySymbol: '₪',
  debCrdCurrencySymbol: '₪',
  debCrdDate: '2026-03-02',
  trnTypeCode: '5',
};

describe('CAL money fields', () => {
  it('reads a settled shekel charge from the billed amount, as money leaving', () => {
    const a = calAmounts(SETTLED_ILS);
    expect(a.chargedAmount).toBe(-120.5);
    expect(a.originalAmount).toBe(-120.5);
    expect(a.chargedCurrency).toBe('₪');
    expect(a.originalCurrency).toBe('₪');
  });

  it('keeps the two amounts apart on a foreign charge', () => {
    // The case the shared alias list cannot express: billed in shekels,
    // transacted in another currency, two different numbers.
    const a = calAmounts({
      ...SETTLED_ILS,
      trnAmt: 25,
      amtBeforeConvAndIndex: 96.4,
      trnCurrencySymbol: '$',
    });
    expect(a.chargedAmount).toBe(-96.4);
    expect(a.originalAmount).toBe(-25);
    expect(a.chargedCurrency).toBe('₪');
    expect(a.originalCurrency).toBe('$');
  });

  it('takes an instalment payment from the billed amount, not the plan total', () => {
    // The defect this delivery exists to fix: trnAmt carries the WHOLE plan.
    const a = calAmounts({ ...SETTLED_ILS, trnAmt: 16150, amtBeforeConvAndIndex: 1615 });
    expect(a.chargedAmount).toBe(-1615);
  });

  it('reads a pending row from the transaction amount, which is all CAL has stated', () => {
    // CAL fills debCrdDate only once a charge settles, so a pending row has it blank.
    const a = calAmounts({ ...SETTLED_ILS, debCrdDate: '', trnAmt: 80, amtBeforeConvAndIndex: 0 });
    expect(a.chargedAmount).toBe(-80);
    expect(a.chargedCurrency).toBe('');
  });

  it('leaves a credit positive, on the type code rather than a sign comparison', () => {
    const a = calAmounts({ ...SETTLED_ILS, trnTypeCode: '6' });
    expect(a.chargedAmount).toBe(120.5);
    expect(a.originalAmount).toBe(120.5);
  });

  it('reads a credit CAL signed but did not type — the shape a real payload showed', () => {
    // From this repository's own card-sign fixture: the minus lives on
    // amtBeforeConvAndIndex, trnAmt is an unsigned magnitude, and there is no
    // trnTypeCode at all. Reading only the type code calls this a charge.
    const a = calAmounts({
      trnAmt: 250,
      amtBeforeConvAndIndex: -250,
      trnCurrencySymbol: '₪',
      debCrdCurrencySymbol: '₪',
      debCrdDate: '2026-03-02',
    });
    expect(a.chargedAmount).toBe(250);
    expect(a.originalAmount).toBe(250);
  });

  it('prefers an explicit minus when the two direction signals disagree', () => {
    // UNVERIFIED against a real payload — no capture contains a credit at all.
    // A sign CAL took the trouble to send outranks a code it may have defaulted.
    const a = calAmounts({ ...SETTLED_ILS, amtBeforeConvAndIndex: -120.5, trnTypeCode: '5' });
    expect(a.chargedAmount).toBe(120.5);
  });

  it('keeps both amounts pointing the same way', () => {
    // The two fields describe one event. Whatever decides direction must decide
    // it once, or a row can report money in and out at the same time.
    const a = calAmounts({ ...SETTLED_ILS, trnAmt: 25, amtBeforeConvAndIndex: -96.4 });
    const chargedDirection = Math.sign(a.chargedAmount);
    const originalDirection = Math.sign(a.originalAmount);
    expect(chargedDirection).toBe(originalDirection);
  });

  it('treats a standing order as money leaving, like any other non-credit', () => {
    // trnTypeCode 9 appears on 3 of 45 rows in the real capture. It is neither
    // a credit nor an instalment, and nothing should special-case it.
    const a = calAmounts({ ...SETTLED_ILS, trnTypeCode: '9' });
    expect(a.chargedAmount).toBe(-120.5);
  });

  it('reads a fee billed elsewhere as zero, not as the deal total', () => {
    const a = calAmounts({ ...SETTLED_ILS, trnAmt: 42, amtBeforeConvAndIndex: 0 });
    expect(a.chargedAmount).toBe(-0);
    expect(a.originalAmount).toBe(-42);
  });

  it('does not invent a currency the provider omitted', () => {
    expect(calAmounts({ ...SETTLED_ILS, trnCurrencySymbol: '' }).originalCurrency).toBe('');
  });

  it('survives a provider sending a non-numeric amount', () => {
    const a = calAmounts({ ...SETTLED_ILS, amtBeforeConvAndIndex: 'not a number' });
    expect(a.chargedAmount).toBe(-0);
  });
});
