import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useT } from '@memry/i18n/renderer'
import { cn } from '@/lib/utils'

/** The element's content width, following resizes. Zero until measured. */
export function useMeasuredWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    setWidth(element.clientWidth)
    const observer = new ResizeObserver(([entry]) => {
      setWidth(Math.floor(entry.contentRect.width))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return [ref, width]
}

/** Formatters in the reader's language. */
export function useChartFormat(): {
  number: (value: number) => string
  day: (day: string) => string
  shortDay: (day: string) => string
  month: (day: string) => string
  weekday: (weekday: number) => string
} {
  const { i18n } = useT('notes')
  const locale = i18n.language
  return useMemo(() => {
    const numberFormat = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 })
    const dayFormat = new Intl.DateTimeFormat(locale, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC'
    })
    const shortDayFormat = new Intl.DateTimeFormat(locale, {
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC'
    })
    const monthFormat = new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' })
    const weekdayFormat = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' })
    // Day keys are calendar days, not instants: read them at UTC midnight so
    // no time zone moves them to the day before.
    const at = (day: string): Date => new Date(`${day}T00:00:00Z`)
    return {
      number: (value) => numberFormat.format(value),
      day: (day) => dayFormat.format(at(day)),
      shortDay: (day) => shortDayFormat.format(at(day)),
      month: (day) => monthFormat.format(at(day)),
      // 2023-01-01 was a Sunday, so day 1 + weekday is that weekday.
      weekday: (weekday) => weekdayFormat.format(new Date(Date.UTC(2023, 0, 1 + weekday)))
    }
  }, [locale])
}

export interface ChartTooltipState {
  x: number
  y: number
  title: string
  body: string
}

/**
 * The hover card over a chart. Charts draw left to right in every language
 * (their container is `dir="ltr"`), so it is placed with physical coordinates
 * inside that container.
 */
export function ChartTooltip({
  tooltip,
  width
}: {
  tooltip: ChartTooltipState | null
  width: number
}): React.JSX.Element | null {
  if (!tooltip) return null
  const flip = tooltip.x > width - 160
  return (
    <div
      role="presentation"
      className={cn(
        'pointer-events-none absolute z-10 flex flex-col gap-0.5 rounded-md bg-primary px-2.5 py-1.5 text-primary-foreground shadow-md',
        flip ? '-translate-x-full' : ''
      )}
      style={{ left: flip ? tooltip.x - 8 : tooltip.x + 8, top: Math.max(0, tooltip.y - 44) }}
    >
      <span className="whitespace-nowrap text-xs font-semibold">{tooltip.title}</span>
      <span className="whitespace-nowrap text-[11px] opacity-75">{tooltip.body}</span>
    </div>
  )
}

export interface ChartStat {
  label: string
  value: string
}

export function ChartStats({ stats }: { stats: ChartStat[] }): React.JSX.Element | null {
  if (stats.length === 0) return null
  return (
    <dl className="flex flex-wrap gap-x-7 gap-y-2">
      {stats.map((stat) => (
        <div key={stat.label} className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-[11px] font-medium uppercase tracking-[0.04em] text-text-tertiary">
            {stat.label}
          </dt>
          <dd className="font-heading text-xl font-semibold tabular-nums text-foreground">
            {stat.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}
