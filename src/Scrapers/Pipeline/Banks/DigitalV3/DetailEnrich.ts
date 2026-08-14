/**
 * DigitalV3 per-transaction detail — the request loop.
 *
 * Shared by Isracard and Amex, which are one company on one API backbone,
 * differing only by domain.
 *
 * Joins the three pure pieces: {@link nextDetailRequest} decides whether a
 * request fits, {@link classifyDetailTransport} judges the response before its
 * body is read, and {@link interpretDetailEnvelope} says what was learned.
 * This file owns only the sequencing and the identity fingerprints.
 *
 * Every row comes back, always. A row whose detail could not be fetched is
 * returned unchanged, or carrying an outcome describing why — never dropped.
 * The enrichment is an addition to a scrape, and must not be able to subtract
 * from it.
 */

import { createHmac } from 'node:crypto';

import type { Procedure } from '../../Types/Procedure.js';
import { isOk } from '../../Types/Procedure.js';
import type { IPostWithMetadata } from '../../Strategy/Fetch/FetchStrategy.js';
import {
  AMEX_DETAIL_SCHEMA_VERSION,
  classifyDetailTransport,
  type IDetailOutcome,
  interpretDetailEnvelope,
} from './DetailInterpret.js';
import {
  type IDetailBudgetLimits,
  nextDetailRequest,
  retryFits,
} from './DetailBudget.js';

/** Identity of the account being scraped, for deriving stable fingerprints. */
export interface IDetailIdentityContext {
  readonly owner: string;
  readonly provider: string;
  readonly credentialSetId: string;
}

/** Maps an observed account fingerprint onto the caller's canonical card id. */
export interface ICardAlias {
  readonly observedAccountFingerprint: string;
  readonly canonicalCardId: string;
}

/** Everything the enrichment pass needs from its caller. */
export interface ICardDetailOptions extends IDetailBudgetLimits {
  readonly enabled: boolean;
  /** When true, re-fetch detail the caller already holds. */
  readonly backfillEnabled: boolean;
  /** Key for the identity fingerprints. Absent disables enrichment entirely. */
  readonly hmacKey?: string;
  readonly identityContext?: IDetailIdentityContext;
  readonly cardAliases?: readonly ICardAlias[];
  /** Fingerprints already stored — skipped unless backfilling. */
  readonly existingFingerprints?: readonly string[];
  /** Fingerprints known to be unproductive — always skipped. */
  readonly blockedFingerprints?: readonly string[];
}

/** The card being enriched, as the scrape knows it. */
export interface IDetailAccount {
  readonly cardSuffix?: string;
  readonly companyCode?: number | string;
}

/** Collaborators, injected so the loop is testable without a browser. */
export interface ICardDetailDeps {
  readonly post: (body: Record<string, unknown>, timeoutMs: number) => Promise<Procedure<IPostWithMetadata>>;
  readonly options: ICardDetailOptions;
  readonly account: IDetailAccount;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  /** Value in [0, 1) selecting a pacing delay within the configured range. */
  readonly jitter: () => number;
}

/** A raw Amex row, plus the outcome once a detail attempt has been made. */
type AmexRow = Record<string, unknown>;

/** Field separator for fingerprint inputs — outside the character set of every part. */
const FIELD_SEPARATOR = '';

/** A four-digit card suffix, the only shape the detail endpoint accepts. */
const CARD_SUFFIX = /^\d{4}$/;

/** Attach an outcome without disturbing any provider field. */
function withOutcome(raw: AmexRow, outcome: IDetailOutcome): AmexRow {
  return { ...raw, __detailOutcome: outcome };
}

/** An outcome for a row that was never requested. */
function notAttempted(code: IDetailOutcome['outcomeCode']): IDetailOutcome {
  return {
    state: 'terminal-failure',
    outcomeCode: code,
    detailSchemaVersion: AMEX_DETAIL_SCHEMA_VERSION,
    attemptCount: 0,
  };
}

/**
 * Stable fingerprint over the given parts.
 *
 * Keyed, so a fingerprint is meaningless without the caller's secret and
 * cannot be recomputed from a stored value.
 *
 * @param key - HMAC key.
 * @param parts - Ordered inputs.
 * @returns Hex digest.
 */
function fingerprint(key: string, parts: readonly string[]): string {
  return createHmac('sha256', key).update(parts.join(FIELD_SEPARATOR)).digest('hex');
}

/**
 * Resolve the caller's canonical id for this card, via its alias table.
 *
 * Requires EXACTLY one matching alias. Zero means the caller does not know this
 * card; more than one means its mapping is ambiguous, and guessing would attach
 * one card's detail to another's history.
 *
 * @param options - Pass options carrying the key and alias table.
 * @param cardSuffix - Four-digit suffix of the card being scraped.
 * @returns The canonical id, or undefined when it cannot be resolved uniquely.
 */
