import { useLayoutEffect, type RefObject } from 'react'

const HOUR_HEIGHT = 96
const VIEWPORT_RATIO = 0.4
const FALLBACK_HOUR = 7

export function useScrollToCurrentTime(
  scrollRef: RefObject<HTMLDivElement | null>,
  containsToday: boolean
): void {
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return

    const targetOffset = containsToday
      ? offsetForNow()
      : FALLBACK_HOUR * HOUR_HEIGHT

    el.scrollTop = Math.max(0, targetOffset - el.clientHeight * VIEWPORT_RATIO)
  }, [scrollRef, containsToday])
}

function offsetForNow(): number {
  const now = new Date()
  return now.getHours() * HOUR_HEIGHT + now.getMinutes() * (HOUR_HEIGHT / 60)
}
