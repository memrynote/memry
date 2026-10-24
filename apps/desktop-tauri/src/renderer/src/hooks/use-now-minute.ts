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
