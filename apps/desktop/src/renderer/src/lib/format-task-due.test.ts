import { describe, expect, it } from 'vitest'
import { formatTaskDue } from './format-task-due'

const NOW = new Date('2026-04-29T10:00:00') // Wed

describe('formatTaskDue', () => {
  it('returns Today + time for same-day due with time', () => {
    expect(formatTaskDue({ dueDate: '2026-04-29', dueTime: '14:00', now: NOW })).toEqual({
      relative: 'today',
      label: 'Today · 2:00 PM',
      isOverdue: false
    })
  })

  it('returns Tomorrow + time for next-day due', () => {
    expect(formatTaskDue({ dueDate: '2026-04-30', dueTime: '09:00', now: NOW })).toEqual({
      relative: 'tomorrow',
      label: 'Tomorrow · 9:00 AM',
      isOverdue: false
    })
  })

  it('returns weekday for this-week due', () => {
    expect(formatTaskDue({ dueDate: '2026-05-01', dueTime: '14:00', now: NOW })).toEqual({
      relative: 'this-week',
      label: 'Fri · 2:00 PM',
      isOverdue: false
    })
  })

  it('returns absolute date for distant future', () => {
    expect(formatTaskDue({ dueDate: '2026-06-15', dueTime: '14:00', now: NOW })).toEqual({
      relative: 'absolute',
      label: 'Jun 15, 2026 · 2:00 PM',
      isOverdue: false
    })
  })

  it('marks overdue when dueDate < today and not completed', () => {
    const out = formatTaskDue({ dueDate: '2026-04-27', dueTime: '14:00', now: NOW })
    expect(out.isOverdue).toBe(true)
    expect(out.label).toBe('2 days overdue')
  })

  it('does NOT mark overdue when completed', () => {
    const out = formatTaskDue({
      dueDate: '2026-04-27',
      dueTime: '14:00',
      completedAt: '2026-04-28T10:00:00Z',
      now: NOW
    })
    expect(out.isOverdue).toBe(false)
  })

  it('drops time when no dueTime', () => {
    expect(formatTaskDue({ dueDate: '2026-04-30', now: NOW })).toEqual({
      relative: 'tomorrow',
      label: 'Tomorrow',
      isOverdue: false
    })
  })

  it('renders range when endAt provided', () => {
    expect(
      formatTaskDue({
        dueDate: '2026-04-29',
        dueTime: '14:00',
        endAt: '2026-04-29T15:00:00',
        now: NOW
      })
    ).toMatchObject({
      label: 'Today · 2:00 PM – 3:00 PM'
    })
  })
})
