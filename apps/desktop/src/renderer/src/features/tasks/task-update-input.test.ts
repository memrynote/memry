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

  it('writes dates as calendar keys and a cleared repeat as null', () => {
    expect(
      toTaskUpdateInput('task-1', {
        dueDate: new Date(2026, 8, 7),
        repeatConfig: null,
        isRepeating: false
      })
    ).toEqual({ id: 'task-1', dueDate: '2026-09-07', repeatConfig: null, isRepeating: false })
  })
})
