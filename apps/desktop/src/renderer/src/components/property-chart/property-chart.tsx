import { useMemo } from 'react'
import { useT } from '@memry/i18n/renderer'
import type { ViewBlockChart, ViewBlockChartType } from '@memry/shared/view-block'
import {
  addDays,
  buildChartDays,
  countCategories,
  dayRange,
  defaultRangeDays,
  resolveChartType,
  valueKindFor,
  type CategoryCount,
  type ChartDay,
  type ChartRow,
  type ChartValueKind
} from '@/lib/property-chart/chart-model'
import { CalendarHeatmap } from './calendar-heatmap'
import { categoryColor, cellColor, chartStats, describeDay } from './chart-presentation'
import { ChartStats, useChartFormat } from './chart-parts'
import { DistributionBars } from './distribution-bars'
import { TimeSeriesChart } from './time-series-chart'

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

/** The range's days, the period before it, and how often each select value came up. */
function useChartSeries(
  rows: ChartRow[],
  property: string,
  kind: ChartValueKind,
  chart: ViewBlockChart,
  today: string,
  rangeDays: number
): { days: ChartDay[]; previous: ChartDay[]; counts: CategoryCount[] } {
  return useMemo(() => {
    const list = dayRange(today, rangeDays)
    const settings = { rows, property, kind, aggregate: chart.aggregate, missing: chart.missing }
    const categorical = kind === 'category' || kind === 'categories'
    return {
      days: buildChartDays({ ...settings, days: list }),
      previous: buildChartDays({
        ...settings,
        days: dayRange(addDays(today, -rangeDays), rangeDays)
      }),
      counts: categorical ? countCategories(rows, property, new Set(list)) : []
    }
  }, [rows, property, kind, chart.aggregate, chart.missing, today, rangeDays])
}

interface ChartBodyProps {
  type: ViewBlockChartType
  kind: ChartValueKind
  days: ChartDay[]
  counts: CategoryCount[]
  optionColors?: ReadonlyMap<string, string>
  onOpenDay?: (day: ChartDay) => void
  ariaLabel: string
  compact: boolean
}

/** The chart itself, one of three shapes. */
function ChartBody({
  type,
  kind,
  days,
  counts,
  optionColors,
  onOpenDay,
  ariaLabel,
  compact
}: ChartBodyProps): React.JSX.Element {
  const { t } = useT('notes')
  const format = useChartFormat()
  const sortedValues = useMemo(
    () =>
      days
        .map((d) => d.value)
        .filter((v): v is number => v !== null && v > 0)
        .sort((a, b) => a - b),
    [days]
  )
  const describe = (day: ChartDay): string => describeDay(kind, day, t, format)

  if (type === 'heatmap') {
    return (
      <CalendarHeatmap
        days={days}
        colorFor={(day) => cellColor(kind, day, sortedValues, optionColors)}
        describe={describe}
        onOpenDay={onOpenDay}
        ariaLabel={ariaLabel}
        maxCell={compact ? 22 : undefined}
      />
    )
  }
  if (type === 'bar' && (kind === 'category' || kind === 'categories')) {
    return (
      <DistributionBars
        counts={counts}
        colorOf={(value) => categoryColor(value, optionColors)}
        ariaLabel={ariaLabel}
      />
    )
  }
  return (
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
  const kind = valueKindFor(propertyType)
  const type = resolveChartType(kind, chart.type)
  const rangeDays = chart.rangeDays ?? defaultRangeDays(type)
  const { days, previous, counts } = useChartSeries(rows, property, kind, chart, today, rangeDays)

  if (!days.some((d) => d.value !== null)) {
    return (
      <div data-property-chart={type}>
        <p className="py-6 text-center text-sm text-text-tertiary">{t('editor.chart.noData')}</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4" data-property-chart={type}>
      {compact ? null : <ChartStats stats={chartStats(kind, days, previous, counts, t, format)} />}
      <ChartBody
        type={type}
        kind={kind}
        days={days}
        counts={counts}
        optionColors={optionColors}
        onOpenDay={onOpenDay}
        ariaLabel={t('editor.chart.aria', { property, days: rangeDays })}
        compact={compact}
      />
    </div>
  )
}
