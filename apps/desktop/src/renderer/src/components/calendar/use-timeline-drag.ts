import { useCallback, useEffect, useRef, useState } from 'react'
import type { Task } from '@/data/task-model'
import {
  applyTimelineEdit,
  dateAtOffset,
  scheduleRange,
  type TimelineDates,
  type TimelineEdit,
  type TimelineShape,
  type TimelineWindow
} from './timeline-model'

/** Pixels the pointer travels before a press becomes a drag. */
const DRAG_THRESHOLD_PX = 4
/** Distance from the scroller's inline edges where a drag scrolls it. */
const EDGE_ZONE_PX = 48
const EDGE_STEP_PX = 14

export interface TimelinePreview {
  taskId: string
  dates: TimelineDates
}

interface Options {
  window: TimelineWindow
  dayWidth: number
  scrollRef: React.RefObject<HTMLDivElement | null>
  listWidth: number
  isRtl: () => boolean
  onCommit: (task: Task, dates: TimelineDates) => void
}

export interface TimelineDragApi {
  preview: TimelinePreview | null
  /** Press on a bar or milestone: move, or resize from a handle. */
  startEdit: (
    event: React.PointerEvent,
    task: Task,
    shape: TimelineShape,
    edit: TimelineEdit
  ) => void
  /** Press on an unscheduled row: click for a due date, drag for a range. */
  startSchedule: (event: React.PointerEvent, task: Task) => void
  dayFromPointer: (event: React.PointerEvent) => string | null
}

function inlineScroll(el: HTMLElement, rtl: boolean): number {
  return rtl ? -el.scrollLeft : el.scrollLeft
}

export function useTimelineDrag({
  window: timelineWindow,
  dayWidth,
  scrollRef,
  listWidth,
  isRtl,
  onCommit
}: Options): TimelineDragApi {
  const [preview, setPreview] = useState<TimelinePreview | null>(null)
  const cleanupRef = useRef<(() => void) | null>(null)

  useEffect(() => () => cleanupRef.current?.(), [])

  const dayAtClientX = useCallback(
    (clientX: number, track: HTMLElement): string | null => {
      const rect = track.getBoundingClientRect()
      const x = isRtl() ? rect.right - clientX : clientX - rect.left
      const offset = Math.floor(x / dayWidth)
      if (offset < 0 || offset >= timelineWindow.dayCount) return null
      return dateAtOffset(offset, timelineWindow)
    },
    [dayWidth, timelineWindow, isRtl]
  )

  const dayFromPointer = useCallback(
    (event: React.PointerEvent): string | null => {
      const track = (event.currentTarget as HTMLElement).closest<HTMLElement>(
        '[data-timeline-track]'
      )
      return track ? dayAtClientX(event.clientX, track) : null
    },
    [dayAtClientX]
  )

  /**
   * Shared gesture plumbing: window listeners (a bar can re-render out from
   * under pointer capture), a drag threshold, edge auto-scroll, Escape to
   * cancel. `onMove` gets the inline distance travelled, scroll included.
   */
  const runGesture = useCallback(
    (
      event: React.PointerEvent,
      handlers: {
        onMove: (distance: number, clientX: number) => void
        onEnd: (moved: boolean, clientX: number) => void
      }
    ): void => {
      cleanupRef.current?.()
      const scroller = scrollRef.current
      const rtl = isRtl()
      const startX = event.clientX
      const startScroll = scroller ? inlineScroll(scroller, rtl) : 0
      let moved = false
      let lastX = startX

      const distance = (clientX: number): number => {
        const scrolled = scroller ? inlineScroll(scroller, rtl) - startScroll : 0
        return (clientX - startX) * (rtl ? -1 : 1) + scrolled
      }

      const autoScroll = (clientX: number): void => {
        if (!scroller) return
        const rect = scroller.getBoundingClientRect()
        // No layout (hidden pane, or a DOM without one): no edges to scroll at.
        if (rect.width === 0) return
        const trackStart = rtl ? rect.right - listWidth : rect.left + listWidth
        const nearStart = rtl
          ? clientX > trackStart - EDGE_ZONE_PX
          : clientX < trackStart + EDGE_ZONE_PX
        const nearEnd = rtl
          ? clientX < rect.left + EDGE_ZONE_PX
          : clientX > rect.right - EDGE_ZONE_PX
        const step = nearEnd ? EDGE_STEP_PX : nearStart ? -EDGE_STEP_PX : 0
        if (step !== 0) scroller.scrollLeft += rtl ? -step : step
      }

      const move = (e: PointerEvent): void => {
        lastX = e.clientX
        if (!moved && Math.abs(e.clientX - startX) < DRAG_THRESHOLD_PX) return
        moved = true
        autoScroll(e.clientX)
        handlers.onMove(distance(e.clientX), e.clientX)
      }
      const finish = (commit: boolean): void => {
        cleanup()
        if (commit) handlers.onEnd(moved, lastX)
        setPreview(null)
      }
      const up = (e: PointerEvent): void => {
        lastX = e.clientX
        finish(true)
      }
      const cancel = (): void => finish(false)
      const key = (e: KeyboardEvent): void => {
        if (e.key !== 'Escape') return
        e.preventDefault()
        e.stopPropagation()
        finish(false)
      }
      const cleanup = (): void => {
        globalThis.removeEventListener('pointermove', move)
        globalThis.removeEventListener('pointerup', up)
        globalThis.removeEventListener('pointercancel', cancel)
        globalThis.removeEventListener('keydown', key, true)
        cleanupRef.current = null
      }

      globalThis.addEventListener('pointermove', move)
      globalThis.addEventListener('pointerup', up)
      globalThis.addEventListener('pointercancel', cancel)
      globalThis.addEventListener('keydown', key, true)
      cleanupRef.current = cleanup
    },
    [scrollRef, isRtl, listWidth]
  )

  const startEdit = useCallback(
    (event: React.PointerEvent, task: Task, shape: TimelineShape, edit: TimelineEdit): void => {
      if (event.button !== 0 || shape.kind === 'none') return
      // A handle sits on its bar: stop its press from also starting a move.
      // The caller selects the row itself.
      event.stopPropagation()
      event.preventDefault()
      let delta = 0
      runGesture(event, {
        onMove: (distance) => {
          const next = Math.round(distance / dayWidth)
          if (next === delta) return
          delta = next
          setPreview({ taskId: task.id, dates: applyTimelineEdit(shape, edit, delta) })
        },
        onEnd: (moved) => {
          if (moved && delta !== 0) onCommit(task, applyTimelineEdit(shape, edit, delta))
        }
      })
    },
    [runGesture, dayWidth, onCommit]
  )

  const startSchedule = useCallback(
    (event: React.PointerEvent, task: Task): void => {
      if (event.button !== 0) return
      const track = (event.currentTarget as HTMLElement).closest<HTMLElement>(
        '[data-timeline-track]'
      )
      if (!track) return
      const from = dayAtClientX(event.clientX, track)
      if (!from) return
      event.preventDefault()
      setPreview({ taskId: task.id, dates: scheduleRange(from, from) })
      runGesture(event, {
        onMove: (_distance, clientX) => {
          const to = dayAtClientX(clientX, track) ?? from
          setPreview({ taskId: task.id, dates: scheduleRange(from, to) })
        },
        onEnd: (moved, clientX) => {
          const to = moved ? (dayAtClientX(clientX, track) ?? from) : from
          onCommit(task, scheduleRange(from, to))
        }
      })
    },
    [runGesture, dayAtClientX, onCommit]
  )

  return { preview, startEdit, startSchedule, dayFromPointer }
}
