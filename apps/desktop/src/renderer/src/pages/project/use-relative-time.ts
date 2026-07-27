import { useSyncExternalStore } from 'react'

/**
 * The wall clock, coarsened to the minute and shared by every subscriber.
 *
 * Relative labels ("2h ago") need the current time, which is external mutable
 * state — reading it during render is impure, and deriving it in an effect is
 * just render-state in disguise. `useSyncExternalStore` is the sanctioned way
 * to read a source like this, and rounding to the minute keeps the snapshot
 * stable so it does not re-render on every tick.
 *
 * One interval serves all rows rather than one per row.
 */
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | null = null

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange)
  if (timer === null) {
    timer = setInterval(() => {
      for (const listener of listeners) listener()
    }, 60_000)
  }
  return () => {
    listeners.delete(onChange)
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }
}

const getMinuteSnapshot = (): number => Math.floor(Date.now() / 60_000)

export function useNowMinute(): number {
  return useSyncExternalStore(subscribe, getMinuteSnapshot, getMinuteSnapshot) * 60_000
}

/** Pure formatter — `now` is passed in, so this is testable and render-safe. */
export function formatRelative(then: Date, language: string, now: number): string {
  const minutes = Math.round((now - then.getTime()) / 60_000)
  if (minutes < 60) return `${Math.max(minutes, 1)}m`
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h`
  if (minutes < 60 * 24 * 7) return `${Math.round(minutes / (60 * 24))}d`
  return new Intl.DateTimeFormat(language, { month: 'short', day: 'numeric' }).format(then)
}

/** Compact relative label — "2h", "3d", else a short date. Refreshes each minute. */
export function useRelativeTime(iso: string | null, language: string): string | null {
  const now = useNowMinute()
  return iso ? formatRelative(new Date(iso), language, now) : null
}
