import { useCallback, useMemo } from 'react'
import { useT } from '@memry/i18n/renderer'
import { AlarmClock, Calendar2, CheckSquare3, NotificationSnooze, StickyNote } from '@/lib/icons'
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
  external_event: Calendar2,
  note: StickyNote,
  note_date: StickyNote
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
  const { t } = useT('calendar')
  const deleteLabel = t('delete-dialog.context-menu-delete-label')
  const timeLabel = item.isAllDay
    ? t('time.all-day')
    : formatTimeOfDay(new Date(item.startAt), clockFormat)
  const VisualIcon = VISUAL_TYPE_ICONS[item.visualType]
  const deletable = Boolean(onDeleteItem) && canDeleteEvent(item)
  const cls = cn(
    'flex h-full w-full items-start justify-between gap-0.5 rounded-[6px] px-1 py-0.5 text-start @xl:px-2 @xl:py-1',
    'transition-[filter,transform] duration-100 ease-out',
    (onClick || deletable) &&
      'cursor-pointer hover:brightness-[1.06] active:scale-[0.98] active:brightness-[0.97]',
    // Fired note_date chips are kept but faded so the date isn't lost.
    item.isTriggered && 'opacity-60'
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

      const menuItems = [{ id: 'delete', label: deleteLabel, accelerator: 'Backspace' }]

      void window.api.showContextMenu(menuItems).then((selectedId) => {
        if (selectedId === 'delete') {
          onDeleteItem(item)
        }
      })
    },
    [item, onDeleteItem, deletable, deleteLabel]
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
        data-triggered={item.isTriggered ? 'true' : undefined}
      >
        {content}
      </button>
    )
  }

  return (
    <div
      className={cls}
      style={chipStyle}
      data-visual-type={item.visualType}
      data-triggered={item.isTriggered ? 'true' : undefined}
    >
      {content}
    </div>
  )
}

export default CalendarItemChip
