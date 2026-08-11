import { useSyncExternalStore } from 'react'
import { formatDateToISO, getTodayString } from '@/lib/journal-utils'

/**
 * Milliseconds from `from` until the next local midnight.
 *
 * Derived from calendar fields rather than a fixed 24h offset: on DST transition days the local
 * day is 23 or 25 hours long, and a "now + 24h" timer would fire an hour early or late twice a
 * year. Constructing the next local 00:00 lets the platform resolve the real offset.
 */
function msUntilNextLocalMidnight(from: Date): number {
  const next = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 1, 0, 0, 0, 0)
  return next.getTime() - from.getTime()
}

// Shared so every consumer rolls over in the same notification: the calendar widget body, its
// header count, and its footer derive one useCalendarRange query key from this value, and
// independent per-component timers would briefly disagree and trigger duplicate fetches.
let currentToday = getTodayString()
let timer: ReturnType<typeof setTimeout> | undefined
const listeners = new Set<() => void>()

// Re-reads the wall clock and re-arms. Called on the midnight timer, and again whenever the app
// resumes (sleep/wake and system clock changes can both delay or skip the timer), so a stale day
// is corrected on the next resume rather than persisting for the rest of the session.
function syncToday(): void {
  if (timer !== undefined) clearTimeout(timer)
  const now = new Date()
  const next = formatDateToISO(now)
  if (next !== currentToday) {
    currentToday = next
    for (const listener of listeners) listener()
  }
  timer = setTimeout(syncToday, msUntilNextLocalMidnight(now))
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) {
    document.addEventListener('visibilitychange', syncToday)
    window.addEventListener('focus', syncToday)
    syncToday()
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size > 0) return
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    document.removeEventListener('visibilitychange', syncToday)
    window.removeEventListener('focus', syncToday)
  }
}

function getSnapshot(): string {
  return currentToday
}

/**
 * Today's local date as `YYYY-MM-DD`, re-rendering consumers when the local day rolls over.
 *
 * Use instead of a mount-time `getTodayString()` / `new Date()` anywhere the value stays on screen
 * across midnight, so an app left open all day does not keep showing yesterday.
 */
export function useToday(): string {
  return useSyncExternalStore(subscribe, getSnapshot)
}
