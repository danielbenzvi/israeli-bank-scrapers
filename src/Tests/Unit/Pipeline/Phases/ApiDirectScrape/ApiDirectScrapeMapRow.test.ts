/**
 * Per-row mapping for the api-direct scrape.
 *
 * These exercise the MAPPER, not the shape. A shape can declare a hook
 * perfectly and have it never called: `purchaseDateOf` was declared, used
 * inside the mapper, and covered by a test that invoked it directly off the
 * shape — while being omitted from the options object the mapper actually
 * receives. Everything passed and the hook was dead, which only a live run
 * discovered.
 */

import {
  type IMapTxnsOpts,
  mapOne,
} from '../../../../../Scrapers/Pipeline/Phases/ApiDirectScrape/ApiDirectScrapeMapRow.js';
import type { ITransaction } from '../../../../../Transactions.js';

/**
 * A row the shared auto-mapper can read. Every value invented.
 * @returns One raw row.
 */
function row(): Record<string, unknown> {
  return {
    identifier: 700000001,
    chargedAmount: -62.5,
    description: 'MERCHANT',
    date: '2026-06-29',
    price: 62.5,
  };
}

/**
 * Map one row and fail the test if the mapper refused it.
 * @param opts - Shape-declared mapping options.
 * @returns The mapped transaction.
 */
function mapped(opts: IMapTxnsOpts): ITransaction {
  const raw = row();
  const result = mapOne(raw, opts);
  // Asserted rather than thrown: a refusal here is a test-setup fault, and an
  // expectation reports it where the reader is already looking.
  expect(result).not.toBe(false);
  return result as ITransaction;
}

/**
 * A provider bag, standing for a shape's declaration.
 * @returns The bag.
 */
function bag(): Readonly<Record<string, unknown>> {
  return { companyPrice: 40 };
}

/**
 * A stated purchase day, standing for a shape's declaration.
 * @returns The day, as `YYYY-MM-DD`.
 */
function statedDay(): string {
  return '2026-06-29';
}

describe('api-direct row mapping — shape hooks', () => {
  it('maps a row without either hook, as every existing bank does', () => {
    const txn = mapped({});
    expect(txn.providerExtra).toBeUndefined();
  });

  it('carries the provider bag when the shape declares one', () => {
    const txn = mapped({ providerExtraOf: bag });
    expect(txn.providerExtra).toEqual({ companyPrice: 40 });
  });

  it('uses the date the shape states, over the one coercion produced', () => {
    // The whole point: coercion re-emits a parsed date as a UTC instant, which
    // east of Greenwich is the previous calendar day. A shape that states the
    // day must win, and BOTH date fields must take it or the row is keyed two
    // ways.
    const txn = mapped({ purchaseDateOf: statedDay });
    expect(txn.date).toBe('2026-06-29');
    expect(txn.processedDate).toBe('2026-06-29');
  });
});
