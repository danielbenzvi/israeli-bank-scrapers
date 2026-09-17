/**
 * Cibus (Pluxee) scrape shape.
 *
 * The payload SHAPES here — key names, nesting and value types — follow a
 * capture of a real session against the provider. Every VALUE is invented: no
 * account identifier, merchant name, amount or date from that capture appears
 * in this repository.
 *
 * The fixture row carries the provider's FULL field set rather than only the
 * four the mapper reads, because the property worth pinning is that the other
 * eighteen are ignored rather than tripping anything.
 */

import type { ICibusDeal } from '../../../../../Scrapers/Pipeline/Banks/Cibus/scrape/CibusMapping.js';
import {
  isCountable,
  partitionByActivity,
  readActivity,
  toAccountBalance,
  toIsoDate,
} from '../../../../../Scrapers/Pipeline/Banks/Cibus/scrape/CibusMapping.js';
import { CIBUS_SHAPE } from '../../../../../Scrapers/Pipeline/Banks/Cibus/scrape/CibusShape.js';
import {
  CIBUS_ACCOUNT,
  type ICibusAcct,
} from '../../../../../Scrapers/Pipeline/Banks/Cibus/scrape/CibusShapeHelpers.js';
import { toProviderDate } from '../../../../../Scrapers/Pipeline/Banks/Cibus/scrape/CibusShapeTxns.js';
import type {
  ApiBody,
  IExtractAccountsArgs,
  IExtractPageArgs,
} from '../../../../../Scrapers/Pipeline/Phases/ApiDirectScrape/IApiDirectScrapeShape.js';
import { ctxUnbounded } from '../../Phases/ApiDirectScrape/WindowNarrowingFixtures.js';

/** Every field the provider sends on a purchase row, with invented values. */
const PROVIDER_ROW = {
  rest_name: 'MERCHANT',
  date: '04/03/2026',
  time: '12:30',
  deal_id: 555001,
  rule_name: 'RULE',
  status: 'OK',
  voucher_code: '0000',
  vtu_price: 0,
  display_price: 62.5,
  coupon: 0,
  discount: 0,
  price: 62.5,
  etc_company_price: 40,
  etc_employee_price: 22.5,
  otl_price: 22.5,
  order_type: 1,
  is_active: 1,
  restaurant_id: 900,
  logo: '',
  refund_id: '',
  budget_activation_date: 0,
  is_3rd_party: false,
  icon: '',
  barcode: null,
};

/**
 * One purchase row, overridable field by field.
 * @param over - Fields to replace on the base row.
 * @returns A provider row.
 */
function deal(over: Partial<ICibusDeal> = {}): ICibusDeal {
  return { ...PROVIDER_ROW, ...over };
}

/**
 * Extract arguments for the customer step, which fetches nothing.
 * @returns Empty extract arguments.
 */
function noAccountsArgs(): IExtractAccountsArgs {
  return { body: {}, sessionContext: {}, secondaryBody: {} };
}

/**
 * Extract arguments for one transactions page.
 * @param body - The response body to read.
 * @returns Page-extract arguments on the first cursor.
 */
function pageArgs(body: ApiBody): IExtractPageArgs<ICibusAcct, number> {
  const ctx = ctxUnbounded();
  return { body, cursor: false, acct: CIBUS_ACCOUNT, ctx };
}

describe('Cibus row activity', () => {
  it('reads both spellings the provider sends, and refuses to guess at others', () => {
    // An earlier revision read this through `Number()`, so any value that did
    // not parse became NaN, compared unequal to 0, and counted — an exclusion
    // that failed open, which is silent and looks like having nothing to drop.
    const readings = [1, '1', 0, '0', 'Y', undefined].map(readActivity);
    expect(readings).toEqual(['live', 'live', 'excluded', 'excluded', 'unknown', 'unknown']);
  });

  it('counts only a row the provider positively marked live', () => {
    const live = deal();
    const off = deal({ is_active: 0 });
    const odd = deal({ is_active: 'Y' });
    const counted = [live, off, odd].map(isCountable);
    expect(counted).toEqual([true, false, false]);
  });

  it('reports what it dropped, separating excluded from unrecognised', () => {
    // The counts are the point: a change in the provider's vocabulary shows up
    // as a rising `unknown` rather than as a month that quietly got cheaper.
    const rows = [deal(), deal({ is_active: 0 }), deal({ is_active: 'Y' })];
    const partition = partitionByActivity(rows);
    expect(partition.countable).toHaveLength(1);
    expect(partition.excluded).toBe(1);
    expect(partition.unknown).toBe(1);
  });
});

