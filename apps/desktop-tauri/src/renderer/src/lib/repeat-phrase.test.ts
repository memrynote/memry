import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { findRepeatPhrase, firstOccurrenceFor, parseRepeatPhrase } from './repeat-phrase'

// Saturday, 10 January 2026.
const NOW = new Date(2026, 0, 10)

describe('parseRepeatPhrase', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('parses the daily forms', () => {
    expect(parseRepeatPhrase('every day')).toMatchObject({ frequency: 'daily', interval: 1 })
    expect(parseRepeatPhrase('every 3 days')).toMatchObject({ frequency: 'daily', interval: 3 })
    expect(parseRepeatPhrase('every other day')).toMatchObject({ frequency: 'daily', interval: 2 })
  })

  it('parses weekday and weekend sets', () => {
    expect(parseRepeatPhrase('every weekday')).toMatchObject({
      frequency: 'weekly',
      interval: 1,
      daysOfWeek: [1, 2, 3, 4, 5]
    })
    expect(parseRepeatPhrase('every weekend')).toMatchObject({
      frequency: 'weekly',
      daysOfWeek: [0, 6]
    })
  })

  it('parses named weekdays, long and short', () => {
    expect(parseRepeatPhrase('every monday')).toMatchObject({
      frequency: 'weekly',
      interval: 1,
      daysOfWeek: [1]
    })
    expect(parseRepeatPhrase('EVERY Fri')).toMatchObject({ daysOfWeek: [5] })
    expect(parseRepeatPhrase('every mon and thu')).toMatchObject({ daysOfWeek: [1, 4] })
    expect(parseRepeatPhrase('every mon, wed, fri')).toMatchObject({ daysOfWeek: [1, 3, 5] })
    expect(parseRepeatPhrase('every other tuesday')).toMatchObject({
      interval: 2,
      daysOfWeek: [2]
    })
  })

  it('parses week, month and year intervals', () => {
    expect(parseRepeatPhrase('every week')).toMatchObject({ frequency: 'weekly', interval: 1 })
    expect(parseRepeatPhrase('every 2 weeks')).toMatchObject({ frequency: 'weekly', interval: 2 })
    expect(parseRepeatPhrase('every year')).toMatchObject({ frequency: 'yearly', interval: 1 })
  })

  it('anchors a monthly repeat to the day the task is due', () => {
    expect(parseRepeatPhrase('every month', new Date(2026, 2, 18))).toMatchObject({
      frequency: 'monthly',
      interval: 1,
      monthlyType: 'dayOfMonth',
      dayOfMonth: 18
    })
  })

  it('leaves a bare interval open-ended rather than guessing an end', () => {
    expect(parseRepeatPhrase('every week')).toMatchObject({ endType: 'never', completedCount: 0 })
  })

  it('rejects phrases that are not recurrences', () => {
    expect(parseRepeatPhrase('every door')).toBeNull()
    expect(parseRepeatPhrase('every')).toBeNull()
    expect(parseRepeatPhrase('every other')).toBeNull()
    expect(parseRepeatPhrase('weekly')).toBeNull()
    expect(parseRepeatPhrase('every 0 days')).toBeNull()
  })
})

describe('findRepeatPhrase', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('locates the phrase inside a sentence', () => {
    const match = findRepeatPhrase('Water the plants every 2 weeks')
    expect(match).toMatchObject({ start: 17, end: 30, text: 'every 2 weeks' })
    expect(match?.config).toMatchObject({ frequency: 'weekly', interval: 2 })
  })

  it('takes the longest phrase that parses', () => {
    expect(findRepeatPhrase('Standup every mon and thu at 9')?.text).toBe('every mon and thu')
    expect(findRepeatPhrase('Standup every monday with Bob')?.text).toBe('every monday')
  })

  it('ignores "every" used as a plain word', () => {
    expect(findRepeatPhrase('Check every door')).toBeNull()
    expect(findRepeatPhrase('Read the everyday carry post')).toBeNull()
  })
})

describe('firstOccurrenceFor', () => {
  it('lands on the next matching weekday', () => {
    // NOW is a Saturday, so "every monday" is due in two days.
    const monday = parseRepeatPhrase('every monday', NOW)!
    expect(firstOccurrenceFor(monday, NOW)).toEqual(new Date(2026, 0, 12))
  })

  it('keeps today when today already matches', () => {
    const weekend = parseRepeatPhrase('every weekend', NOW)!
    expect(firstOccurrenceFor(weekend, NOW)).toEqual(new Date(2026, 0, 10))
  })

  it('starts a non-weekly repeat today', () => {
    const daily = parseRepeatPhrase('every day', NOW)!
    expect(firstOccurrenceFor(daily, NOW)).toEqual(new Date(2026, 0, 10))
  })
})
