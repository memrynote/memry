import { Button } from '@/components/ui/button'
import { ChevronLeft, ChevronRight, Plus, Search } from '@/lib/icons'
import { addLocalDays, getStartOfWeek, parseLocalDate } from './date-utils'

export type CalendarWorkspaceView = 'day' | 'week' | 'month' | 'year'

const VIEW_LABELS: Record<CalendarWorkspaceView, string> = {
  day: 'Day',
  week: 'Week',
  month: 'Month',
  year: 'Year'
}

const VIEW_OPTIONS = Object.keys(VIEW_LABELS) as CalendarWorkspaceView[]

interface CalendarToolbarProps {
  view: CalendarWorkspaceView
  anchorDate: string
  onViewChange: (view: CalendarWorkspaceView) => void
  onPrevious: () => void
  onNext: () => void
  onToday: () => void
  onCreateEvent: () => void
  extraActions?: React.ReactNode
}

export function getSubLabel(view: CalendarWorkspaceView, anchorDate: string): string {
  const date = parseLocalDate(anchorDate)

  if (view === 'day') {
    return new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(date)
  }

  if (view === 'week') {
    const start = parseLocalDate(getStartOfWeek(anchorDate))
    const end = parseLocalDate(addLocalDays(getStartOfWeek(anchorDate), 6))
    const fmt = new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    })
    return `${fmt.format(start)} – ${fmt.format(end)}`
  }

  if (view === 'month') {
    const first = new Date(date.getFullYear(), date.getMonth(), 1)
    const last = new Date(date.getFullYear(), date.getMonth() + 1, 0)
    const fmt = new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    })
    return `${fmt.format(first)} – ${fmt.format(last)}`
  }

  return String(date.getFullYear())
}

export function CalendarToolbar({
  view,
  anchorDate,
  onViewChange,
  onPrevious,
  onNext,
  onToday,
  onCreateEvent,
  extraActions
}: CalendarToolbarProps): React.JSX.Element {
  const anchorParsed = parseLocalDate(anchorDate)
  const monthName = new Intl.DateTimeFormat(undefined, { month: 'long' }).format(anchorParsed)
  const yearStr = String(anchorParsed.getFullYear())

  return (
    <div className="flex flex-col gap-4 border-b border-border bg-background px-6 py-4">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={onCreateEvent}
          className="flex size-9 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:border-muted-foreground hover:text-foreground"
          aria-label="Create event"
        >
          <Plus className="size-4" />
        </button>

        <div className="flex items-center rounded-full bg-surface-active/80 p-0.5">
          {VIEW_OPTIONS.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => onViewChange(option)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                view === option
                  ? 'bg-tint text-tint-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {VIEW_LABELS[option]}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1.5">
          {extraActions}
          <button
            type="button"
            className="flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground"
            aria-label="Search"
          >
            <Search className="size-4" />
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <h2 className="text-2xl tracking-tight">
          {view === 'year' ? (
            <span className="font-bold text-foreground">{yearStr}</span>
          ) : (
            <>
              <span className="font-bold text-foreground">{monthName}</span>{' '}
              <span className="font-normal text-muted-foreground">{yearStr}</span>
            </>
          )}
        </h2>

        <div className="flex items-center rounded-full bg-surface-active/80">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="rounded-full text-muted-foreground hover:bg-surface-active hover:text-foreground"
            onClick={onPrevious}
            aria-label="Previous period"
          >
            <ChevronLeft className="size-4" />
          </Button>
          <button
            type="button"
            onClick={onToday}
            className="px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            Today
          </button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="rounded-full text-muted-foreground hover:bg-surface-active hover:text-foreground"
            onClick={onNext}
            aria-label="Next period"
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}

export default CalendarToolbar
