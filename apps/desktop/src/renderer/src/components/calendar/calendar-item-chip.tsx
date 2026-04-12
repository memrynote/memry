import { cn } from '@/lib/utils'
import type { CalendarProjectionItem } from '@/services/calendar-service'

const VISUAL_STYLES: Record<CalendarProjectionItem['visualType'], string> = {
  event: 'border-amber-500/30 bg-amber-500/10 text-amber-950 dark:text-amber-100',
  task: 'border-sky-500/30 bg-sky-500/10 text-sky-950 dark:text-sky-100',
  reminder: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-950 dark:text-emerald-100',
  snooze: 'border-fuchsia-500/30 bg-fuchsia-500/10 text-fuchsia-950 dark:text-fuchsia-100',
  external_event: 'border-slate-500/30 bg-slate-500/10 text-slate-950 dark:text-slate-100'
}

const VISUAL_LABELS: Record<CalendarProjectionItem['visualType'], string> = {
  event: 'Event',
  task: 'Task',
  reminder: 'Reminder',
  snooze: 'Snooze',
  external_event: 'Imported'
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

export function CalendarItemChip({
  item,
  onClick
}: CalendarItemChipProps): React.JSX.Element {
  const className = cn(
    'w-full rounded-lg border px-3 py-2 text-left transition-colors',
    VISUAL_STYLES[item.visualType],
    onClick ? 'hover:bg-accent/60 cursor-pointer' : ''
  )

  const content = (
    <>
      <div className="flex items-center justify-between gap-3">
        <span className="truncate text-sm font-medium">{item.title}</span>
        <span className="shrink-0 text-[11px] font-medium uppercase tracking-[0.16em] opacity-75">
          {formatTime(item)}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-2 text-[11px] opacity-75">
        <span>{VISUAL_LABELS[item.visualType]}</span>
        <span>{item.source.title ?? 'Memry'}</span>
      </div>
    </>
  )

  if (onClick) {
    return (
      <button
        type="button"
        className={className}
        data-visual-type={item.visualType}
        onClick={() => onClick(item)}
      >
        {content}
      </button>
    )
  }

  return (
    <div className={className} data-visual-type={item.visualType}>
      {content}
    </div>
  )
}

export default CalendarItemChip
