import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  buildDateSuggestions,
  buildDateMentionEntry,
  predictDateCompletion,
  isTimeInProgress
} from './date-suggestions'

// parseNaturalDate reads the real clock internally, so drive everything from a
// fake system time (Wednesday 2026-06-17, noon) and let the default `now` align.
describe('buildDateSuggestions', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-17T12:00:00'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns null for a non-date query', () => {
    expect(buildDateSuggestions('project roadmap')).toBeNull()
  })

  it('labels "Today" and bumps the reminder to tomorrow 9am (today already passed 9am)', () => {
    const s = buildDateSuggestions('today')
    expect(s?.dateLabel).toBe('Today')
    expect(s?.dateValue.remind).toBe('none')
    expect(s?.remindSubtitle).toBe('Tomorrow 9am')
    expect(s?.remindValue.remind).toBe('at')
    const r = new Date(s!.remindValue.dateISO)
    expect(r.getDate()).toBe(18)
    expect(r.getHours()).toBe(9)
  })

  it('uses a future long date for the reminder subtitle (no bump)', () => {
    const s = buildDateSuggestions('tomorrow')
    expect(s?.dateLabel).toBe('Tomorrow')
    // 2026-06-18 is in the future → subtitle is the long date, not a bump
    expect(s?.remindSubtitle).toBe('18 June 2026')
  })

  it('empty query defaults to today', () => {
    const s = buildDateSuggestions('')
    expect(s?.dateLabel).toBe('Today')
  })

  it('returns null (no crash) for an offset that overflows Date', () => {
    // "in 99999999999 days" overflows Date to Invalid; before the parser fix it
    // slipped through parsed.success === true, and new Date(...).toISOString()
    // here threw a RangeError while the user was still typing in the mention menu.
    expect(() => buildDateSuggestions('in 99999999999 days')).not.toThrow()
    expect(buildDateSuggestions('in 99999999999 days')).toBeNull()
  })

  it('returns null for a far-future offset that overflows only after setHours', () => {
    // "in 5000000 days" (~year 15715) has a VALID midnight, so a NaN-only parser
    // guard admits it; buildDateSuggestions' base.setHours(9,0,0,0) then overflows a
    // near-max date to Invalid and base.toISOString() throws. The 4-digit-year cap in
    // the parser rejects it, so the mention menu offers nothing instead of crashing.
    expect(() => buildDateSuggestions('in 5000000 days')).not.toThrow()
    expect(buildDateSuggestions('in 5000000 days')).toBeNull()
  })
})

// buildDateMentionEntry keeps the `@` menu alive through intermediate keystrokes:
// it returns a full suggestion when any leading token-prefix parses, otherwise a
// `hint` flag when the query merely looks like a date being typed.
describe('buildDateMentionEntry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-17T12:00:00'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns a full suggestion (no hint) when the whole query parses', () => {
    const e = buildDateMentionEntry('today')
    expect(e.suggestion?.dateLabel).toBe('Today')
    expect(e.hint).toBe(false)
  })

  it('falls back to the longest parseable prefix while a time is being typed', () => {
    // "today 12p" does not parse, but the "today" prefix does → keep showing Today
    const e = buildDateMentionEntry('today 12p')
    expect(e.suggestion?.dateLabel).toBe('Today')
    expect(e.suggestion?.dateValue.hasTime).toBe(false)
    expect(e.hint).toBe(false)
  })

  it('keeps the prefix suggestion for a partially-typed time after a multi-word date', () => {
    const e = buildDateMentionEntry('next monday 14:3')
    expect(e.suggestion).not.toBeNull()
    expect(e.hint).toBe(false)
  })

  it('flags a hint for a date-ish connector that does not parse yet', () => {
    expect(buildDateMentionEntry('next')).toEqual({ suggestion: null, hint: true })
    expect(buildDateMentionEntry('last')).toEqual({ suggestion: null, hint: true })
    expect(buildDateMentionEntry('next mon').hint).toBe(true)
  })

  it('returns neither suggestion nor hint for a non-date query', () => {
    expect(buildDateMentionEntry('project roadmap')).toEqual({ suggestion: null, hint: false })
  })

  it('fires the reminder at the typed time (no bump) for a future timed query', () => {
    const e = buildDateMentionEntry('today 1pm')
    expect(e.suggestion?.remindValue.remind).toBe('at')
    const r = new Date(e.suggestion!.remindValue.dateISO)
    expect(r.getHours()).toBe(13)
  })
})

