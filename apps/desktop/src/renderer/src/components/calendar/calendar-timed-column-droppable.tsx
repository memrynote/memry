import { useDndMonitor, useDroppable, type Active, type DragMoveEvent } from '@dnd-kit/core'
import { useState, type ReactNode } from 'react'
import { useOptionalDragContext } from '@/contexts/drag-context'
import { parseDateKey } from '@/lib/task-utils'
import { formatTimeRange, type ClockFormat } from '@/lib/time-format'
import { cn } from '@/lib/utils'
import { timeFromOffset } from './drop-time'
import { DEFAULT_BLOCK_MINUTES } from './time-grid-constants'

interface CalendarTimedColumnDroppableProps {
  date: string
  hourHeight: number
  /**
   * Draw where a dragged task would land, as a dashed block labelled with its
   * title and time range, instead of tinting the whole column.
   */
  dropPreview?: boolean
  clockFormat?: ClockFormat
  children: ReactNode
}

interface DropPreview {
  startMinutes: number
  durationMinutes: number
  title: string
}

/**
 * The dragged task's title and length. A Day Panel row carries them in its drag
 * payload; any other task drag falls back to the task drag-context resolved.
 */
function draggedTaskShape(
  active: Active,
  fallbackTitle: string | undefined
): { title: string; durationMinutes: number } | null {
  const data = active.data.current
  const isTaskDrag =
    data?.type === 'task' || data?.type === 'calendar-task' || data?.type === 'subtask'
  if (!isTaskDrag) return null
  const title = typeof data?.title === 'string' ? data.title : (fallbackTitle ?? '')
  const durationMinutes =
    typeof data?.durationMinutes === 'number' && data.durationMinutes > 0
      ? data.durationMinutes
      : DEFAULT_BLOCK_MINUTES
  return { title, durationMinutes }
}

function minutesFromTime(time: string): number {
  const [hours, minutes] = time.split(':').map(Number)
  return hours * 60 + minutes
}

/**
 * One droppable per day column rather than per 15-minute slot (96 slots/day
 * would mean 672 droppables in a week). `timeBehavior: 'slot'` tells
 * handleDragEnd to derive the time from where the chip landed.
 */
export function CalendarTimedColumnDroppable({
  date,
  hourHeight,
  dropPreview = false,
  clockFormat = '12h',
  children
}: CalendarTimedColumnDroppableProps): React.JSX.Element {
  const id = `calendar-timed-column:${date}`
  const { setNodeRef, isOver } = useDroppable({
    id,
    data: {
      type: 'date',
      date: parseDateKey(date),
      dateKey: date,
      timeBehavior: 'slot',
      hourHeight
    }
  })
  return (
    <div
      ref={setNodeRef}
      data-drop-date={date}
      className={cn('relative h-full', isOver && !dropPreview && 'bg-tint/10')}
    >
      {children}
      {dropPreview && (
        <TimedColumnDropPreview
          droppableId={id}
          date={date}
          hourHeight={hourHeight}
          clockFormat={clockFormat}
        />
      )}
    </div>
  )
}

interface TimedColumnDropPreviewProps {
  droppableId: string
  date: string
  hourHeight: number
  clockFormat: ClockFormat
}

/**
 * Its own component because `useDndMonitor` throws outside a DndContext, and
 * only the Day Panel timeline, which always sits in the app's DndContext, asks
 * for a preview.
 */
function TimedColumnDropPreview({
  droppableId,
  date,
  hourHeight,
  clockFormat
}: TimedColumnDropPreviewProps): React.JSX.Element | null {
  const fallbackTitle = useOptionalDragContext()?.dragState.draggedTasks[0]?.title
  const [preview, setPreview] = useState<DropPreview | null>(null)

  useDndMonitor({
    onDragMove(event: DragMoveEvent) {
      const activeTop = event.active.rect.current.translated?.top
      const shape = draggedTaskShape(event.active, fallbackTitle)
      if (event.over?.id !== droppableId || activeTop === undefined || !shape) {
        setPreview((prev) => (prev === null ? prev : null))
        return
      }
      // Same arithmetic as the drop handler, so the preview is where the task lands.
      const startMinutes = minutesFromTime(
        timeFromOffset(activeTop - event.over.rect.top, hourHeight)
      )
      setPreview((prev) =>
        prev?.startMinutes === startMinutes &&
        prev.durationMinutes === shape.durationMinutes &&
        prev.title === shape.title
          ? prev
          : { startMinutes, ...shape }
      )
    },
    onDragEnd: () => setPreview(null),
    onDragCancel: () => setPreview(null)
  })

  if (!preview) return null
  const [year, month, day] = date.split('-').map(Number)
  const start = new Date(year, month - 1, day, 0, preview.startMinutes)
  const end = new Date(start.getTime() + preview.durationMinutes * 60_000)

  return (
    <div
      data-testid="timed-column-drop-preview"
      className="pointer-events-none absolute inset-x-0.5 z-30 flex flex-col gap-px overflow-hidden rounded-[4px] border border-dashed border-tint bg-tint/10 px-2 py-1"
      style={{
        top: (preview.startMinutes / 60) * hourHeight,
        height: Math.max((preview.durationMinutes / 60) * hourHeight - 2, 18)
      }}
    >
      <span className="truncate text-xs font-medium leading-4 text-foreground">
        {preview.title}
      </span>
      <span className="truncate text-[11px] leading-[14px] tabular-nums text-muted-foreground">
        {formatTimeRange(start, end, clockFormat)}
      </span>
    </div>
  )
}
