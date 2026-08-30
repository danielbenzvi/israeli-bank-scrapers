/**
 * DigitalV3 transaction-details enrichment — the pass over one page of rows.
 *
 * Shared by Isracard and Amex, which are one company on one API backbone,
 * differing only by domain.
 *
 * Joins the pure pieces: `nextDetailRequest` decides whether a request fits,
 * `classifyDetailTransport` judges the response before its body is read, and
 * `interpretDetailEnvelope` says what was learned. One request, and the
 * identity it is made under, live in `TransactionDetailRequest`. This file owns
 * only the sequencing.
 *
 * Every row comes back, always. A row whose detail could not be fetched is
 * returned unchanged, or carrying an outcome describing why — never dropped.
 * The enrichment is an addition to a scrape, and must not be able to subtract
 * from it.
 */

import { nextDetailRequest } from './TransactionDetailBudget.js';
import {
  canonicalCardId,
  CARD_SUFFIX,
  detailBody,
  fetchOneDetail,
  fingerprint,
  notAttempted,
  voucherOf,
  withOutcome,
} from './TransactionDetailRequest.js';
import type { AmexRow, ICardDetailDeps } from './TransactionDetailTypes.js';

export type {
  AmexRow,
  ICardAlias,
  ICardDetailDeps,
  ICardDetailOptions,
  IDetailAccount,
  IDetailIdentityContext,
} from './TransactionDetailTypes.js';

/** Resolved once for the whole pass, then read for every row. */
interface IPassContext {
  readonly deps: ICardDetailDeps;
  readonly cardSuffix: string;
  readonly companyCode: number;
  readonly canonical: string | false;
  readonly seen: ReadonlySet<string>;
  readonly blocked: ReadonlySet<string>;
  readonly startedAt: number;
}

/** How far the pass has got: rows emitted, requests spent, whether to stop. */
interface IPassState {
  readonly out: readonly AmexRow[];
  readonly calls: number;
  readonly isStopped: boolean;
}

/**
 * Record a row as never asked about.
 * @param raw - The row as the provider returned it.
 * @returns The row carrying a not-found outcome.
 */
function markUnfetchable(raw: AmexRow): AmexRow {
  const outcome = notAttempted('not-found');
  return withOutcome(raw, outcome);
}

/**
 * Emit a row without spending a request on it.
 * @param state - The pass state so far.
 * @param row - The row to emit, already carrying any outcome it earned.
 * @returns The state with that row appended.
 */
function emit(state: IPassState, row: AmexRow): IPassState {
  return { ...state, out: [...state.out, row] };
}

/**
 * True when this row's detail is already held, or known to be unproductive.
 *
 * A blocked fingerprint is always skipped; a merely-seen one is skipped unless
 * the caller asked for a backfill, which is the only mode that re-asks.
 * @param ctx - Pass context.
 * @param rowFingerprint - This row's identity fingerprint.
 * @returns True when the row should be returned untouched.
 */
function isAlreadyKnown(ctx: IPassContext, rowFingerprint: string): boolean {
  if (ctx.blocked.has(rowFingerprint)) return true;
  if (ctx.deps.options.backfillEnabled) return false;
  return ctx.seen.has(rowFingerprint);
}

/** One row and the voucher that identifies it to the detail endpoint. */
interface IRowTarget {
  readonly row: AmexRow;
  readonly voucher: string;
}

/**
 * Ask the budget whether one more request fits, at this point in the pass.
 * @param ctx - Pass context.
 * @param state - The pass state so far.
 * @returns Whether to proceed, and the delay to wait first.
 */
function decideNextRequest(
  ctx: IPassContext,
  state: IPassState,
): ReturnType<typeof nextDetailRequest> {
  const elapsedMs = ctx.deps.now() - ctx.startedAt;
  const jitter = ctx.deps.jitter();
  return nextDetailRequest(ctx.deps.options, { callsMade: state.calls, elapsedMs, jitter });
}

/**
 * The request body for one target row.
 * @param ctx - Pass context, carrying the card identity.
 * @param target - The row and its voucher.
 * @returns The POST body.
 */
function buildBody(ctx: IPassContext, target: IRowTarget): Record<string, unknown> {
  const identity = {
    cardSuffix: ctx.cardSuffix,
    companyCode: ctx.companyCode,
    voucher: target.voucher,
  };
  return detailBody(target.row, identity);
}

/**
 * Return a row the budget could not pay for, untouched.
 *
 * Only a wall-clock exhaustion stops the pass: a per-pass call ceiling is
 * reached in order, so later rows would fail the same check anyway, whereas an
 * expired clock means nothing further can be attempted at all.
 * @param state - The pass state so far.
 * @param row - The row that could not be requested.
 * @param reason - Which limit was reached.
 * @returns The state with the row appended, stopped if the clock ran out.
 */
function outOfBudget(state: IPassState, row: AmexRow, reason: 'row-limit' | 'wall-clock'): IPassState {
  const isStopped = state.isStopped || reason === 'wall-clock';
  return { ...emit(state, row), isStopped };
}

