export interface ITransactionsAccount {
  accountNumber: string;
  balance?: number;
  /**
   * Provider-specific structured values with no home in the common account
   * shape — e.g. a benefit allowance and the date it expires, neither of which
   * is the quantity `balance` names and neither of which may be flattened into
   * it.
   *
   * Opaque to this library: nothing here reads or validates it, and a consumer
   * is expected to re-type it at its own boundary.
   *
   * DATA, NEVER CREDENTIALS. This rides the scraping result, which callers
   * routinely persist and log. Session tokens, cookies and one-time codes
   * belong on `ScraperOptions.onAuthFlowComplete` — a separate channel, for
   * exactly this reason.
   */
  providerExtra?: Readonly<Record<string, unknown>>;
  txns: ITransaction[];
}

export enum TransactionTypes {
  Normal = 'normal',
  Installments = 'installments',
}

export enum TransactionStatuses {
  Completed = 'completed',
  Pending = 'pending',
}

export interface ITransactionInstallments {
  /**
   * the current installment number
   */
  number: number;

  /**
   * the total number of installments
   */
  total: number;
}

export interface ITransaction {
  type: TransactionTypes;
  /**
   * sometimes called Asmachta
   */
  identifier?: string | number;
  /**
   * ISO date string
   */
  date: string;
  /**
   * ISO date string
   */
  processedDate: string;
  originalAmount: number;
  originalCurrency: string;
  chargedAmount: number;
  chargedCurrency?: string;
  description: string;
  memo?: string;
  status: TransactionStatuses;
  installments?: ITransactionInstallments;
  category?: string;
  rawTransaction?: unknown;
  /**
   * Provider-specific structured values with no home in the common transaction
   * shape — e.g. a benefit purchase's split between employer-funded and
   * out-of-pocket amounts, where `chargedAmount` alone cannot express who paid
   * what.
   *
   * Same contract as {@link ITransactionsAccount.providerExtra}: opaque here,
   * re-typed by the consumer, and **data only — never credentials**.
   */
  providerExtra?: Readonly<Record<string, unknown>>;
}
