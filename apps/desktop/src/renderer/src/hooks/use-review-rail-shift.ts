import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'

const RAIL_WIDTH = 340
const RAIL_GAP = 48
const GROUP_EXTRA = RAIL_WIDTH + RAIL_GAP
const MIN_PAD = 32

interface ReviewRailShiftOptions {
  railEnabled: boolean
  fullWidth: boolean
}

interface ReviewRailShiftResult {
  /** Spread onto the centered content column (sets --review-rail-shift). */
  shiftStyle: CSSProperties
  /** Too narrow for content + rail: hide the rail and let content re-center. */
  railHidden: boolean
  /** Attach to the content column element so its width can be measured. */
  setContentEl: (el: HTMLElement | null) => void
}

/**
 * Notion-style review rail shift: content stays centered at its max width and,
 * when the rail is visible, the whole content + gap + rail group is centered as
 * a unit by shifting the content column left with a transform. The shift clamps
 * so the content's inline-start edge keeps at least MIN_PAD, and the rail hides
 * entirely once content + rail no longer fit.
 */
export function useReviewRailShift(
  scrollEl: HTMLElement | null,
  { railEnabled, fullWidth }: ReviewRailShiftOptions
): ReviewRailShiftResult {
  const [contentEl, setContentEl] = useState<HTMLElement | null>(null)
  const [shiftPx, setShiftPx] = useState(0)
  const [railHidden, setRailHidden] = useState(false)
  const frameRef = useRef<number | null>(null)

  const active = railEnabled && !fullWidth

  useEffect(() => {
    if (!active || !scrollEl || !contentEl) return

    const compute = () => {
      frameRef.current = null
      const containerWidth = scrollEl.clientWidth
      const contentWidth = contentEl.offsetWidth
      const idealLeft = (containerWidth - (contentWidth + GROUP_EXTRA)) / 2
      const contentLeft = Math.max(MIN_PAD, idealLeft)
      const hidden = contentLeft + contentWidth + GROUP_EXTRA > containerWidth - MIN_PAD
      setRailHidden(hidden)
      setShiftPx(hidden ? 0 : Math.max(0, (containerWidth - contentWidth) / 2 - contentLeft))
    }
    const schedule = () => {
      if (frameRef.current !== null) return
      frameRef.current = requestAnimationFrame(compute)
    }

    const observer = new ResizeObserver(schedule)
    observer.observe(scrollEl)
    observer.observe(contentEl)
    schedule()
    return () => {
      observer.disconnect()
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
  }, [active, scrollEl, contentEl])

  const shiftStyle = useMemo<CSSProperties>(
    () =>
      active && !railHidden ? ({ '--review-rail-shift': `${shiftPx}px` } as CSSProperties) : {},
    [active, railHidden, shiftPx]
  )

  return { shiftStyle, railHidden: active && railHidden, setContentEl }
}
