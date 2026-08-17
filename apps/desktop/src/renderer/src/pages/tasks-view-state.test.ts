import { describe, expect, it } from 'vitest'

import {
  DEFAULT_COLLAPSED_GROUPS,
  PROJECT_TASKS_SCROLL_KEY,
  TASKS_VIEW_STATE_KEYS,
  parseInternalTab,
  parseNullableId,
  parseStringArray,
  parseViewMode,
  tasksScrollKey
} from './tasks-view-state'

describe('tasks view-state keys', () => {
  it('keeps the names sessions on disk were written with', () => {
    // These have been persisted by shipped builds. Renaming one silently drops
    // every existing session back to its defaults.
    expect(TASKS_VIEW_STATE_KEYS).toMatchObject({
      activeView: 'activeView',
      activeInternalTab: 'activeInternalTab',
      activeInternalTabLegacy: 'activeTab',
      selectedProjectId: 'selectedProjectId',
      openTaskId: 'openTaskId',
      focusQuickAddAt: 'focusQuickAddAt'
    })
  })

  it('uses a distinct key per persisted value', () => {
    const keys = Object.values(TASKS_VIEW_STATE_KEYS)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('gives Today, All and the project list separate scroll keys', () => {
    // Today and All are the same component with a different storage key; one
    // shared scroll key would drop one list's offset onto the other.
    expect(tasksScrollKey('today')).not.toBe(tasksScrollKey('all'))
    expect(tasksScrollKey('all')).not.toBe(PROJECT_TASKS_SCROLL_KEY)
  })
})

describe('tasks view-state readers', () => {
  it('accepts the view modes and rejects anything else', () => {
    expect(parseViewMode('list')).toBe('list')
    expect(parseViewMode('kanban')).toBe('kanban')
    expect(parseViewMode('calendar')).toBeUndefined()
    expect(parseViewMode(null)).toBeUndefined()
  })

  it('accepts the internal tabs and rejects anything else', () => {
    expect(parseInternalTab('today')).toBe('today')
    expect(parseInternalTab('all')).toBe('all')
    expect(parseInternalTab('upcoming')).toBeUndefined()
    expect(parseInternalTab(0)).toBeUndefined()
  })

  it('tells "no project" apart from "nothing stored"', () => {
    // `null` has to survive: it is the user having chosen All projects, and it
    // must not fall back to the default-project preference.
    expect(parseNullableId(null)).toBeNull()
    expect(parseNullableId('project-1')).toBe('project-1')
    expect(parseNullableId(undefined)).toBeUndefined()
    expect(parseNullableId(3)).toBeUndefined()
  })

  it('keeps only string group keys', () => {
    expect(parseStringArray(['done', 'today'])).toEqual(['done', 'today'])
    expect(parseStringArray(['done', 4, null])).toEqual(['done'])
    expect(parseStringArray([])).toEqual([])
    expect(parseStringArray('done')).toBeUndefined()
  })

  it('starts with only the done group collapsed', () => {
    expect(DEFAULT_COLLAPSED_GROUPS).toEqual(['done'])
  })
})
