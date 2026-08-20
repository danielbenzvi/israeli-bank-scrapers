/**
 * Isracard — charges posting outside the current statement cycle are rows,
 * not summary.
 *
 * `mergeIsracardRows` read two containers and dropped a third:
 * `israelAbroadVouchers.outOfStatementChargeDateVouchers[]
 *  .immediateVouchersCurrencyDate[]`. Recurring international online merchants
 * post there almost exclusively, so the omission removed real spend from every
 * consumer's totals without an error — the failure looked like a quiet month.
 *
 * Shape taken from live GetTransactionsList responses; every value here is
 * invented.
 */

import mergeIsracardRows from '../../../../../Scrapers/Pipeline/Banks/Isracard/scrape/IsracardShapeExtract.js';

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

describe('Isracard/outOfStatementChargeDateVouchers', () => {
  it('returns rows that post outside the statement cycle', () => {
    const body = response({ outOfStatement: [[txn(1, 'STREAMING CO'), txn(2, 'CLOUD CO')]] });
    const rows = mergeIsracardRows(body);
    expect(rows.length).toBe(2);
  });

  it('merges all three containers into one list', () => {
    const body = response({
      approved: [txn(10, 'PENDING CO')],
      settled: [txn(20, 'SHOP')],
      outOfStatement: [[txn(30, 'STREAMING CO')]],
    });
    const rows = mergeIsracardRows(body) as Array<Record<string, unknown>>;
    const seqs = rows.map((r) => r.seqVoucherNumber).sort((a, b) => Number(a) - Number(b));
    expect(seqs).toEqual([10, 20, 30]);
  });

  it('flattens several per-currency-date groups', () => {
    const body = response({ outOfStatement: [[txn(1, 'A')], [txn(2, 'B'), txn(3, 'C')]] });
    const rows = mergeIsracardRows(body);
    expect(rows.length).toBe(3);
  });

  it('does not invent rows when the container is absent', () => {
    const body = response({ settled: [txn(20, 'SHOP')] });
    const rows = mergeIsracardRows(body);
    expect(rows.length).toBe(1);
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
    const rows = mergeIsracardRows(body);
    expect(rows.length).toBe(0);
  });

  it('keeps returning nothing for an empty response', () => {
    const rows = mergeIsracardRows({ data: null });
    expect(rows.length).toBe(0);
  });
});
