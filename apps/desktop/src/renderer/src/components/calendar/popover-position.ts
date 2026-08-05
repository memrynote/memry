import type { AnchorRect } from './types'

export const POPOVER_WIDTH = 288
export const POPOVER_GAP = 8

export function computePopoverPosition(
  anchor: AnchorRect,
  options: { width?: number; estimatedHeight?: number } = {}
): { top: number; left: number } {
  const width = options.width ?? POPOVER_WIDTH
  const estimatedHeight = options.estimatedHeight ?? 240
  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1024
  const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 768

  const rightCandidate = anchor.x + anchor.width + POPOVER_GAP
  const fitsRight = rightCandidate + width + 8 <= viewportWidth
  const preferredLeft = fitsRight ? rightCandidate : anchor.x - width - POPOVER_GAP
  // Clamp both edges into the window. An anchor can sit outside the viewport —
  // the week grid is an infinitely virtualized strip whose own rect is millions
  // of pixels off-screen — and an unclamped `left` then parked the popover
  // outside the window, where its Save/action row could never be clicked.
  const left = Math.min(Math.max(8, preferredLeft), Math.max(8, viewportWidth - width - 8))
  const top = Math.min(Math.max(8, anchor.y), Math.max(8, viewportHeight - estimatedHeight))
  return { top, left }
}
