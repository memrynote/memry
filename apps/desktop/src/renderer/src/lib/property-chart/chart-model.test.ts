import { describe, expect, it } from 'vitest'
import {
  addDays,
  buildChartDays,
  countCategories,
  dayOfValue,
  dayRange,
  resolveChartType,
  summarizeNumbers,
  summarizeStreaks,
  valueKindFor,
  type ChartRow
} from './chart-model'

const row = (id: string, day: string | null, properties: Record<string, unknown>): ChartRow => ({
  id,
  day,
  properties
})

describe('day arithmetic', () => {
  it('crosses month, year and leap-day boundaries', () => {
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01')
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31')
    expect(dayRange('2026-03-02', 3)).toEqual(['2026-02-28', '2026-03-01', '2026-03-02'])
  })

  it('keeps date keys as written and places timestamps on a day', () => {
    expect(dayOfValue('2026-09-29')).toBe('2026-09-29')
    expect(dayOfValue('')).toBeNull()
    expect(dayOfValue('not a date')).toBeNull()
    expect(dayOfValue(new Date(2026, 8, 29, 23, 30).toISOString())).toBe('2026-09-29')
  })
})

describe('resolveChartType', () => {
  it('suggests from the property type and refuses a type the kind cannot draw', () => {
    expect(resolveChartType(valueKindFor('number'), undefined)).toBe('line')
    expect(resolveChartType(valueKindFor('checkbox'), undefined)).toBe('heatmap')
    expect(resolveChartType(valueKindFor('status'), undefined)).toBe('heatmap')
    expect(resolveChartType(valueKindFor('multiselect'), undefined)).toBe('bar')
    expect(resolveChartType(valueKindFor('checkbox'), 'line')).toBe('heatmap')
    expect(resolveChartType(valueKindFor('number'), 'bar')).toBe('bar')
  })
})

describe('buildChartDays', () => {
  const days = ['2026-09-01', '2026-09-02', '2026-09-03']

  it('aggregates numbers on the same day and leaves empty days as gaps or zeros', () => {
    const rows = [
      row('a', '2026-09-01', { sleep: 6 }),
      row('b', '2026-09-01', { sleep: '8' }),
      row('c', '2026-09-03', { sleep: 'n/a' }),
      row('d', null, { sleep: 100 })
    ]

    const average = buildChartDays({ rows, property: 'sleep', kind: 'number', days })
    expect(average.map((d) => d.value)).toEqual([7, null, null])
    expect(average[0].rowIds).toEqual(['a', 'b'])

    const summed = buildChartDays({
      rows,
      property: 'sleep',
      kind: 'number',
      days,
      aggregate: 'sum',
      missing: 'zero'
    })
    expect(summed.map((d) => d.value)).toEqual([14, 0, 0])
  })

  it('marks a checkbox day done when any entry that day is checked', () => {
    const rows = [
      row('a', '2026-09-01', { workout: false }),
      row('b', '2026-09-01', { workout: true }),
      row('c', '2026-09-02', { workout: false })
    ]
    const result = buildChartDays({ rows, property: 'workout', kind: 'boolean', days })
    expect(result.map((d) => d.value)).toEqual([1, 0, null])
  })

  it('takes the most frequent select value, the later one on a tie', () => {
    const rows = [
      row('a', '2026-09-01', { mood: 'good' }),
      row('b', '2026-09-01', { mood: 'bad' }),
      row('c', '2026-09-02', { mood: 'good' }),
      row('d', '2026-09-02', { mood: 'good' }),
      row('e', '2026-09-02', { mood: 'okay' })
    ]
    const result = buildChartDays({ rows, property: 'mood', kind: 'category', days })
    expect(result.map((d) => d.category)).toEqual(['bad', 'good', null])
  })
})

describe('summaries', () => {
  it('compares the average with the previous period and finds the extremes', () => {
    const days = buildChartDays({
      rows: [row('a', '2026-09-02', { s: 6 }), row('b', '2026-09-03', { s: 8 })],
      property: 's',
      kind: 'number',
      days: ['2026-09-02', '2026-09-03']
    })
    const previous = buildChartDays({
      rows: [row('c', '2026-09-01', { s: 5 })],
      property: 's',
      kind: 'number',
      days: ['2026-08-31', '2026-09-01']
    })

    expect(summarizeNumbers(days, previous)).toEqual({
      average: 7,
      previousAverage: 5,
      min: { value: 6, day: '2026-09-02' },
      max: { value: 8, day: '2026-09-03' },
      logged: 2
    })
  })

  it('keeps the current streak alive while today is still open', () => {
    const at = (values: (number | null)[]) =>
      values.map((value, i) => ({ day: `d${i}`, value, category: null, rowIds: [] }))

    expect(summarizeStreaks(at([1, 1, 0, 1, 1, 1, null]))).toEqual({
      current: 3,
      longest: 3,
      done: 5,
      total: 7
    })
    expect(summarizeStreaks(at([1, 1, null, null])).current).toBe(0)
  })

  it('counts the days each select value was recorded on', () => {
    const rows = [
      row('a', '2026-09-01', { tags: ['gym', 'run'] }),
      row('b', '2026-09-01', { tags: ['gym'] }),
      row('c', '2026-09-02', { tags: ['run'] }),
      row('d', '2026-08-01', { tags: ['swim'] })
    ]
    expect(countCategories(rows, 'tags', new Set(['2026-09-01', '2026-09-02']))).toEqual([
      { value: 'run', count: 2 },
      { value: 'gym', count: 1 }
    ])
  })
})
