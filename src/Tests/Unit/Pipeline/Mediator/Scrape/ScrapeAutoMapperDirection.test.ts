/**
 * ScrapeAutoMapper — WK.direction sign-convention tests.
 * Generic: any bank whose API emits DEBIT / CREDIT markers gets the correct sign,
 * whether it spells the direction as a word or reports it as a numeric code.
 * Back-compat: records without a direction field keep their sign unchanged.
 */

import { extractTransactions } from '../../../../../Scrapers/Pipeline/Mediator/Scrape/ScrapeAutoMapper.js';

/** Wrap raw movements into the root-array shape findFirstArray understands. */
interface IWrapArgs {
  readonly movements: readonly Record<string, unknown>[];
}

/**
 * Build an envelope that the mapper will recognise as a transaction array.
 * @param args - The movements array to embed.
 * @returns Envelope shape with a container the mapper can find.
 */
function buildEnvelope(args: IWrapArgs): Record<string, unknown> {
  return { movements: args.movements };
}

/**
 * Build one raw movement record with amount + optional direction.
 * @param amount - Transaction amount.
 * @param direction - Optional direction marker.
 * @returns Raw record.
 */
function buildMovement(amount: number, direction?: string): Record<string, unknown> {
  const base: Record<string, unknown> = {
    movementId: 'm-1',
    movementTimestamp: '2026-01-15T10:00:00',
    movementAmount: amount,
    movementCurrency: 'ILS',
    description: 'demo',
  };
  if (direction !== undefined) base.creditDebit = direction;
  return base;
}

describe('ScrapeAutoMapper/WKDirection', () => {
  it('creditDebit="DEBIT" inverts positive amount to negative', () => {
    const envelope = buildEnvelope({ movements: [buildMovement(150, 'DEBIT')] });
    const txns = extractTransactions(envelope);
    expect(txns.length).toBe(1);
    expect(txns[0].chargedAmount).toBe(-150);
  });

  it('creditDebit="CREDIT" keeps positive amount positive', () => {
    const envelope = buildEnvelope({ movements: [buildMovement(200, 'CREDIT')] });
    const txns = extractTransactions(envelope);
    expect(txns.length).toBe(1);
    expect(txns[0].chargedAmount).toBe(200);
  });

  it('direction="debit" (lowercase) also inverts', () => {
    const envelope = {
      movements: [
        {
          movementId: 'm-2',
          movementTimestamp: '2026-01-15T10:00:00',
          movementAmount: 75,
          direction: 'debit',
        },
      ],
    };
    const txns = extractTransactions(envelope);
    expect(txns.length).toBe(1);
    expect(txns[0].chargedAmount).toBe(-75);
  });

  it('debitCreditIndicator="DEBIT" alias also inverts', () => {
    const envelope = {
      movements: [
        {
          movementId: 'm-3',
          movementTimestamp: '2026-01-15T10:00:00',
          movementAmount: 42,
          debitCreditIndicator: 'DEBIT',
        },
      ],
    };
    const txns = extractTransactions(envelope);
    expect(txns.length).toBe(1);
    expect(txns[0].chargedAmount).toBe(-42);
  });

  it('records without any direction field leave sign unchanged (back-compat)', () => {
    const envelope = buildEnvelope({ movements: [buildMovement(90)] });
    const txns = extractTransactions(envelope);
    expect(txns.length).toBe(1);
    expect(txns[0].chargedAmount).toBe(90);
  });
});

/**
 * Build one raw movement carrying a numeric activity code instead of a word.
 * @param amount - Transaction amount, always a positive magnitude.
 * @param code - Activity code as the bank reports it.
 * @returns Envelope shape with a container the mapper can find.
 */
function buildCodedEnvelope(amount: number, code: unknown): Record<string, unknown> {
  return {
    movements: [
      {
        movementId: 'm-coded',
        movementTimestamp: '2026-01-15T10:00:00',
        movementAmount: amount,
        eventActivityTypeCode: code,
      },
    ],
  };
}

describe('ScrapeAutoMapper/NumericDirection', () => {
  it('outbound code 2 inverts a positive magnitude to negative', () => {
    const envelope = buildCodedEnvelope(320, 2);
    const txns = extractTransactions(envelope);
    expect(txns.length).toBe(1);
    expect(txns[0].chargedAmount).toBe(-320);
  });

  it('inbound code 1 leaves a positive magnitude positive', () => {
    const envelope = buildCodedEnvelope(4500, 1);
    const txns = extractTransactions(envelope);
    expect(txns.length).toBe(1);
    expect(txns[0].chargedAmount).toBe(4500);
  });

  it('an outbound code sent as a string still inverts', () => {
    const envelope = buildCodedEnvelope(85, '2');
    const txns = extractTransactions(envelope);
    expect(txns.length).toBe(1);
    expect(txns[0].chargedAmount).toBe(-85);
  });

  it('an unrelated code leaves the sign unchanged', () => {
    const envelope = buildCodedEnvelope(60, 7);
    const txns = extractTransactions(envelope);
    expect(txns.length).toBe(1);
    expect(txns[0].chargedAmount).toBe(60);
  });

  it('a non-numeric code leaves the sign unchanged', () => {
    const envelope = buildCodedEnvelope(30, 'n/a');
    const txns = extractTransactions(envelope);
    expect(txns.length).toBe(1);
    expect(txns[0].chargedAmount).toBe(30);
  });
});
