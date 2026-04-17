import { useState, useCallback, useRef, useEffect, type RefObject } from 'react'

const MAX_MINUTES = 1425 // 23:45
const END_OF_DAY = MAX_MINUTES + 15 // 24:00 — valid end time for selections starting at 23:45

const HOUR_HEIGHT = 96
const SNAP_MINUTES = 15
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
  const anchorRect = {
    x: colRect?.x ?? gridRect?.x ?? 0,
    y: (gridRect?.top ?? 0) + top - scrollTop,
    width: colRect?.width ?? (gridRect?.width ?? 0) / Math.max(columnCount, 1),
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
  } | null>(null)

  const clearSelection = useCallback(() => setSelection(null), [])

  const stopDrag = useCallback(() => {
    if (dragState.current?.rafId != null) {
      cancelAnimationFrame(dragState.current.rafId)
    }
    dragState.current = null
    setIsDragging(false)
  }, [])

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!dragState.current) return
      dragState.current.hasMoved = true
      const { anchorY, columnIndex } = dragState.current
      const currentY = getMouseY(e.clientY, gridRef)
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

      const el = gridRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const distFromTop = e.clientY - rect.top
      const distFromBottom = rect.bottom - e.clientY

      if (dragState.current.rafId != null) {
        cancelAnimationFrame(dragState.current.rafId)
        dragState.current.rafId = null
      }

      if (distFromTop < AUTO_SCROLL_THRESHOLD) {
        const speed = Math.round(AUTO_SCROLL_MAX_SPEED * (1 - distFromTop / AUTO_SCROLL_THRESHOLD))
        const scroll = () => {
          el.scrollTop -= speed
          if (dragState.current) dragState.current.rafId = requestAnimationFrame(scroll)
        }
        dragState.current.rafId = requestAnimationFrame(scroll)
      } else if (distFromBottom < AUTO_SCROLL_THRESHOLD) {
        const speed = Math.round(
          AUTO_SCROLL_MAX_SPEED * (1 - distFromBottom / AUTO_SCROLL_THRESHOLD)
        )
        const scroll = () => {
          el.scrollTop += speed
          if (dragState.current) dragState.current.rafId = requestAnimationFrame(scroll)
        }
        dragState.current.rafId = requestAnimationFrame(scroll)
      }
    },
    [gridRef, dateForColumn, hourHeight, snapMinutes, columnCount, getColumnElement]
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
      dragState.current = { anchorY, columnIndex, rafId: null, hasMoved: false }
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
