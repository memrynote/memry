import type React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { useCalendarRange } from '@/hooks/use-calendar-range'
import { useToday } from '@/hooks/use-today'
import { useGeneralSettings } from '@/hooks/use-general-settings'
import { formatTimeOfDay } from '@/lib/time-format'
import {
  findNextEventIndex,
  nowLinePosition,
  toCalendarWidgetEvents,
  type CalendarWidgetEvent
} from '@/lib/home/calendar-widget-events'
import { localDayRange } from '@/lib/local-day-range'
import type { WidgetComponentProps } from '@/lib/home/widget-registry'
import { Skeleton } from '@/components/ui/skeleton'
import { extractErrorMessage } from '@/lib/ipc-error'
import { Calendar } from '@/lib/icons/icon-map'
import { WidgetRow, WidgetEmptyState } from './widget-list'
import { useT } from '@memry/i18n/renderer'

export function CalendarWidget({ size }: WidgetComponentProps): React.JSX.Element {
  const { t } = useT('common')
  const { settings } = useGeneralSettings()
  const clockFormat = settings.clockFormat
  const today = useToday()
  const range = useMemo(() => localDayRange(today), [today])
  const { items, isLoading, error } = useCalendarRange(range)
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    // ponytail: 60s tick; widget is glanceable, second-precision not needed
    const id = setInterval(() => setNowMs(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])

  const events = useMemo(() => toCalendarWidgetEvents(items, clockFormat), [items, clockFormat])

  if (isLoading)
    return (
      <div className="flex flex-col gap-1" aria-busy="true" aria-label={t('state.loading')}>
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
      </div>
    )

  if (error)
    return (
      <div className="text-xs text-destructive" role="alert" title={extractErrorMessage(error)}>
        {t('home.widget.loadError')}
      </div>
    )

  if (events.length === 0) return <WidgetEmptyState icon={Calendar} label={t('home.noEventsYet')} />

  const limit = size === 'L' ? 12 : 6
  const visible = events.slice(0, limit)
  const nextIndex = findNextEventIndex(events, nowMs)
  const nowPos = Math.min(nowLinePosition(events, nowMs), visible.length)

  const subtitle = (ev: CalendarWidgetEvent): string => {
    const parts: string[] = []
    if (ev.durationMinutes != null)
      parts.push(t('home.widget.duration', { count: ev.durationMinutes }))
    if (ev.metaLabel) parts.push(ev.metaLabel)
    return parts.join(' · ')
  }

  const nowLine = (
    <li key="now-line" data-testid="calendar-now-line" className="flex items-center gap-2.5 py-0.5">
      <span className="w-11 shrink-0 font-mono text-[10px] font-semibold tabular-nums text-[var(--tint)]">
        {formatTimeOfDay(new Date(nowMs), clockFormat)}
      </span>
      <span className="size-1.5 shrink-0 rounded-full bg-[var(--tint)]" aria-hidden="true" />
      <span className="h-px grow bg-[var(--tint)] opacity-50" aria-hidden="true" />
    </li>
  )

  const rows: React.JSX.Element[] = []
  visible.forEach((ev, i) => {
    if (i === nowPos) rows.push(nowLine)
    const isNext = i === nextIndex
    const sub = subtitle(ev)
    rows.push(
      <WidgetRow
        key={ev.id}
        data-testid="calendar-event"
        className={
          isNext
            ? 'flex items-center gap-2.5 rounded-md bg-[var(--tint-light)] px-2 py-1.5'
            : 'flex items-center gap-2.5 px-2 py-1.5'
        }
      >
        <span
          className={
            isNext
              ? 'w-11 shrink-0 font-mono text-[12px] font-semibold tabular-nums text-[var(--foreground)]'
              : 'w-11 shrink-0 font-mono text-[12px] tabular-nums text-[var(--text-tertiary)]'
          }
        >
          {ev.startTimeLabel}
        </span>
        <span
          className="h-7 w-[3px] shrink-0 rounded-full"
          style={{ backgroundColor: isNext ? 'var(--tint)' : ev.color }}
          aria-hidden="true"
        />
        <span className="flex min-w-0 flex-col gap-px">
          <span
            className={
              isNext
                ? 'truncate text-[13px] font-semibold text-foreground'
                : 'truncate text-[13px] font-medium text-foreground/90'
            }
          >
            {ev.title}
          </span>
          {isNext ? (
            <span className="truncate text-[11px] font-medium text-[var(--tint)]">
              {t('home.widget.startsIn', {
                count: Math.max(0, Math.round((ev.startAtMs - nowMs) / 60_000))
              })}
            </span>
          ) : (
            sub && <span className="truncate text-[11px] text-text-tertiary">{sub}</span>
          )}
        </span>
      </WidgetRow>
    )
  })
  if (nowPos >= visible.length) rows.push(nowLine)

  return <ul className="flex flex-col gap-0.5">{rows}</ul>
}
