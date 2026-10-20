import { describe, expect, it } from 'vitest'
import {
  deriveHeaderStatus,
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
  it('reads a completed task as done whatever its status', () => {
    expect(
      taskStatusCategory({ completed: true }, { isDone: false, isDefault: true, position: 0 })
    ).toBe('done')
  })

  it('reads an open task on a done status as done', () => {
    expect(
      taskStatusCategory({ completed: false }, { isDone: true, isDefault: false, position: 2 })
    ).toBe('done')
  })

  it('reads an open task with no status, or the first default status, as to-do', () => {
    expect(taskStatusCategory({ completed: false }, null)).toBe('todo')
    expect(
      taskStatusCategory({ completed: false }, { isDone: false, isDefault: true, position: 0 })
    ).toBe('todo')
  })

  it('reads any other open status as in progress', () => {
    expect(
      taskStatusCategory({ completed: false }, { isDone: false, isDefault: false, position: 1 })
    ).toBe('in_progress')
    expect(
      taskStatusCategory({ completed: false }, { isDone: false, isDefault: true, position: 1 })
    ).toBe('in_progress')
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