// predictDateCompletion drives the inline ghost-text autocomplete: given the raw
// text typed after `@`, it returns the single best full completion (canonical
// casing) the ghost should preview, or null when the query is not date-ish.
// Fixture clock is Wednesday 2026-06-17, so "today's weekday" is Wednesday.
describe('predictDateCompletion', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-17T12:00:00'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('defaults an empty query to Today', () => {
    expect(predictDateCompletion('')).toBe('Today')
  })

  it('prefers Today for "t"/"to" over tomorrow/tuesday/thursday/this', () => {
    expect(predictDateCompletion('t')).toBe('Today')
    expect(predictDateCompletion('to')).toBe('Today')
  })

  it('completes tomorrow and yesterday', () => {
    expect(predictDateCompletion('tom')).toBe('Tomorrow')
    expect(predictDateCompletion('y')).toBe('Yesterday')
  })

  it("completes next/last to today's weekday by default", () => {
    expect(predictDateCompletion('ne')).toBe('next Wednesday')
    expect(predictDateCompletion('next')).toBe('next Wednesday')
    expect(predictDateCompletion('la')).toBe('last Wednesday')
    expect(predictDateCompletion('last')).toBe('last Wednesday')
  })

  it('respects a partially typed weekday after next/last', () => {
    expect(predictDateCompletion('next m')).toBe('next Monday')
    expect(predictDateCompletion('last fri')).toBe('last Friday')
  })

  it('completes a bare weekday and a month name', () => {
    expect(predictDateCompletion('mon')).toBe('Monday')
    expect(predictDateCompletion('th')).toBe('Thursday')
    expect(predictDateCompletion('dec')).toBe('December')
  })

  it('completes a bare hour to :00, and a time after a date', () => {
    expect(predictDateCompletion('12')).toBe('12:00')
    expect(predictDateCompletion('today 12')).toBe('today 12:00')
  })

  it('completes a time typed after the "at" connector', () => {
    expect(predictDateCompletion('today at 23')).toBe('today at 23:00')
    expect(predictDateCompletion('today at 2')).toBe('today at 2:00')
  })

  it('pads the minutes once the colon is typed (with or without "at")', () => {
    expect(predictDateCompletion('today 23:')).toBe('today 23:00')
    expect(predictDateCompletion('today at 23:')).toBe('today at 23:00')
    expect(predictDateCompletion('23:')).toBe('23:00')
  })

  it('does not time-complete a number after a non-date word', () => {
    expect(predictDateCompletion('meeting 12')).toBeNull()
    expect(predictDateCompletion('meeting at 12')).toBeNull()
  })

  it('returns null for a non-date query', () => {
    expect(predictDateCompletion('meeting')).toBeNull()
    expect(predictDateCompletion('project roadmap')).toBeNull()
  })

  it('returns a prediction that is a case-insensitive superstring of the query', () => {
    const p = predictDateCompletion('ne')
    expect(p).not.toBeNull()
    expect(p!.toLowerCase().startsWith('ne')).toBe(true)
  })
})

// isTimeInProgress keeps the inline mention alive through the time-entry phase
// even when there is nothing confident to ghost: a freshly typed "at" connector
// or a single, still-ambiguous minute digit.
describe('isTimeInProgress', () => {
  it('is true while the "at" connector is typed after a date', () => {
    expect(isTimeInProgress('today at')).toBe(true)
    expect(isTimeInProgress('today at ')).toBe(true)
    expect(isTimeInProgress('next monday at')).toBe(true)
  })

  it('is true while a single minute digit is being typed', () => {
    expect(isTimeInProgress('today 23:3')).toBe(true)
    expect(isTimeInProgress('today at 9:0')).toBe(true)
    expect(isTimeInProgress('23:3')).toBe(true)
  })

  it('is true while a meridiem is being typed after a dated hour', () => {
    expect(isTimeInProgress('today at 14p')).toBe(true)
    expect(isTimeInProgress('today 2p')).toBe(true)
    expect(isTimeInProgress('next monday at 14pm')).toBe(true)
    expect(isTimeInProgress('today 2:30p')).toBe(true)
  })

  it('is false for a non-date connector or plain prose', () => {
    expect(isTimeInProgress('meeting at')).toBe(false)
    expect(isTimeInProgress('meeting at 5p')).toBe(false)
    expect(isTimeInProgress('next monday foo')).toBe(false)
    expect(isTimeInProgress('today')).toBe(false)
  })
})
