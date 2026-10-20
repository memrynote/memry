import { describe, expect, it } from 'vitest'
import {
  deriveHeaderStatus,
  findHeaderStatusProperty,
  isHeaderStatusProperty,
  deriveStatusCategory,
  taskStatusCategory,
  type StatusOptionCategories
} from './note-status'

const categories: StatusOptionCategories = {
  todo: { options: [{ value: 'Not started', default: true }] },
  in_progress: { options: [{ value: 'In Progress' }] },
  done: { options: [{ value: 'Done' }, { value: 'Abandoned' }] }
}

describe('taskStatusCategory', () => {
  const todo = { isDone: false, isDefault: true, position: 0 }
  const doing = { isDone: false, isDefault: false, position: 1 }
  const done = { isDone: true, isDefault: false, position: 2 }

  it('reads the status a task is on', () => {
    expect(taskStatusCategory({ completed: false }, todo)).toBe('todo')
    expect(taskStatusCategory({ completed: false }, doing)).toBe('in_progress')
    expect(taskStatusCategory({ completed: false }, done)).toBe('done')
    expect(taskStatusCategory({ completed: false }, { ...doing, isDefault: true })).toBe(
      'in_progress'
    )
  })

  it('reads a done task moved back to In Progress as in progress, though completedAt is left', () => {
    expect(taskStatusCategory({ completed: true }, doing)).toBe('in_progress')
  })

  it('reads a task completed without moving its status as done', () => {
    expect(taskStatusCategory({ completed: true }, todo)).toBe('done')
    expect(taskStatusCategory({ completed: true }, null)).toBe('done')
    expect(taskStatusCategory({ completed: false }, null)).toBe('todo')
  })
})

describe('header status property', () => {
  it('matches the stock name and the name the picker gives a new one', () => {
    expect(isHeaderStatusProperty('status')).toBe(true)
    expect(isHeaderStatusProperty('Status')).toBe(true)
    expect(isHeaderStatusProperty('Project status')).toBe(false)
    expect(findHeaderStatusProperty({ owner: 'K', Status: null })).toBe('Status')
    expect(findHeaderStatusProperty({ owner: 'K' })).toBeUndefined()
  })
})

describe('deriveStatusCategory', () => {
  it('has no category for a note without tasks', () => {
    expect(deriveStatusCategory([])).toBeNull()
  })

  it('follows the all-to-do, all-done, otherwise-in-progress rule', () => {
    expect(deriveStatusCategory(['todo', 'todo'])).toBe('todo')
    expect(deriveStatusCategory(['done', 'done'])).toBe('done')
    expect(deriveStatusCategory(['todo', 'in_progress'])).toBe('in_progress')
    expect(deriveStatusCategory(['todo', 'done'])).toBe('in_progress')
    expect(deriveStatusCategory(['in_progress', 'done'])).toBe('in_progress')
  })
})

describe('deriveHeaderStatus', () => {
  it('picks the default option of the category, else its first', () => {
    expect(deriveHeaderStatus(['todo'], categories)).toBe('Not started')
    expect(deriveHeaderStatus(['done', 'done'], categories)).toBe('Done')
  })

  it('uses the vault own option names', () => {
    const custom: StatusOptionCategories = {
      ...categories,
      in_progress: { options: [{ value: 'Doing' }, { value: 'Review', default: true }] }
    }
    expect(deriveHeaderStatus(['todo', 'done'], custom)).toBe('Review')
  })

  it('has no value without tasks or without an option in the category', () => {
    expect(deriveHeaderStatus([], categories)).toBeNull()
    expect(deriveHeaderStatus(['done'], { ...categories, done: { options: [] } })).toBeNull()
  })
})
