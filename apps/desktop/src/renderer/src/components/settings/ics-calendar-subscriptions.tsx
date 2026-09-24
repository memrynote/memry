import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ICS_CALENDAR_PROVIDER, IcsFeedErrorCodeSchema } from '@memry/contracts/calendar-api'
import { useT } from '@memry/i18n/renderer'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { extractErrorMessage } from '@/lib/ipc-error'
import { ProviderAgentAccessRow } from '@/components/settings/calendar-provider-agent-access'
import {
  calendarService,
  onCalendarChanged,
  type CalendarSourceRecord,
  type IcsCalendarMutationResponse
} from '@/services/calendar-service'

const ICS_SOURCES_QUERY_KEY = ['calendar', 'ics', 'sources'] as const

function feedHost(source: CalendarSourceRecord): string {
  try {
    return new URL(source.remoteId).hostname
  } catch {
    return ''
  }
}

export function IcsCalendarSubscriptions(): React.JSX.Element {
  const { t, i18n } = useT('settings')
  const queryClient = useQueryClient()
  const [url, setUrl] = useState('')

  const unknownError = (code: string): string =>
    t('calendar.subscriptions.errors.unknown', { code })
  const feedErrorMessage = (code: string): string =>
    IcsFeedErrorCodeSchema.safeParse(code).success
      ? t(`calendar.subscriptions.errors.${code}`)
      : unknownError(code)
  const responseError = (result: IcsCalendarMutationResponse): Error =>
    new Error(
      result.errorCode ? feedErrorMessage(result.errorCode) : (result.error ?? unknownError('ipc'))
    )

  const { data } = useQuery({
    queryKey: ICS_SOURCES_QUERY_KEY,
    queryFn: () => calendarService.listSources({ provider: ICS_CALENDAR_PROVIDER })
  })

  // Background refreshes rewrite each row's status; keep the list current.
  useEffect(
    () =>
      onCalendarChanged((event) => {
        if (event.entityType !== 'calendar_source') return
        void queryClient.invalidateQueries({ queryKey: ICS_SOURCES_QUERY_KEY })
      }),
    [queryClient]
  )

  const invalidate = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ICS_SOURCES_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: ['calendar', 'sources'] }),
      queryClient.invalidateQueries({ queryKey: ['calendar', 'range'] })
    ])
  }

  const subscribeMutation = useMutation({
    mutationFn: async (feedUrl: string) => {
      const result = await calendarService.subscribeIcsCalendar({ url: feedUrl })
      if (!result.success) throw responseError(result)
      return result
    },
    onSuccess: async () => {
      setUrl('')
      await invalidate()
    }
  })

  const refreshMutation = useMutation({
    mutationFn: async (sourceId: string) => {
      const result = await calendarService.refreshIcsCalendar({ sourceId })
      // A feed failure is written to the source row, which shows it in place.
      if (!result.success && !result.errorCode) throw responseError(result)
      return result
    },
    onSettled: invalidate
  })

  const removeMutation = useMutation({
    mutationFn: async (sourceId: string) => {
      const result = await calendarService.unsubscribeIcsCalendar({ sourceId })
      if (!result.success) throw responseError(result)
      return result
    },
    onSuccess: invalidate
  })

  const sources = data?.sources ?? []
  const dateFormatter = new Intl.DateTimeFormat(i18n.language, {
    dateStyle: 'medium',
    timeStyle: 'short'
  })
  const rowActionError = removeMutation.error ?? refreshMutation.error ?? null

  return (
    <div className="grid gap-3 px-4 py-3">
      <p className="text-xs/4 text-muted-foreground">{t('calendar.subscriptions.description')}</p>

      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          if (!url.trim() || subscribeMutation.isPending) return
          subscribeMutation.mutate(url.trim())
        }}
      >
        <Input
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder={t('calendar.subscriptions.urlPlaceholder')}
          aria-label={t('calendar.subscriptions.urlLabel')}
          aria-invalid={subscribeMutation.isError}
          spellCheck={false}
          autoComplete="off"
          data-testid="ics-subscribe-url"
        />
        <Button
          type="submit"
          variant="outline"
          size="sm"
          className="h-7 shrink-0 px-3 text-xs/4"
          disabled={!url.trim() || subscribeMutation.isPending}
          data-testid="ics-subscribe-submit"
        >
          {subscribeMutation.isPending
            ? t('calendar.subscriptions.subscribing')
            : t('calendar.subscriptions.subscribe')}
        </Button>
      </form>

      {subscribeMutation.error && (
        <p role="alert" className="text-xs text-destructive">
          {extractErrorMessage(subscribeMutation.error, unknownError('ipc'))}
        </p>
      )}

      {sources.length > 0 && (
        <ul className="grid gap-2" aria-label={t('calendar.subscriptions.name')}>
          {sources.map((source) => {
            const isRefreshing =
              refreshMutation.isPending && refreshMutation.variables === source.id
            const host = feedHost(source)
            const statusLine =
              source.syncStatus === 'error' && source.lastError
                ? null
                : source.lastSyncedAt
                  ? t('calendar.subscriptions.updatedAt', {
                      time: dateFormatter.format(new Date(source.lastSyncedAt))
                    })
                  : t('calendar.subscriptions.notCheckedYet')

            return (
              <li
                key={source.id}
                data-testid={`ics-source-row-${source.id}`}
                className="flex items-start justify-between gap-3 rounded-md border border-border/70 bg-muted/20 px-3 py-2"
              >
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate text-xs font-medium text-foreground">
                    {source.title}
                  </span>
                  <span className="truncate text-[11px]/4 text-muted-foreground">
                    {[host, t('calendar.subscriptions.readOnly'), statusLine]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                  {source.syncStatus === 'error' && source.lastError && (
                    <p className="text-[11px]/4 text-destructive">
                      {feedErrorMessage(source.lastError)} {t('calendar.subscriptions.keptEvents')}
                    </p>
                  )}
                </div>

                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-[11px]/4"
                    disabled={isRefreshing || removeMutation.isPending}
                    onClick={() => refreshMutation.mutate(source.id)}
                    data-testid={`ics-source-refresh-${source.id}`}
                  >
                    {isRefreshing
                      ? t('calendar.subscriptions.refreshing')
                      : t('calendar.subscriptions.refresh')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-[11px]/4"
                    disabled={removeMutation.isPending}
                    onClick={() => removeMutation.mutate(source.id)}
                    data-testid={`ics-source-remove-${source.id}`}
                  >
                    {t('calendar.subscriptions.remove')}
                  </Button>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {rowActionError && (
        <p role="alert" className="text-xs text-destructive">
          {extractErrorMessage(rowActionError, unknownError('ipc'))}
        </p>
      )}

      {/* #1394: subscribed calendars have their own AI answer, separate from Google's. */}
      {sources.length > 0 && (
        <div className="-mx-4 -mb-3 border-t border-border/60">
          <ProviderAgentAccessRow providerId={ICS_CALENDAR_PROVIDER} />
        </div>
      )}
    </div>
  )
}

export default IcsCalendarSubscriptions
