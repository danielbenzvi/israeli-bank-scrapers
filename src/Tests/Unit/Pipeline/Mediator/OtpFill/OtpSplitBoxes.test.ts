/**
 * Split OTP code fields — per-digit boxes.
 *
 * Why this path exists at all is the thing worth remembering: `fillInput`
 * already re-types a whole code as keypresses and relies on the component to
 * advance focus. Measured against a real provider, that left boxes 1..5
 * `ng-pristine` and the submit disabled — the auto-advance never happened.
 * Addressing each box removes that dependency.
 */

import {
  fillSplitBoxes,
  type IFillSplitArgs,
  type IOtpBoxWriter,
  OTP_SPLIT_BOXES_KEY,
  readSplitBoxes,
} from '../../../../../Scrapers/Pipeline/Mediator/OtpFill/OtpSplitBoxes.js';
import type {
  IDiagnosticsState,
  IResolvedTarget,
} from '../../../../../Scrapers/Pipeline/Types/PipelineContext.js';

/** One recorded write. */
interface IWrite {
  readonly selector: string;
  readonly value: string;
}

/** A writer that records rather than drives a page. */
interface IRecordingWriter extends IOtpBoxWriter {
  readonly writes: IWrite[];
}

/**
 * A resolved target standing for one code box.
 * @param index - Position in the field.
 * @returns A target.
 */
function box(index: number): IResolvedTarget {
  return {
    selector: `box-${String(index)}`,
    contextId: 'main',
    kind: 'xpath',
    candidateValue: `(//input[@maxlength="1"])[${String(index + 1)}]`,
  };
}

/**
 * Build a writer that records every fill instead of performing one.
 *
 * Implements {@link IOtpBoxWriter} outright rather than casting a partial
 * mediator — the interface is one method wide precisely so this is possible.
 * @returns A recording writer.
 */
function recordingWriter(): IRecordingWriter {
  const writes: IWrite[] = [];
  return {
    writes,
    /**
     * Records a write instead of driving a page.
     * @param _contextId - Unused; the recorder has no frames.
     * @param selector - Where the write was aimed.
     * @param value - What was written.
     * @returns True, as the real mediator does.
     */
    fillInput: (_contextId: string, selector: string, value: string): Promise<true> => {
      writes.push({ selector, value });
      return Promise.resolve(true);
    },
  };
}

/**
 * Fill arguments over a recording writer.
 * @param writer - The recording writer.
 * @param count - How many boxes the field has.
 * @param code - The code to write.
 * @returns Arguments for {@link fillSplitBoxes}.
 */
function fillArgs(writer: IRecordingWriter, count: number, code: string): IFillSplitArgs {
  const boxes = Array.from({ length: count }, (_unused, index): IResolvedTarget => box(index));
  return { executor: writer, boxes, code };
}

describe('split OTP field — filling', () => {
  it('puts one character in each box, in code order', async () => {
    const writer = recordingWriter();
    const args = fillArgs(writer, 6, '912371');
    await fillSplitBoxes(args);
    const values = writer.writes.map((w): string => w.value);
    expect(values).toEqual(['9', '1', '2', '3', '7', '1']);
  });

  it('addresses every box, not just the first', async () => {
    // The whole point. Writing only the first box and trusting auto-advance is
    // exactly the behaviour that left the rest pristine and the submit dead.
    const writer = recordingWriter();
    const args = fillArgs(writer, 6, '912371');
    await fillSplitBoxes(args);
    expect(writer.writes).toHaveLength(6);
  });

  it('writes strictly left to right', async () => {
    const writer = recordingWriter();
    const args = fillArgs(writer, 3, '123');
    await fillSplitBoxes(args);
    const order = writer.writes.map((w): string => w.selector);
    expect(order).toEqual(['box-0', 'box-1', 'box-2']);
  });

  it('writes an empty character rather than undefined when the code is short', async () => {
    const writer = recordingWriter();
    const args = fillArgs(writer, 3, '12');
    await fillSplitBoxes(args);
    expect(writer.writes[2]?.value).toBe('');
  });
});

describe('OTP screen targets — reading what PRE stamped', () => {
  it('reports no boxes for a bank whose code field is one input', () => {
    // Every OTP bank in the tree before this change. The single-fill path
    // depends on this staying empty.
    const targets = readSplitBoxes({} as IDiagnosticsState);
    expect(targets.boxes).toEqual([]);
  });

  it('reports no remember-device control when the screen has none', () => {
    // The normal case for most providers, and never an error.
    const targets = readSplitBoxes({} as IDiagnosticsState);
    expect(targets.remember).toBe(false);
  });

  it('reads back what PRE stamped', () => {
    const stamped = { boxes: [box(0), box(1)], remember: false };
    const diag = { [OTP_SPLIT_BOXES_KEY]: stamped } as unknown as IDiagnosticsState;
    const targets = readSplitBoxes(diag);
    expect(targets.boxes).toHaveLength(2);
  });
});
