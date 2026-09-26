import {
  CALENDAR_QUIET_BUTTON,
  CalendarCheckRow
} from '@/components/settings/calendar-provider-row'
import type { CalendarSourceRecord } from '@/services/calendar-service'
import { useT } from '@memry/i18n/renderer'

interface GoogleCalendarSourcePickerProps {
  sources: CalendarSourceRecord[]
  isUpdating: boolean
  onToggleSource: (sourceId: string, isSelected: boolean) => void
  onRetrySource?: (sourceId: string) => void
  retryingSourceId?: string | null
  /** Remote id of the calendar new memrynote events go to; marked "Default". */
  defaultRemoteId?: string | null
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

function statusLabelKey(status: CalendarSourceRecord['syncStatus']): string {
  switch (status) {
    case 'ok':
      return 'calendar.google.sourcePicker.statuses.synced'
    case 'error':
      return 'calendar.google.sourcePicker.statuses.error'
    case 'pending':
      return 'calendar.google.sourcePicker.statuses.pending'
    default:
      return 'calendar.google.sourcePicker.statuses.idle'
  }
}

export function GoogleCalendarSourcePicker({
  sources,
  isUpdating,
  onToggleSource,
  onRetrySource,
  retryingSourceId,
  defaultRemoteId = null
}: GoogleCalendarSourcePickerProps): React.JSX.Element {
  const { t } = useT('settings')

  if (sources.length === 0) {
    return (
      <p className="text-xs/4 text-muted-foreground">{t('calendar.google.sourcePicker.empty')}</p>
    )
  }

  return (
    <div className="flex flex-col">
      {sources.map((source) => {
        const isError = source.syncStatus === 'error'
        const isRetrying = retryingSourceId === source.id

        return (
          <div
            key={source.id}
            data-testid={`calendar-source-row-${source.id}`}
            data-sync-status={source.syncStatus}
          >
            <CalendarCheckRow
              id={`google-calendar-source-${source.id}`}
              title={source.title}
              color={source.color}
              checked={source.isSelected}
              disabled={isUpdating}
              isDefault={defaultRemoteId !== null && source.remoteId === defaultRemoteId}
              onCheckedChange={(checked) => onToggleSource(source.id, checked)}
              trailing={
                <>
                  <span
                    data-testid={`calendar-source-status-${source.id}`}
                    className="inline-flex items-center gap-1.5 text-[11px]/4 text-muted-foreground"
                  >
                    <span
                      className={`size-1.5 rounded-full ${statusDotClass(source.syncStatus)}`}
                    />
                    {t(statusLabelKey(source.syncStatus))}
                  </span>
                  {isError && onRetrySource && (
                    <button
                      type="button"
                      className={CALENDAR_QUIET_BUTTON}
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
                      {isRetrying
                        ? t('calendar.google.sourcePicker.retrying')
                        : t('calendar.google.sourcePicker.retryNow')}
                    </button>
                  )}
                </>
              }
            >
              {isError && source.lastError && (
                <p
                  data-testid={`calendar-source-error-${source.id}`}
                  className="truncate text-[11px]/4 text-destructive"
                  title={source.lastError}
                >
                  {source.lastError}
                </p>
              )}
            </CalendarCheckRow>
          </div>
        )
      })}
    </div>
  )
}

export default GoogleCalendarSourcePicker
