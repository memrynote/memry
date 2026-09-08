import { describe, expect, it } from 'vitest'
import {
  EMPTY_WORKSPACE_TABS,
  activateWorkspaceTab,
  closeWorkspaceTab,
  mergeWorkspaceTabs,
  normalizeWorkspaceTabs,
  openWorkspaceNote,
  type WorkspaceTab
} from './model'

function tab(id: string, noteId: string, accessed: number): WorkspaceTab {
  return {
    id,
    destination: { kind: 'note', noteId },
    title: noteId,
    openedAt: accessed,
    lastAccessedAt: accessed
  }
}

describe('workspace tabs model', () => {
  it('opens each note once and activates the existing descriptor', () => {
    const first = openWorkspaceNote(
      EMPTY_WORKSPACE_TABS,
      { id: 'note-a', title: 'A' },
      {
        tabId: 'tab-a',
        now: 1
      }
    )
    const reopened = openWorkspaceNote(
      first,
      { id: 'note-a', title: 'A renamed' },
      {
        tabId: 'unused',
        now: 2
      }
    )

    expect(reopened.tabs).toHaveLength(1)
    expect(reopened.tabs[0]).toMatchObject({ id: 'tab-a', title: 'A renamed', lastAccessedAt: 2 })
    expect(reopened.activeTabId).toBe('tab-a')
  })

  it('keeps active ids valid and ignores activation of a missing tab', () => {
    const state = normalizeWorkspaceTabs([tab('tab-a', 'note-a', 1)], 'missing')
    expect(state.activeTabId).toBe('tab-a')
    expect(activateWorkspaceTab(state, 'missing', 9)).toBe(state)
  })

  it('chooses the nearest card when active closes and supports closing the final tab', () => {
    const state = normalizeWorkspaceTabs(
      [tab('tab-a', 'note-a', 1), tab('tab-b', 'note-b', 2), tab('tab-c', 'note-c', 3)],
      'tab-b'
    )
    const middleClosed = closeWorkspaceTab(state, 'tab-b')
    expect(middleClosed.activeTabId).toBe('tab-c')

    const rightClosed = closeWorkspaceTab(middleClosed, 'tab-c')
    expect(rightClosed.activeTabId).toBe('tab-a')
    expect(closeWorkspaceTab(rightClosed, 'tab-a')).toEqual(EMPTY_WORKSPACE_TABS)
  })

  it('deduplicates persisted destinations in favour of the MRU descriptor', () => {
    const state = normalizeWorkspaceTabs(
      [tab('old', 'same-note', 1), tab('new', 'same-note', 5)],
      'old'
    )
    expect(state.tabs.map((item) => item.id)).toEqual(['new'])
    expect(state.activeTabId).toBe('new')
  })

  it('merges a delayed disk restore without erasing live registrations', () => {
    const stored = normalizeWorkspaceTabs([tab('tab-a', 'note-a', 1)], 'tab-a')
    const live = normalizeWorkspaceTabs([tab('tab-b', 'note-b', 5)], 'tab-b')

    const merged = mergeWorkspaceTabs(stored, live)

    expect(merged.tabs.map((item) => item.id)).toEqual(['tab-a', 'tab-b'])
    expect(merged.activeTabId).toBe('tab-b')
  })
})
