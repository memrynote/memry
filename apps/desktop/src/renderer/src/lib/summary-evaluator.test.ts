import { describe, expect, it, vi } from 'vitest'
import {
  computeSummary,
  formatSummaryValue,
  getColumnValues,
  getSummaryTypeLabel,
  getSummaryTypesForColumn,
  getSummaryTypeSymbol
} from './summary-evaluator'

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ warn: vi.fn() })
}))

const notes = [
  {
    title: 'Alpha',
    folder: 'Work',
    tags: ['alpha', 'shared'],
    created: '2026-01-01T00:00:00.000Z',
    modified: '2026-01-02T00:00:00.000Z',
    wordCount: 120,
    properties: { score: 10, status: 'Open', points: '2.5' }
  },
  {
    title: 'Beta',
    folder: 'Home',
    tags: ['shared'],
    created: '2026-01-03T00:00:00.000Z',
    modified: '2026-01-04T00:00:00.000Z',
    wordCount: 80,
    properties: { score: 5, status: 'Done', points: '7.5' }
  }
] as any[]

describe('summary evaluator', () => {
  it('extracts built-in, property, and formula column values', () => {
    expect(getColumnValues(notes, 'title')).toEqual(['Alpha', 'Beta'])
    expect(getColumnValues(notes, 'folder')).toEqual(['Work', 'Home'])
    expect(getColumnValues(notes, 'tags')).toEqual([['alpha', 'shared'], ['shared']])
    expect(getColumnValues(notes, 'created')).toEqual([
      '2026-01-01T00:00:00.000Z',
      '2026-01-03T00:00:00.000Z'
    ])
    expect(getColumnValues(notes, 'modified')).toEqual([
      '2026-01-02T00:00:00.000Z',
      '2026-01-04T00:00:00.000Z'
    ])
    expect(getColumnValues(notes, 'wordCount')).toEqual([120, 80])
    expect(getColumnValues(notes, 'score')).toEqual([10, 5])
    expect(getColumnValues(notes, 'missing')).toEqual([null, null])
    expect(getColumnValues(notes, 'formula.total', { total: 'score + wordCount' })).toEqual([
      130, 85
    ])
    expect(getColumnValues(notes, 'formula.unknown')).toEqual([null, null])
  })

  it('computes numeric and date summaries', () => {
    expect(computeSummary([1, '2.5', Number.NaN, 'x', 4], { type: 'sum' } as any)).toBe(7.5)
    expect(computeSummary([1, '2', null], { type: 'average' } as any)).toBe(1.5)
    expect(computeSummary(['2026-01-03', '2026-01-01'], { type: 'min' } as any)).toBe(
      '2026-01-01T00:00:00.000Z'
    )
    expect(computeSummary(['2026-01-03', '2026-01-01'], { type: 'max' } as any)).toBe(
      '2026-01-03T00:00:00.000Z'
    )
    expect(computeSummary([null, undefined, 'x'], { type: 'min' } as any)).toBeNull()
    expect(computeSummary([null, 5, 2, '1.5x'], { type: 'min' } as any)).toBe(1.5)
    expect(computeSummary([null, 5, 2, '7.5x'], { type: 'max' } as any)).toBe(7.5)
    expect(computeSummary([null, undefined, 'x'], { type: 'max' } as any)).toBeNull()
    expect(computeSummary(['x'], { type: 'average' } as any)).toBeNull()
  })

  it('computes count summaries across empty, scalar, and array values', () => {
    expect(computeSummary([null, undefined, '', 'x', [], ['a']], { type: 'count' } as any)).toBe(2)
    expect(computeSummary([['b', 'a'], 'a', 'c', 'b'], { type: 'countUnique' } as any)).toBe(3)
    expect(
      computeSummary([['b', 'a'], 'a', 'c', 'b', 'd', 'e', 'f'], { type: 'countBy' } as any)
    ).toBe('a: 2, b: 2, c: 1, d: 1, e: 1 (+1 more)')
    expect(computeSummary([null, ''], { type: 'countBy' } as any)).toBe('')
  })

  it('computes custom summaries for supported aggregate expressions', () => {
    expect(computeSummary([2, 3], { type: 'custom', expression: 'sum' } as any)).toBe(5)
    expect(computeSummary([2, 4], { type: 'custom', expression: 'average(values)' } as any)).toBe(3)
    expect(computeSummary([2, 4], { type: 'custom', expression: 'min(values)' } as any)).toBe(2)
    expect(computeSummary([2, 4], { type: 'custom', expression: 'max' } as any)).toBe(4)
    expect(
      computeSummary([2, null, 'x'], { type: 'custom', expression: 'count(values)' } as any)
    ).toBe(2)
    expect(
      computeSummary([['a', 'b'], 'a'], { type: 'custom', expression: 'countUnique' } as any)
    ).toBe(2)
    expect(computeSummary([2, 4], { type: 'custom', expression: 'sum * 1.5' } as any)).toBe(9)
    expect(computeSummary(['2', '3'], { type: 'custom', expression: 'sum * 1.5' } as any)).toBe(2)
    expect(computeSummary(['x', 'y'], { type: 'custom', expression: 'unknown' } as any)).toBe(2)
    expect(computeSummary([1], { type: 'custom' } as any)).toBeNull()
    expect(
      computeSummary([1], {
        type: 'custom',
        expression: {
          toLowerCase: () => {
            throw new Error('bad expression')
          }
        }
      } as any)
    ).toBeNull()
    expect(computeSummary([1], { type: 'unknown' } as any)).toBeNull()
  })

  it('formats results and exposes type metadata', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-10T12:00:00.000Z'))

    expect(formatSummaryValue(null, { type: 'count' } as any)).toBe('--'.replace('--', '—'))
    expect(formatSummaryValue(undefined, { type: 'count' } as any)).toBe('—')
    expect(formatSummaryValue(1234.567, { type: 'sum' } as any)).toBe('1,234.57')
    expect(formatSummaryValue(3.5, { type: 'average' } as any)).toBe('3.5')
    expect(formatSummaryValue(1200, { type: 'countUnique' } as any)).toBe('1,200')
    expect(formatSummaryValue('Open: 2', { type: 'countBy' } as any)).toBe('Open: 2')
    expect(formatSummaryValue('2026-05-10T00:00:00.000Z', { type: 'min' } as any)).toBe('Today')
    expect(formatSummaryValue('2026-05-09T00:00:00.000Z', { type: 'max' } as any)).toBe('Yesterday')
    expect(formatSummaryValue('2026-05-11T00:00:00.000Z', { type: 'min' } as any)).toBe('Tomorrow')
    expect(formatSummaryValue('2026-01-01T00:00:00.000Z', { type: 'min' } as any)).toBe('Jan 1')
    expect(formatSummaryValue('2025-12-31T00:00:00.000Z', { type: 'max' } as any)).toBe(
      'Dec 31, 2025'
    )
    expect(formatSummaryValue('not-a-date', { type: 'min' } as any)).toBe('not-a-date')
    expect(formatSummaryValue(true as any, { type: 'count' } as any)).toBe('true')

    expect(getSummaryTypesForColumn('number')).toContain('average')
    expect(getSummaryTypesForColumn('date')).toEqual(['count', 'min', 'max'])
    expect(getSummaryTypesForColumn('checkbox')).toEqual(['count', 'countBy'])
    expect(getSummaryTypesForColumn('select')).toEqual(['count', 'countBy', 'countUnique'])
    expect(getSummaryTypesForColumn('tags')).toEqual(['count', 'countBy', 'countUnique'])
    expect(getSummaryTypesForColumn('text')).toEqual(['count', 'countUnique'])
    expect(getSummaryTypesForColumn('multiselect')).toContain('countBy')
    expect(getSummaryTypesForColumn('url')).toEqual(['count', 'countUnique'])
    expect(getSummaryTypeLabel('sum')).toBe('Sum')
    expect(getSummaryTypeLabel('average')).toBe('Average')
    expect(getSummaryTypeLabel('min')).toBe('Min')
    expect(getSummaryTypeLabel('max')).toBe('Max')
    expect(getSummaryTypeLabel('count')).toBe('Count')
    expect(getSummaryTypeLabel('countBy')).toBe('Count by value')
    expect(getSummaryTypeLabel('countUnique')).toBe('Unique')
    expect(getSummaryTypeLabel('custom')).toBe('Custom')
    expect(getSummaryTypeLabel('unknown' as any)).toBe('unknown')
    expect(getSummaryTypeSymbol('sum')).toBe('Σ')
    expect(getSummaryTypeSymbol('average')).toBe('μ')
    expect(getSummaryTypeSymbol('min')).toBe('↓')
    expect(getSummaryTypeSymbol('max')).toBe('↑')
    expect(getSummaryTypeSymbol('count')).toBe('#')
    expect(getSummaryTypeSymbol('countBy')).toBe('⊞')
    expect(getSummaryTypeSymbol('countUnique')).toBe('∪')
    expect(getSummaryTypeSymbol('custom')).toBe('ƒ')
    expect(getSummaryTypeSymbol('unknown' as any)).toBe('?')

    vi.useRealTimers()
  })
})
