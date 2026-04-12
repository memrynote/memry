import { Button } from '@/components/ui/button'
import { CalendarDays, ChevronLeft, ChevronRight, Plus } from '@/lib/icons'
import { cn } from '@/lib/utils'

export type CalendarWorkspaceView = 'day' | 'week' | 'month' | 'year'

const VIEW_OPTIONS: CalendarWorkspaceView[] = ['day', 'week', 'month', 'year']

interface CalendarToolbarProps {
  view: CalendarWorkspaceView
  rangeLabel: string
  onViewChange: (view: CalendarWorkspaceView) => void
  onPrevious: () => void
  onNext: () => void
  onToday: () => void
  onCreateEvent: () => void
}

export function CalendarToolbar({
  view,
  rangeLabel,
  onViewChange,
  onPrevious,
  onNext,
  onToday,
  onCreateEvent
}: CalendarToolbarProps): React.JSX.Element {
  return (
    <div className="border-b border-border/80 px-6 py-5">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-muted-foreground">
            <CalendarDays className="size-4" />
            <span className="text-xs font-medium uppercase tracking-[0.2em]">Calendar</span>
          </div>
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">{rangeLabel}</h1>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onPrevious} aria-label="Previous period">
            <ChevronLeft className="size-4" />
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={onToday}>
            Today
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={onNext} aria-label="Next period">
            <ChevronRight className="size-4" />
          </Button>

          <div className="ml-2 flex items-center gap-1 rounded-full border border-border/80 bg-muted/40 p-1">
            {VIEW_OPTIONS.map((option) => (
              <button
                key={option}
                type="button"
                className={cn(
                  'rounded-full px-3 py-1.5 text-sm font-medium capitalize transition-colors',
                  view === option
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                )}
                onClick={() => onViewChange(option)}
              >
                {option.charAt(0).toUpperCase() + option.slice(1)}
              </button>
            ))}
          </div>

          <Button type="button" size="sm" onClick={onCreateEvent}>
            <Plus className="size-4" />
            New Event
          </Button>
        </div>
      </div>
    </div>
  )
}

export default CalendarToolbar
