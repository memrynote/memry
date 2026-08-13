import { useState, useCallback, useRef, useEffect, type RefObject } from 'react'
import { HOUR_HEIGHT, SNAP_MINUTES } from './time-grid-constants'

const MAX_MINUTES = 1425 // 23:45
const END_OF_DAY = MAX_MINUTES + 15 // 24:00 — valid end time for selections starting at 23:45

const DOUBLE_CLICK_DURATION_MINUTES = 60
const AUTO_SCROLL_THRESHOLD = 48
const AUTO_SCROLL_MAX_SPEED = 12

export function pixelToSnappedMinutes(
  pixelY: number,
  hourHeight: number,
  snapMinutes: number
): number {
  const rawMinutes = (pixelY / hourHeight) * 60
  const snapped = Math.round(rawMinutes / snapMinutes) * snapMinutes
  return Math.max(0, Math.min(snapped, MAX_MINUTES))
}

export function minutesToTimeString(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

export interface MarqueeSelectionGeometry {
  startMinutes: number
  endMinutes: number
  top: number
  height: number
}

export function selectionFromDrag(
  startPixelY: number,
  endPixelY: number,
  hourHeight: number,
  snapMinutes: number
): MarqueeSelectionGeometry {
  const startMin = pixelToSnappedMinutes(startPixelY, hourHeight, snapMinutes)
  const endMin = pixelToSnappedMinutes(endPixelY, hourHeight, snapMinutes)
  const lo = Math.min(startMin, endMin)
  const hi = Math.max(startMin, endMin)
  const finalEnd = hi === lo ? lo + snapMinutes : hi
  const pxPerMinute = hourHeight / 60
  const clampedEnd = Math.min(finalEnd, END_OF_DAY)
  return {
    startMinutes: lo,
    endMinutes: clampedEnd,
    top: Math.round(lo * pxPerMinute),
    height: Math.round((clampedEnd - lo) * pxPerMinute)
  }
}

export interface TimeGridSelection {
  top: number
  height: number
  date: string
  startAt: string
  endAt: string
  columnIndex: number
  anchorRect: { x: number; y: number; width: number; height: number }
}

interface UseTimeGridMarqueeOptions {
  gridRef: RefObject<HTMLDivElement | null>
  /**
   * The scrolling ancestor of `gridRef` (the element carrying `overflow-y`).
   * The grid itself is the full 24-hour strip and never scrolls, so edge
   * auto-scroll has to measure and move this element instead.
   */
  scrollRef: RefObject<HTMLElement | null>
  dateForColumn: (columnIndex: number) => string
  columnCount?: number
  hourHeight?: number
  snapMinutes?: number
  getColumnElement?: (columnIndex: number) => HTMLElement | null
}

interface UseTimeGridMarqueeResult {
  selection: TimeGridSelection | null
  isDragging: boolean
  handlers: {
    onMouseDown: (e: React.MouseEvent, columnIndex: number) => void
    onDoubleClick: (e: React.MouseEvent, columnIndex: number) => void
  }
  clearSelection: () => void
}

function isEventChip(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return target.closest('[data-visual-type]') !== null
}

function getMouseY(clientY: number, gridRef: RefObject<HTMLDivElement | null>): number {
  const el = gridRef.current
  if (!el) return 0
  // The grid is not the scroll container, so `rect.top` already travels with
  // the scroll and `el.scrollTop` is 0. Reading the scroller here instead would
  // double-count the offset — this stays on the grid deliberately.
  const rect = el.getBoundingClientRect()
  return clientY - rect.top + el.scrollTop
}

function buildSelection(
  startMinutes: number,
  endMinutes: number,
  columnIndex: number,
  date: string,
  gridRef: RefObject<HTMLDivElement | null>,
  hourHeight: number,
  columnCount: number,
  getColumnElement?: (columnIndex: number) => HTMLElement | null
): TimeGridSelection {
  const pxPerMinute = hourHeight / 60
  const top = Math.round(startMinutes * pxPerMinute)
  const height = Math.round((endMinutes - startMinutes) * pxPerMinute)
  const el = gridRef.current
  const gridRect = el?.getBoundingClientRect()
  const scrollTop = el?.scrollTop ?? 0
  const columnEl = getColumnElement
    ? getColumnElement(columnIndex)
    : ((el?.children?.[columnIndex + 1] as HTMLElement | undefined) ?? null)
  const colRect = columnEl?.getBoundingClientRect()
  const fallbackColumnWidth = (gridRect?.width ?? 0) / Math.max(columnCount, 1)
  const anchorRect = {
    // Week view's grid is an infinitely virtualized strip, so `gridRect.x` is the
    // strip's own left edge — millions of pixels off-screen once scrolled to
    // today. Collapsing the anchor onto it placed the quick-create popover
    // outside the window; offset by the column instead. Day view has a single
    // column at index 0, so its anchor is unchanged.
    x: colRect?.x ?? (gridRect?.x ?? 0) + columnIndex * fallbackColumnWidth,
    y: (gridRect?.top ?? 0) + top - scrollTop,
    width: colRect?.width ?? fallbackColumnWidth,
    height
  }
  return {
    top,
    height,
    date,
    startAt: `${date}T${minutesToTimeString(startMinutes)}`,
    endAt: `${date}T${minutesToTimeString(endMinutes)}`,
    columnIndex,
    anchorRect
  }
}

export function useTimeGridMarquee({
  gridRef,
  scrollRef,
  dateForColumn,
  columnCount = 1,
  hourHeight = HOUR_HEIGHT,
  snapMinutes = SNAP_MINUTES,
  getColumnElement
}: UseTimeGridMarqueeOptions): UseTimeGridMarqueeResult {
  const [selection, setSelection] = useState<TimeGridSelection | null>(null)
  const [isDragging, setIsDragging] = useState(false)

  const dragState = useRef<{
    anchorY: number
    columnIndex: number
    rafId: number | null
    hasMoved: boolean
    lastClientY: number
  } | null>(null)

  const clearSelection = useCallback(() => setSelection(null), [])

  const stopDrag = useCallback(() => {
    if (dragState.current?.rafId != null) {
      cancelAnimationFrame(dragState.current.rafId)
    }
    dragState.current = null
    setIsDragging(false)
  }, [])

  // Re-derived from the pointer's viewport position, so it also picks up
  // movement caused by auto-scroll while the pointer is held still.
  const updateSelection = useCallback(
    (clientY: number) => {
      if (!dragState.current) return
      const { anchorY, columnIndex } = dragState.current
      const currentY = getMouseY(clientY, gridRef)
      const geo = selectionFromDrag(anchorY, currentY, hourHeight, snapMinutes)
      const date = dateForColumn(columnIndex)
      setSelection(
        buildSelection(
          geo.startMinutes,
          geo.endMinutes,
          columnIndex,
          date,
          gridRef,
          hourHeight,
          columnCount,
          getColumnElement
        )
      )
    },
    [gridRef, dateForColumn, hourHeight, snapMinutes, columnCount, getColumnElement]
  )

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!dragState.current) return
      dragState.current.hasMoved = true
      dragState.current.lastClientY = e.clientY
      updateSelection(e.clientY)

      // Auto-scroll is measured against the scroll container's visible box. The
      // grid's own rect is the whole 24-hour strip, which extends far past both
      // edges of the viewport once scrolled, so its `top`/`bottom` never came
      // within the threshold and the drag could not be extended past the hours
      // already on screen.
      const el = scrollRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const distFromTop = e.clientY - rect.top
      const distFromBottom = rect.bottom - e.clientY

      if (dragState.current.rafId != null) {
        cancelAnimationFrame(dragState.current.rafId)
        dragState.current.rafId = null
      }

      const startAutoScroll = (delta: number): void => {
        const scroll = (): void => {
          if (!dragState.current) return
          el.scrollTop += delta
          // The pointer has not moved, but the hours under it have.
          updateSelection(dragState.current.lastClientY)
          dragState.current.rafId = requestAnimationFrame(scroll)
        }
        if (dragState.current) dragState.current.rafId = requestAnimationFrame(scroll)
      }

      if (distFromTop < AUTO_SCROLL_THRESHOLD) {
        const speed = Math.round(AUTO_SCROLL_MAX_SPEED * (1 - distFromTop / AUTO_SCROLL_THRESHOLD))
        startAutoScroll(-speed)
      } else if (distFromBottom < AUTO_SCROLL_THRESHOLD) {
        const speed = Math.round(
          AUTO_SCROLL_MAX_SPEED * (1 - distFromBottom / AUTO_SCROLL_THRESHOLD)
        )
        startAutoScroll(speed)
      }
    },
    [scrollRef, updateSelection]
  )

  const handleMouseUp = useCallback(() => {
    const hadMovement = dragState.current?.hasMoved ?? false
    stopDrag()
    if (!hadMovement) setSelection(null)
  }, [stopDrag])

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

  const onMouseDown = useCallback(
    (e: React.MouseEvent, columnIndex: number) => {
      if (e.button !== 0) return
      if (isEventChip(e.target)) return
      e.preventDefault()
      const anchorY = getMouseY(e.clientY, gridRef)
      dragState.current = {
        anchorY,
        columnIndex,
        rafId: null,
        hasMoved: false,
        lastClientY: e.clientY
      }
      setIsDragging(true)
      setSelection(null)
    },
    [gridRef]
  )

  const onDoubleClick = useCallback(
    (e: React.MouseEvent, columnIndex: number) => {
      e.preventDefault()
      const clickY = getMouseY(e.clientY, gridRef)
      const startMinutes = pixelToSnappedMinutes(clickY, hourHeight, snapMinutes)
      const endMinutes = Math.min(startMinutes + DOUBLE_CLICK_DURATION_MINUTES, END_OF_DAY)
      const date = dateForColumn(columnIndex)
      setSelection(
        buildSelection(
          startMinutes,
          endMinutes,
          columnIndex,
          date,
          gridRef,
          hourHeight,
          columnCount,
          getColumnElement
        )
      )
    },
    [gridRef, dateForColumn, hourHeight, snapMinutes, columnCount, getColumnElement]
  )

  return {
    selection,
    isDragging,
    handlers: { onMouseDown, onDoubleClick },
    clearSelection
  }
}
