import { describe, expect, it } from 'vitest'
import type { CalendarProjectionItem } from '@/services/calendar-service'
import { taskBlockChange } from './task-block'

const at = (hours: number, minutes = 0): string =>
  new Date(2026, 8, 21, hours, minutes).toISOString()

const taskBlock = (startAt: string, endAt: string | null): CalendarProjectionItem =>
  ({
    projectionId: 'task:task-1',
    sourceType: 'task',
    sourceId: 'task-1',
    title: 'Write the brief',
    startAt,
    endAt,
    isAllDay: false,
    visualType: 'task'
  }) as CalendarProjectionItem

describe('taskBlockChange', () => {
  it('moves a task that never had a length without giving it one', () => {
    const change = taskBlockChange(taskBlock(at(9), null), at(13, 30), at(14, 30))

    expect(change).toEqual({
      next: { dueDate: '2026-09-21', dueTime: '13:30' },
      previous: { dueDate: '2026-09-21', dueTime: '09:00' }
    })
  })

  it('writes the new length on resize and restores the missing one on undo', () => {
    const change = taskBlockChange(taskBlock(at(9), null), at(9), at(10, 45))

    expect(change).toEqual({
      next: { dueDate: '2026-09-21', dueTime: '09:00', durationMinutes: 105 },
      previous: { dueDate: '2026-09-21', dueTime: '09:00', durationMinutes: null }
    })
  })

  it('keeps a stored length through a move', () => {
    const change = taskBlockChange(taskBlock(at(9), at(9, 30)), at(16), at(16, 30))

    expect(change).toEqual({
      next: { dueDate: '2026-09-21', dueTime: '16:00' },
      previous: { dueDate: '2026-09-21', dueTime: '09:00' }
    })
  })

  it('resizes a stored length and undoes back to it', () => {
    const change = taskBlockChange(taskBlock(at(9), at(9, 30)), at(8, 45), at(9, 30))

    expect(change).toEqual({
      next: { dueDate: '2026-09-21', dueTime: '08:45', durationMinutes: 45 },
      previous: { dueDate: '2026-09-21', dueTime: '09:00', durationMinutes: 30 }
    })
  })
})
