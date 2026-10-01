/**
 * The data behind a property chart: rows bucketed into days, one value per
 * day, and the numbers a chart's summary line shows. Pure, so it is tested
 * without a renderer and shared by the view block and the property popover.
 */
import type {
  ViewBlockChartAggregate,
  ViewBlockChartMissing,
  ViewBlockChartType
} from '@memry/shared/view-block'

/** How a property's values are read, whatever its declared type is called. */
export type ChartValueKind = 'number' | 'boolean' | 'category' | 'categories' | 'presence'

export interface ChartRow {
  id: string
  /** The day the row falls on, `YYYY-MM-DD`, or null when it has none. */
  day: string | null
  properties: Record<string, unknown>
}

export interface ChartDay {
  day: string
  /**
   * The day's number. For a checkbox 1 or 0, for a select 1 when set, for
   * a multi-select the count of values. Null when nothing was recorded.
   */
  value: number | null
  /** A select's value that day, the most frequent one when there are several. */
  category: string | null
  /** The rows that fell on the day, for opening them from the chart. */
  rowIds: string[]
}

export function valueKindFor(propertyType: string | undefined): ChartValueKind {
  switch (propertyType) {
    case 'number':
    case 'rating':
      return 'number'
    case 'checkbox':
      return 'boolean'
    case 'select':
    case 'status':
      return 'category'
    case 'multiselect':
      return 'categories'
    default:
      return 'presence'
  }
}

const ALLOWED_TYPES: Record<ChartValueKind, readonly ViewBlockChartType[]> = {
  number: ['line', 'bar', 'heatmap'],
  boolean: ['heatmap', 'bar'],
  category: ['heatmap', 'bar'],
  categories: ['bar', 'heatmap'],
  presence: ['heatmap', 'bar']
}

/** The chart types that make sense for a kind, the suggested one first. */
export function allowedChartTypes(kind: ChartValueKind): readonly ViewBlockChartType[] {
  return ALLOWED_TYPES[kind]
}

export function suggestedChartType(kind: ChartValueKind): ViewBlockChartType {
  return ALLOWED_TYPES[kind][0]
}

/** The chart type drawn: the chosen one when it fits the kind, else the suggestion. */
export function resolveChartType(
  kind: ChartValueKind,
  chosen: ViewBlockChartType | undefined
): ViewBlockChartType {
  return chosen && ALLOWED_TYPES[kind].includes(chosen) ? chosen : suggestedChartType(kind)
}

/** A range that reads well for the type: a month of points, half a year of squares. */
export function defaultRangeDays(type: ViewBlockChartType): number {
  return type === 'heatmap' ? 182 : 30
}

// ---------------------------------------------------------------------------
// Days
// ---------------------------------------------------------------------------

const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** Today's local day key. */
export function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** A day key moved by `delta` days, through UTC so no time zone shift can skip one. */
export function addDays(day: string, delta: number): string {
  const match = DAY_KEY.exec(day)
  if (!match) return day
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + delta))
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
}

/** 0 for Sunday through 6 for Saturday. */
export function weekdayOf(day: string): number {
  const match = DAY_KEY.exec(day)
  if (!match) return 0
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay()
}

/** The `count` days ending on `end`, oldest first. */
export function dayRange(end: string, count: number): string[] {
  const days: string[] = []
  for (let i = count - 1; i >= 0; i--) days.push(addDays(end, -i))
  return days
}

/**
 * The local day a stored value falls on: a `YYYY-MM-DD` key as is, a
 * timestamp in the reader's own time zone.
 */
export function dayOfValue(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (DAY_KEY.test(trimmed)) return trimmed
    if (trimmed === '') return null
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : localDayKey(date)
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

export function readNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

export function readBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  if (value === 'true' || value === 'yes' || value === 1) return true
  if (value === 'false' || value === 'no' || value === 0) return false
  return null
}

export function readCategories(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value]
  return list
    .filter(
      (entry): entry is string | number => typeof entry === 'string' || typeof entry === 'number'
    )
    .map((entry) => String(entry).trim())
    .filter((entry) => entry !== '')
}

function isPresent(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false
  if (typeof value === 'string') return value.trim() !== ''
  if (Array.isArray(value)) return value.length > 0
  return true
}

function aggregateNumbers(values: number[], aggregate: ViewBlockChartAggregate): number | null {
  if (aggregate === 'count') return values.length
  if (values.length === 0) return null
  switch (aggregate) {
    case 'sum':
      return values.reduce((a, b) => a + b, 0)
    case 'min':
      return Math.min(...values)
    case 'max':
      return Math.max(...values)
    default:
      return values.reduce((a, b) => a + b, 0) / values.length
  }
}

