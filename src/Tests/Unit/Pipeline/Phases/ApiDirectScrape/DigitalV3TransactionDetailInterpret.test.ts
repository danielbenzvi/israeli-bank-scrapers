/**
 * DigitalV3 detail interpretation (Isracard and Amex share this backbone).
 *
 * The costly mistakes here are both silent: claiming a counterparty name that
 * is really a wallet label (which would be written into a transaction's
 * display name), and recording "succeeded, nothing useful" so the same
 * transaction is re-requested on every future run against a rate-limited,
 * WAF-protected endpoint.
 *
 * Field names and shapes only; no real values.
 */

import {
  classifyDetailTransport,
  DIGITALV3_DETAIL_SCHEMA_VERSION,
  interpretDetailEnvelope,
} from '../../../../../Scrapers/Pipeline/Phases/ApiDirectScrape/DigitalV3/TransactionDetailInterpret.js';

/**
 *
 * @param data
 */
const envelope = (data: Record<string, unknown>) => ({ isSuccess: true, data });

describe('interpretDetailEnvelope', () => {
  it('rejects a body that is not a success envelope', () => {
    for (const bad of [null, undefined, 'text', 42, {}, { isSuccess: false, data: {} }, { isSuccess: true }]) {
      const outcome = interpretDetailEnvelope(bad);
      expect(outcome.state).toBe('schema-mismatch');
      expect(outcome.outcomeCode).toBe('shape-mismatch');
    }
  });

  it('extracts the issuer category for an ordinary merchant', () => {
    const outcome = interpretDetailEnvelope(envelope({ businessName: 'MERCHANT', branchDescription: ' CATEGORY  NAME ' }));
    expect(outcome.state).toBe('succeeded');
    expect(outcome.sourceCategory).toBe('CATEGORY NAME');
    expect(outcome.detailKind).toBe('issuer-category');
    expect(outcome.counterpartyDisplayName).toBeUndefined();
  });

  it('records a parsed-but-useless response as terminal, not successful', () => {
    // The re-request trap: marking this a success with empty fields would leave
    // the caller unable to tell it apart from "not asked yet", so it would ask
    // again every run, forever.
    const outcome = interpretDetailEnvelope(envelope({ businessName: 'MERCHANT' }));
    expect(outcome.state).toBe('terminal-failure');
    expect(outcome.outcomeCode).toBe('empty-useful-detail');
  });

  it('extracts the counterparty name for a wallet transfer', () => {
    const outcome = interpretDetailEnvelope(envelope({ businessName: 'BIT', transferBeneficiary: '  SOME  NAME ' }));
    expect(outcome.state).toBe('succeeded');
    expect(outcome.counterpartyDisplayName).toBe('SOME NAME');
  });

  it('needs BOTH the wallet label and a counterparty field', () => {
    // The label alone appears on rows carrying no name; treating those as
    // transfers would claim a name that does not exist.
    const outcome = interpretDetailEnvelope(envelope({ businessName: 'BIT', branchDescription: 'CATEGORY' }));
    expect(outcome.counterpartyDisplayName).toBeUndefined();
    expect(outcome.detailKind).toBe('issuer-category');
  });

  it('refuses a counterparty name that is itself the wallet label', () => {
    // Carries no more information than the row already had.
    const outcome = interpretDetailEnvelope(envelope({ businessName: 'BIT', transferBeneficiary: 'BIT' }));
    expect(outcome.state).toBe('terminal-failure');
    expect(outcome.counterpartyDisplayName).toBeUndefined();
  });

  it('refuses an implausibly long counterparty name', () => {
    const outcome = interpretDetailEnvelope(
      envelope({ businessName: 'BIT', transferBeneficiary: 'x'.repeat(161) }),
    );
    expect(outcome.state).toBe('terminal-failure');
  });

  it('keeps only whitelisted detail fields', () => {
    const outcome = interpretDetailEnvelope(
      envelope({ businessName: 'M', branchDescription: 'C', countryCode: 'IL', somethingElse: 'dropped' }),
    );
    expect(outcome.detailPayload).toEqual({ branchDescription: 'C', countryCode: 'IL' });
    expect(outcome.detailPayload).not.toHaveProperty('somethingElse');
  });

  it('stamps the schema version on every outcome', () => {
    for (const body of [null, envelope({ businessName: 'M' }), envelope({ businessName: 'M', branchDescription: 'C' })]) {
      expect(interpretDetailEnvelope(body).detailSchemaVersion).toBe(DIGITALV3_DETAIL_SCHEMA_VERSION);
    }
  });
});

describe('classifyDetailTransport', () => {
  const ok = { status: 200, contentType: 'application/json', redirected: false, sameOrigin: true };

  it('passes a clean JSON response through for interpretation', () => {
    expect(classifyDetailTransport(ok)).toBeUndefined();
  });

  it('stops the pass on throttling', () => {
    const verdict = classifyDetailTransport({ ...ok, status: 429 });
    expect(verdict?.code).toBe('throttled');
    expect(verdict?.stopPass).toBe(true);
  });

  it('stops the pass on an expired session, however it presents', () => {
    // All four shapes mean the same thing operationally, and continuing would
    // spend the remaining budget on requests that cannot succeed.
    for (const meta of [
      { ...ok, status: 401 },
      { ...ok, status: 403 },
      { ...ok, redirected: true },
      { ...ok, sameOrigin: false },
      { ...ok, contentType: 'text/html' },
    ]) {
      const verdict = classifyDetailTransport(meta);
      expect(verdict?.code).toBe('auth-expired');
      expect(verdict?.stopPass).toBe(true);
    }
  });

  it('treats a server error as retryable without stopping the pass', () => {
    const verdict = classifyDetailTransport({ ...ok, status: 503 });
    expect(verdict?.state).toBe('retryable-failure');
    expect(verdict?.stopPass).toBe(false);
  });

  it('treats a request that never landed as retryable', () => {
    expect(classifyDetailTransport(undefined)?.state).toBe('retryable-failure');
  });
});
