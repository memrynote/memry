import { describe, expect, it } from 'vitest'
import { toTaskUpdateInput } from './task-update-input'

describe('toTaskUpdateInput', () => {
  // Main reads a missing key as "untouched"; any key that shows up is an edit.
  it('carries only the fields the edit touches', () => {
    expect(toTaskUpdateInput('task-1', { priority: 'high' })).toEqual({ id: 'task-1', priority: 3 })
    expect(Object.keys(toTaskUpdateInput('task-1', { tags: ['a'] }))).toEqual(['id', 'tags'])
  })

  it('sends a cleared date or time as null, not as a missing key', () => {
    expect(toTaskUpdateInput('task-1', { dueDate: null, dueTime: null })).toEqual({
      id: 'task-1',
      dueDate: null,
      dueTime: null
    })
    expect(toTaskUpdateInput('task-1', { startDate: null })).toEqual({
      id: 'task-1',
      startDate: null
    })
  })

  it('sends a duration edit and leaves an untouched duration out', () => {
    expect(toTaskUpdateInput('task-1', { dueTime: '09:00', durationMinutes: 30 })).toEqual({
      id: 'task-1',
      dueTime: '09:00',
      durationMinutes: 30
    })
    expect(toTaskUpdateInput('task-1', { dueTime: '09:00' })).toEqual({
      id: 'task-1',
      dueTime: '09:00'
    })
  })

  // A dropped null left "make top level" and "move out" as silent no-ops.
  it('sends a cleared parent as null so the task becomes top level', () => {
    expect(toTaskUpdateInput('task-1', { parentId: null })).toEqual({
      id: 'task-1',
      parentId: null
    })
  })

  it('writes dates as calendar keys and a cleared repeat as null', () => {
    expect(
      toTaskUpdateInput('task-1', {
        dueDate: new Date(2026, 8, 7),
        repeatConfig: null,
        isRepeating: false
      })
    ).toEqual({ id: 'task-1', dueDate: '2026-09-07', repeatConfig: null, isRepeating: false })
  })

  it('forwards a fields patch, keeping null as a removal', () => {
    expect(
      toTaskUpdateInput('task-1', { fields: { 'Waiting on': ['memry://note/n1'], Thread: null } })
    ).toEqual({ id: 'task-1', fields: { 'Waiting on': ['memry://note/n1'], Thread: null } })
  })
})
