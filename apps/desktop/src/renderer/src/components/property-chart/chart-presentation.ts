/**
 * How a chart's days read and look: the tooltip line, the summary figures and
 * the heatmap colours, per value kind. Pure functions over the chart model; the
 * translator and formatters come in as arguments.
 */
import { defaultTagColorName, getTagColors } from '@/components/note/tags-row/tag-colors'
import {
  summarizeLogged,
  summarizeNumbers,
  summarizeStreaks,
  type CategoryCount,
  type ChartDay,
  type ChartValueKind
} from '@/lib/property-chart/chart-model'
import type { ChartStat } from './chart-parts'

type Translate = (key: string, values?: Record<string, unknown>) => string

export interface ChartFormat {
  number: (value: number) => string
  shortDay: (day: string) => string
}

/** `color-mix` of the accent into the empty-cell colour, for intensity levels. */
const LEVELS = [
  'color-mix(in srgb, var(--tint) 30%, var(--muted))',
  'color-mix(in srgb, var(--tint) 55%, var(--muted))',
  'color-mix(in srgb, var(--tint) 80%, var(--muted))',
  'var(--tint)'
]
const FULL = LEVELS[LEVELS.length - 1]
const EMPTY_CELL = 'var(--muted)'

/** The tooltip's second line for a day. */
export function describeDay(
  kind: ChartValueKind,
  day: ChartDay,
  t: Translate,
  format: ChartFormat
): string {
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

/** A select value's own option colour, or a stable hue when it has none. */
export function categoryColor(value: string, optionColors?: ReadonlyMap<string, string>): string {
  return getTagColors(optionColors?.get(value) ?? defaultTagColorName(value)).background
}

/**
 * A value's level among the recorded values, so one outlier does not wash
 * every other day out to the palest level. `sorted` is ascending.
 */
function levelColor(value: number, sorted: number[]): string {
  if (sorted.length === 0) return FULL
  let below = 0
  while (below < sorted.length && sorted[below] < value) below++
  const rank = sorted.length === 1 ? 1 : below / (sorted.length - 1)
  return LEVELS[Math.min(LEVELS.length - 1, Math.floor(rank * LEVELS.length))]
}

/** A heatmap cell's fill. */
export function cellColor(
  kind: ChartValueKind,
  day: ChartDay,
  sortedValues: number[],
  optionColors?: ReadonlyMap<string, string>
): string {
  if (day.value === null) return EMPTY_CELL
  if (kind === 'category') return categoryColor(day.category ?? '', optionColors)
  if (day.value <= 0) return EMPTY_CELL
  if (kind === 'boolean' || kind === 'presence') return FULL
  return levelColor(day.value, sortedValues)
}

function signed(delta: number, format: ChartFormat): string {
  const sign = delta > 0 ? '+' : delta < 0 ? '−' : ''
  return `${sign}${format.number(Math.abs(delta))}`
}

function numberStats(
  days: ChartDay[],
  previous: ChartDay[],
  t: Translate,
  format: ChartFormat
): ChartStat[] {
  const { average, previousAverage, min } = summarizeNumbers(days, previous)
  const stats: ChartStat[] = []
  if (average !== null)
    stats.push({ label: t('editor.chart.average'), value: format.number(average) })
  if (average !== null && previousAverage !== null) {
    stats.push({
      label: t('editor.chart.vsPrevious'),
      value: signed(average - previousAverage, format)
    })
  }
  if (min) {
    stats.push({
      label: t('editor.chart.lowest'),
      value: `${format.number(min.value)} · ${format.shortDay(min.day)}`
    })
  }
  return stats
}

/** The figures over a chart: averages for numbers, streaks for days done, the usual value for selects. */
export function chartStats(
  kind: ChartValueKind,
  days: ChartDay[],
  previous: ChartDay[],
  counts: CategoryCount[],
  t: Translate,
  format: ChartFormat
): ChartStat[] {
  const ofTotal = (part: number, total: number): string =>
    t('editor.chart.ofTotal', { part: format.number(part), total: format.number(total) })
  if (kind === 'number') return numberStats(days, previous, t, format)
  if (kind === 'boolean' || kind === 'presence') {
    const streaks = summarizeStreaks(days)
    return [
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
    ]
  }
  const logged = summarizeLogged(days)
  return [
    ...(counts[0] ? [{ label: t('editor.chart.mostCommon'), value: counts[0].value }] : []),
    { label: t('editor.chart.loggedDays'), value: ofTotal(logged.logged, logged.total) }
  ]
}
