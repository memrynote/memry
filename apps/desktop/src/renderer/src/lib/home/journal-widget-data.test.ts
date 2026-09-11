import { describe, it, expect } from 'vitest'
import type { HeatmapEntry } from '../../../../preload/index.d'
import {
  buildWeekDays,
  buildUpcomingDays,
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

describe('buildUpcomingDays', () => {
  it('returns today first, then the next three days', () => {
    const days = buildUpcomingDays('2026-06-23', 'en-US')
    expect(days.map((d) => d.iso)).toEqual(['2026-06-23', '2026-06-24', '2026-06-25', '2026-06-26'])
    expect(days[0].isToday).toBe(true)
    expect(days.slice(1).every((d) => !d.isToday)).toBe(true)
    expect(days[3].dayNum).toBe(26)
    expect(days[0].weekdayShort).toBeTruthy()
  })

  it('crosses a month boundary', () => {
    expect(buildUpcomingDays('2026-06-29', 'en-US').map((d) => d.iso)).toEqual([
      '2026-06-29',
      '2026-06-30',
      '2026-07-01',
      '2026-07-02'
    ])
  })

  it('crosses a year boundary', () => {
    expect(buildUpcomingDays('2026-12-30', 'en-US').map((d) => d.iso)).toEqual([
      '2026-12-30',
      '2026-12-31',
      '2027-01-01',
      '2027-01-02'
    ])
  })

  it('crosses a leap day', () => {
    expect(buildUpcomingDays('2028-02-27', 'en-US').map((d) => d.iso)).toEqual([
      '2028-02-27',
      '2028-02-28',
      '2028-02-29',
      '2028-03-01'
    ])
  })

  // Local calendar arithmetic, not UTC or +24h: a 23- or 25-hour day inside the window
  // must still advance exactly one calendar date, in whatever zone the run happens in.
  it('advances one calendar day at a time across DST transition dates', () => {
    for (const start of ['2026-03-07', '2026-10-31', '2026-03-27', '2026-11-01']) {
      const days = buildUpcomingDays(start, 'en-US')
      expect(days).toHaveLength(4)
      for (let i = 1; i < days.length; i++) {
        const previous = new Date(`${days[i - 1].iso}T12:00:00Z`)
        const current = new Date(`${days[i].iso}T12:00:00Z`)
        expect(current.getTime() - previous.getTime()).toBe(24 * 60 * 60 * 1000)
        expect(days[i].dayNum).toBe(Number(days[i].iso.slice(8)))
      }
    }
  })

  it('honours an explicit count', () => {
    expect(buildUpcomingDays('2026-06-23', 'en-US', 2).map((d) => d.iso)).toEqual([
      '2026-06-23',
      '2026-06-24'
    ])
  })
})
