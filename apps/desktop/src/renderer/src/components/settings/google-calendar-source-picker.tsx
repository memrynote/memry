import { Checkbox } from '@/components/ui/checkbox'
import type { CalendarSourceRecord } from '@/services/calendar-service'

interface GoogleCalendarSourcePickerProps {
  sources: CalendarSourceRecord[]
  isUpdating: boolean
  onToggleSource: (sourceId: string, isSelected: boolean) => void
}

export function GoogleCalendarSourcePicker({
  sources,
  isUpdating,
  onToggleSource
}: GoogleCalendarSourcePickerProps): React.JSX.Element {
  if (sources.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No imported Google calendars are available on this device yet.
      </p>
    )
  }

  return (
    <div className="grid gap-2">
      {sources.map((source) => {
        const inputId = `google-calendar-source-${source.id}`

        return (
          <div
            key={source.id}
            className="flex items-center justify-between rounded-md border border-border/70 bg-muted/20 px-3 py-2"
          >
            <label htmlFor={inputId} className="flex min-w-0 items-center gap-2">
              <span
                className="size-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: source.color ?? '#64748b' }}
              />
              <span className="truncate text-xs font-medium text-foreground">{source.title}</span>
            </label>

            <Checkbox
              id={inputId}
              checked={source.isSelected}
              disabled={isUpdating}
              onCheckedChange={(checked) => onToggleSource(source.id, checked === true)}
              aria-label={source.title}
            />
          </div>
        )
      })}
    </div>
  )
}

export default GoogleCalendarSourcePicker
