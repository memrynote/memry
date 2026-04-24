import { useMemo } from 'react'
import { ChevronLeft, ChevronRight } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { formatDateParts, getMonthName } from '@/lib/journal-utils'
import type { JournalViewState } from './date-breadcrumb'

interface JournalBreadcrumbProps {
  viewState: JournalViewState
  isToday: boolean
  onPreviousDay: () => void
  onNextDay: () => void
  onMonthClick: (year: number, month: number) => void
  onYearClick: (year: number) => void
  onTodayClick: () => void
  className?: string
}

const CRUMB_CLASS =
  'text-xs text-muted-foreground hover:bg-muted rounded-sm px-1 py-0.5 transition-colors cursor-pointer bg-transparent border-none'

const BACK_BTN_CLASS =
  'flex items-center justify-center shrink-0 text-muted-foreground hover:text-foreground transition-colors bg-transparent border-none cursor-pointer p-0'

export function JournalBreadcrumb({
  viewState,
  isToday,
  onPreviousDay,
  onNextDay,
  onMonthClick,
  onYearClick,
  onTodayClick,
  className
}: JournalBreadcrumbProps) {
  const dateParts = useMemo(() => {
    if (viewState.type === 'day') return formatDateParts(viewState.date)
    return null
  }, [viewState])

  if (viewState.type === 'day' && dateParts) {
    return (
      <nav
        aria-label="Journal date navigation"
        className={cn('flex items-center gap-1.5 text-xs leading-4 select-none', className)}
      >
        <button
          type="button"
          onClick={onPreviousDay}
          className={BACK_BTN_CLASS}
          aria-label="Previous day"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        <button type="button" onClick={onNextDay} className={BACK_BTN_CLASS} aria-label="Next day">
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
        <button type="button" onClick={() => onYearClick(dateParts.year)} className={CRUMB_CLASS}>
          {dateParts.year}
        </button>
        <span className="text-xs text-text-secondary px-0.5">/</span>
        <button
          type="button"
          onClick={() => onMonthClick(dateParts.year, dateParts.monthIndex)}
          className={CRUMB_CLASS}
        >
          {dateParts.month}
        </button>
        <span className="text-xs text-text-secondary px-0.5">/</span>
        <span className="text-xs text-foreground font-medium">{dateParts.day}</span>
        {isToday && (
          <span className="ml-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-amber-700 dark:text-amber-400 bg-amber-500/10 rounded-full px-2 py-0.5 border border-amber-500/20">
            Today
          </span>
        )}
      </nav>
    )
  }

  if (viewState.type === 'month') {
    const monthName = getMonthName(viewState.month)
    return (
      <nav
        aria-label="Journal date navigation"
        className={cn('flex items-center gap-1.5 text-xs leading-4 select-none', className)}
      >
        <button
          type="button"
          onClick={() => onYearClick(viewState.year)}
          className={BACK_BTN_CLASS}
          aria-label="Go to year view"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        <button type="button" onClick={() => onYearClick(viewState.year)} className={CRUMB_CLASS}>
          {viewState.year}
        </button>
        <span className="text-xs text-text-secondary px-0.5">/</span>
        <span className="text-xs text-foreground font-medium">{monthName}</span>
      </nav>
    )
  }

  if (viewState.type === 'year') {
    return (
      <nav
        aria-label="Journal date navigation"
        className={cn('flex items-center gap-1.5 text-xs leading-4 select-none', className)}
      >
        <span className="text-xs text-foreground font-medium">{viewState.year}</span>
      </nav>
    )
  }

  return null
}
