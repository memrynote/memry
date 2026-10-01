import { useMemo } from 'react'
import { useT } from '@memry/i18n/renderer'
import type { ViewBlockChart } from '@memry/shared/view-block'
import { defaultTagColorName, getTagColors } from '@/components/note/tags-row/tag-colors'
import {
  addDays,
  buildChartDays,
  countCategories,
  dayRange,
  defaultRangeDays,
  resolveChartType,
  summarizeLogged,
  summarizeNumbers,
  summarizeStreaks,
  valueKindFor,
  type ChartDay,
  type ChartRow,
  type ChartValueKind
} from '@/lib/property-chart/chart-model'
import { CalendarHeatmap } from './calendar-heatmap'
import { ChartStats, useChartFormat, type ChartStat } from './chart-parts'
import { DistributionBars } from './distribution-bars'
import { TimeSeriesChart } from './time-series-chart'

/** `color-mix` of the accent into the empty-cell colour, for intensity levels. */
const LEVELS = [
  'color-mix(in srgb, var(--tint) 30%, var(--muted))',
  'color-mix(in srgb, var(--tint) 55%, var(--muted))',
  'color-mix(in srgb, var(--tint) 80%, var(--muted))',
  'var(--tint)'
]
const EMPTY_CELL = 'var(--muted)'

export interface PropertyChartProps {
  /** Rows covering the range and the same length before it. */
  rows: ChartRow[]
  property: string
  propertyType: string | undefined
  /** A select's option colours by value; values without one get a stable hue. */
  optionColors?: ReadonlyMap<string, string>
  chart: ViewBlockChart
  today: string
  onOpenDay?: (day: ChartDay) => void
  /** The popover's small form: no summary figures, bigger squares. */
  compact?: boolean
}

function levelColor(value: number, sorted: number[]): string {
  if (sorted.length === 0) return LEVELS[LEVELS.length - 1]
  // The value's place among the recorded values, so one outlier does not wash
  // every other day out to the palest level.
  let below = 0
  while (below < sorted.length && sorted[below] < value) below++
  const rank = sorted.length === 1 ? 1 : below / (sorted.length - 1)
  return LEVELS[Math.min(LEVELS.length - 1, Math.floor(rank * LEVELS.length))]
}

function categoryColor(value: string, optionColors?: ReadonlyMap<string, string>): string {
  return getTagColors(optionColors?.get(value) ?? defaultTagColorName(value)).background
}

/**
 * A property over a date range: its summary figures and one of three charts,
 * picked from the property's type unless the settings name one that fits.
 */
