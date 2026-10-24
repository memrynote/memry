import { useEffect, useState } from 'react'

export interface ResizablePanelOptions {
  storageKey: string
  defaultPx: number
  minPx: number
  maxPx: number
}

export interface ResizablePanelState {
  width: number
  setWidth: React.Dispatch<React.SetStateAction<number>>
  isResizing: boolean
  setIsResizing: React.Dispatch<React.SetStateAction<boolean>>
}

// Fraction of the viewport one side panel may occupy. Kept below the day panel's
// 0.5 cap so the two side panels can never both claim half the window.
const VIEWPORT_FRACTION = 0.4

const clamp = (value: number, minPx: number, maxPx: number): number =>
  Math.min(maxPx, Math.max(minPx, value))

/**
 * Width state for a drag-resizable panel: persists to localStorage, skips writes
 * mid-drag, and clamps live width down when the window shrinks (responsive).
 * Mirrors the day-panel / sidebar resize pattern.
 */
export function useResizablePanel({
  storageKey,
  defaultPx,
  minPx,
  maxPx
}: ResizablePanelOptions): ResizablePanelState {
  const [width, setWidth] = useState(() => {
    try {
      const stored = localStorage.getItem(storageKey)
      if (!stored) return defaultPx
      const parsed = Number(stored)
      if (!Number.isFinite(parsed)) return defaultPx
      return clamp(parsed, minPx, maxPx)
    } catch {
      return defaultPx
    }
  })

  const [isResizing, setIsResizing] = useState(false)

  // Persist width, but skip writes mid-drag to avoid thrashing localStorage.
  useEffect(() => {
    if (isResizing) return () => {}
    try {
      localStorage.setItem(storageKey, String(width))
    } catch {
      /* localStorage unavailable */
    }
    return () => {}
  }, [storageKey, width, isResizing])

  // Responsive: never let the panel overflow a shrunk window.
  useEffect(() => {
    const onResize = (): void => {
      const cap = Math.min(maxPx, window.innerWidth * VIEWPORT_FRACTION)
      setWidth((w) => (w > cap ? cap : w))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [maxPx])

  return { width, setWidth, isResizing, setIsResizing }
}
