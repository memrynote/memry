import { formatTimeOfDay } from '@/lib/time-format'
import type { ClockFormat } from '@/lib/time-format'
import { cn } from '@/lib/utils'
import type { CalendarProjectionItem } from '@/services/calendar-service'

const CHIP_STYLES: Record<CalendarProjectionItem['visualType'], string> = {
  event:
    'border-[#D8B4FE] bg-[#FAF5FF] text-violet-800 dark:border-violet-500/30 dark:bg-violet-950/30 dark:text-violet-200',
  task: 'border-[#BEDBFF] bg-[#EFF6FF] text-blue-800 dark:border-blue-500/30 dark:bg-blue-950/30 dark:text-blue-200',
  reminder:
    'border-[#B9F8CF] bg-[#F0FDF4] text-green-800 dark:border-green-500/30 dark:bg-green-950/30 dark:text-green-200',
  snooze:
    'border-[#FFD6A7] bg-[#FFF7ED] text-orange-800 dark:border-orange-500/30 dark:bg-orange-950/30 dark:text-orange-200',
  external_event: 'border-border bg-surface text-muted-foreground'
}

interface CalendarItemChipProps {
  item: CalendarProjectionItem
  clockFormat?: ClockFormat
  onClick?: (item: CalendarProjectionItem) => void
}

export function CalendarItemChip({
  item,
  clockFormat = '12h',
  onClick
}: CalendarItemChipProps): React.JSX.Element {
  const timeLabel = item.isAllDay ? 'All day' : formatTimeOfDay(new Date(item.startAt), clockFormat)
  const cls = cn(
    'flex h-full w-full items-start justify-between gap-0.5 rounded-[6px] border px-1 py-0.5 text-left transition-colors @xl:px-2 @xl:py-1',
    CHIP_STYLES[item.visualType],
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

  if (onClick) {
    return (
      <button
        type="button"
        className={cls}
        onClick={() => onClick(item)}
        data-visual-type={item.visualType}
      >
        {content}
      </button>
    )
  }

  return (
    <div className={cls} data-visual-type={item.visualType}>
      {content}
    </div>
  )
}

export default CalendarItemChip
