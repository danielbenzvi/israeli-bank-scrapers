/**
 * OTP Fill WellKnown selectors — code input + submit.
 * Used exclusively by OtpFillPhase.
 */

/** OTP code input field patterns. */
const WK_OTP_INPUT = [
  { kind: 'placeholder', value: 'קוד חד פעמי' },
  { kind: 'placeholder', value: 'סיסמה חד פעמית' },
  { kind: 'placeholder', value: 'קוד SMS' },
  { kind: 'placeholder', value: 'יש להקליד סיסמה' },
  { kind: 'xpath', value: '//*[@autocomplete="one-time-code"]//input[1]' },
  // DELIBERATELY ABSENT: a bare `//input[@autocomplete="one-time-code"]`.
  //
  // It looks like the obvious way to reach a split field's hidden backing
  // input, and it is wrong twice. Filling that input does not move the
  // component's state — the per-digit boxes do, see WK_OTP_SPLIT_BOXES — and
  // worse, the element survives in the DOM AFTER a successful login. This
  // list is also what POST re-probes to ask "is the code form still here?",
  // so matching an invisible leftover reports a completed login as a failed
  // one. Visibility does not save it: the resolution alone is enough, and the
  // hit test it fails is not consulted.
  { kind: 'xpath', value: '//input[@data-testid="separated-0"]' },
  // DELIBERATELY ABSENT: a candidate for a split field's boxes.
  //
  // Discovery of those lives in WK_OTP_SPLIT_BOXES, because THIS list is also
  // what POST re-probes to ask "is the code form still here?". The boxes are
  // still rendered for a moment after a correct code is submitted, while the
  // page is still moving, so a candidate here reports an ACCEPTED code as a
  // silent rejection and sends the phase round again for a code it does not
  // need. Rejection is detected by the provider's own error banner instead.
] as const;

/**
 * Excludes buttons inside a cookie-consent banner.
 *
 * Consent banners are the richest source of false submits on these pages: they
 * are always present, always clickable, and their buttons read exactly like a
 * submit — "אישור", "המשך". One already cost a run by matching the OneTrust
 * accept button instead of the code form's own control.
 *
 * NOT paired with a `not(@disabled)` guard, though the real submit is usually
 * disabled until the code validates. The submit is resolved in PRE, BEFORE the
 * code is filled — so at resolution time the correct button is still disabled
 * and such a guard excludes precisely the element it is meant to find.
 */
const NOT_CONSENT = 'not(ancestor-or-self::*[@id="onetrust-consent-sdk"])';

/** OTP submit button after code entry. */
const WK_OTP_SUBMIT = [
  { kind: 'xpath', value: '//form[.//*[@autocomplete="one-time-code"]]//button[@type="submit"]' },
  { kind: 'xpath', value: '//button[@type="submit"]' },
  { kind: 'xpath', value: '//input[@type="submit"]' },
  { kind: 'xpath', value: '//form//button' },
  // Text-matched, but restricted to a real ENABLED BUTTON.
  //
  // These sit above the bare `clickableText` entries below because that kind
  // matches ANY element carrying the words, including prose. A cookie banner
  // reading "המשך גלישה באתר מהווה הסכמה" is a plain <div>, and it was winning
  // the race against the actual submit — the phase clicked a paragraph of
  // consent text, reported success, and left the code form untouched.
  //
  // `שנמשיך` first: it is a whole word rather than a fragment of a sentence,
  // so it cannot be reached by the looser matches that follow.
  { kind: 'xpath', value: `//button[${NOT_CONSENT}][contains(normalize-space(.), "שנמשיך")]` },
  { kind: 'xpath', value: `//button[${NOT_CONSENT}][contains(normalize-space(.), "המשך")]` },
  { kind: 'xpath', value: `//button[${NOT_CONSENT}][contains(normalize-space(.), "אישור")]` },
  // Last resort: any clickable carrying the word. Kept for banks whose submit
  // is not a <button> at all, and reached only when everything above misses.
  { kind: 'clickableText', value: 'המשך' },
  { kind: 'clickableText', value: 'אישור' },
] as const;

/**
 * Per-digit boxes of a SPLIT one-time-code field, in code order.
 *
 * Keyed on the shape every such component shares — a single-character input
 * that only accepts digits — rather than on any provider's class or id, so the
 * same list serves each of them. Position is 1-based because XPath is.
 *
 * Used only when the component does not advance focus by itself; see
 * `Mediator/OtpFill/OtpSplitBoxes.ts` for why that cannot be assumed.
 */
const WK_OTP_SPLIT_BOXES = [
  { kind: 'xpath', value: '(//input[@maxlength="1" and @inputmode="numeric"])[1]' },
  { kind: 'xpath', value: '(//input[@maxlength="1" and @inputmode="numeric"])[2]' },
  { kind: 'xpath', value: '(//input[@maxlength="1" and @inputmode="numeric"])[3]' },
  { kind: 'xpath', value: '(//input[@maxlength="1" and @inputmode="numeric"])[4]' },
  { kind: 'xpath', value: '(//input[@maxlength="1" and @inputmode="numeric"])[5]' },
  { kind: 'xpath', value: '(//input[@maxlength="1" and @inputmode="numeric"])[6]' },
  { kind: 'xpath', value: '(//input[@maxlength="1" and @inputmode="numeric"])[7]' },
  { kind: 'xpath', value: '(//input[@maxlength="1" and @inputmode="numeric"])[8]' },
] as const;

/**
 * The "remember this device" control on an OTP screen.
 *
 * Ticking it is what makes a provider mint a long-lived device token, and it
 * is read as part of the CODE step, not the password step. Left unticked, a
 * correct code still yields no token and EVERY later run is challenged — the
 * difference between answering one code ever and needing a person present on
 * every scheduled run.
 *
 * Matched by the checkbox's own id/name fragment before its label text: the
 * control is usually a styled component whose real <input> is what must be
 * toggled, while the visible words sit on a sibling label.
 */
const WK_OTP_REMEMBER_DEVICE = [
  { kind: 'xpath', value: '//input[@type="checkbox"][contains(@id, "remember")]' },
  { kind: 'xpath', value: '//input[@type="checkbox"][contains(@name, "remember")]' },
  { kind: 'clickableText', value: 'זכור מכשיר זה' },
  { kind: 'clickableText', value: 'זכור אותי' },
] as const;

export {
  WK_OTP_INPUT,
  WK_OTP_REMEMBER_DEVICE,
  WK_OTP_SPLIT_BOXES,
  WK_OTP_SUBMIT,
};
