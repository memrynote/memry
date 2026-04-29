import { describe, expect, it } from 'vitest'
import { computeSnoozeOptions } from './snooze-options'

describe('computeSnoozeOptions', () => {
  it('returns laterToday/tomorrow/nextWeek for timed task at noon', () => {
    const now = new Date('2026-04-29T12:00:00')
    const opts = computeSnoozeOptions({ now, isAllDay: false })
    expect(opts.laterToday).toEqual({ dueDate: '2026-04-29', dueTime: '15:00' })
    expect(opts.tomorrow).toEqual({ dueDate: '2026-04-30', dueTime: '09:00' })
    expect(opts.nextWeek).toEqual({ dueDate: '2026-05-04', dueTime: '09:00' })
  })

  it('clamps Later today to 8 PM cap', () => {
    const now = new Date('2026-04-29T18:00:00')
    const opts = computeSnoozeOptions({ now, isAllDay: false })
    expect(opts.laterToday).toEqual({ dueDate: '2026-04-29', dueTime: '20:00' })
  })

  it('hides Later today when now ≥ 19:00', () => {
    const now = new Date('2026-04-29T19:00:00')
    const opts = computeSnoozeOptions({ now, isAllDay: false })
    expect(opts.laterToday).toBeNull()
  })

  it('drops dueTime for all-day task', () => {
    const now = new Date('2026-04-29T12:00:00')
    const opts = computeSnoozeOptions({ now, isAllDay: true })
    expect(opts.laterToday).toBeNull()
    expect(opts.tomorrow).toEqual({ dueDate: '2026-04-30', dueTime: null })
    expect(opts.nextWeek).toEqual({ dueDate: '2026-05-04', dueTime: null })
  })

  it('Sunday → Mon next-week is the very next day', () => {
    const now = new Date('2026-05-03T10:00:00')
    const opts = computeSnoozeOptions({ now, isAllDay: false })
    expect(opts.nextWeek?.dueDate).toBe('2026-05-04')
  })

  it('Monday → next-week is +7 days', () => {
    const now = new Date('2026-05-04T10:00:00')
    const opts = computeSnoozeOptions({ now, isAllDay: false })
    expect(opts.nextWeek?.dueDate).toBe('2026-05-11')
  })
})
