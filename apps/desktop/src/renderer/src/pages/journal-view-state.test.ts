import { describe, expect, it } from 'vitest'

import {
  DEFAULT_JOURNAL_DRILL,
  journalScrollKey,
  parseJournalDrill,
  resolveJournalDate,
  toJournalViewState
} from './journal-view-state'

describe('parseJournalDrill', () => {
  it('accepts the three levels the breadcrumb can reach', () => {
    expect(parseJournalDrill({ type: 'day' })).toEqual({ type: 'day' })
    expect(parseJournalDrill({ type: 'month', year: 2026, month: 0 })).toEqual({
      type: 'month',
      year: 2026,
      month: 0
    })
    expect(parseJournalDrill({ type: 'year', year: 2026 })).toEqual({ type: 'year', year: 2026 })
  })

  it('keeps month 0, which is January and not "missing"', () => {
    expect(parseJournalDrill({ type: 'month', year: 2026, month: 0 })?.type).toBe('month')
    expect(parseJournalDrill({ type: 'month', year: 2026, month: 11 })?.type).toBe('month')
  })

  it('rejects a month outside the year rather than clamping it', () => {
    // A clamp would silently show January for a value that means nothing; a
    // rejection falls back to the day view the user can navigate from.
    expect(parseJournalDrill({ type: 'month', year: 2026, month: 12 })).toBeUndefined()
    expect(parseJournalDrill({ type: 'month', year: 2026, month: -1 })).toBeUndefined()
  })

  it('rejects a level missing the numbers it needs', () => {
    expect(parseJournalDrill({ type: 'month', year: 2026 })).toBeUndefined()
    expect(parseJournalDrill({ type: 'month', month: 3 })).toBeUndefined()
    expect(parseJournalDrill({ type: 'year' })).toBeUndefined()
    expect(parseJournalDrill({ type: 'year', year: '2026' })).toBeUndefined()
    expect(parseJournalDrill({ type: 'year', year: 2026.5 })).toBeUndefined()
  })

  it('rejects anything that is not a drill record', () => {
    expect(parseJournalDrill(undefined)).toBeUndefined()
    expect(parseJournalDrill(null)).toBeUndefined()
    expect(parseJournalDrill('day')).toBeUndefined()
    expect(parseJournalDrill({ type: 'decade', year: 2020 })).toBeUndefined()
  })

  it('drops a date smuggled into a day drill', () => {
    // The tab's own `date` key is the one truth for which day is open. Storing
    // it twice gives it two owners that disagree the moment `openTab` writes.
    expect(parseJournalDrill({ type: 'day', date: '2026-01-05' })).toEqual({ type: 'day' })
  })
})

describe('toJournalViewState', () => {
  it('takes the day from the tab, never from the drill record', () => {
    expect(toJournalViewState(DEFAULT_JOURNAL_DRILL, '2026-01-05')).toEqual({
      type: 'day',
      date: '2026-01-05'
    })
  })

  it('passes a month or year level straight through', () => {
    expect(toJournalViewState({ type: 'month', year: 2026, month: 4 }, '2026-01-05')).toEqual({
      type: 'month',
      year: 2026,
      month: 4
    })
    expect(toJournalViewState({ type: 'year', year: 2019 }, '2026-01-05')).toEqual({
      type: 'year',
      year: 2019
    })
  })
})

describe('resolveJournalDate', () => {
  it('opens on today when the tab carries no date', () => {
    expect(resolveJournalDate(undefined, '2026-08-17')).toBe('2026-08-17')
    // An empty string is not a date either — the first open must still land on
    // today rather than on a blank entry.
    expect(resolveJournalDate('', '2026-08-17')).toBe('2026-08-17')
  })

  it('prefers the tab own date once it has one', () => {
    expect(resolveJournalDate('2026-01-05', '2026-08-17')).toBe('2026-01-05')
  })
})

describe('journalScrollKey', () => {
  it('gives every day its own scroller identity', () => {
    // The tab's entityId does not change when the journal moves to the next
    // day, so the entity stamp cannot discard the previous day's offset. The
    // key has to.
    expect(journalScrollKey({ type: 'day', date: '2026-01-05' })).not.toBe(
      journalScrollKey({ type: 'day', date: '2026-01-06' })
    )
  })

  it('separates the three levels from each other', () => {
    const keys = [
      journalScrollKey({ type: 'day', date: '2026-01-05' }),
      journalScrollKey({ type: 'month', year: 2026, month: 0 }),
      journalScrollKey({ type: 'year', year: 2026 })
    ]
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('shares one key across months and one across years', () => {
    // Month and year views are short grids the user pages through; giving each
    // one its own slot would evict the day offsets that matter.
    expect(journalScrollKey({ type: 'month', year: 2026, month: 0 })).toBe(
      journalScrollKey({ type: 'month', year: 2019, month: 7 })
    )
    expect(journalScrollKey({ type: 'year', year: 2026 })).toBe(
      journalScrollKey({ type: 'year', year: 2019 })
    )
  })
})
