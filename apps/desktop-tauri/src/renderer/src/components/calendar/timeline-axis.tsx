import { useMemo } from 'react'
import { useT } from '@memry/i18n/renderer'
import { cn } from '@/lib/utils'
import { parseLocalDate } from './date-utils'
import {
  dayOffset,
  getAxisTicks,
  getMonthSpans,
  getWeekendOffsets,
  type TimelineWindow,
  type TimelineZoom
} from './timeline-model'

export const TIMELINE_LIST_WIDTH = 296
export const TIMELINE_AXIS_HEIGHT = 56

interface TimelineAxisProps {
  window: TimelineWindow
  zoom: TimelineZoom
  dayWidth: number
  weekStartsOn: 0 | 1
  today: string
  listLabel: string
  listCount: number
  listTrailing?: React.ReactNode
}

/**
 * Sticky two-tier header: months above, days (or week starts at quarter zoom)
 * below. The corner above the list stays pinned in both directions.
 */
export function TimelineAxis({
  window,
  zoom,
  dayWidth,
  weekStartsOn,
  today,
  listLabel,
  listCount,
  listTrailing
}: TimelineAxisProps): React.JSX.Element {
  const { i18n } = useT('calendar')
  const months = useMemo(() => getMonthSpans(window), [window])
  const ticks = useMemo(
    () => getAxisTicks(window, zoom, weekStartsOn),
    [window, zoom, weekStartsOn]
  )
  const monthFormat = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { month: 'long' }),
    [i18n.language]
  )
  const monthYearFormat = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { month: 'long', year: 'numeric' }),
    [i18n.language]
  )
  const weekdayFormat = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { weekday: 'narrow' }),
    [i18n.language]
  )
  const todayYear = today.slice(0, 4)

  return (
    <div
      className="sticky top-0 z-30 flex border-b border-border bg-background"
      style={{ height: TIMELINE_AXIS_HEIGHT }}
    >
      <div
        className="sticky start-0 z-10 flex shrink-0 items-end justify-between gap-2 border-e border-border bg-background ps-6 pe-3 pb-2.5"
        style={{ width: TIMELINE_LIST_WIDTH }}
      >
        <div aria-hidden="true" className="flex items-baseline gap-1.5">
          <span className="text-xs font-semibold text-text-secondary">{listLabel}</span>
          <span className="text-xs text-text-tertiary tabular-nums">{listCount}</span>
        </div>
        {listTrailing}
      </div>

      <div
        aria-hidden="true"
        className="relative shrink-0"
        style={{ width: window.dayCount * dayWidth }}
      >
        {months.map((span) => {
          const label = span.month.startsWith(todayYear)
            ? monthFormat.format(parseLocalDate(span.month))
            : monthYearFormat.format(parseLocalDate(span.month))
          return (
            <div
              key={span.month}
              className="absolute top-2.5 h-4"
              style={{ insetInlineStart: span.offset * dayWidth, width: span.length * dayWidth }}
            >
              {span.offset > 0 && <div className="absolute start-0 top-0 h-4 w-px bg-border" />}
              {/* Sticky so the current month's name stays readable while it scrolls */}
              <span className="sticky start-[calc(296px+0.5rem)] inline-block ps-2 text-xs font-semibold text-foreground whitespace-nowrap">
                {label}
              </span>
            </div>
          )
        })}

        {ticks.map((tick) => {
          const isToday = tick.date === today
          return (
            <div
              key={tick.date}
              className="absolute bottom-2 flex flex-col items-center gap-0.5"
              style={{
                insetInlineStart: tick.offset * dayWidth,
                width: zoom === 'quarters' ? dayWidth * 7 : dayWidth
              }}
            >
              {zoom === 'weeks' && (
                <span
                  className={cn(
                    'text-[10px] leading-none font-medium',
                    isToday ? 'text-tint' : 'text-text-tertiary'
                  )}
                >
                  {weekdayFormat.format(parseLocalDate(tick.date))}
                </span>
              )}
              <span
                className={cn(
                  'inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[11px] font-medium tabular-nums',
                  zoom === 'quarters' && 'self-start',
                  isToday
                    ? 'bg-tint font-semibold text-tint-foreground'
                    : tick.isWeekend
                      ? 'text-text-tertiary'
                      : 'text-text-secondary'
                )}
              >
                {Number(tick.date.slice(8))}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

interface TimelineGridProps {
  window: TimelineWindow
  zoom: TimelineZoom
  dayWidth: number
  today: string
}

/** Weekend shading and month edges behind the rows. */
export function TimelineGrid({
  window,
  zoom,
  dayWidth,
  today
}: TimelineGridProps): React.JSX.Element {
  const weekends = useMemo(() => getWeekendOffsets(window, zoom), [window, zoom])
  const months = useMemo(() => getMonthSpans(window), [window])
  const todayOffset = dayOffset(today, window)
  const showToday = todayOffset >= 0 && todayOffset < window.dayCount

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-y-0"
      style={{ insetInlineStart: TIMELINE_LIST_WIDTH, width: window.dayCount * dayWidth }}
    >
      {weekends.map((offset) => (
        <div
          key={offset}
          className="absolute inset-y-0 bg-surface/70"
          style={{ insetInlineStart: offset * dayWidth, width: dayWidth }}
        />
      ))}
      {months.map((span) =>
        span.offset > 0 ? (
          <div
            key={span.month}
            className="absolute inset-y-0 w-px bg-border/70"
            style={{ insetInlineStart: span.offset * dayWidth }}
          />
        ) : null
      )}
      {showToday && (
        <div
          data-testid="timeline-today-column"
          className="absolute inset-y-0 bg-tint/5"
          style={{ insetInlineStart: todayOffset * dayWidth, width: dayWidth }}
        />
      )}
    </div>
  )
}

/** The today line, drawn over the bars like Linear's. */
export function TimelineTodayLine({
  window,
  dayWidth,
  today
}: Omit<TimelineGridProps, 'zoom'>): React.JSX.Element | null {
  const offset = dayOffset(today, window)
  if (offset < 0 || offset >= window.dayCount) return null
  return (
    <div
      aria-hidden="true"
      data-testid="timeline-today-line"
      className="pointer-events-none absolute inset-y-0 z-20 w-0.5 -translate-x-1/2 bg-tint/45 rtl:translate-x-1/2"
      style={{ insetInlineStart: TIMELINE_LIST_WIDTH + offset * dayWidth + dayWidth / 2 }}
    />
  )
}
