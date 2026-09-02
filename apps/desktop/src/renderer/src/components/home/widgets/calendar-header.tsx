import type React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { useCalendarRange } from '@/hooks/use-calendar-range'
import { useToday } from '@/hooks/use-today'
import { useGeneralSettings } from '@/hooks/use-general-settings'
import { useTabActions } from '@/contexts/tabs'
import { findNextEventIndex, toCalendarWidgetEvents } from '@/lib/home/calendar-widget-events'
import { localDayRange } from '@/lib/local-day-range'
import { ArrowRight } from '@/lib/icons/icon-map'
import { useT } from '@memry/i18n/renderer'

export function CalendarHeaderLabel(): React.JSX.Element {
  const { t } = useT('common')
  return (
    <span className="shrink-0 text-[12px] text-[var(--text-tertiary)]">
      · {t('home.widget.calendarToday')}
    </span>
  )
}

export function CalendarHeaderCount(): React.JSX.Element | null {
  const { settings } = useGeneralSettings()
  const today = useToday()
  const range = useMemo(() => localDayRange(today), [today])
  const { items, isLoading } = useCalendarRange(range)
  if (isLoading) return null

  const count = toCalendarWidgetEvents(items, settings.clockFormat).length
  return (
    <span className="font-mono text-[11px] font-semibold text-[var(--text-tertiary)]">{count}</span>
  )
}

export function CalendarFooter(): React.JSX.Element {
  const { t } = useT('common')
  const { settings } = useGeneralSettings()
  const { openTab } = useTabActions()
  const today = useToday()
  const range = useMemo(() => localDayRange(today), [today])
  const { items } = useCalendarRange(range)
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    // ponytail: 60s tick keeps "Next:" fresh as events pass; matches the widget body
    const id = setInterval(() => setNowMs(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])

  const events = useMemo(
    () => toCalendarWidgetEvents(items, settings.clockFormat),
    [items, settings.clockFormat]
  )
  const next = events[findNextEventIndex(events, nowMs)]

  return (
    <div className="flex items-center justify-between border-t px-3.5 py-2.5">
      <span className="min-w-0 truncate text-[12px] text-[var(--text-tertiary)]">
        {next ? t('home.widget.next', { title: next.title }) : ''}
      </span>
      <button
        type="button"
        onClick={() =>
          openTab({
            type: 'calendar',
            title: t('home.widget.calendar'),
            icon: 'calendar',
            path: '/calendar',
            isPinned: false,
            isModified: false,
            isPreview: false,
            isDeleted: false
          })
        }
        className="inline-flex shrink-0 items-center gap-1 rounded text-[12px] font-semibold text-[var(--tint)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--tint-ring)]"
      >
        {t('home.widget.openCalendar')}
        <ArrowRight className="size-3" aria-hidden="true" />
      </button>
    </div>
  )
}
