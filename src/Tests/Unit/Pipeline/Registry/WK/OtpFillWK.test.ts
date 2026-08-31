/**
 * OTP-FILL well-known dictionary.
 *
 * An ORDERED list: the resolver takes the first candidate that hits, so
 * ordering is behaviour. Every property pinned here was observed failing
 * against a real provider, and none is visible by reading the list — which is
 * why they are asserted rather than left to review.
 */

import {
  WK_OTP_INPUT,
  WK_OTP_REMEMBER_DEVICE,
  WK_OTP_SUBMIT,
} from '../../../../../Scrapers/Pipeline/Registry/WK/OtpFillWK.js';

/** A candidate as the dictionary stores it. */
interface IWkCandidate {
  readonly kind: string;
  readonly value: string;
}

/**
 * Position of the first candidate satisfying a predicate.
 * @param list - The ordered candidate list.
 * @param match - Predicate over a candidate.
 * @returns The index, or -1.
 */
function indexOfFirst(
  list: readonly IWkCandidate[],
  match: (candidate: IWkCandidate) => boolean,
): number {
  return list.findIndex(match);
}

describe('OTP submit candidates', () => {
  it('never resolves a button inside a cookie-consent banner', () => {
    // A consent banner is always present and its buttons read exactly like a
    // submit — "אישור", "המשך". One matched the OneTrust accept button and the
    // phase clicked it instead of the code form's own control.
    const list = WK_OTP_SUBMIT as unknown as readonly IWkCandidate[];
    const textScoped = list.filter((c): boolean => c.value.includes('contains('));
    const isEveryGuarded = textScoped.every((c): boolean => c.value.includes('onetrust-consent-sdk'));
    expect(textScoped.length).toBeGreaterThan(0);
    expect(isEveryGuarded).toBe(true);
  });

  it('does not require the submit to be enabled when it is resolved', () => {
    // These buttons stay disabled until the code validates, and the submit is
    // resolved in PRE — BEFORE the fill. A `not(@disabled)` guard therefore
    // excludes exactly the button it is meant to find, and the race falls
    // through to whatever else carries the word.
    const list = WK_OTP_SUBMIT as unknown as readonly IWkCandidate[];
    const isAnyDisabledGuarded = list.some((c): boolean => c.value.includes('not(@disabled)'));
    expect(isAnyDisabledGuarded).toBe(false);
  });

  it('prefers a real button over any element merely carrying the words', () => {
    const list = WK_OTP_SUBMIT as unknown as readonly IWkCandidate[];
    const firstButtonScoped = indexOfFirst(list, (c): boolean =>
      c.kind === 'xpath' && c.value.includes('contains('),
    );
    const firstLooseText = indexOfFirst(list, (c): boolean => c.kind === 'clickableText');
    expect(firstButtonScoped).toBeGreaterThanOrEqual(0);
    expect(firstButtonScoped).toBeLessThan(firstLooseText);
  });
});

describe('OTP input candidates', () => {
  it('never matches a split field, which POST would misread', () => {
    // POST re-probes THIS list to ask whether the code form is still there.
    // The boxes linger for a moment after a correct code is submitted, so a
    // candidate here turns an accepted code into a silent rejection and sends
    // the phase round again for a code the provider already accepted.
    const list = WK_OTP_INPUT as unknown as readonly IWkCandidate[];
    const isBoxMatched = list.some((c): boolean => c.value.includes('@maxlength="1"'));
    expect(isBoxMatched).toBe(false);
  });

  it('does not resolve a bare one-time-code input', () => {
    // It survives in the DOM after a successful login, and this same list is
    // what POST re-probes to ask whether the form is still there — so matching
    // it reports a completed login as a failed one.
    const list = WK_OTP_INPUT as unknown as readonly IWkCandidate[];
    const isBarePresent = list.some((c): boolean => c.value === '//input[@autocomplete="one-time-code"]');
    expect(isBarePresent).toBe(false);
  });
});

describe('remember-device candidates', () => {
  it('targets the checkbox itself before its label text', () => {
    // The control is usually a styled component: the visible words sit on a
    // sibling label while the real <input> is what actually toggles.
    const list = WK_OTP_REMEMBER_DEVICE as unknown as readonly IWkCandidate[];
    const firstInput = indexOfFirst(list, (c): boolean => c.value.includes('@type="checkbox"'));
    const firstText = indexOfFirst(list, (c): boolean => c.kind === 'clickableText');
    expect(firstInput).toBeGreaterThanOrEqual(0);
    expect(firstInput).toBeLessThan(firstText);
  });
});