function canonicalCardId(options: ICardDetailOptions, cardSuffix: string): string | undefined {
  const { hmacKey, identityContext } = options;
  if (hmacKey === undefined || identityContext === undefined) return undefined;
  const observed = fingerprint(hmacKey, [
    identityContext.owner,
    identityContext.provider,
    identityContext.credentialSetId,
    cardSuffix,
  ]);
  const matches = (options.cardAliases ?? []).filter(
    (alias): boolean => alias.observedAccountFingerprint === observed,
  );
  return matches.length === 1 ? matches[0]?.canonicalCardId : undefined;
}

/** The voucher number identifying one transaction, when it has a usable one. */
function voucherOf(raw: AmexRow): string | undefined {
  const value = raw['seqVoucherNumber'] ?? raw['voucherNumber'];
  const text = String(value ?? '');
  return /^\d+$/.test(text) ? text : undefined;
}

/** Request body for one transaction's detail. */
function detailBody(raw: AmexRow, cardSuffix: string, companyCode: number, voucher: string): Record<string, unknown> {
  return {
    cardSuffix,
    companyCode,
    isIsraelDeal: raw['isIsraelDeal'] !== false,
    seqVoucherNumber: voucher,
    isPartner: raw['isPartner'] === true,
  };
}

/**
 * Fetch and interpret one transaction's detail, with a single bounded retry.
 *
 * @param deps - Injected collaborators.
 * @param body - Request body for this transaction.
 * @param startedAt - When the pass began, for the retry budget.
 * @returns The outcome, and whether the pass should stop.
 */
async function fetchOneDetail(
  deps: ICardDetailDeps,
  body: Record<string, unknown>,
  startedAt: number,
): Promise<{ outcome: IDetailOutcome; stopPass: boolean }> {
  const { options } = deps;
  let attempt = await deps.post(body, options.timeoutMs);

  // A transport-level failure (the request never landed) is retried once, but
  // only if a full delay plus another timeout still fit — otherwise the pass
  // ends holding a session it can no longer use.
  if (!isOk(attempt)) {
    if (!retryFits(options, deps.now() - startedAt)) {
      return { outcome: { ...notAttempted('transient-failure'), state: 'retryable-failure', attemptCount: 1 }, stopPass: true };
    }
    await deps.sleep(options.minDelayMs);
    attempt = await deps.post(body, options.timeoutMs);
    if (!isOk(attempt)) {
      return { outcome: { ...notAttempted('transient-failure'), state: 'retryable-failure', attemptCount: 2 }, stopPass: false };
    }
  }

  const verdict = classifyDetailTransport(attempt.value.http);
  if (verdict !== undefined) {
    return {
      outcome: {
        state: verdict.state,
        outcomeCode: verdict.code,
        detailSchemaVersion: AMEX_DETAIL_SCHEMA_VERSION,
        attemptCount: 1,
      },
      stopPass: verdict.stopPass,
    };
  }

  const outcome = interpretDetailEnvelope(attempt.value.envelope);
  // A shape mismatch means the response no longer looks like what this code
  // understands. Continuing would spend the budget re-learning that on every
  // remaining row.
  return { outcome, stopPass: outcome.state === 'schema-mismatch' };
}

/**
 * Enrich a page of Amex rows with per-transaction detail.
 *
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

  const cardSuffix = String(account.cardSuffix ?? '');
  const companyCode = Number(account.companyCode);
  // Without a usable card identity there is nothing to ask about. Recorded on
  // every row rather than skipped silently, so "we never asked" is
  // distinguishable from "we asked and learned nothing".
  if (!CARD_SUFFIX.test(cardSuffix) || !Number.isFinite(companyCode)) {
    return rows.map((raw): AmexRow => withOutcome(raw, notAttempted('not-found')));
  }
  const canonical = canonicalCardId(options, cardSuffix);

  const existing = new Set(options.existingFingerprints ?? []);
  const blocked = new Set(options.blockedFingerprints ?? []);
  const startedAt = deps.now();
  const out: AmexRow[] = [];
  let calls = 0;
  let stopped = false;

  for (const raw of rows) {
    const voucher = voucherOf(raw);
    if (stopped || voucher === undefined || canonical === undefined) {
      out.push(voucher === undefined ? withOutcome(raw, notAttempted('not-found')) : raw);
      continue;
    }

    const rowFingerprint = fingerprint(options.hmacKey, [canonical, 'voucher', voucher]);
    if (blocked.has(rowFingerprint) || (!options.backfillEnabled && existing.has(rowFingerprint))) {
      out.push(raw);
      continue;
    }

    const verdict = nextDetailRequest(options, calls, deps.now() - startedAt, deps.jitter());
    if (!verdict.proceed) {
      // Out of budget is not a failure of this row — it is simply where the
      // pass ran out, so the row is returned untouched and remains eligible
      // next time.
      stopped = verdict.reason === 'wall-clock';
      out.push(raw);
      continue;
    }
    if (verdict.delayMs > 0) await deps.sleep(verdict.delayMs);

    calls += 1;
    const result = await fetchOneDetail(deps, detailBody(raw, cardSuffix, companyCode, voucher), startedAt);
    if (result.stopPass) stopped = true;
    out.push(withOutcome(raw, result.outcome));
  }

  return out;
}
