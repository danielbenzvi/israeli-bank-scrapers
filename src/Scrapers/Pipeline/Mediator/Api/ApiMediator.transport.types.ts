/**
 * ApiMediator transport arg bundles.
 *
 * The three `fire*` helpers each take more collaborators than the repository's
 * 3-parameter ceiling allows, so each takes one bundle instead. They live here
 * rather than beside the mediator's own types for the same reason the headless
 * types do: to keep `ApiMediator.types.ts` within its 150-LoC budget.
 */

import type { IApiMediatorDeps } from './ApiMediator.types.js';

/** Args for firePost — bundled to satisfy the 3-parameter ceiling. */
interface IFirePostArgs {
  readonly deps: IApiMediatorDeps;
  readonly url: string;
  readonly body: Record<string, unknown>;
  readonly rawAuth: string;
  readonly extraHeaders: Record<string, string>;
  readonly query: Record<string, string>;
  readonly onSetCookie?: (setCookies: readonly string[]) => number;
  readonly timeoutMs?: number;
  readonly firstPartyContract?: boolean;
}

/** Args for fireGet — bundled so extraHeaders (HMAC) fit the 3-param ceiling. */
interface IFireGetArgs {
  readonly deps: IApiMediatorDeps;
  readonly url: string;
  readonly rawAuth: string;
  readonly extraHeaders: Record<string, string>;
}

/** Args for fireQuery — bundled to satisfy the 3-parameter ceiling. */
interface IFireQueryArgs {
  readonly deps: IApiMediatorDeps;
  readonly queryString: string;
  readonly variables: Record<string, unknown>;
  readonly rawAuth: string;
  readonly extraHeaders: Record<string, string>;
}

export type { IFireGetArgs, IFirePostArgs, IFireQueryArgs };
