import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { useDndMonitor, useDroppable, type DragStartEvent } from '@dnd-kit/core'
import { useDragContext } from '@/contexts/drag-context'
import { minutesFromOffset, type SlotDropData } from '@/components/calendar/drop-time'
import { parseDateKey } from '@/lib/task-utils'
import {
  DEFAULT_BLOCK_MINUTES,
  TIMELINE_HOUR_HEIGHT,
  TIMELINE_SNAP_MINUTES
} from './timeline-layout'

const EDGE_PX = 32
const MAX_SCROLL_PX_PER_FRAME = 12

export interface DropPreview {
  startMin: number
  endMin: number
  scrollTop: number
}

/**
 * The timeline's drop target in the shared `type: 'date'`, `timeBehavior: 'slot'`
 * contract, so App's drag handler resolves it like a calendar column.
 */
export function timelineDropData(
  date: string,
  getSlotOffsetY: () => number | null
): SlotDropData & Record<string, unknown> {
  return {
    type: 'date',
    date: parseDateKey(date),
    dateKey: date,
    timeBehavior: 'slot',
    hourHeight: TIMELINE_HOUR_HEIGHT,
    snapMinutes: TIMELINE_SNAP_MINUTES,
    durationIfUntimed: DEFAULT_BLOCK_MINUTES,
    getSlotOffsetY
  }
}

function activatorClientY(event: Event): number | null {
  if ('clientY' in event && typeof event.clientY === 'number') return event.clientY
  return null
}

interface Pointer {
  x: number
  y: number
}

/**
 * Tracks a task drag against the timeline: the real pointer (dnd-kit's cached
 * rects go stale while this container scrolls), the dashed drop preview, and
 * edge auto-scroll. dnd-kit's own auto-scroll never reaches this container,
 * because the dragged node is the global DragOverlay, not a descendant of it.
 */
export function useTimelineDrag({
  date,
  scrollRef,
  columnRef
}: {
  date: string
  scrollRef: RefObject<HTMLDivElement | null>
  columnRef: RefObject<HTMLDivElement | null>
}): { setDropRef: (node: HTMLElement | null) => void; preview: DropPreview | null } {
  const { dragState } = useDragContext()
  const pointer = useRef<Pointer | null>(null)
  const grabOffset = useRef(0)
  const [active, setActive] = useState(false)
  const [preview, setPreview] = useState<DropPreview | null>(null)

  const draggedTask = dragState.draggedTasks[0]
  const previewMinutes = draggedTask?.dueTime
    ? (draggedTask.durationMinutes ?? DEFAULT_BLOCK_MINUTES)
    : DEFAULT_BLOCK_MINUTES

  const getSlotOffsetY = useCallback((): number | null => {
    const column = columnRef.current
    if (!pointer.current || !column) return null
    return pointer.current.y - grabOffset.current - column.getBoundingClientRect().top
  }, [columnRef])

  const { setNodeRef } = useDroppable({
    id: `day-timeline:${date}`,
    data: timelineDropData(date, getSlotOffsetY)
  })

  useDndMonitor({
    onDragStart(event: DragStartEvent) {
      const type = event.active.data.current?.type
      if (type !== 'task' && type !== 'calendar-task') return
      const startY = activatorClientY(event.activatorEvent)
      const initialTop = event.active.rect.current.initial?.top
      grabOffset.current = startY !== null && initialTop !== undefined ? startY - initialTop : 0
      pointer.current = null
      setActive(true)
    },
    onDragEnd() {
      setActive(false)
    },
    onDragCancel() {
      setActive(false)
    }
  })

  useEffect(() => {
    if (!active) return
    const onMove = (event: PointerEvent): void => {
      pointer.current = { x: event.clientX, y: event.clientY }
    }
    window.addEventListener('pointermove', onMove, true)

    let frame = 0
    const tick = (): void => {
      frame = requestAnimationFrame(tick)
      const scroller = scrollRef.current
      const at = pointer.current
      if (!scroller || !at) return
      const box = scroller.getBoundingClientRect()
      const inside = at.x >= box.left && at.x <= box.right && at.y >= box.top && at.y <= box.bottom
      if (!inside) {
        setPreview((prev) => (prev === null ? prev : null))
        return
      }
      if (at.y < box.top + EDGE_PX) {
        scroller.scrollTop -= MAX_SCROLL_PX_PER_FRAME * (1 - (at.y - box.top) / EDGE_PX)
      } else if (at.y > box.bottom - EDGE_PX) {
        scroller.scrollTop += MAX_SCROLL_PX_PER_FRAME * (1 - (box.bottom - at.y) / EDGE_PX)
      }
      const offset = getSlotOffsetY()
      if (offset === null) return
      const startMin = minutesFromOffset(offset, TIMELINE_HOUR_HEIGHT, TIMELINE_SNAP_MINUTES)
      const endMin = Math.min(1440, startMin + previewMinutes)
      const scrollTop = scroller.scrollTop
      setPreview((prev) =>
        prev?.startMin === startMin && prev.endMin === endMin && prev.scrollTop === scrollTop
          ? prev
          : { startMin, endMin, scrollTop }
      )
    }
    frame = requestAnimationFrame(tick)
    return () => {
      window.removeEventListener('pointermove', onMove, true)
      cancelAnimationFrame(frame)
    }
  }, [active, getSlotOffsetY, previewMinutes, scrollRef])

  return { setDropRef: setNodeRef, preview: active ? preview : null }
}