export function PropertyChart({
  rows,
  property,
  propertyType,
  optionColors,
  chart,
  today,
  onOpenDay,
  compact = false
}: PropertyChartProps): React.JSX.Element {
  const { t } = useT('notes')
  const format = useChartFormat()
  const kind: ChartValueKind = valueKindFor(propertyType)
  const type = resolveChartType(kind, chart.type)
  const rangeDays = chart.rangeDays ?? defaultRangeDays(type)

  const { days, previous, dayList } = useMemo(() => {
    const list = dayRange(today, rangeDays)
    const settings = { rows, property, kind, aggregate: chart.aggregate, missing: chart.missing }
    return {
      dayList: list,
      days: buildChartDays({ ...settings, days: list }),
      previous: buildChartDays({
        ...settings,
        days: dayRange(addDays(today, -rangeDays), rangeDays)
      })
    }
  }, [rows, property, kind, chart.aggregate, chart.missing, today, rangeDays])

  const counts = useMemo(
    () =>
      kind === 'category' || kind === 'categories'
        ? countCategories(rows, property, new Set(dayList))
        : [],
    [kind, rows, property, dayList]
  )

  const sortedValues = useMemo(
    () =>
      days
        .map((d) => d.value)
        .filter((v): v is number => v !== null && v > 0)
        .sort((a, b) => a - b),
    [days]
  )

  const describe = (day: ChartDay): string => {
    if (day.value === null) return t('editor.chart.noEntry')
    switch (kind) {
      case 'number':
        return format.number(day.value)
      case 'boolean':
        return day.value > 0 ? t('editor.chart.done') : t('editor.chart.notDone')
      case 'category':
        return day.category ?? ''
      case 'categories':
        return t('editor.chart.valueCount', { count: day.value })
      default:
        return t('editor.chart.logged')
    }
  }

  const colorFor = (day: ChartDay): string => {
    if (day.value === null) return EMPTY_CELL
    if (kind === 'category') return categoryColor(day.category ?? '', optionColors)
    if (kind === 'boolean' || kind === 'presence') return day.value > 0 ? LEVELS[3] : EMPTY_CELL
    return day.value > 0 ? levelColor(day.value, sortedValues) : EMPTY_CELL
  }

  const stats: ChartStat[] = []
  const ofTotal = (part: number, total: number): string =>
    t('editor.chart.ofTotal', { part: format.number(part), total: format.number(total) })
  if (kind === 'number') {
    const summary = summarizeNumbers(days, previous)
    if (summary.average !== null) {
      stats.push({ label: t('editor.chart.average'), value: format.number(summary.average) })
    }
    if (summary.average !== null && summary.previousAverage !== null) {
      const delta = summary.average - summary.previousAverage
      stats.push({
        label: t('editor.chart.vsPrevious'),
        value: `${delta > 0 ? '+' : delta < 0 ? '−' : ''}${format.number(Math.abs(delta))}`
      })
    }
    if (summary.min) {
      stats.push({
        label: t('editor.chart.lowest'),
        value: `${format.number(summary.min.value)} · ${format.shortDay(summary.min.day)}`
      })
    }
  } else if (kind === 'boolean' || kind === 'presence') {
    const streaks = summarizeStreaks(days)
    stats.push(
      {
        label: t('editor.chart.currentStreak'),
        value: t('editor.chart.dayCount', { count: streaks.current })
      },
      {
        label: t('editor.chart.longestStreak'),
        value: t('editor.chart.dayCount', { count: streaks.longest })
      },
      {
        label: kind === 'boolean' ? t('editor.chart.doneDays') : t('editor.chart.loggedDays'),
        value: ofTotal(streaks.done, streaks.total)
      }
    )
  } else {
    const logged = summarizeLogged(days)
    if (counts[0]) stats.push({ label: t('editor.chart.mostCommon'), value: counts[0].value })
    stats.push({
      label: t('editor.chart.loggedDays'),
      value: ofTotal(logged.logged, logged.total)
    })
  }

  const ariaLabel = t('editor.chart.aria', { property, days: rangeDays })
  const hasData = days.some((d) => d.value !== null)

  let body: React.ReactNode
  if (!hasData) {
    body = <p className="py-6 text-center text-sm text-text-tertiary">{t('editor.chart.noData')}</p>
  } else if (type === 'heatmap') {
    body = (
      <CalendarHeatmap
        days={days}
        colorFor={colorFor}
        describe={describe}
        onOpenDay={onOpenDay}
        ariaLabel={ariaLabel}
        maxCell={compact ? 22 : undefined}
      />
    )
  } else if (type === 'bar' && (kind === 'category' || kind === 'categories')) {
    body = (
      <DistributionBars
        counts={counts}
        colorOf={(value) => categoryColor(value, optionColors)}
        ariaLabel={ariaLabel}
      />
    )
  } else {
    body = (
      <TimeSeriesChart
        days={days}
        type={type === 'bar' ? 'bar' : 'line'}
        height={compact ? 140 : 220}
        describe={describe}
        onOpenDay={onOpenDay}
        ariaLabel={ariaLabel}
      />
    )
  }

  return (
    <div className="flex flex-col gap-4" data-property-chart={type}>
      {compact || !hasData ? null : <ChartStats stats={stats} />}
      {body}
    </div>
  )
}