/** The value seen most often; on a tie, the one recorded last. */
function mostFrequent(values: string[]): string | null {
  const counts = new Map<string, number>()
  let best: string | null = null
  let bestCount = 0
  for (const value of values) {
    const next = (counts.get(value) ?? 0) + 1
    counts.set(value, next)
    if (next >= bestCount) {
      best = value
      bestCount = next
    }
  }
  return best
}

export interface BuildChartDaysInput {
  rows: ChartRow[]
  property: string
  kind: ChartValueKind
  days: string[]
  aggregate?: ViewBlockChartAggregate
  missing?: ViewBlockChartMissing
}

/** One entry per day in `days`, in the same order. */
export function buildChartDays({
  rows,
  property,
  kind,
  days,
  aggregate = 'average',
  missing = 'gap'
}: BuildChartDaysInput): ChartDay[] {
  const byDay = new Map<string, ChartRow[]>()
  for (const day of days) byDay.set(day, [])
  for (const row of rows) {
    if (row.day === null) continue
    byDay.get(row.day)?.push(row)
  }

  return days.map((day) => {
    const dayRows = byDay.get(day) ?? []
    const rowIds = dayRows.map((row) => row.id)
    const values = dayRows.map((row) => row.properties[property])
    let value: number | null = null
    let category: string | null = null

    if (kind === 'number') {
      const numbers = values.map(readNumber).filter((n): n is number => n !== null)
      value = aggregateNumbers(numbers, aggregate)
    } else if (kind === 'boolean') {
      const flags = values.map(readBoolean).filter((b): b is boolean => b !== null)
      value = flags.length === 0 ? null : flags.some(Boolean) ? 1 : 0
    } else if (kind === 'category') {
      category = mostFrequent(values.flatMap(readCategories))
      value = category === null ? null : 1
    } else if (kind === 'categories') {
      const all = values.flatMap(readCategories)
      value = all.length === 0 ? null : new Set(all).size
    } else {
      value = values.some(isPresent) ? 1 : null
    }

    if (value === null && missing === 'zero' && (kind === 'number' || kind === 'boolean')) {
      value = 0
    }
    return { day, value, category, rowIds }
  })
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

export interface NumberSummary {
  average: number | null
  /** The same average over the period before, for the "vs previous" figure. */
  previousAverage: number | null
  min: { value: number; day: string } | null
  max: { value: number; day: string } | null
  logged: number
}

function averageOf(days: ChartDay[]): number | null {
  const values = days.map((d) => d.value).filter((v): v is number => v !== null)
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length
}

export function summarizeNumbers(days: ChartDay[], previous: ChartDay[]): NumberSummary {
  let min: NumberSummary['min'] = null
  let max: NumberSummary['max'] = null
  let logged = 0
  for (const { day, value } of days) {
    if (value === null) continue
    logged++
    if (!min || value < min.value) min = { value, day }
    if (!max || value > max.value) max = { value, day }
  }
  return { average: averageOf(days), previousAverage: averageOf(previous), min, max, logged }
}

export interface StreakSummary {
  /** Done days in a row, ending today, or yesterday while today is still open. */
  current: number
  longest: number
  done: number
  total: number
}

/** A day counts as done when its value is above zero. `days` ends today. */
export function summarizeStreaks(days: ChartDay[]): StreakSummary {
  const done = days.map((d) => d.value !== null && d.value > 0)
  let longest = 0
  let run = 0
  for (const isDone of done) {
    run = isDone ? run + 1 : 0
    longest = Math.max(longest, run)
  }
  let current = 0
  let i = done.length - 1
  if (i >= 0 && !done[i]) i--
  while (i >= 0 && done[i]) {
    current++
    i--
  }
  return { current, longest, done: done.filter(Boolean).length, total: days.length }
}

export interface CategoryCount {
  value: string
  count: number
}

/**
 * How many days each value was recorded on, most frequent first. For a select
 * that is its daily value; for a multi-select, each value it held.
 */
export function countCategories(
  rows: ChartRow[],
  property: string,
  daysInRange: ReadonlySet<string>
): CategoryCount[] {
  const daysByValue = new Map<string, Set<string>>()
  for (const row of rows) {
    if (row.day === null || !daysInRange.has(row.day)) continue
    for (const value of readCategories(row.properties[property])) {
      const set = daysByValue.get(value) ?? new Set<string>()
      set.add(row.day)
      daysByValue.set(value, set)
    }
  }
  return [...daysByValue.entries()]
    .map(([value, set]) => ({ value, count: set.size }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
}

export interface LoggedSummary {
  logged: number
  total: number
}

export function summarizeLogged(days: ChartDay[]): LoggedSummary {
  return { logged: days.filter((d) => d.value !== null).length, total: days.length }
}
