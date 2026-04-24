import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

export interface MonthGridSelection {
  startDate: string
  endDate: string
  anchorRect: { x: number; y: number; width: number; height: number }
}

interface UseMonthGridMarqueeOptions {
  gridRef: RefObject<HTMLElement | null>
}

interface UseMonthGridMarqueeReturn {
  selection: MonthGridSelection | null
  isDragging: boolean
  handlers: {
    onMouseDown: (e: React.MouseEvent) => void
    onDoubleClick: (e: React.MouseEvent) => void
  }
  clearSelection: () => void
}

function isEventChip(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return target.closest('[data-visual-type]') !== null
}

function getDateFromTarget(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null
  const cell = target.closest('[data-date]')
  if (!(cell instanceof HTMLElement)) return null
  return cell.dataset.date ?? null
}

function orderDates(a: string, b: string): [string, string] {
  return a <= b ? [a, b] : [b, a]
}

function getAnchorRect(
  gridRef: RefObject<HTMLElement | null>,
  startDate: string
): { x: number; y: number; width: number; height: number } {
  const grid = gridRef.current
  if (!grid) return { x: 0, y: 0, width: 0, height: 0 }
  const cell = grid.querySelector(`[data-date="${startDate}"]`)
  if (!cell) return { x: 0, y: 0, width: 0, height: 0 }
  const rect = cell.getBoundingClientRect()
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
}

export function useMonthGridMarquee({
  gridRef
}: UseMonthGridMarqueeOptions): UseMonthGridMarqueeReturn {
  const [selection, setSelection] = useState<MonthGridSelection | null>(null)
  const [isDragging, setIsDragging] = useState(false)

  const anchorDateRef = useRef<string | null>(null)
  const hasMovedRef = useRef(false)

  const clearSelection = useCallback(() => setSelection(null), [])

  const buildSelection = useCallback(
    (start: string, end: string): MonthGridSelection => {
      const [startDate, endDate] = orderDates(start, end)
      return {
        startDate,
        endDate,
        anchorRect: getAnchorRect(gridRef, startDate)
      }
    },
    [gridRef]
  )

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!anchorDateRef.current) return
      const date = getDateFromTarget(e.target)
      if (!date) return
      hasMovedRef.current = true
      setSelection(buildSelection(anchorDateRef.current, date))
    },
    [buildSelection]
  )

  const handleMouseUp = useCallback(() => {
    const hadMovement = hasMovedRef.current
    anchorDateRef.current = null
    hasMovedRef.current = false
    setIsDragging(false)
    if (!hadMovement) setSelection(null)
  }, [])

  useEffect(() => {
    if (isDragging) {
      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
    }
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDragging, handleMouseMove, handleMouseUp])

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    if (isEventChip(e.target)) return
    const date = getDateFromTarget(e.target)
    if (!date) return
    e.preventDefault()
    anchorDateRef.current = date
    hasMovedRef.current = false
    setIsDragging(true)
    setSelection(null)
  }, [])

  const onDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (isEventChip(e.target)) return
      const date = getDateFromTarget(e.target)
      if (!date) return
      e.preventDefault()
      setSelection(buildSelection(date, date))
    },
    [buildSelection]
  )

  return {
    selection,
    isDragging,
    handlers: { onMouseDown, onDoubleClick },
    clearSelection
  }
}
