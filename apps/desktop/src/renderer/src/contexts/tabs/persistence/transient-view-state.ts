/**
 * The `viewState` keys a session must NOT carry across an app restart.
 *
 * Two kinds of value live in a tab's `viewState`:
 *
 * - Durable preferences — the calendar's view, its filters, a task list's
 *   sort. Restoring those is the whole point of persisting `viewState`.
 * - One-shot intents and session-scoped positions — "open the new-event
 *   popover", "focus this inbox item", "the date I was looking at". They are
 *   answers to something the user did a moment ago, and replaying them on the
 *   next launch is a bug, not a restore.
 *
 * The reported symptom was the second kind persisted: Calendar opened on a day
 * in August with the event-creation dialog already up, on every launch, because
 * `createEventAt` (a nonce from a "New event" click weeks earlier) and
 * `calendarAnchorDate` were both written to disk and replayed verbatim.
 *
 * Stripped on the way OUT (so this build never writes them again) and on the
 * way IN (so a session file written by an older build, which is what real
 * users are sitting on, is cleaned before it reaches a page).
 */

/**
 * Nonces delivered as `viewState` when a surface opens a singleton tab with an
 * intent attached. Each is `Date.now()`, so a fresh click re-fires it; a
 * restored one fires it for a click that happened in a previous app run.
 */
const ONE_SHOT_INTENT_KEYS = [
  'createEventAt',
  'focusCaptureAt',
  'focusQuickAddAt',
  'focusedAt',
  'focusDate',
  'focusCalendarEventId',
  'focusInboxItemId'
] as const

/**
 * Positions that mean "where I am right now", not "where I like to start".
 *
 * The calendar anchor is session-scoped by product decision: opening Calendar
 * on a fresh start must land on today, in the user's last view mode. A
 * remembered date is only correct while the session that navigated there is
 * still alive — and within a session the anchor lives in the in-memory tab
 * state, which this file does not touch.
 */
const SESSION_SCOPED_KEYS = ['calendarAnchorDate'] as const

export const TRANSIENT_TAB_VIEW_STATE_KEYS: readonly string[] = [
  ...ONE_SHOT_INTENT_KEYS,
  ...SESSION_SCOPED_KEYS
]

/**
 * `viewState` without its transient keys, or `undefined` when nothing durable
 * is left — an empty record is noise in the session file.
 *
 * Returns the input untouched when there is nothing to strip, so an unchanged
 * tab does not churn object identity on every save.
 */
export function stripTransientViewState(
  viewState: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!viewState) return viewState

  const keys = Object.keys(viewState)
  if (!keys.some((key) => TRANSIENT_TAB_VIEW_STATE_KEYS.includes(key))) {
    return keys.length > 0 ? viewState : undefined
  }

  const durable: Record<string, unknown> = {}
  for (const key of keys) {
    if (TRANSIENT_TAB_VIEW_STATE_KEYS.includes(key)) continue
    durable[key] = viewState[key]
  }

  return Object.keys(durable).length > 0 ? durable : undefined
}
