import { describe, expect, it } from 'vitest'
import type { Project } from '@/data/tasks-data'
import { hasPendingQuickAddSyntax, parseQuickAddEdit } from './quick-add-edit'

// Friday, 2026-09-25, midday: far from a day boundary.
const NOW = new Date(2026, 8, 25, 12, 0, 0)

const projects = [
  { id: 'p-work', name: 'Work', color: '#000', statuses: [] },
  { id: 'p-home', name: 'Home', color: '#000', statuses: [] }
] as unknown as Project[]

const bare = { tags: [], dueDate: null }

describe('parseQuickAddEdit', () => {
  it('applies the tokens typed into a new title and lifts them out of it', () => {
    const edit = parseQuickAddEdit('Buy milk !high #groceries +home', '', null, projects, NOW)

    expect(edit).toEqual({
      title: 'Buy milk',
      changes: { priority: 'high', tags: ['groceries'], projectId: 'p-home' }
    })
  })

  it('sets the due date and time a typed date phrase carries', () => {
    const edit = parseQuickAddEdit('Standup @tomorrow at 9:30', '', bare, projects, NOW)

    expect(edit?.title).toBe('Standup')
    expect(edit?.changes.dueDate?.getDate()).toBe(26)
    expect(edit?.changes.dueTime).toBe('09:30')
  })

  // Fixing a typo elsewhere in a line that already carries syntax-shaped text
  // must not turn that text into a command.
  it('leaves syntax that was already in the saved title alone', () => {
    expect(parseQuickAddEdit('Fix #launch bugs', 'Fix #launch bug', bare, projects, NOW)).toBeNull()

    const edit = parseQuickAddEdit(
      'Fix #launch bug !urgent',
      'Fix #launch bug',
      bare,
      projects,
      NOW
    )
    expect(edit).toEqual({ title: 'Fix #launch bug', changes: { priority: 'urgent' } })
  })

  it('keeps a token that names nothing in the title', () => {
    expect(parseQuickAddEdit('Ship it !soon +nowhere', '', bare, projects, NOW)).toBeNull()
  })

  it('adds new tags to the ones the task has, without duplicates', () => {
    const edit = parseQuickAddEdit(
      'Ship #Launch #beta',
      'Ship',
      { tags: ['launch', 'q3'], dueDate: null },
      projects,
      NOW
    )

    expect(edit?.changes.tags).toEqual(['launch', 'q3', 'beta'])
  })

  it('keeps the due date of a task that gains a repeat', () => {
    const due = new Date(2026, 9, 1)
    const edit = parseQuickAddEdit(
      'Water plants every week',
      'Water plants',
      { tags: [], dueDate: due },
      projects,
      NOW
    )

    expect(edit?.title).toBe('Water plants')
    expect(edit?.changes.isRepeating).toBe(true)
    expect(edit?.changes.repeatConfig?.frequency).toBe('weekly')
    expect(edit?.changes).not.toHaveProperty('dueDate')
  })

  it('dates an undated repeating task to its first occurrence', () => {
    const edit = parseQuickAddEdit('Water plants every week', 'Water plants', bare, projects, NOW)

    expect(edit?.changes.dueDate).toBeInstanceOf(Date)
  })

  it('falls back to the saved title when the edit is nothing but tokens', () => {
    const edit = parseQuickAddEdit('!low', 'Ship the beta', bare, projects, NOW)

    expect(edit).toEqual({ title: 'Ship the beta', changes: { priority: 'low' } })
  })

  it('never consumes a note link', () => {
    expect(parseQuickAddEdit('Read [[Roadmap]]', '', bare, projects, NOW)).toBeNull()
  })
})

describe('hasPendingQuickAddSyntax', () => {
  it('is true while a new token is being typed, finished or not', () => {
    expect(hasPendingQuickAddSyntax('Buy milk !hi', '', NOW)).toBe(true)
    expect(hasPendingQuickAddSyntax('Buy milk #groceries', 'Buy milk', NOW)).toBe(true)
  })

  it('is false for plain text and for tokens the title already had', () => {
    expect(hasPendingQuickAddSyntax('Buy milk', '', NOW)).toBe(false)
    expect(hasPendingQuickAddSyntax('Fix #launch bugs', 'Fix #launch bug', NOW)).toBe(false)
  })
})
