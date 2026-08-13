import { describe, it, expect } from 'vitest'
import { classifyCalendarStem } from './calendar-dates.ts'

describe('classifyCalendarStem', () => {
  it('reads a daily note stem as an ISO day', () => {
    expect(classifyCalendarStem('20260812')).toEqual({
      kind: 'day',
      iso: '2026-08-12',
      label: '2026-08-12'
    })
  })

  it('rejects a daily stem that is not a real calendar date', () => {
    expect(classifyCalendarStem('20260231')).toBeNull()
    expect(classifyCalendarStem('20261301')).toBeNull()
    expect(classifyCalendarStem('20260800')).toBeNull()
  })

  it('reads weekly, monthly, quarterly and yearly stems', () => {
    expect(classifyCalendarStem('2026-W33')).toEqual({ kind: 'week', label: '2026-W33' })
    expect(classifyCalendarStem('2026-08')).toEqual({ kind: 'month', label: '2026-08' })
    expect(classifyCalendarStem('2026-Q3')).toEqual({ kind: 'quarter', label: '2026-Q3' })
    expect(classifyCalendarStem('2026')).toEqual({ kind: 'year', label: '2026' })
  })

  it('rejects out-of-range week, month and quarter numbers', () => {
    expect(classifyCalendarStem('2026-W00')).toBeNull()
    expect(classifyCalendarStem('2026-W54')).toBeNull()
    expect(classifyCalendarStem('2026-13')).toBeNull()
    expect(classifyCalendarStem('2026-00')).toBeNull()
    expect(classifyCalendarStem('2026-Q5')).toBeNull()
  })

  it('rejects anything that is not a calendar stem', () => {
    expect(classifyCalendarStem('start-here')).toBeNull()
    expect(classifyCalendarStem('')).toBeNull()
    expect(classifyCalendarStem('2026-08-12')).toBeNull()
  })
})
