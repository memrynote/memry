/**
 * Snooze Countdown Hook
 *
 * Hook that returns a live-updating snooze countdown string.
 * Updates every minute automatically.
 *
 * @module components/snooze/use-snooze-countdown
 */

import { useSyncExternalStore } from 'react'
import { formatSnoozeReturn } from './snooze-presets'

/**
 * The minute tick, shared by every mounted countdown.
 *
 * One `setInterval` and one `visibilitychange` listener serve all rows instead
 * of one pair per row — an inbox with 200 snoozed items used to hold 200 timers
 * and 200 document listeners, each firing its own re-render. Both are torn down
 * as soon as the last subscriber unsubscribes.
 *
 * The snapshot is a version counter rather than the wall clock so that a
 * `visibilitychange` still forces a re-render even when it lands inside the same
 * minute — matching the pre-shared-tick behaviour exactly.
 */
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | null = null
let version = 0

function notify(): void {
  version += 1
  for (const listener of listeners) listener()
}

function handleVisibilityChange(): void {
  // Timers are throttled while the app is backgrounded, so refresh on return.
  if (document.visibilityState === 'visible') {
    notify()
  }
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange)
  if (timer === null) {
    timer = setInterval(notify, 60000)
    document.addEventListener('visibilitychange', handleVisibilityChange)
  }
  return (): void => {
    listeners.delete(onChange)
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer)
      timer = null
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }
}

/** Rows without a snooze need no clock at all, so they never join the tick. */
function subscribeIdle(): () => void {
  return (): void => {}
}

const getVersion = (): number => version

/**
 * Hook that returns a live-updating snooze countdown string.
 * Updates every minute.
 *
 * @param snoozedUntil - The date/time when snooze expires
 * @returns Formatted countdown string like "4h left", "1d left"
 */
export function useSnoozeCountdown(snoozedUntil: Date | string | null): string | null {
  useSyncExternalStore(snoozedUntil ? subscribe : subscribeIdle, getVersion, getVersion)

  if (!snoozedUntil) return null
  const date = snoozedUntil instanceof Date ? snoozedUntil : new Date(snoozedUntil)
  return formatSnoozeReturn(date)
}
