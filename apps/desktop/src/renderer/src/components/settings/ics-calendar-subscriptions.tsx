import { useEffect, useId, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  ICS_CALENDAR_PROVIDER,
  IcsFeedErrorCodeSchema,
  type IcsCalendarFeedSummary
} from '@memry/contracts/calendar-api'
import {
  CALENDAR_EVENT_COLORS,
  calendarColorHex,
  calendarDisplayHex,
  type CalendarEventColor
} from '@memry/contracts/calendar-colors'
import { useT } from '@memry/i18n/renderer'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { inkOnCalendarColor } from '@/lib/calendar-colors'
import { AlertTriangle, Check, ChevronRight } from '@/lib/icons'
import { extractErrorMessage } from '@/lib/ipc-error'
import { cn } from '@/lib/utils'
import { ProviderAgentAccessRow } from '@/components/settings/calendar-provider-agent-access'
import {
  calendarService,
  onCalendarChanged,
  type CalendarSourceRecord,
  type IcsCalendarMutationResponse
} from '@/services/calendar-service'

const ICS_SOURCES_QUERY_KEY = ['calendar', 'ics', 'sources'] as const

/** Services whose sharing link the help lists, in the order shown. */
const HELP_SERVICES = ['proton', 'icloud', 'outlook', 'fastmail', 'notion', 'public'] as const

function feedHost(source: CalendarSourceRecord): string {
  try {
    return new URL(source.remoteId).hostname
  } catch {
    return ''
  }
}

/** A feed read over plain http: the secret link and the events cross the network in the clear. */
function isPlainHttp(url: string): boolean {
  return /^http:\/\//i.test(url.trim())
}

interface UpdateInput {
  sourceId: string
  title?: string
  color?: CalendarEventColor
}

