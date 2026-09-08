import { describe, expect, it } from 'vitest'
import { EMPTY_WORKSPACE_TABS, type WorkspaceTabsState } from './model'
import { parseWorkspaceTabs, serializeWorkspaceTabs } from './storage'

const state: WorkspaceTabsState = {
  activeTabId: 'tab-a',
  tabs: [
    {
      id: 'tab-a',
      destination: { kind: 'note', noteId: 'note-a' },
      title: 'A note',
      openedAt: 10,
      lastAccessedAt: 20
    }
  ]
}

describe('workspace tab persistence', () => {
  it('round-trips the versioned descriptor state', () => {
    expect(parseWorkspaceTabs(serializeWorkspaceTabs(state))).toEqual(state)
  })

  it('rejects malformed, unknown-version, and unsupported destination data', () => {
    expect(parseWorkspaceTabs('{')).toEqual(EMPTY_WORKSPACE_TABS)
    expect(parseWorkspaceTabs(JSON.stringify({ version: 2, ...state }))).toEqual(
      EMPTY_WORKSPACE_TABS
    )
    expect(
      parseWorkspaceTabs(
        JSON.stringify({
          version: 1,
          activeTabId: 'tab-a',
          tabs: [{ ...state.tabs[0], destination: { kind: 'task', taskId: 'task-a' } }]
        })
      )
    ).toEqual(EMPTY_WORKSPACE_TABS)
  })

  it('persists descriptors without note bodies', () => {
    const serialized = serializeWorkspaceTabs(state)
    expect(serialized).not.toContain('body')
    expect(serialized).not.toContain('content')
  })

  it('repairs duplicate tab ids without discarding valid tabs', () => {
    const parsed = parseWorkspaceTabs(
      JSON.stringify({
        version: 1,
        activeTabId: 'same',
        tabs: [
          { ...state.tabs[0], id: 'same' },
          {
            ...state.tabs[0],
            id: 'same',
            destination: { kind: 'note', noteId: 'note-b' }
          }
        ]
      })
    )

    expect(new Set(parsed.tabs.map((tab) => tab.id))).toEqual(new Set(['same', 'note:note-b']))
    expect(parsed.activeTabId).toBe('same')
  })
})
