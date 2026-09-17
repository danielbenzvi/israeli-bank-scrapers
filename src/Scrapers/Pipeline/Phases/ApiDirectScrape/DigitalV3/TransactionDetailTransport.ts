/**
 * DigitalV3 transaction-details enrichment — transport-level classification.
 *
 * Judges a response by its transport facts alone, before its body is read.
 * Separate from the envelope interpretation because the two answer different
 * questions: this one decides whether a body is worth reading at all, and
 * whether the whole pass should stop; that one decides what a readable body
 * actually said.
 */

import type { DetailOutcomeCode, DetailState } from './TransactionDetailInterpret.js';

/** Transport facts needed to judge whether a response is worth interpreting. */
export interface IDetailTransport {
  readonly status: number;
  readonly contentType: string;
  readonly redirected: boolean;
  readonly sameOrigin: boolean;
}

/** A transport-level verdict: what went wrong, and whether the pass can go on. */
export interface IDetailTransportVerdict {
  readonly code: DetailOutcomeCode;
  readonly state: DetailState;
  readonly stopPass: boolean;
}

/** The state shared by every verdict a retry could not improve on. */
const TERMINAL_STATE: DetailState = 'terminal-failure';

/**
 * Bounced somewhere other than the endpoint we asked — an expired session, in
 * effect, whatever the status line says.
 */
const BOUNCED: IDetailTransportVerdict = {
  code: 'auth-expired',
  state: TERMINAL_STATE,
  stopPass: true,
};

/** The endpoint is rate-limiting us; spending the rest of the budget cannot help. */
const THROTTLED: IDetailTransportVerdict = {
  code: 'throttled',
  state: TERMINAL_STATE,
  stopPass: true,
};

/** The request may well succeed if asked again later. */
const TRANSIENT: IDetailTransportVerdict = {
  code: 'transient-failure',
  state: 'retryable-failure',
  stopPass: false,
};

/**
 * True when the answer did not come from the endpoint that was asked.
 *
 * A redirect, a cross-origin answer, or a non-JSON content type all mean the
 * same thing in practice: something in front of the API answered instead of
 * the API, and the body is a login page or a challenge rather than detail.
 * @param meta - Transport metadata for the response.
 * @returns True when the response should be treated as a bounce.
 */
function wasBounced(meta: IDetailTransport): boolean {
  if (meta.redirected || !meta.sameOrigin) return true;
  const contentType = meta.contentType.toLowerCase();
  return !contentType.includes('application/json');
}

/**
 * True when a status says the request might succeed if repeated.
 * @param status - HTTP status of the response.
 * @returns True for 5xx and for any non-2xx not already classified.
 */
function isRetryableStatus(status: number): boolean {
  if (status >= 500) return true;
  return status < 200 || status >= 300;
}

/**
 * Classify a response by its transport facts alone, before its body is read.
 *
 * Returns `false` when the response is worth interpreting. Otherwise it names
 * the failure — and whether it should stop the whole enrichment pass.
 *
 * Auth expiry and throttling stop the pass: continuing would spend the
 * remaining budget on requests that cannot succeed, against an endpoint behind
 * the same protections as login.
 *
 * @param meta - Transport metadata, or `false` when the request never landed.
 * @returns The failure classification, or `false` when the body is usable.
 */
export function classifyDetailTransport(
  meta: IDetailTransport | false,
): IDetailTransportVerdict | false {
  if (meta === false) return TRANSIENT;
  if (meta.status === 429) return THROTTLED;
  if (meta.status === 401 || meta.status === 403) return BOUNCED;
  if (wasBounced(meta)) return BOUNCED;
  if (isRetryableStatus(meta.status)) return TRANSIENT;
  return false;
}
