import { cn } from '@/lib/utils'
import type { CalendarProjectionItem } from '@/services/calendar-service'

const CHIP_STYLES: Record<CalendarProjectionItem['visualType'], string> = {
  event:
    'border-[#D8B4FE] bg-[#FAF5FF] text-violet-800 dark:border-violet-500/30 dark:bg-violet-950/30 dark:text-violet-200',
  task:
    'border-[#BEDBFF] bg-[#EFF6FF] text-blue-800 dark:border-blue-500/30 dark:bg-blue-950/30 dark:text-blue-200',
  reminder:
    'border-[#B9F8CF] bg-[#F0FDF4] text-green-800 dark:border-green-500/30 dark:bg-green-950/30 dark:text-green-200',
  snooze:
    'border-[#FFD6A7] bg-[#FFF7ED] text-orange-800 dark:border-orange-500/30 dark:bg-orange-950/30 dark:text-orange-200',
  external_event:
    'border-[#E5E5E5] bg-[#FAFAFA] text-neutral-600 dark:border-neutral-700 dark:bg-neutral-800/50 dark:text-neutral-300'
}

function formatTime(item: CalendarProjectionItem): string {
  if (item.isAllDay) return 'All day'
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(item.startAt))
}

interface CalendarItemChipProps {
  item: CalendarProjectionItem
  onClick?: (item: CalendarProjectionItem) => void
}

export function CalendarItemChip({ item, onClick }: CalendarItemChipProps): React.JSX.Element {
  const cls = cn(
    'flex w-full items-center justify-between gap-0.5 rounded-[6px] border px-2 py-1 text-left transition-colors',
    CHIP_STYLES[item.visualType],
    onClick && 'cursor-pointer hover:brightness-95'
  )

  const content = (
    <>
      <span className="flex-1 truncate text-xs font-semibold leading-[18px]">{item.title}</span>
      <span className="shrink-0 text-xs leading-[18px] opacity-75">{formatTime(item)}</span>
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
