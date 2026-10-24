/**
 * `formatRelativeDateHint` (#1861)
 *
 * Every case passes an explicit `now` rather than faking the clock: the hint is
 * pure calendar-day arithmetic, and the boundaries that matter (day 14 vs 15,
 * -1 vs -2) are easier to read as two dates than as a system-time offset.
 */

import { describe, it, expect } from 'vitest'
import { formatRelativeDateHint } from './task-formatting'

const now = new Date(2026, 2, 13, 10, 30) // Fri Mar 13 2026, local
const at = (month: number, day: number, hour = 9): Date => new Date(2026, month, day, hour)

describe('formatRelativeDateHint', () => {
  it('returns null without a date', () => {
    expect(formatRelativeDateHint(null, { now })).toBe(null)
  })

  it('returns null for a completed task', () => {
    expect(formatRelativeDateHint(at(2, 10), { kind: 'due', isCompleted: true, now })).toBe(null)
  })

  describe('upcoming', () => {
    it('says Today for the same calendar day, whatever the clock time', () => {
      expect(formatRelativeDateHint(at(2, 13, 23), { kind: 'due', now })).toEqual({
        label: 'Today',
        tone: 'neutral'
      })
    })

    it('says Tomorrow for the next calendar day', () => {
      expect(formatRelativeDateHint(at(2, 14), { kind: 'due', now })).toEqual({
        label: 'Tomorrow',
        tone: 'neutral'
      })
    })

    it('counts days from two days out', () => {
      expect(formatRelativeDateHint(at(2, 15), { kind: 'due', now })).toEqual({
        label: 'in 2 days',
        tone: 'neutral'
      })
    })

    it('still counts days on the fourteenth day', () => {
      expect(formatRelativeDateHint(at(2, 27), { kind: 'due', now })?.label).toBe('in 14 days')
    })

    it('switches to weeks on the fifteenth day', () => {
      expect(formatRelativeDateHint(at(2, 28), { kind: 'due', now })?.label).toBe('in 2 weeks')
    })

    it('rounds weeks to the nearest whole week', () => {
      // Apr 10 is 28 days out; Apr 6 is 24 days, which rounds up to 3 weeks.
      expect(formatRelativeDateHint(at(3, 10), { kind: 'due', now })?.label).toBe('in 4 weeks')
      expect(formatRelativeDateHint(at(3, 6), { kind: 'due', now })?.label).toBe('in 3 weeks')
    })

    it('uses the singular for exactly one week beyond the day window', () => {
      // 21 days out: the plural rule has to pick `one` for the week count, not
      // for the day count.
      expect(formatRelativeDateHint(at(3, 3), { kind: 'due', now })?.label).toBe('in 3 weeks')
    })
  })

  describe('overdue due dates', () => {
    it('counts a single day', () => {
      expect(formatRelativeDateHint(at(2, 12), { kind: 'due', now })).toEqual({
        label: '1 day overdue',
        tone: 'overdue'
      })
    })

    it('counts days', () => {
      expect(formatRelativeDateHint(at(2, 10), { kind: 'due', now })).toEqual({
        label: '3 days overdue',
        tone: 'overdue'
      })
    })

    it('never switches to weeks, however long it has been', () => {
      const hint = formatRelativeDateHint(at(0, 13), { kind: 'due', now })
      expect(hint).toEqual({ label: '59 days overdue', tone: 'overdue' })
    })

    it('defaults to the due reading when no kind is given', () => {
      expect(formatRelativeDateHint(at(2, 10), { now })).toEqual({
        label: '3 days overdue',
        tone: 'overdue'
      })
    })
  })

  describe('past start dates', () => {
    it('reads as elapsed, not overdue: a start date cannot be late', () => {
      expect(formatRelativeDateHint(at(2, 10), { kind: 'start', now })).toEqual({
        label: '3 days ago',
        tone: 'neutral'
      })
    })

    it('says Yesterday for a single day back', () => {
      expect(formatRelativeDateHint(at(2, 12), { kind: 'start', now })).toEqual({
        label: 'Yesterday',
        tone: 'neutral'
      })
    })

    it('shares the upcoming wording', () => {
      expect(formatRelativeDateHint(at(2, 15), { kind: 'start', now })).toEqual({
        label: 'in 2 days',
        tone: 'neutral'
      })
    })
  })

  it('counts calendar days across a DST spring-forward boundary', () => {
    // US DST starts Sun Mar 8 2026; the local day is 23 hours long. Flooring a
    // raw millisecond diff reports 0 days for two distinct dates, so this must
    // round: Mar 7 -> Mar 8 is one day.
    const beforeShift = new Date(2026, 2, 7, 12)
    const afterShift = new Date(2026, 2, 8, 12)
    expect(formatRelativeDateHint(afterShift, { kind: 'due', now: beforeShift })?.label).toBe(
      'Tomorrow'
    )
    expect(formatRelativeDateHint(beforeShift, { kind: 'due', now: afterShift })).toEqual({
      label: '1 day overdue',
      tone: 'overdue'
    })
  })
})
