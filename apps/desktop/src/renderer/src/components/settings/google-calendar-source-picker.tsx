import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import type { CalendarSourceRecord } from '@/services/calendar-service'

interface GoogleCalendarSourcePickerProps {
  sources: CalendarSourceRecord[]
  isUpdating: boolean
  onToggleSource: (sourceId: string, isSelected: boolean) => void
  onRetrySource?: (sourceId: string) => void
  retryingSourceId?: string | null
}

function statusDotClass(status: CalendarSourceRecord['syncStatus']): string {
  switch (status) {
    case 'ok':
      return 'bg-emerald-500'
    case 'error':
      return 'bg-destructive'
    case 'pending':
      return 'bg-amber-500'
    default:
      return 'bg-muted-foreground/40'
  }
}

function statusLabel(status: CalendarSourceRecord['syncStatus']): string {
  switch (status) {
    case 'ok':
      return 'Synced'
    case 'error':
      return 'Error'
    case 'pending':
      return 'Pending'
    default:
      return 'Idle'
  }
}

export function GoogleCalendarSourcePicker({
  sources,
  isUpdating,
  onToggleSource,
  onRetrySource,
  retryingSourceId
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
        const isError = source.syncStatus === 'error'
        const isRetrying = retryingSourceId === source.id

        return (
          <div
            key={source.id}
            data-testid={`calendar-source-row-${source.id}`}
            data-sync-status={source.syncStatus}
            className="flex flex-col gap-1.5 rounded-md border border-border/70 bg-muted/20 px-3 py-2"
          >
            <div className="flex items-center justify-between gap-2">
              <label htmlFor={inputId} className="flex min-w-0 items-center gap-2">
                <span
                  className="size-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: source.color ?? '#64748b' }}
                />
                <span className="truncate text-xs font-medium text-foreground">{source.title}</span>
              </label>

              <div className="flex shrink-0 items-center gap-2">
                <span
                  data-testid={`calendar-source-status-${source.id}`}
                  className="inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
                >
                  <span className={`size-1.5 rounded-full ${statusDotClass(source.syncStatus)}`} />
                  {statusLabel(source.syncStatus)}
                </span>
                {isError && onRetrySource && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 px-2 text-[10px]/3"
                    disabled={isRetrying}
                    onPointerDown={(e) => {
                      if (e.button !== 0) return
                      if (isRetrying) return
                      e.preventDefault()
                      onRetrySource(source.id)
                    }}
                    onClick={() => {
                      if (isRetrying) return
                      onRetrySource(source.id)
                    }}
                    data-testid={`calendar-source-retry-${source.id}`}
                  >
                    {isRetrying ? 'Retrying…' : 'Retry now'}
                  </Button>
                )}
                <Checkbox
                  id={inputId}
                  checked={source.isSelected}
                  disabled={isUpdating}
                  onCheckedChange={(checked) => onToggleSource(source.id, checked === true)}
                  aria-label={source.title}
                />
              </div>
            </div>

            {isError && source.lastError && (
              <p
                data-testid={`calendar-source-error-${source.id}`}
                className="truncate text-[11px] text-destructive"
                title={source.lastError}
              >
                {source.lastError}
              </p>
            )}
          </div>
        )
      })}
    </div>
  )
}

export default GoogleCalendarSourcePicker
