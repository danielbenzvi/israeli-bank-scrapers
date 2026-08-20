/**
 * Amex — charges posting outside the current statement cycle are rows, not
 * summary.
 *
 * The same omission found on Isracard: `mergeAmexRows` read two containers and
 * dropped `israelAbroadVouchers.outOfStatementChargeDateVouchers[]
 * .immediateVouchersCurrencyDate[]`. Recurring international merchants post
 * there almost exclusively, so the loss read as a quiet month, not an error.
 *
 * A replay could not have caught this: stored Amex rows came from the same
 * lossy path, so a loss that was always present looks like agreement.
 *
 * Shape taken from live GetTransactionsList responses; every value is invented.
 */

import mergeAmexRows from '../../../../../Scrapers/Pipeline/Banks/Amex/scrape/AmexShapeExtract.js';

/** One transaction row, in the shape all three containers share. */
function txn(seq: number, name: string): Record<string, unknown> {
  return {
    seqVoucherNumber: seq,
    businessName: name,
    billingAmount: 49.9,
    purchaseDate: '2026-06-02',
  };
}

/**
 * Build a response carrying any mix of the three containers.
 * @param args - Rows for each container.
 * @returns GetTransactionsList response body.
 */
function response(args: {
  approved?: Record<string, unknown>[];
  settled?: Record<string, unknown>[];
  outOfStatement?: Record<string, unknown>[][];
}): object {
  return {
    data: {
      approvals: args.approved ? { approvedTransactions: args.approved } : null,
      israelAbroadVouchers: {
        vouchers: { israelAbroadVouchersList: args.settled ?? [] },
        outOfStatementChargeDateVouchers:
          args.outOfStatement?.map((rows) => ({ immediateVouchersCurrencyDate: rows })) ?? null,
      },
      currentTransactionsList: null,
    },
  };
}

describe('Amex/outOfStatementChargeDateVouchers', () => {
  it('returns rows that post outside the statement cycle', () => {
    const body = response({ outOfStatement: [[txn(1, 'STREAMING CO'), txn(2, 'CLOUD CO')]] });
    const rows = mergeAmexRows(body);
    expect(rows.length).toBe(2);
  });

  it('merges all three containers into one list', () => {
    const body = response({
      approved: [txn(10, 'PENDING CO')],
      settled: [txn(20, 'SHOP')],
      outOfStatement: [[txn(30, 'STREAMING CO')]],
    });
    const rows = mergeAmexRows(body);
    const seqs = rows.map((r) => r.seqVoucherNumber).sort((a, b) => Number(a) - Number(b));
    expect(seqs).toEqual([10, 20, 30]);
  });

  it('classes them as vouchers, so consumers matching the existing two keep working', () => {
    const body = response({ outOfStatement: [[txn(1, 'STREAMING CO')]] });
    const rows = mergeAmexRows(body);
    expect(rows[0].__rowProvenance.rowClass).toBe('voucher');
  });

  it('carries the amount provenance the settled rows get', () => {
    const body = response({ outOfStatement: [[txn(1, 'STREAMING CO')]] });
    const rows = mergeAmexRows(body);
    expect(rows[0].__rowProvenance.amountField).toBe('billingAmount');
    expect(rows[0].__rowProvenance.rawAmount).toBe(49.9);
  });

  it('flattens several per-currency-date groups', () => {
    const body = response({ outOfStatement: [[txn(1, 'A')], [txn(2, 'B'), txn(3, 'C')]] });
    expect(mergeAmexRows(body).length).toBe(3);
  });

  it('does not invent rows when the container is absent', () => {
    const body = response({ settled: [txn(20, 'SHOP')] });
    expect(mergeAmexRows(body).length).toBe(1);
  });

  it('tolerates a group whose row list is null', () => {
    const body = {
      data: {
        approvals: null,
        israelAbroadVouchers: {
          vouchers: { israelAbroadVouchersList: [] },
          outOfStatementChargeDateVouchers: [{ immediateVouchersCurrencyDate: null }],
        },
      },
    };
    expect(mergeAmexRows(body).length).toBe(0);
  });
});