export function IcsCalendarSubscriptions(): React.JSX.Element {
  const { t, i18n } = useT('settings')
  const queryClient = useQueryClient()
  const [url, setUrl] = useState('')
  const httpWarningId = useId()

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

  const dayFormatter = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' })
  const addedMessage = (title: string, summary: IcsCalendarFeedSummary | undefined): string => {
    if (!summary) return t('calendar.subscriptions.added', { title })
    if (summary.eventCount === 0 || !summary.firstStartAt || !summary.lastStartAt) {
      return t('calendar.subscriptions.addedEmpty', { title })
    }
    return t('calendar.subscriptions.addedSummary', {
      title,
      count: summary.eventCount,
      start: dayFormatter.format(new Date(summary.firstStartAt)),
      end: dayFormatter.format(new Date(summary.lastStartAt))
    })
  }

  const subscribeMutation = useMutation({
    mutationFn: async (feedUrl: string) => {
      const result = await calendarService.subscribeIcsCalendar({ url: feedUrl })
      if (!result.success) throw responseError(result)
      return result
    },
    onSuccess: async (result) => {
      setUrl('')
      toast.success(addedMessage(result.source?.title ?? '', result.summary))
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

  const updateMutation = useMutation({
    mutationFn: async (input: UpdateInput) => {
      const result = await calendarService.updateIcsCalendar(input)
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
  const rowActionError =
    updateMutation.error ?? removeMutation.error ?? refreshMutation.error ?? null

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
          aria-describedby={isPlainHttp(url) ? httpWarningId : undefined}
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

      {isPlainHttp(url) && (
        <p
          id={httpWarningId}
          className="flex items-start gap-1.5 text-[11px]/4 text-muted-foreground"
          data-testid="ics-subscribe-http-warning"
        >
          <AlertTriangle className="mt-px size-3 shrink-0" aria-hidden />
          {t('calendar.subscriptions.httpWarning')}
        </p>
      )}

      {subscribeMutation.error && (
        <p role="alert" className="text-xs text-destructive">
          {extractErrorMessage(subscribeMutation.error, unknownError('ipc'))}
        </p>
      )}

      <IcsLinkHelp />

      {sources.length > 0 && (
        <ul className="grid gap-2" aria-label={t('calendar.subscriptions.name')}>
          {sources.map((source) => {
            const statusLine =
              source.syncStatus === 'error' && source.lastError
                ? null
                : source.lastSyncedAt
                  ? t('calendar.subscriptions.updatedAt', {
                      time: dateFormatter.format(new Date(source.lastSyncedAt))
                    })
                  : t('calendar.subscriptions.notCheckedYet')

            return (
              <IcsSubscriptionRow
                key={source.id}
                source={source}
                statusLine={statusLine}
                errorLine={
                  source.syncStatus === 'error' && source.lastError
                    ? `${feedErrorMessage(source.lastError)} ${t('calendar.subscriptions.keptEvents')}`
                    : null
                }
                isRefreshing={refreshMutation.isPending && refreshMutation.variables === source.id}
                isBusy={removeMutation.isPending || updateMutation.isPending}
                onRefresh={() => refreshMutation.mutate(source.id)}
                onRemove={() => removeMutation.mutate(source.id)}
                onUpdate={(input) => updateMutation.mutateAsync({ sourceId: source.id, ...input })}
              />
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

/** Where each common service hides its sharing link, and why Proton stays read-only. */
function IcsLinkHelp(): React.JSX.Element {
  const { t } = useT('settings')
  const [open, setOpen] = useState(false)

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        className="group flex items-center gap-1 rounded-sm text-[11px]/4 font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        data-testid="ics-link-help-toggle"
      >
        <ChevronRight
          className="size-3 transition-transform duration-(--duration-fast) group-data-[state=open]:rotate-90 motion-reduce:transition-none rtl:-scale-x-100"
          aria-hidden
        />
        {t('calendar.subscriptions.help.toggle')}
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 grid gap-2 ps-4 text-[11px]/4 text-muted-foreground">
        <p>{t('calendar.subscriptions.help.intro')}</p>
        <ul className="grid gap-1.5">
          {HELP_SERVICES.map((service) => (
            <li key={service} data-testid={`ics-link-help-${service}`}>
              <span className="font-medium text-foreground">
                {t(`calendar.subscriptions.help.${service}.name`)}
              </span>
              {' · '}
              {t(`calendar.subscriptions.help.${service}.steps`)}
              {service === 'proton' && (
                <span className="mt-0.5 block">
                  {t('calendar.subscriptions.help.proton.readOnly')}
                </span>
              )}
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  )
}

interface IcsSubscriptionRowProps {
  source: CalendarSourceRecord
  statusLine: string | null
  errorLine: string | null
  isRefreshing: boolean
  isBusy: boolean
  onRefresh: () => void
  onRemove: () => void
  onUpdate: (input: Omit<UpdateInput, 'sourceId'>) => Promise<unknown>
}

function IcsSubscriptionRow({
  source,
  statusLine,
  errorLine,
  isRefreshing,
  isBusy,
  onRefresh,
  onRemove,
  onUpdate
}: IcsSubscriptionRowProps): React.JSX.Element {
  const { t } = useT('settings')
  const [draftTitle, setDraftTitle] = useState<string | null>(null)
  const host = feedHost(source)
  const meta = [
    host,
    t('calendar.subscriptions.readOnly'),
    isPlainHttp(source.remoteId) ? t('calendar.subscriptions.notEncrypted') : null,
    statusLine
  ]
    .filter(Boolean)
    .join(' · ')

  const saveTitle = async (): Promise<void> => {
    const title = draftTitle?.trim() ?? ''
    if (!title) return
    if (title !== source.title) {
      try {
        await onUpdate({ title })
      } catch {
        // The list shows the failure; keep the field open with what was typed.
        return
      }
    }
    setDraftTitle(null)
  }

  return (
    <li
      data-testid={`ics-source-row-${source.id}`}
      className="flex items-start justify-between gap-3 rounded-md border border-border/70 bg-muted/20 px-3 py-2"
    >
      <div className="flex min-w-0 flex-1 items-start gap-2">
        <IcsColorPicker source={source} disabled={isBusy} onPick={(color) => onUpdate({ color })} />

        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {draftTitle === null ? (
            <span className="truncate text-xs font-medium text-foreground">{source.title}</span>
          ) : (
            <form
              className="flex items-center gap-1"
              onSubmit={(event) => {
                event.preventDefault()
                void saveTitle()
              }}
            >
              <Input
                value={draftTitle}
                onChange={(event) => setDraftTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    event.stopPropagation()
                    setDraftTitle(null)
                  }
                }}
                aria-label={t('calendar.subscriptions.renameLabel')}
                maxLength={200}
                autoFocus
                className="h-6 text-xs"
                data-testid={`ics-source-title-input-${source.id}`}
              />
              <Button
                type="submit"
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[11px]/4"
                disabled={!draftTitle.trim() || isBusy}
                data-testid={`ics-source-title-save-${source.id}`}
              >
                {t('calendar.subscriptions.save')}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[11px]/4"
                onClick={() => setDraftTitle(null)}
              >
                {t('calendar.subscriptions.cancel')}
              </Button>
            </form>
          )}
          <span className="truncate text-[11px]/4 text-muted-foreground">{meta}</span>
          {errorLine && <p className="text-[11px]/4 text-destructive">{errorLine}</p>}
        </div>
      </div>

      {draftTitle === null && (
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[11px]/4"
            disabled={isBusy}
            onClick={() => setDraftTitle(source.title)}
            data-testid={`ics-source-rename-${source.id}`}
          >
            {t('calendar.subscriptions.rename')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[11px]/4"
            disabled={isRefreshing || isBusy}
            onClick={onRefresh}
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
            disabled={isBusy}
            onClick={onRemove}
            data-testid={`ics-source-remove-${source.id}`}
          >
            {t('calendar.subscriptions.remove')}
          </Button>
        </div>
      )}
    </li>
  )
}

interface IcsColorPickerProps {
  source: CalendarSourceRecord
  disabled: boolean
  onPick: (color: CalendarEventColor) => Promise<unknown>
}

/**
 * The event colours, the same set the event form offers. No "default" swatch:
 * a cleared colour would not reach other devices (the source sync keeps the
 * old value when the incoming one is null).
 */
function IcsColorPicker({ source, disabled, onPick }: IcsColorPickerProps): React.JSX.Element {
  const { t } = useT('settings')
  const { t: tCalendar } = useT('calendar')
  const [open, setOpen] = useState(false)
  const currentHex = calendarDisplayHex(source.color)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className={cn(
          'mt-0.5 size-3 shrink-0 rounded-full border border-border',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
          !currentHex && 'bg-background'
        )}
        style={currentHex ? { backgroundColor: currentHex } : undefined}
        aria-label={t('calendar.subscriptions.color')}
        disabled={disabled}
        data-testid={`ics-source-color-${source.id}`}
      />
      <PopoverContent align="start" className="w-auto p-2">
        <div
          role="group"
          aria-label={t('calendar.subscriptions.color')}
          className="grid grid-cols-6 gap-1.5"
        >
          {CALENDAR_EVENT_COLORS.map((color) => {
            const hex = calendarColorHex(color)
            const selected = currentHex === hex
            const label = tCalendar(`calendar-color.${color}`)
            return (
              <button
                key={color}
                type="button"
                className={cn(
                  'flex size-[18px] items-center justify-center rounded-full border border-border',
                  'transition-transform duration-100 hover:scale-110 motion-reduce:transition-none',
                  'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-popover'
                )}
                style={{ backgroundColor: hex, color: inkOnCalendarColor(hex) }}
                aria-label={t('calendar.subscriptions.colorOption', { color: label })}
                title={label}
                aria-pressed={selected}
                data-testid={`ics-source-color-option-${color}`}
                onClick={() => {
                  setOpen(false)
                  if (!selected) void onPick(color).catch(() => undefined)
                }}
              >
                {selected && <Check className="size-3" />}
              </button>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}

export default IcsCalendarSubscriptions