/**
 * Request one row's detail, having decided it is worth asking about.
 *
 * Running out of budget is not a failure of this row — it is simply where the
 * pass ran out, so the row is returned untouched and remains eligible next
 * time. Only a wall-clock exhaustion stops the pass: a per-pass call ceiling
 * is reached in order, so later rows would fail the same check anyway.
 * @param ctx - Pass context.
 * @param state - The pass state so far.
 * @param target - The row to enrich and the voucher identifying it.
 * @returns The state after this row.
 */
async function requestRow(
  ctx: IPassContext,
  state: IPassState,
  target: IRowTarget,
): Promise<IPassState> {
  const { deps } = ctx;
  const verdict = decideNextRequest(ctx, state);
  if (!verdict.proceed) return outOfBudget(state, target.row, verdict.reason);
  if (verdict.delayMs > 0) await deps.sleep(verdict.delayMs);
  const body = buildBody(ctx, target);
  const attempt = await fetchOneDetail(deps, body, ctx.startedAt);
  const enriched = withOutcome(target.row, attempt.outcome);
  const next = emit({ ...state, calls: state.calls + 1 }, enriched);
  return { ...next, isStopped: state.isStopped || attempt.stopPass };
}

/**
 * This row's identity fingerprint, under the caller's key.
 * @param ctx - Pass context, carrying the key.
 * @param canonical - The caller's canonical id for this card.
 * @param voucher - The voucher identifying this transaction.
 * @returns The fingerprint to check against what the caller already holds.
 */
function rowKeyOf(ctx: IPassContext, canonical: string, voucher: string): string {
  const hmacKey = ctx.deps.options.hmacKey ?? '';
  return fingerprint(hmacKey, [canonical, 'voucher', voucher]);
}

/**
 * Advance the pass by one row.
 *
 * A row with no voucher is recorded as unfetchable even once the pass has
 * stopped, so "we never asked" stays distinguishable from "we asked and learned
 * nothing" for every row in the page.
 * @param ctx - Pass context.
 * @param state - The pass state so far.
 * @param row - The row to consider.
 * @returns The state after this row.
 */
async function stepRow(ctx: IPassContext, state: IPassState, row: AmexRow): Promise<IPassState> {
  const voucher = voucherOf(row);
  if (voucher === false) {
    const unfetchable = markUnfetchable(row);
    return emit(state, unfetchable);
  }
  const canonical = ctx.canonical;
  if (state.isStopped || canonical === false) return emit(state, row);
  const rowFingerprint = rowKeyOf(ctx, canonical, voucher);
  if (isAlreadyKnown(ctx, rowFingerprint)) return emit(state, row);
  return requestRow(ctx, state, { row, voucher });
}

/**
 * Walk the page one row at a time.
 *
 * Sequential by construction: the rows share a wall-clock budget and a paced
 * request rate, so they cannot be issued concurrently. Expressed as a reduce
 * over a promise chain rather than a `for await`, which is the shape the
 * pipeline uses elsewhere for the same reason.
 * @param ctx - Pass context.
 * @param rows - The page as extracted from the transactions response.
 * @returns The final pass state.
 */
async function walkRows(ctx: IPassContext, rows: readonly AmexRow[]): Promise<IPassState> {
  const seed: IPassState = { out: [], calls: 0, isStopped: false };
  const start: Promise<IPassState> = Promise.resolve(seed);
  return rows.reduce(async (prev, row): Promise<IPassState> => {
    const state = await prev;
    return stepRow(ctx, state, row);
  }, start);
}

/**
 * Resolve everything the walk needs that does not change between rows.
 * @param deps - Injected collaborators.
 * @param cardSuffix - Four-digit suffix of the card being scraped.
 * @param companyCode - The issuer's numeric company code.
 * @returns The pass context.
 */
function buildPassContext(
  deps: ICardDetailDeps,
  cardSuffix: string,
  companyCode: number,
): IPassContext {
  return {
    deps,
    cardSuffix,
    companyCode,
    canonical: canonicalCardId(deps.options, cardSuffix),
    seen: new Set(deps.options.existingFingerprints ?? []),
    blocked: new Set(deps.options.blockedFingerprints ?? []),
    startedAt: deps.now(),
  };
}

/**
 * Enrich a page of card rows with per-transaction detail.
 *
 * Without a usable card identity there is nothing to ask about. That is
 * recorded on every row rather than skipped silently, so "we never asked" is
 * distinguishable from "we asked and learned nothing".
 * @param rows - Rows as extracted from the transactions response.
 * @param deps - Injected collaborators.
 * @returns The same rows, in the same order, some carrying an outcome.
 */
export async function enrichCardDetail(
  rows: readonly AmexRow[],
  deps: ICardDetailDeps,
): Promise<readonly AmexRow[]> {
  const { options, account } = deps;
  if (!options.enabled || options.hmacKey === undefined) return rows;
  const cardSuffix = account.cardSuffix ?? '';
  const companyCode = Number(account.companyCode);
  const isUsableCard = CARD_SUFFIX.test(cardSuffix) && Number.isFinite(companyCode);
  if (!isUsableCard) return rows.map(markUnfetchable);
  const ctx = buildPassContext(deps, cardSuffix, companyCode);
  const finished = await walkRows(ctx, rows);
  return finished.out;
}
