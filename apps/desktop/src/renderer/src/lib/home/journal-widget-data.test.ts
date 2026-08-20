import { describe, it, expect } from 'vitest'
import type { HeatmapEntry } from '../../../../preload/index.d'
import {
  buildWeekDays,
  recentEntryDates,
  relativeDayLabel,
  entrySnippet
} from './journal-widget-data'

describe('buildWeekDays', () => {
  it('returns 7 days ending today, oldest first', () => {
    const days = buildWeekDays('2026-06-23', new Set(), 'en-US')
    expect(days).toHaveLength(7)
    expect(days.map((d) => d.iso)).toEqual([
      '2026-06-17',
      '2026-06-18',
      '2026-06-19',
      '2026-06-20',
      '2026-06-21',
      '2026-06-22',
      '2026-06-23'
    ])
    expect(days[6].isToday).toBe(true)
    expect(days[0].isToday).toBe(false)
    expect(days[6].dayNum).toBe(23)
    expect(days[6].weekdayNarrow).toBeTruthy()
  })

  it('flags days that have an entry', () => {
    const days = buildWeekDays('2026-06-23', new Set(['2026-06-19', '2026-06-23']), 'en-US')
    expect(days.find((d) => d.iso === '2026-06-19')?.hasEntry).toBe(true)
    expect(days.find((d) => d.iso === '2026-06-20')?.hasEntry).toBe(false)
  })

  it('crosses month boundaries', () => {
    const days = buildWeekDays('2026-07-02', new Set(), 'en-US')
    expect(days[0].iso).toBe('2026-06-26')
    expect(days[6].iso).toBe('2026-07-02')
  })
})

describe('recentEntryDates', () => {
  const entries: HeatmapEntry[] = [
    { date: '2026-06-20', characterCount: 10, level: 1 },
    { date: '2026-06-23', characterCount: 50, level: 3 },
    { date: '2026-06-21', characterCount: 0, level: 0 },
    { date: '2026-06-22', characterCount: 30, level: 2 }
  ]

  it('drops empty days, sorts most-recent first, caps at limit', () => {
    expect(recentEntryDates(entries, 2)).toEqual(['2026-06-23', '2026-06-22'])
  })

  it('returns all qualifying dates when limit exceeds count', () => {
    expect(recentEntryDates(entries, 10)).toEqual(['2026-06-23', '2026-06-22', '2026-06-20'])
  })
})

describe('relativeDayLabel', () => {
  it('labels today and yesterday', () => {
    expect(relativeDayLabel('2026-06-23', '2026-06-23', 'en-US')).toEqual({ kind: 'today' })
    expect(relativeDayLabel('2026-06-22', '2026-06-23', 'en-US')).toEqual({ kind: 'yesterday' })
  })

  it('formats older dates', () => {
    const label = relativeDayLabel('2026-06-18', '2026-06-23', 'en-US')
    expect(label.kind).toBe('date')
    expect(label.kind === 'date' && label.text).toBeTruthy()
  })
})

describe('entrySnippet', () => {
  it('strips markdown markers and collapses whitespace', () => {
    expect(entrySnippet('# Title\n\nFelt **clear-headed**   today.')).toBe(
      'Title Felt clear-headed today.'
    )
  })

  it('keeps link text, drops the url', () => {
    expect(entrySnippet('See [the notes](https://x.test) later')).toBe('See the notes later')
  })

  it('truncates with an ellipsis past max', () => {
    const out = entrySnippet('abcdefghij', 5)
    expect(out).toBe('abcde…')
  })

  it('drops frontmatter when present', () => {
    expect(entrySnippet('---\ndate: 2026-06-23\n---\nBody text')).toBe('Body text')
  })
})

describe('entrySnippet wiki links (issue #1556)', () => {
  it('reads a heading link as its note half', () => {
    expect(entrySnippet('see [[Sprint Notes#Retro]] today')).toBe('see Sprint Notes today')
  })

  it('reads an aliased link as its alias, not the raw target|alias run', () => {
    expect(entrySnippet('see [[Sprint Notes|retro]] today')).toBe('see retro today')
  })
})
