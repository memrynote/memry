import { useLayoutEffect, type RefObject } from 'react'
import { useTabAutoPosition } from '@/hooks/use-tab-auto-position'

const HOUR_HEIGHT = 96
const VIEWPORT_RATIO = 0.4
const FALLBACK_HOUR = 7

/**
 * Opens a time grid at the current hour — but only on a tab that has no
 * position of its own. See `hooks/use-tab-auto-position.ts` for the rule.
 *
 * The gate matters twice here. Once on mount, where it would otherwise race the
 * restore. And once after: this effect re-runs every time its range starts or
 * stops containing today, which in week view happens as the user scrolls the
 * weeks past today — so without the gate the grid yanks itself back to the
 * current hour while they are reading.
 */
export function useScrollToCurrentTime(
  scrollRef: RefObject<HTMLDivElement | null>,
  containsToday: boolean,
  scrollKey: string
): void {
  const mayAutoPosition = useTabAutoPosition(scrollKey)

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (!mayAutoPosition()) return

    const targetOffset = containsToday ? offsetForNow() : FALLBACK_HOUR * HOUR_HEIGHT

    el.scrollTop = Math.max(0, targetOffset - el.clientHeight * VIEWPORT_RATIO)
  }, [scrollRef, containsToday, mayAutoPosition])
}

function offsetForNow(): number {
  const now = new Date()
  return now.getHours() * HOUR_HEIGHT + now.getMinutes() * (HOUR_HEIGHT / 60)
}