describe('Cibus dates', () => {
  it('re-emits the provider DD/MM/YYYY by field position', () => {
    // `new Date('04/03/2026')` is 3 April in a US locale, and a round trip
    // through any date object resolves the day in the run's local zone — which
    // shifts it into the previous UTC day everywhere east of Greenwich.
    const march = toIsoDate('04/03/2026');
    const december = toIsoDate('31/12/2026');
    expect(march).toBe('2026-03-04');
    expect(december).toBe('2026-12-31');
  });

  it('refuses a shape it does not recognise rather than guessing', () => {
    /**
     * Reads an already-ISO date, which is not the provider's shape.
     * @returns Never; the call throws.
     */
    const isoShaped = (): string => toIsoDate('2026-03-04');
    /**
     * Reads an empty date, which a dropped field would produce.
     * @returns Never; the call throws.
     */
    const empty = (): string => toIsoDate('');
    expect(isoShaped).toThrow();
    expect(empty).toThrow();
  });

  it('refuses a date outside the calendar, which catches a switch to MM/DD', () => {
    /**
     * Reads a date whose fields are outside the calendar's own bounds.
     * @returns Never; the call throws.
     */
    const outOfRange = (): string => toIsoDate('13/25/2026');
    expect(outOfRange).toThrow();
  });

  it('emits the provider format its own filters expect', () => {
    const march = toProviderDate('2026-03-04T00:00:00.000Z');
    const december = toProviderDate('2026-12-31T00:00:00.000Z');
    expect(march).toBe('04/03/2026');
    expect(december).toBe('31/12/2026');
  });
});

describe('Cibus balance', () => {
  it('reads the remaining benefit from the provider budget block', () => {
    const resolved = toAccountBalance({ CurrBudget: '412.75' });
    expect(resolved.balance).toBe(412.75);
  });

  it('omits the key rather than inventing a sentinel when none was reported', () => {
    // A benefit balance of 0 is a real, reportable state, so "absent" cannot be
    // spelled as 0.
    const absent = toAccountBalance({});
    const zero = toAccountBalance({ CurrBudget: '0' });
    expect(absent.balance).toBeUndefined();
    expect(zero.balance).toBe(0);
  });
});

