import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { parseLocalDate, toLocalDateKey } from './date-utils'
import type { CalendarProjectionItem } from '@/services/calendar-service'
import { HOUR_HEIGHT, SNAP_MINUTES } from './time-grid-constants'

const MOVE_THRESHOLD_PX = 4
const DEFAULT_DURATION_MINUTES = 60
export const MINUTES_IN_DAY = 1440

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max))
}

export function snapMinutes(minutes: number, snap: number): number {
  return Math.round(minutes / snap) * snap
}

/** Keep a moved event fully inside its day (no multi-day spill). */
// ponytail: clamp within day; multi-day spill not supported.
export function clampStartWithinDay(startMinutes: number, durationMinutes: number): number {
  return clamp(startMinutes, 0, MINUTES_IN_DAY - durationMinutes)
}

export function isoFromDayMinutes(date: string, minutesFromMidnight: number): string {
  const d = parseLocalDate(date)
  d.setMinutes(d.getMinutes() + minutesFromMidnight)
  return d.toISOString()
}

export interface DragTimes {
  startMin: number
  endMin: number
  startAt: string
  endAt: string
}

export function computeMovedTimes(
  originalStartMin: number,
  durationMin: number,
  deltaMin: number,
  snap: number,
  targetDate: string
): DragTimes {
  const startMin = clampStartWithinDay(snapMinutes(originalStartMin + deltaMin, snap), durationMin)
  const endMin = startMin + durationMin
  return {
    startMin,
    endMin,
    startAt: isoFromDayMinutes(targetDate, startMin),
    endAt: isoFromDayMinutes(targetDate, endMin)
  }
}

export function computeResizedTimes(
  startMin: number,
  endMin: number,
  deltaMin: number,
  edge: 'start' | 'end',
  snap: number,
  date: string
): DragTimes {
  let nextStart = startMin
  let nextEnd = endMin
  if (edge === 'start') {
    nextStart = clamp(snapMinutes(startMin + deltaMin, snap), 0, endMin - snap)
  } else {
    nextEnd = clamp(snapMinutes(endMin + deltaMin, snap), startMin + snap, MINUTES_IN_DAY)
  }
  return {
    startMin: nextStart,
    endMin: nextEnd,
    startAt: isoFromDayMinutes(date, nextStart),
    endAt: isoFromDayMinutes(date, nextEnd)
  }
}

/**
 * Time-grid dragging covers native events and timed tasks. All-day chips are
 * date-granular and handled by dnd-kit; notes, reminders and imports are
 * read-only (main sets canMove: false on those projections).
 */
export function isEventMovable(item: CalendarProjectionItem): boolean {
  const isDraggableSource = item.sourceType === 'event' || item.sourceType === 'task'
  return isDraggableSource && Boolean(item.editability?.canMove) && !item.isAllDay
}

export function isEventResizable(item: CalendarProjectionItem): boolean {
  return isEventMovable(item) && Boolean(item.editability?.canResize)
}

function minutesOfDay(iso: string): number {
  const d = new Date(iso)
  return d.getHours() * 60 + d.getMinutes()
}

function durationMinutes(item: CalendarProjectionItem, snap: number): number {
  const start = new Date(item.startAt).getTime()
  const end = item.endAt ? new Date(item.endAt).getTime() : start + DEFAULT_DURATION_MINUTES * 60000
  return Math.max((end - start) / 60000, snap)
}

export interface EventDragState {
  projectionId: string
  columnIndex: number
  top: number
  height: number
}

type DragMode = { kind: 'move' } | { kind: 'resize'; edge: 'start' | 'end' }

interface UseEventDragOptions {
  gridRef: RefObject<HTMLDivElement | null>
  /** Resolve a column index to its local date (week: dateForDayIndex; day: () => anchorDate). */
  dateForColumn: (columnIndex: number) => string
  /** Week view: hit-test the column under the pointer for cross-day moves. Day view omits it. */
  columnIndexAtClientX?: (clientX: number) => number | null
  hourHeight?: number
  snapMinutes?: number
  onCommit: (item: CalendarProjectionItem, startAt: string, endAt: string) => void | Promise<void>
}

interface UseEventDragResult {
  drag: EventDragState | null
  startMove: (e: React.MouseEvent, item: CalendarProjectionItem, columnIndex: number) => void
  startResize: (
    e: React.MouseEvent,
    item: CalendarProjectionItem,
    columnIndex: number,
    edge: 'start' | 'end'
  ) => void
  /** Read-and-clear: true if the last gesture moved, so the trailing click can be suppressed. */
  wasDragged: () => boolean
}

