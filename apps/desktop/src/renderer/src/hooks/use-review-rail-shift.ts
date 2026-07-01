import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'

const RAIL_WIDTH = 340
const RAIL_GAP = 48
const GROUP_EXTRA = RAIL_WIDTH + RAIL_GAP
const MIN_PAD = 32

interface ReviewRailShiftOptions {
  railEnabled: boolean
  fullWidth: boolean
  /** Notified at the measurement source whenever the effective rail-hidden state changes. */
  onRailHiddenChange?: (hidden: boolean) => void
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
 * Review rail shift: content stays centered at its max width and,
 * when the rail is visible, the whole content + gap + rail group is centered as
 * a unit by shifting the content column left with a transform. The shift clamps
 * so the content's inline-start edge keeps at least MIN_PAD, and the rail hides
 * entirely once content + rail no longer fit.
 */
export function useReviewRailShift(
  scrollEl: HTMLElement | null,
  { railEnabled, fullWidth, onRailHiddenChange }: ReviewRailShiftOptions
): ReviewRailShiftResult {
  const [contentEl, setContentEl] = useState<HTMLElement | null>(null)
  const [shiftPx, setShiftPx] = useState(0)
  const [railHidden, setRailHidden] = useState(false)
  const frameRef = useRef<number | null>(null)
  const onRailHiddenChangeRef = useRef(onRailHiddenChange)
  const lastEmittedHiddenRef = useRef<boolean | null>(null)

  useEffect(() => {
    onRailHiddenChangeRef.current = onRailHiddenChange
  }, [onRailHiddenChange])

  const active = railEnabled && !fullWidth

  // Layout-measurement subscription: reads geometry and writes the resulting
  // shift + rail visibility, so it runs as a layout effect (the correct hook for
  // measuring the DOM). The parent is notified at this measurement source via
  // onRailHiddenChange rather than mirroring the returned state back up.
  useLayoutEffect(() => {
    const emit = (hidden: boolean): void => {
      if (lastEmittedHiddenRef.current === hidden) return
      lastEmittedHiddenRef.current = hidden
      onRailHiddenChangeRef.current?.(hidden)
    }

    if (!active) {
      emit(false)
      return
    }
    if (!scrollEl || !contentEl) return

    const compute = () => {
      frameRef.current = null
      const containerWidth = scrollEl.clientWidth
      const contentWidth = contentEl.offsetWidth
      const idealLeft = (containerWidth - (contentWidth + GROUP_EXTRA)) / 2
      const contentLeft = Math.max(MIN_PAD, idealLeft)
      const hidden = contentLeft + contentWidth + GROUP_EXTRA > containerWidth - MIN_PAD
      setRailHidden(hidden)
      emit(hidden)
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
