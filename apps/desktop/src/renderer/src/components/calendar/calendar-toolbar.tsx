import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { ChevronDown, ChevronLeft, ChevronRight, Plus, Search } from '@/lib/icons'
import {
  addLocalDays,
  getStartOfWeek,
  getWeekNumber,
  parseLocalDate
} from './date-utils'

export type CalendarWorkspaceView = 'day' | 'week' | 'month' | 'year'

const VIEW_LABELS: Record<CalendarWorkspaceView, string> = {
  day: 'Day view',
  week: 'Week view',
  month: 'Month view',
  year: 'Year view'
}

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

function getSubLabel(view: CalendarWorkspaceView, anchorDate: string): string {
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
  const today = new Date()
  const todayMonth = new Intl.DateTimeFormat(undefined, { month: 'short' })
    .format(today)
    .toUpperCase()
  const todayDay = today.getDate()

  const anchorParsed = parseLocalDate(anchorDate)
  const monthYear = new Intl.DateTimeFormat(undefined, {
    month: 'long',
    year: 'numeric'
  }).format(anchorParsed)
  const weekNum = getWeekNumber(anchorDate)
  const subLabel = getSubLabel(view, anchorDate)

  return (
    <div className="flex items-start justify-between gap-4 border-b border-[#E5E5E5] bg-white px-6 py-5 dark:border-neutral-800 dark:bg-neutral-950">
      <div className="flex items-center gap-3">
        <div className="flex min-w-16 flex-col items-center overflow-hidden rounded-lg border border-[#E5E5E5] dark:border-neutral-700">
          <div className="w-full px-2 py-0.5 text-center text-xs font-semibold text-[#737373] dark:text-neutral-400">
            {todayMonth}
          </div>
          <div className="w-full px-2 py-0.5 text-center text-lg font-bold text-[#6941C6] dark:text-violet-400">
            {todayDay}
          </div>
        </div>

        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <span className="text-lg font-semibold text-[#171717] dark:text-neutral-100">
              {monthYear}
            </span>
            <span className="rounded border border-[#E5E5E5] px-1.5 py-0.5 text-xs font-medium text-[#404040] dark:border-neutral-700 dark:text-neutral-300">
              Week {weekNum}
            </span>
          </div>
          <span className="text-sm text-[#525252] dark:text-neutral-400">{subLabel}</span>
        </div>
      </div>

      <div className="flex items-center gap-2">
        {extraActions}

        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-9 rounded-lg"
          aria-label="Search"
        >
          <Search className="size-5" />
        </Button>

        <div className="flex items-center">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="rounded-r-none border-r-0"
            onClick={onPrevious}
            aria-label="Previous period"
          >
            <ChevronLeft className="size-4" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="rounded-none"
            onClick={onToday}
          >
            Today
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="rounded-l-none border-l-0"
            onClick={onNext}
            aria-label="Next period"
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="gap-1">
              {VIEW_LABELS[view]}
              <ChevronDown className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {(Object.keys(VIEW_LABELS) as CalendarWorkspaceView[]).map((option) => (
              <DropdownMenuItem key={option} onClick={() => onViewChange(option)}>
                {VIEW_LABELS[option]}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <Button
          type="button"
          size="sm"
          className="gap-1 bg-[#7F56D9] text-white hover:bg-[#6941C6]"
          onClick={onCreateEvent}
        >
          <Plus className="size-4" />
          Add event
        </Button>
      </div>
    </div>
  )
}

export default CalendarToolbar
