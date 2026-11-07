/**
 * Pepper GraphQL query strings — data only.
 * Three operations: customer (UserDataV2), balance (fetchAccountBalance),
 * transactions (Transactions). Registered into WK at module load.
 * The Pepper GraphQL gateway also requires a `queryname` request header
 * matching the operation name — consumed by the scrape shape as extraHeaders.
 */

import { CompanyTypes } from '../../../../../Definitions.js';
import { registerWkQuery } from '../../../Registry/WK/QueriesWK.js';

const HINT = CompanyTypes.Pepper;

const USER_DATA_V2 = `
query UserDataV2 {
  userDataV2 {
    getUserDataV2 {
      customerAndAccounts {
        customerId
        accounts {
          accountId
          accountNumber
          accountCategory
        }
      }
    }
  }
}
`;

const FETCH_ACCOUNT_BALANCE = `
query fetchAccountBalance($accountId: String!) {
  accounts {
    balance(accountId: $accountId) {
      currentBalance
    }
  }
}
`;

// Pepper removed `oshTransactionsNew` (it now returns a downstream HTTP 400);
// the current API exposes `oshTransactionsPagination`, paginated by
// `nextTransactionSerialNumber`. The first page sends only { accountId }.
const TRANSACTIONS = `
query Transactions(
  $accountId: String!
  $nextTransactionSerialNumber: Int
) {
  accounts {
    oshTransactionsPagination(
      accountId: $accountId
      nextTransactionSerialNumber: $nextTransactionSerialNumber
    ) {
      totalCount
      nextTransactionSerialNumber
      transactions {
        transactionId
        transactionSerialNumber
        transactionAmount
        currency
        bookingDate
        effectiveDate
        processingDate
        description
        title
        subTitle
        referenceNumber
        runningBalance
        transactionCategory
        pepperMainTransactionType
        status
        liquidityStatus
      }
      pendingTransactions {
        transactionId
        transactionSerialNumber
        transactionAmount
        currency
        bookingDate
        effectiveDate
        processingDate
        description
        title
        subTitle
        referenceNumber
        runningBalance
        transactionCategory
        pepperMainTransactionType
        status
        liquidityStatus
      }
    }
  }
}
`;

registerWkQuery('customer', HINT, USER_DATA_V2);
registerWkQuery('balance', HINT, FETCH_ACCOUNT_BALANCE);
registerWkQuery('transactions', HINT, TRANSACTIONS);

export { FETCH_ACCOUNT_BALANCE, TRANSACTIONS, USER_DATA_V2 };
