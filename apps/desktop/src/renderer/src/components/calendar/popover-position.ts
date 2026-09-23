import { useLayoutEffect, useState, useSyncExternalStore, type CSSProperties } from 'react'

import type { AnchorRect } from './types'

export const POPOVER_WIDTH = 288
export const POPOVER_GAP = 8
/** Minimum distance kept between a popover and every window edge. */
export const POPOVER_VIEWPORT_MARGIN = 8

export interface PopoverPosition {
  top: number
  left: number
  /** Tallest the popover may be while staying fully inside the window. */
  maxHeight: number
}

export function computePopoverPosition(
  anchor: AnchorRect,
  options: {
    width?: number
    estimatedHeight?: number
    viewport?: { width: number; height: number }
  } = {}
): PopoverPosition {
  const width = options.width ?? POPOVER_WIDTH
  const estimatedHeight = options.estimatedHeight ?? 240
  const viewportWidth =
    options.viewport?.width ?? (typeof window !== 'undefined' ? window.innerWidth : 1024)
  const viewportHeight =
    options.viewport?.height ?? (typeof window !== 'undefined' ? window.innerHeight : 768)
  const margin = POPOVER_VIEWPORT_MARGIN

  const rightCandidate = anchor.x + anchor.width + POPOVER_GAP
  const fitsRight = rightCandidate + width + margin <= viewportWidth
  const preferredLeft = fitsRight ? rightCandidate : anchor.x - width - POPOVER_GAP
  // Clamp both edges into the window. An anchor can sit outside the viewport —
  // the week grid is an infinitely virtualized strip whose own rect is millions
  // of pixels off-screen — and an unclamped `left` then parked the popover
  // outside the window, where its Save/action row could never be clicked.
  const left = Math.min(
    Math.max(margin, preferredLeft),
    Math.max(margin, viewportWidth - width - margin)
  )

  // Vertically the popover starts level with the anchor and slides up only as
  // far as needed to keep its bottom edge on screen. When it is taller than the
  // window it pins to the top margin and `maxHeight` caps it, so the caller can
  // scroll the overflow instead of pushing the action row below the window.
  const maxHeight = Math.max(0, viewportHeight - margin * 2)
  const height = Math.min(estimatedHeight, maxHeight)
  const top = Math.min(Math.max(margin, anchor.y), viewportHeight - margin - height)
  return { top, left, maxHeight }
}

function subscribeToViewport(onChange: () => void): () => void {
  window.addEventListener('resize', onChange)
  return () => window.removeEventListener('resize', onChange)
}

const getViewportWidth = (): number => window.innerWidth
const getViewportHeight = (): number => window.innerHeight

/** Full content height of `node`, including any part hidden by `max-height`. */
function measureNaturalHeight(node: HTMLElement): number {
  const borderHeight = node.offsetHeight - node.clientHeight
  return node.scrollHeight + borderHeight
}

/**
 * Positions a fixed popover next to the clicked anchor and keeps it inside the
 * window. Unlike a one-shot `computePopoverPosition` call it measures the real
 * rendered height (forms grow as optional rows mount) and recomputes on window
 * resize, so the popover never ends up partly below the window edge.
 *
 * Attach `ref` to the popover element and spread `style` onto it.
 */
export function useAnchoredPopoverPosition(
  anchor: AnchorRect,
  options: { width?: number; estimatedHeight?: number } = {}
): { ref: (node: HTMLElement | null) => void; style: CSSProperties } {
  const width = options.width ?? POPOVER_WIDTH
  const [node, setNode] = useState<HTMLElement | null>(null)
  const [measuredHeight, setMeasuredHeight] = useState<number | null>(null)
  const viewportWidth = useSyncExternalStore(subscribeToViewport, getViewportWidth)
  const viewportHeight = useSyncExternalStore(subscribeToViewport, getViewportHeight)

  useLayoutEffect(() => {
    if (!node) return
    const measure = (): void => {
      const height = measureNaturalHeight(node)
      // Layout-less environments (jsdom) report 0; keep the estimate there.
      if (height > 0) setMeasuredHeight(height)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
    // Viewport size is a dependency so a clamped popover re-measures its natural
    // height when the window grows and can expand back to full size.
  }, [node, viewportWidth, viewportHeight])

  const height = measuredHeight ?? options.estimatedHeight
  const { top, left, maxHeight } = computePopoverPosition(anchor, {
    width,
    estimatedHeight: height,
    viewport: { width: viewportWidth, height: viewportHeight }
  })
  const overflows = height !== undefined && height > maxHeight

  return {
    ref: setNode,
    style: {
      top,
      left,
      width,
      maxHeight,
      overflowY: overflows ? 'auto' : undefined
    }
  }
}
