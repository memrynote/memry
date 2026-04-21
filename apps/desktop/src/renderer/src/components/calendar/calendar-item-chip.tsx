import { useCallback, useMemo } from 'react'
import { AlarmClock, Calendar2, CheckSquare3, NotificationSnooze } from '@/lib/icons'
import { getEventBaseColor, getEventBgColor, getEventTextColor } from '@/lib/event-type-colors'
import { formatTimeOfDay } from '@/lib/time-format'
import type { ClockFormat } from '@/lib/time-format'
import { cn } from '@/lib/utils'
import type { CalendarProjectionItem } from '@/services/calendar-service'
import type { AnchorRect } from './types'

const VISUAL_TYPE_ICONS: Record<
  CalendarProjectionItem['visualType'],
  React.ComponentType<{ className?: string }>
> = {
  event: Calendar2,
  task: CheckSquare3,
  reminder: AlarmClock,
  snooze: NotificationSnooze,
  external_event: Calendar2
}

interface CalendarItemChipProps {
  item: CalendarProjectionItem
  clockFormat?: ClockFormat
  isSelected?: boolean
  onClick?: (item: CalendarProjectionItem, rect: AnchorRect) => void
  onDeleteItem?: (item: CalendarProjectionItem) => void
}

function canDeleteEvent(item: CalendarProjectionItem): boolean {
  return item.sourceType === 'event' && item.editability.canDelete
}

export function CalendarItemChip({
  item,
  clockFormat = '12h',
  isSelected = false,
  onClick,
  onDeleteItem
}: CalendarItemChipProps): React.JSX.Element {
  const timeLabel = item.isAllDay ? 'All day' : formatTimeOfDay(new Date(item.startAt), clockFormat)
  const VisualIcon = VISUAL_TYPE_ICONS[item.visualType]
  const deletable = Boolean(onDeleteItem) && canDeleteEvent(item)
  const cls = cn(
    'flex h-full w-full items-start justify-between gap-0.5 rounded-[6px] px-1 py-0.5 text-left transition-[filter] @xl:px-2 @xl:py-1',
    (onClick || deletable) && 'cursor-pointer hover:brightness-100'
  )
  const chipStyle = useMemo<React.CSSProperties>(
    () =>
      isSelected
        ? {
            backgroundColor: getEventBaseColor(item.visualType),
            color: '#FFFFFF'
          }
        : {
            backgroundColor: getEventBgColor(item.visualType),
            color: getEventTextColor(item.visualType)
          },
    [item.visualType, isSelected]
  )

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (!deletable || !onDeleteItem) return
      e.preventDefault()

      const menuItems = [{ id: 'delete', label: 'Delete event', accelerator: 'Backspace' }]

      void window.api.showContextMenu(menuItems).then((selectedId) => {
        if (selectedId === 'delete') {
          onDeleteItem(item)
        }
      })
    },
    [item, onDeleteItem, deletable]
  )

  const content = (
    <>
      <VisualIcon className="mt-0.5 size-3 shrink-0" />
      <span className="flex-1 truncate text-xs font-semibold leading-[18px]">{item.title}</span>
      <span className="hidden shrink-0 text-xs leading-[18px] opacity-75 @xl:inline">
        {timeLabel}
      </span>
    </>
  )

  if (onClick || deletable) {
    return (
      <button
        type="button"
        className={cls}
        style={chipStyle}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          onClick?.(item, {
            x: rect.left,
            y: rect.top,
            width: rect.width,
            height: rect.height
          })
        }}
        onContextMenu={deletable ? handleContextMenu : undefined}
        data-visual-type={item.visualType}
      >
        {content}
      </button>
    )
  }

  return (
    <div className={cls} style={chipStyle} data-visual-type={item.visualType}>
      {content}
    </div>
  )
}

export default CalendarItemChip
