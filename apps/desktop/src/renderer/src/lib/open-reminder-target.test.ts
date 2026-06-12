import { describe, it, expect } from 'vitest'

import { buildReminderTargetTab } from './open-reminder-target'

const fallbacks = { note: 'Untitled note', journal: 'Journal', task: 'Task' }

describe('buildReminderTargetTab', () => {
  it('builds a note tab without highlight view state', () => {
    const tab = buildReminderTargetTab({
      targetType: 'note',
      targetId: 'note-1',
      targetTitle: 'Q3 planning',
      fallbacks
    })

    expect(tab).toMatchObject({
      type: 'note',
      title: 'Q3 planning',
      path: '/notes/note-1',
      entityId: 'note-1',
      isPinned: false,
      isModified: false,
      isPreview: false,
      isDeleted: false
    })
    expect(tab.viewState).toBeUndefined()
  })

  it('falls back to the note fallback title when target title is null', () => {
    const tab = buildReminderTargetTab({
      targetType: 'note',
      targetId: 'note-2',
      targetTitle: null,
      fallbacks
    })

    expect(tab.title).toBe('Untitled note')
  })

  it('builds a note tab with highlight view state for highlight targets', () => {
    const tab = buildReminderTargetTab({
      targetType: 'highlight',
      targetId: 'note-3',
      targetTitle: 'Research notes',
      highlightStart: 10,
      highlightEnd: 25,
      highlightText: 'important bit',
      fallbacks
    })

    expect(tab.type).toBe('note')
    expect(tab.path).toBe('/notes/note-3')
    expect(tab.viewState).toEqual({
      highlightStart: 10,
      highlightEnd: 25,
      highlightText: 'important bit'
    })
  })

  it('builds a journal tab keyed on the date target id', () => {
    const tab = buildReminderTargetTab({
      targetType: 'journal',
      targetId: '2026-06-12',
      targetTitle: '2026-06-12',
      fallbacks
    })

    expect(tab).toMatchObject({
      type: 'journal',
      path: '/journal',
      title: 'Journal'
    })
    expect(tab.viewState).toEqual({ date: '2026-06-12' })
  })

  it('builds a tasks tab that opens the task and its project', () => {
    const tab = buildReminderTargetTab({
      targetType: 'task',
      targetId: 'task-9',
      targetTitle: 'Ship release notes',
      projectId: 'project-7',
      fallbacks
    })

    expect(tab).toMatchObject({
      type: 'tasks',
      path: '/tasks',
      title: 'Ship release notes'
    })
    expect(tab.viewState).toMatchObject({
      openTaskId: 'task-9',
      selectedProjectId: 'project-7'
    })
  })
})