export function useEventDrag({
  dateForColumn,
  columnIndexAtClientX,
  hourHeight = HOUR_HEIGHT,
  snapMinutes: snap = SNAP_MINUTES,
  onCommit
}: UseEventDragOptions): UseEventDragResult {
  const [drag, setDrag] = useState<EventDragState | null>(null)
  const [active, setActive] = useState(false)
  const wasDraggedRef = useRef(false)

  const dragState = useRef<{
    mode: DragMode
    item: CalendarProjectionItem
    originColumnIndex: number
    anchorX: number
    anchorY: number
    originStartMin: number
    originEndMin: number
    durationMin: number
    originDate: string
    hasMoved: boolean
    last: DragTimes | null
  } | null>(null)

  const pxPerMinute = hourHeight / 60

  const begin = useCallback(
    (e: React.MouseEvent, item: CalendarProjectionItem, columnIndex: number, mode: DragMode) => {
      if (e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()
      const startMin = minutesOfDay(item.startAt)
      const duration = durationMinutes(item, snap)
      dragState.current = {
        mode,
        item,
        originColumnIndex: columnIndex,
        anchorX: e.clientX,
        anchorY: e.clientY,
        originStartMin: startMin,
        originEndMin: startMin + duration,
        durationMin: duration,
        originDate: toLocalDateKey(item.startAt),
        hasMoved: false,
        last: null
      }
      setActive(true)
    },
    [snap]
  )

  const startMove = useCallback(
    (e: React.MouseEvent, item: CalendarProjectionItem, columnIndex: number) => {
      if (!isEventMovable(item)) return
      begin(e, item, columnIndex, { kind: 'move' })
    },
    [begin]
  )

  const startResize = useCallback(
    (
      e: React.MouseEvent,
      item: CalendarProjectionItem,
      columnIndex: number,
      edge: 'start' | 'end'
    ) => {
      if (!isEventResizable(item)) return
      begin(e, item, columnIndex, { kind: 'resize', edge })
    },
    [begin]
  )

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      const state = dragState.current
      if (!state) return
      if (!state.hasMoved) {
        const moved =
          Math.abs(e.clientX - state.anchorX) > MOVE_THRESHOLD_PX ||
          Math.abs(e.clientY - state.anchorY) > MOVE_THRESHOLD_PX
        if (!moved) return
        state.hasMoved = true
        wasDraggedRef.current = true
      }

      const deltaMin = ((e.clientY - state.anchorY) / hourHeight) * 60

      let times: DragTimes
      let columnIndex: number
      if (state.mode.kind === 'move') {
        columnIndex = columnIndexAtClientX?.(e.clientX) ?? state.originColumnIndex
        const targetDate = dateForColumn(columnIndex)
        times = computeMovedTimes(
          state.originStartMin,
          state.durationMin,
          deltaMin,
          snap,
          targetDate
        )
      } else {
        columnIndex = state.originColumnIndex
        times = computeResizedTimes(
          state.originStartMin,
          state.originEndMin,
          deltaMin,
          state.mode.edge,
          snap,
          state.originDate
        )
      }
      state.last = times
      setDrag({
        projectionId: state.item.projectionId,
        columnIndex,
        top: times.startMin * pxPerMinute,
        height: (times.endMin - times.startMin) * pxPerMinute
      })
    },
    [columnIndexAtClientX, dateForColumn, hourHeight, pxPerMinute, snap]
  )

  const handleMouseUp = useCallback(() => {
    const state = dragState.current
    dragState.current = null
    setActive(false)
    if (!state || !state.hasMoved || !state.last) {
      setDrag(null)
      return
    }
    const { item, last } = state
    const changed = last.startAt !== item.startAt || last.endAt !== (item.endAt ?? null)
    if (!changed) {
      setDrag(null)
      return
    }
    void Promise.resolve(onCommit(item, last.startAt, last.endAt)).finally(() => setDrag(null))
  }, [onCommit])

  useEffect(() => {
    if (!active) return
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [active, handleMouseMove, handleMouseUp])

  const wasDragged = useCallback(() => {
    const value = wasDraggedRef.current
    wasDraggedRef.current = false
    return value
  }, [])

  return { drag, startMove, startResize, wasDragged }
}
