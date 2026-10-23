import { useCallback, useRef, useState, type CSSProperties } from 'react'
import { useDraggable } from '@dnd-kit/core'
import { useT } from '@memry/i18n/renderer'
import { cn } from '@/lib/utils'
import { getEventBaseColor } from '@/lib/event-type-colors'
import { formatClockMinutes } from '@/components/calendar/drop-time'
import { resizeSteps, type PlacedTimelineItem } from './timeline-layout'

const MIN_BLOCK_PX = 18

function blockStyle(placed: PlacedTimelineItem, endMin: number, hourHeight: number): CSSProperties {
  const pxPerMin = hourHeight / 60
  const width = 100 / placed.columns
  return {
    top: placed.startMin * pxPerMin,
    height: Math.max((endMin - placed.startMin) * pxPerMin - 1, MIN_BLOCK_PX),
    insetInlineStart: `${placed.column * width}%`,
    width: `calc(${width}% - 2px)`
  }
}

export function TimelineEventBlock({
  placed,
  hourHeight,
  timeLabel,
  onHoverColor
}: {
  placed: PlacedTimelineItem
  hourHeight: number
  timeLabel: string
  onHoverColor?: (color: string | null) => void
}): React.JSX.Element {
  const rail = getEventBaseColor(placed.kind)
  return (
    <div
      data-testid="timeline-event"
      className="absolute overflow-hidden rounded-e border-s-2 bg-muted px-1.5 py-0.5"
      style={{ ...blockStyle(placed, placed.endMin, hourHeight), borderColor: rail }}
      onMouseEnter={() => onHoverColor?.(rail)}
      onMouseLeave={() => onHoverColor?.(null)}
    >
      <p className="truncate text-[12px] font-medium leading-4 text-foreground/90">
        {placed.title}
      </p>
      <p className="truncate font-mono text-[10px] tabular-nums leading-3 text-muted-foreground">
        {timeLabel}
      </p>
    </div>
  )
}

/**
 * A bottom-edge resize on a pointer drag. Commits the stepped duration on
 * release; the block draws the pending end until the refetch lands.
 */
function useBlockResize(
  placed: PlacedTimelineItem,
  hourHeight: number,
  onResize: (minutes: number) => void
): {
  pendingEndMin: number | null
  onPointerDown: (event: React.PointerEvent) => void
  consumeResizeClick: () => boolean
} {
  const [pending, setPending] = useState<{ baseEndMin: number; endMin: number } | null>(null)
  const origin = useRef<{ y: number; minutes: number } | null>(null)
  // The release of a resize also lands as a click on the block, which would open the task.
  const resized = useRef(false)
  const consumeResizeClick = useCallback(() => {
    const value = resized.current
    resized.current = false
    return value
  }, [])
  const pendingEndMin = pending?.baseEndMin === placed.endMin ? pending.endMin : null
  const setPendingEndMin = useCallback(
    (endMin: number | null) => {
      setPending(endMin === null ? null : { baseEndMin: placed.endMin, endMin })
    },
    [placed.endMin]
  )

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (event.button !== 0) return
      event.stopPropagation()
      event.preventDefault()
      const current = placed.endMin - placed.startMin
      const max = 1440 - placed.startMin
      origin.current = { y: event.clientY, minutes: current }
      resized.current = true
      const move = (e: PointerEvent): void => {
        if (!origin.current) return
        const minutes = resizeSteps(
          origin.current.minutes,
          e.clientY - origin.current.y,
          hourHeight,
          max
        )
        setPendingEndMin(placed.startMin + minutes)
      }
      const up = (e: PointerEvent): void => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        window.setTimeout(() => {
          resized.current = false
        })
        if (!origin.current) return
        const minutes = resizeSteps(
          origin.current.minutes,
          e.clientY - origin.current.y,
          hourHeight,
          max
        )
        origin.current = null
        if (minutes === current) {
          setPendingEndMin(null)
          return
        }
        setPendingEndMin(placed.startMin + minutes)
        onResize(minutes)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [hourHeight, onResize, placed.endMin, placed.startMin, setPendingEndMin]
  )

  return { pendingEndMin, onPointerDown, consumeResizeClick }
}

export function TimelineTaskBlock({
  placed,
  hourHeight,
  formatTime,
  onComplete,
  onOpen,
  onResize
}: {
  placed: PlacedTimelineItem
  hourHeight: number
  formatTime: (minutes: number) => string
  onComplete: (taskId: string) => void
  onOpen: (taskId: string) => void
  onResize: (taskId: string, minutes: number) => void
}): React.JSX.Element {
  const { t } = useT('journal')
  const taskId = placed.sourceId
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `day-timeline-task:${taskId}`,
    data: { type: 'calendar-task', sourceType: 'calendar', taskId }
  })
  const handleResize = useCallback(
    (minutes: number) => {
      onResize(taskId, minutes)
    },
    [onResize, taskId]
  )
  const { pendingEndMin, onPointerDown, consumeResizeClick } = useBlockResize(
    placed,
    hourHeight,
    handleResize
  )
  const endMin = pendingEndMin ?? placed.endMin
  const range = t('dayTimeline.range', {
    start: formatTime(placed.startMin),
    end: formatTime(endMin)
  })

  return (
    <div
      ref={setNodeRef}
      data-testid="timeline-task"
      data-task-id={taskId}
      data-start={formatClockMinutes(placed.startMin)}
      data-end={formatClockMinutes(endMin)}
      {...attributes}
      {...listeners}
      role="button"
      tabIndex={0}
      aria-label={t('dayTimeline.openTask', { title: placed.title, range })}
      onClick={() => {
        if (!consumeResizeClick()) onOpen(taskId)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          onOpen(taskId)
          return
        }
        listeners?.onKeyDown?.(event)
      }}
      className={cn(
        'group absolute flex cursor-grab touch-none gap-1.5 overflow-hidden rounded-e border-s-2 border-tint bg-tint/15 px-1.5 py-0.5 text-start',
        'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-foreground',
        isDragging && 'opacity-40'
      )}
      style={blockStyle(placed, endMin, hourHeight)}
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={false}
        aria-label={t('dayTimeline.completeTask', { title: placed.title })}
        onPointerDown={(event) => {
          event.stopPropagation()
        }}
        onClick={(event) => {
          event.stopPropagation()
          onComplete(taskId)
        }}
        className="mt-0.5 size-3 shrink-0 rounded-full border border-foreground/50 hover:bg-tint/30 focus-visible:outline-2 focus-visible:outline-foreground"
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[12px] font-medium leading-4 text-foreground">{placed.title}</p>
        <p
          className={cn(
            'truncate font-mono text-[10px] tabular-nums leading-3 text-muted-foreground',
            pendingEndMin !== null && 'font-semibold text-foreground'
          )}
        >
          {range}
        </p>
      </div>
      <div
        data-testid="timeline-task-resize"
        aria-hidden="true"
        onPointerDown={onPointerDown}
        className="absolute inset-x-0 bottom-0 h-1.5 cursor-ns-resize group-hover:bg-tint/40"
      />
    </div>
  )
}
