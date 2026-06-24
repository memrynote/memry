import { describe, it, expect } from 'vitest'
import { resolveDueDate } from './dates.ts'

// Fixed reference: Monday 2026-06-15
const now = new Date(2026, 5, 15, 9, 0, 0)
const opts = { now, lang: 'en' }

describe('resolveDueDate', () => {
  it('returns null for empty', () => {
    expect(resolveDueDate('', opts)).toBeNull()
  })
  it('parses absolute ISO date', () => {
    expect(resolveDueDate('2026-06-20', opts)).toEqual({ date: '2026-06-20', time: null })
  })
  it('parses absolute ISO datetime → date + time', () => {
    expect(resolveDueDate('2026-06-20T17:30:00', opts)).toEqual({
      date: '2026-06-20',
      time: '17:30'
    })
  })
  it('parses today / tomorrow / yesterday', () => {
    expect(resolveDueDate('today', opts)).toEqual({ date: '2026-06-15', time: null })
    expect(resolveDueDate('tomorrow', opts)).toEqual({ date: '2026-06-16', time: null })
    expect(resolveDueDate('yesterday', opts)).toEqual({ date: '2026-06-14', time: null })
  })
  it('parses "in N days/weeks/months" (the real export values)', () => {
    expect(resolveDueDate('in 2 days', opts)).toEqual({ date: '2026-06-17', time: null })
    expect(resolveDueDate('in 7 days', opts)).toEqual({ date: '2026-06-22', time: null })
    expect(resolveDueDate('in 1 week', opts)).toEqual({ date: '2026-06-22', time: null })
    expect(resolveDueDate('in 1 month', opts)).toEqual({ date: '2026-07-15', time: null })
  })
  it('parses a named month (forward-looking when no year)', () => {
    expect(resolveDueDate('Jun 20', opts)).toEqual({ date: '2026-06-20', time: null })
    expect(resolveDueDate('20 June 2027', opts)).toEqual({ date: '2027-06-20', time: null })
  })
  it('parses a weekday → next occurrence', () => {
    // now is Mon 2026-06-15; next Wednesday = 2026-06-17
    expect(resolveDueDate('Wednesday', opts)).toEqual({ date: '2026-06-17', time: null })
  })
  it('returns null for recurring "every ..."', () => {
    expect(resolveDueDate('every day', opts)).toBeNull()
  })
  it('returns null for a non-English lang', () => {
    expect(resolveDueDate('20 Haziran', { now, lang: 'tr' })).toBeNull()
  })
  it('returns null for gibberish', () => {
    expect(resolveDueDate('someday maybe', opts)).toBeNull()
  })
})
