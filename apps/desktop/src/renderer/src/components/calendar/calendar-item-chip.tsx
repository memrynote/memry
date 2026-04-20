import { useEffect, useState } from 'react'
import { formatTimeOfDay } from '@/lib/time-format'
import type { ClockFormat } from '@/lib/time-format'
import { cn } from '@/lib/utils'
import type { CalendarProjectionItem } from '@/services/calendar-service'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import type { AnchorRect } from './types'
import { VISUAL_TYPE_META } from './visual-type-meta'

function isItemInPast(item: CalendarProjectionItem, now: Date): boolean {
  if (item.isAllDay) {
    const start = new Date(item.startAt)
    const startDay = new Date(start.getFullYear(), start.getMonth(), start.getDate()).getTime()
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    return startDay < today
  }
  const startMs = new Date(item.startAt).getTime()
  const endMs = item.endAt ? new Date(item.endAt).getTime() : startMs
  return endMs <= now.getTime()
}

function useMinuteTick(): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const msToNextMinute = 60_000 - (Date.now() % 60_000)
    let interval: ReturnType<typeof setInterval> | undefined
    const timeout = setTimeout(() => {
      setNow(new Date())
      interval = setInterval(() => setNow(new Date()), 60_000)
    }, msToNextMinute)
    return () => {
      clearTimeout(timeout)
      if (interval) clearInterval(interval)
    }
  }, [])
  return now
}

interface CalendarItemChipProps {
  item: CalendarProjectionItem
  clockFormat?: ClockFormat
  onClick?: (item: CalendarProjectionItem, rect: AnchorRect) => void
  onDeleteItem?: (item: CalendarProjectionItem) => void
}

function canDeleteEvent(item: CalendarProjectionItem): boolean {
  return item.sourceType === 'event' && item.editability.canDelete
}

export function CalendarItemChip({
  item,
  clockFormat = '12h',
  onClick,
  onDeleteItem
}: CalendarItemChipProps): React.JSX.Element {
  const timeLabel = item.isAllDay ? 'All day' : formatTimeOfDay(new Date(item.startAt), clockFormat)
  const now = useMinuteTick()
  const isPast = isItemInPast(item, now)
  const cls = cn(
    'flex h-full w-full items-start justify-between gap-0.5 rounded-[6px] py-0.5 text-left transition-opacity @xl:px-2 @xl:py-1 opacity-90',
    VISUAL_TYPE_META[item.visualType].chipClassName,
    isPast && 'opacity-50',
    onClick && 'cursor-pointer hover:brightness-95'
  )

  const content = (
    <>
      <span className="flex-1 truncate text-xs font-semibold leading-[18px]">{item.title}</span>
      <span className="hidden shrink-0 text-xs leading-[18px] opacity-75 @xl:inline">
        {timeLabel}
      </span>
    </>
  )

  const chip = onClick ? (
    <button
      type="button"
      className={cls}
      onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect()
        onClick(item, {
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height
        })
      }}
      data-visual-type={item.visualType}
      data-is-past={isPast || undefined}
    >
      {content}
    </button>
  ) : (
    <div className={cls} data-visual-type={item.visualType} data-is-past={isPast || undefined}>
      {content}
    </div>
  )

  if (onDeleteItem && canDeleteEvent(item)) {
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>{chip}</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem
            onSelect={() => onDeleteItem(item)}
            className="text-destructive focus:text-destructive"
          >
            Delete event
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    )
  }

  return chip
}

export default CalendarItemChip
