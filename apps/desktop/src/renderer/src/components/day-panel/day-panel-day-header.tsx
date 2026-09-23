import { useT } from '@memry/i18n/renderer'
import { ArrowUpRight } from '@/lib/icons'
import { parseISODate } from '@/lib/journal-utils'

interface DayPanelDayHeaderProps {
  date: string
  isToday: boolean
  /** Omitted when the Calendar module is off. */
  onOpenCalendar?: (date: string) => void
}

/**
 * Names the day the timeline and task list below belong to. Today reads
 * "Today  Wed, Sep 23"; any other day reads "Thursday  Sep 24".
 */
export function DayPanelDayHeader({
  date,
  isToday,
  onOpenCalendar
}: DayPanelDayHeaderProps): React.JSX.Element {
  const { t, i18n } = useT('journal')
  const day = parseISODate(date)
  const title = isToday
    ? t('date.relative.today')
    : day.toLocaleDateString(i18n.language, { weekday: 'long' })
  const subtitle = day.toLocaleDateString(
    i18n.language,
    isToday
      ? { weekday: 'short', month: 'short', day: 'numeric' }
      : { month: 'short', day: 'numeric' }
  )
  const openLabel = t('dayPanel.openInCalendar')

  return (
    <div
      data-testid="day-panel-day-header"
      className="flex h-7 items-center justify-between gap-2 ps-[18px] pe-2.5"
    >
      <h2 className="flex min-w-0 items-baseline gap-2">
        <span className="truncate text-[15px] font-semibold tracking-[-0.015em] text-foreground">
          {title}
        </span>
        <span className="shrink-0 text-xs text-text-tertiary">{subtitle}</span>
      </h2>
      {onOpenCalendar && (
        <button
          type="button"
          aria-label={openLabel}
          title={openLabel}
          onClick={() => onOpenCalendar(date)}
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-surface-active hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <ArrowUpRight className="size-3.5 rtl:-scale-x-100" aria-hidden="true" />
        </button>
      )}
    </div>
  )
}
