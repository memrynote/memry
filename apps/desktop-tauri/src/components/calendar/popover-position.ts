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
  const left = fitsRight ? rightCandidate : Math.max(8, anchor.x - width - POPOVER_GAP)
  const top = Math.min(Math.max(8, anchor.y), Math.max(8, viewportHeight - estimatedHeight))
  return { top, left }
}
