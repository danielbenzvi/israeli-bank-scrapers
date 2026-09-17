/**
 * Month-sized fetch windows, and the pause between them.
 *
 * The range is chunked by calendar month regardless of whether the endpoint
 * paginates: it is cheap, it makes truncation self-limiting, and it removes a
 * dependency on an assumption whose failure would be silent.
 */
import moment from 'moment';

import { WINDOW_DELAY_MAX_MS, WINDOW_DELAY_MIN_MS } from './Config/CibusApiConfig.js';

/** A date range in the provider's own format. */
export interface IDateWindow {
  from: string;
  to: string;
}

/**
 * Clamp one calendar month to the configured scrape range.
 * @param cursor - The month being emitted.
 * @param start - Earliest date the caller asked for.
 * @param end - Latest date the caller asked for.
 * @returns The clamped window, in the provider's date format.
 */
function toWindow(cursor: moment.Moment, start: moment.Moment, end: moment.Moment): IDateWindow {
  const monthStart = cursor.clone().startOf('month');
  const monthEnd = cursor.clone().endOf('month');
  const from = moment.max(monthStart, start);
  const to = moment.min(monthEnd, end);
  return { from: from.format('DD/MM/YYYY'), to: to.format('DD/MM/YYYY') };
}

/**
 * Walk the configured range one calendar month at a time.
 * @param start - Earliest date the caller asked for.
 * @param end - Latest date the caller asked for.
 * @returns One window per month, clamped to the range.
 */
export function collectWindows(start: moment.Moment, end: moment.Moment): IDateWindow[] {
  const cursor = start.clone().startOf('month');
  const windows: IDateWindow[] = [];
  while (cursor.isSameOrBefore(end, 'month')) {
    const window = toWindow(cursor, start, end);
    windows.push(window);
    cursor.add(1, 'month');
  }
  return windows;
}

/**
 * Pause between two window requests, by a varying amount.
 *
 * WHY THERE IS A PAUSE AT ALL. These requests once went out concurrently,
 * putting a burst of simultaneous calls on a provider that scores request
 * behaviour through reCAPTCHA — and a low score is rejected with the same
 * opaque status a wrong password gives, so looking automated costs a failure
 * nobody can diagnose.
 *
 * Varying rather than fixed: a constant interval is itself a signature, and
 * the point is not to present as a machine working through a list.
 * @returns Nothing, once the pause has elapsed.
 */
export async function pauseBetweenWindows(): Promise<void> {
  const spread = WINDOW_DELAY_MAX_MS - WINDOW_DELAY_MIN_MS;
  const delay = WINDOW_DELAY_MIN_MS + Math.floor(Math.random() * spread);
  await new Promise<void>(resolve => {
    globalThis.setTimeout(resolve, delay);
  });
}
