/**
 * Provider fields the shared auto-mapper used to drop.
 *
 * Every institution routes through `autoMapTransaction`, which populates a
 * field only when the payload carries a key listed for it in the Well-Known
 * dictionary — so five optional `ITransaction` fields, which have no entry
 * there, were never populated even when the payload carried them. These tests
 * assert each one is recovered, and that the recovery is keyed narrowly enough
 * that it cannot fire on a payload that does not have the field.
 *
 * Payload field names only; no real provider values.
 */

import { autoMapTransaction } from '../../../../Scrapers/Pipeline/Mediator/Scrape/ScrapeAutoMapper.js';
import type { ITransaction } from '../../../../Transactions.js';
import { TransactionStatuses, TransactionTypes } from '../../../../Transactions.js';

/** Minimum a record needs to survive the mapper's date/amount gate. */
const BASE = { date: '2026-02-03', amount: -300, description: 'MERCHANT' };

/**
 * Map a record and assert it survived the mapper's date/amount gate.
 *
 * @param extra - Payload keys under test, merged over {@link BASE}.
 * @returns The mapped transaction.
 */
function mapped(extra: Record<string, unknown>): ITransaction {
  const result = autoMapTransaction({ ...BASE, ...extra });
  if (result === false) throw new TypeError('record was rejected by the mapper');
  return result;
}

describe('restoreProviderFields', () => {
  it('recovers a flat memo', () => {
    expect(mapped({ moreInfo: 'NOTE TEXT' }).memo).toBe('NOTE TEXT');
  });

  it('flattens a nested beneficiary block into a single-line memo', () => {
    const txn = mapped({
      beneficiaryDetailsData: {
        partyHeadline: 'HEADLINE',
        partyName: 'NAME',
        messageHeadline: 'MSG',
        messageDetail: 'DETAIL',
      },
    });
    expect(txn.memo).toBe('HEADLINE NAME. MSG DETAIL.');
  });

  it('recovers the issuer category hint', () => {
    expect(mapped({ branchCodeDesc: 'CATEGORY' }).category).toBe('CATEGORY');
  });

  it('recovers the charged currency', () => {
    expect(mapped({ debCrdCurrencySymbol: 'USD' }).chargedCurrency).toBe('USD');
  });

  it('marks a provisional row pending rather than settled', () => {
    expect(mapped({ serialNumber: 0 }).status).toBe(TransactionStatuses.Pending);
    expect(mapped({ trnPurchaseDate: '2026-02-03' }).status).toBe(TransactionStatuses.Pending);
  });

  it('leaves a settled row completed', () => {
    expect(mapped({ trnPurchaseDate: '2026-02-03', debCrdDate: '2026-03-02' }).status).toBe(
      TransactionStatuses.Completed,
    );
  });

  it('recovers instalment ordinals from explicit numeric fields', () => {
    expect(mapped({ numOfPayments: 10, curPaymentNum: 3 }).installments).toEqual({
      number: 3,
      total: 10,
    });
  });

  it('treats a pending instalment row as payment 1', () => {
    expect(mapped({ numberOfPayments: 10 }).installments).toEqual({ number: 1, total: 10 });
  });

  it('recovers instalment ordinals from a keyworded note', () => {
    expect(mapped({ moreInfo: 'תשלום 3 מתוך 10' }).installments).toEqual({ number: 3, total: 10 });
  });

  it('does not read an unrelated two-number note as an instalment plan', () => {
    expect(mapped({ moreInfo: 'REF 12 34' }).installments).toBeUndefined();
  });

  it('maps the instalment transaction type', () => {
    expect(mapped({ numOfPayments: 10, curPaymentNum: 3 }).type).toBe(
      TransactionTypes.Installments,
    );
  });

  it('honours an explicit non-instalment transaction-type code', () => {
    // Code 5 is a regular charge; without this the presence of a type code
    // alone would be read as an instalment plan.
    expect(mapped({ trnTypeCode: '5', debCrdDate: '2026-03-02' }).type).toBe(
      TransactionTypes.Normal,
    );
    expect(mapped({ trnTypeCode: '8', debCrdDate: '2026-03-02' }).type).toBe(
      TransactionTypes.Installments,
    );
  });

  it('leaves every restored field absent when the payload has none of them', () => {
    const txn = mapped({});
    expect(txn.memo).toBeUndefined();
    expect(txn.category).toBeUndefined();
    expect(txn.installments).toBeUndefined();
    expect(txn.status).toBe(TransactionStatuses.Completed);
    expect(txn.type).toBe(TransactionTypes.Normal);
  });

  it('does not overwrite the description the mapper already resolved', () => {
    expect(mapped({ moreInfo: 'NOTE TEXT' }).description).toBe('MERCHANT');
  });
});
