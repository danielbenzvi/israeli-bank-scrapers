/**
 * DigitalV3 transaction-details enrichment — the contract between its parts.
 *
 * Shared by the request module and the pass that sequences it. Kept apart from
 * both so neither has to import the other for a type, which would put a cycle
 * through modules that otherwise depend in one direction only.
 */

import type { IPostWithMetadata } from '../../../Strategy/Fetch/FetchStrategy.js';
import type { Procedure } from '../../../Types/Procedure.js';
import type { IDetailBudgetLimits } from './TransactionDetailBudget.js';

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
  readonly post: (
    body: Record<string, unknown>,
    timeoutMs: number,
  ) => Promise<Procedure<IPostWithMetadata>>;
  readonly options: ICardDetailOptions;
  readonly account: IDetailAccount;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  /** Value in [0, 1) selecting a pacing delay within the configured range. */
  readonly jitter: () => number;
}

/** A raw Amex row, plus the outcome once a detail attempt has been made. */
export type AmexRow = Record<string, unknown>;