describe('Cibus scrape shape', () => {
  it('asks for one month window at a time, in the provider date format', () => {
    const ctx = ctxUnbounded();
    const vars = CIBUS_SHAPE.transactions.buildVars(CIBUS_ACCOUNT, false, ctx);
    expect(vars.type).toBe('prx_user_deals');
    const fromDate = String(vars.from_date);
    const toDate = String(vars.to_date);
    expect(fromDate).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
    expect(toDate).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
  });

  it('names the budget verb on the balance step', () => {
    const ctx = ctxUnbounded();
    const vars = CIBUS_SHAPE.balance.buildVars(CIBUS_ACCOUNT, ctx);
    expect(vars.type).toBe('prx_get_budgets');
  });

  it('reads rows from the top-level list, dropping the ones marked inactive', () => {
    // Rows arrive under `list` at the TOP level — not nested under `data`, and
    // not called `deals`.
    const body = { head: { count: 2 }, list: [deal(), deal({ is_active: 0 })], code: 0 };
    const args = pageArgs(body);
    const page = CIBUS_SHAPE.transactions.extractPage(args);
    expect(page.items).toHaveLength(1);
  });

  it('restates each row under the names the shared mapper resolves', () => {
    // This provider's own key names — `price`, `rest_name`, `deal_id` — are in
    // the Well-Known dictionary for NO field. Only `date` aliased, so rows
    // mapped clean and arrived with amount 0, no description and no identifier,
    // on a scrape reporting success and the right count. The amount is negated
    // because the provider states a purchase as a positive magnitude.
    const body = { head: { count: 1 }, list: [deal()], code: 0 };
    const args = pageArgs(body);
    const page = CIBUS_SHAPE.transactions.extractPage(args);
    const row = page.items[0] as Record<string, unknown>;
    expect(row.chargedAmount).toBe(-62.5);
    expect(row.description).toBe('MERCHANT');
    expect(row.identifier).toBe(555001);
  });

  it('states the purchase day as a bare date, never a UTC instant', () => {
    // The shared coercion re-emits a parsed date with `toISOString()`, which at
    // UTC+3 turns local midnight into the PREVIOUS day: a 29/06 purchase became
    // "2026-06-28T21:00:00.000Z". A consumer keying rows on the bare date reads
    // that as a different purchase — and a wrong day never surfaces as an
    // error, it re-imports the row as new, forever.
    const row = deal({ date: '29/06/2026' });
    const stated = CIBUS_SHAPE.purchaseDateOf?.(row);
    expect(stated).toBe('2026-06-29');
  });

  it('keeps the provider fields the funding split is read from', () => {
    // The restated row is what `providerExtraOf` receives. Dropping the
    // provider's own keys while renaming would take the split with them.
    const body = { head: { count: 1 }, list: [deal()], code: 0 };
    const args = pageArgs(body);
    const page = CIBUS_SHAPE.transactions.extractPage(args);
    const bag = CIBUS_SHAPE.providerExtraOf?.(page.items[0]) ?? {};
    expect(bag).toMatchObject({ companyPrice: 40, otlPrice: 22.5 });
  });

  it('tolerates a month the provider answered with no rows', () => {
    const body = { head: { count: 0 }, list: [], code: 0 };
    const args = pageArgs(body);
    const page = CIBUS_SHAPE.transactions.extractPage(args);
    expect(page.items).toEqual([]);
  });

  it('refuses a call the provider refused, rather than calling it an empty month', () => {
    // The failure this exists for: a refusal carries no `list`, so read as a
    // payload it is byte-for-byte a quiet month. The spend it should have
    // carried would then be absent from every total with nothing to see.
    const body = { code: 177 };
    const args = pageArgs(body);
    expect((): unknown => CIBUS_SHAPE.transactions.extractPage(args)).toThrow(/code 177/);
  });

  it('does not report the provider\u2019s own prose about the session', () => {
    // The message accompanying a refusal is the provider talking about the
    // session token. The numeric verdict is enough to act on.
    const body = { code: 177, msg: "Can't find cookie token" };
    const args = pageArgs(body);
    expect((): unknown => CIBUS_SHAPE.transactions.extractPage(args)).not.toThrow(/cookie/);
  });

  it('declares a provider bag, so the shared mapper carries the split', () => {
    // The split silently vanished when it rode `rawTransaction`: that key is
    // present only when the caller sets `includeRawTransaction`, so an ordinary
    // scrape produced rows a consumer read as a violated contract. The employer
    // share is deferred salary and still the household's spend, so losing it is
    // not cosmetic — it is the field the benefit accounting is built on.
    // Exercised through the SHAPE's own hook, which is what the mapper calls.
    // `toTransaction` is not on this path at all — the shared auto-mapper builds
    // the transaction — so asserting against it would prove nothing about a run.
    const row = deal();
    const extra = CIBUS_SHAPE.providerExtraOf?.(row) as { companyPrice?: number; otlPrice?: number };
    expect(extra.companyPrice).toBe(40);
    expect(extra.otlPrice).toBe(22.5);
  });

  it('keeps the provider\u2019s own key names for the split', () => {
    // One schema checks this split, downstream. Renaming a key here moves the
    // place a provider change is noticed away from the check that would catch it.
    const row = deal();
    const bag = CIBUS_SHAPE.providerExtraOf?.(row) ?? {};
    const keys = Object.keys(bag).sort();
    expect(keys).toEqual(['companyPrice', 'otlPrice', 'time']);
  });

  it('reads the balance out of the array the provider wraps it in', () => {
    // `data` is an ARRAY and the current period is its first entry.
    const body = { data: [{ CurrBudget: '412.75', CreatioBudget: '750', ExpirationDate: '' }] };
    const balance = CIBUS_SHAPE.balance.extract(body, CIBUS_ACCOUNT);
    expect(balance).toBe(412.75);
  });

  it('treats an unprovisioned period as zero rather than as a failure', () => {
    // An absent or empty array is the provider saying the period is not
    // provisioned, which is a legitimate state.
    const empty = CIBUS_SHAPE.balance.extract({ data: [] }, CIBUS_ACCOUNT);
    const missing = CIBUS_SHAPE.balance.extract({}, CIBUS_ACCOUNT);
    expect(empty).toBe(0);
    expect(missing).toBe(0);
  });

  it('serves one account without asking the provider for a list', () => {
    const args = noAccountsArgs();
    const accounts = CIBUS_SHAPE.customer.extractAccounts(args);
    const number = CIBUS_SHAPE.accountNumberOf(accounts[0]);
    expect(accounts).toHaveLength(1);
    // A stable synthetic label, never the provider's own card identifier —
    // which the budget payload does carry, and which a consumer does not key on.
    expect(number).toBe('cibus');
    expect(CIBUS_SHAPE.customer.skipFetch).toBe(true);
  });
});
