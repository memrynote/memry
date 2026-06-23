import { describe, it, expect } from 'vitest'
import { splitDateTime } from './dates'

describe('splitDateTime', () => {
  it('returns local date + time in the given timezone', () => {
    // 08:00 UTC in Istanbul (+03:00) → 11:00 local
    expect(splitDateTime('2020-05-07T08:00:00+0000', 'Europe/Istanbul', false)).toEqual({
      date: '2020-05-07',
      time: '11:00'
    })
  })
  it('drops the time for all-day', () => {
    expect(splitDateTime('2020-05-07T08:00:00+0000', 'Europe/Istanbul', true)).toEqual({
      date: '2020-05-07',
      time: null
    })
  })
  it('returns nulls for empty/invalid input', () => {
    expect(splitDateTime('', 'UTC', false)).toEqual({ date: null, time: null })
    expect(splitDateTime('nope', 'UTC', false)).toEqual({ date: null, time: null })
  })
})
