import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useTabKeyboardShortcuts } from './use-tab-keyboard-shortcuts'

const mocks = vi.hoisted(() => ({
  state: {} as any,
  dispatch: vi.fn(),
  openTab: vi.fn(),
  closeTab: vi.fn(),
  reopenClosedTab: vi.fn(),
  pinTab: vi.fn(),
  unpinTab: vi.fn(),
  splitView: vi.fn(),
  navBack: vi.fn(),
  navForward: vi.fn(),
  shortcuts: [] as any[],
  windowClose: vi.fn()
}))

vi.mock('@/contexts/tabs', () => ({
  useTabs: () => ({
    state: mocks.state,
    dispatch: mocks.dispatch,
    openTab: mocks.openTab,
    closeTab: mocks.closeTab,
    reopenClosedTab: mocks.reopenClosedTab,
    pinTab: mocks.pinTab,
    unpinTab: mocks.unpinTab,
    splitView: mocks.splitView,
    navBack: mocks.navBack,
    navForward: mocks.navForward
  })
}))

vi.mock('./use-keyboard-shortcuts-base', () => ({
  useKeyboardShortcuts: (shortcuts: any[]) => {
    mocks.shortcuts = shortcuts
  }
}))

function shortcut(description: string) {
  const found = mocks.shortcuts.find((item) => item.description === description)
  if (!found) throw new Error(`Missing shortcut: ${description}`)
  return found
}

describe('useTabKeyboardShortcuts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.shortcuts = []
    mocks.state = {
      activeGroupId: 'main',
      tabGroups: {
        main: {
          id: 'main',
          tabs: [{ id: 'home', type: 'home', title: 'Home' }],
          activeTabId: 'home'
        }
      }
    }
    ;(window as Window & { api: unknown }).api = {
      windowClose: mocks.windowClose
    }
  })

  it('registers tab shortcuts and routes the last Home tab close to the window', () => {
    const newTabMenu = vi.fn()
    window.addEventListener('memry:new-tab-menu', newTabMenu)

    renderHook(() => useTabKeyboardShortcuts())
    expect(mocks.shortcuts).toHaveLength(13)

    shortcut('New tab').action()
    expect(newTabMenu).toHaveBeenCalled()

    shortcut('Reopen closed tab').action()
    expect(mocks.reopenClosedTab).toHaveBeenCalled()

    shortcut('Close tab').action()
    expect(mocks.windowClose).toHaveBeenCalled()
    expect(mocks.closeTab).not.toHaveBeenCalled()

    shortcut('Close all tabs').action()
    expect(mocks.dispatch).toHaveBeenCalledWith({
      type: 'CLOSE_ALL_TABS',
      payload: { groupId: 'main' }
    })

    shortcut('Next tab').action()
    shortcut('Previous tab').action()
    expect(mocks.dispatch).toHaveBeenCalledWith({
      type: 'GO_TO_NEXT_TAB',
      payload: { groupId: 'main' }
    })
    expect(mocks.dispatch).toHaveBeenCalledWith({
      type: 'GO_TO_PREVIOUS_TAB',
      payload: { groupId: 'main' }
    })

    shortcut('Navigate back').action()
    shortcut('Navigate forward').action()
    expect(mocks.navBack).toHaveBeenCalledWith('main')
    expect(mocks.navForward).toHaveBeenCalledWith('main')

    expect(shortcut('Close split pane').when()).toBe(false)
    window.removeEventListener('memry:new-tab-menu', newTabMenu)
  })

  it('closes the tab while typing, so the editor and capture bar cannot swallow ⌘W', () => {
    renderHook(() => useTabKeyboardShortcuts())

    expect(shortcut('Close tab').allowInInput).toBe(true)
  })

  it.each([
    ['inbox', 'inbox'],
    ['calendar', 'calendar'],
    ['tasks', 'tasks']
  ])('closes a lone %s tab instead of the window', (_name, type) => {
    mocks.state = {
      activeGroupId: 'main',
      tabGroups: {
        main: {
          id: 'main',
          tabs: [{ id: 'singleton', type, title: type }],
          activeTabId: 'singleton'
        }
      }
    }

    renderHook(() => useTabKeyboardShortcuts())
    shortcut('Close tab').action()

    expect(mocks.closeTab).toHaveBeenCalledWith('singleton', 'main')
    expect(mocks.windowClose).not.toHaveBeenCalled()
  })

  it('closes the Home tab like any other while a sibling tab is open', () => {
    mocks.state = {
      activeGroupId: 'main',
      tabGroups: {
        main: {
          id: 'main',
          tabs: [
            { id: 'home', type: 'home', title: 'Home' },
            { id: 'note-1', type: 'note', title: 'Note' }
          ],
          activeTabId: 'home'
        }
      }
    }

    renderHook(() => useTabKeyboardShortcuts())
    shortcut('Close tab').action()

    expect(mocks.closeTab).toHaveBeenCalledWith('home', 'main')
    expect(mocks.windowClose).not.toHaveBeenCalled()
  })

  it('collapses the split instead of closing the window on a lone Home tab', () => {
    mocks.state = {
      activeGroupId: 'main',
      tabGroups: {
        main: {
          id: 'main',
          tabs: [{ id: 'home', type: 'home', title: 'Home' }],
          activeTabId: 'home'
        },
        side: {
          id: 'side',
          tabs: [{ id: 'note-1', type: 'note', title: 'Note' }],
          activeTabId: 'note-1'
        }
      }
    }

    renderHook(() => useTabKeyboardShortcuts())
    shortcut('Close tab').action()

    expect(mocks.closeTab).toHaveBeenCalledWith('home', 'main')
    expect(mocks.windowClose).not.toHaveBeenCalled()
  })

  it('routes normal tab close, pin, duplicate, split, and close-split actions', () => {
    mocks.state = {
      activeGroupId: 'main',
      tabGroups: {
        main: {
          id: 'main',
          tabs: [
            {
              id: 'note-1',
              type: 'note',
              title: 'Note',
              icon: 'file',
              emoji: 'spark',
              path: '/notes/note.md',
              entityId: 'note-1',
              isPinned: false
            },
            { id: 'tasks', type: 'tasks', title: 'Tasks' }
          ],
          activeTabId: 'note-1'
        },
        side: {
          id: 'side',
          tabs: [],
          activeTabId: null
        }
      }
    }

    const { rerender } = renderHook(() => useTabKeyboardShortcuts())

    shortcut('Close tab').action()
    expect(mocks.closeTab).toHaveBeenCalledWith('note-1', 'main')

    shortcut('Pin/Unpin tab').action()
    expect(mocks.pinTab).toHaveBeenCalledWith('note-1', 'main')

    shortcut('Duplicate tab').action()
    expect(mocks.openTab).toHaveBeenCalledWith({
      type: 'note',
      title: 'Note',
      icon: 'file',
      emoji: 'spark',
      path: '/notes/note.md',
      entityId: 'note-1',
      isPinned: false,
      isModified: false,
      isPreview: false,
      isDeleted: false
    })

    shortcut('Split right').action()
    shortcut('Split down').action()
    expect(mocks.splitView).toHaveBeenCalledWith('horizontal', 'main')
    expect(mocks.splitView).toHaveBeenCalledWith('vertical', 'main')

    expect(shortcut('Close split pane').when()).toBe(true)
    shortcut('Close split pane').action()
    expect(mocks.dispatch).toHaveBeenCalledWith({
      type: 'CLOSE_SPLIT',
      payload: { groupId: 'main' }
    })

    mocks.state = {
      ...mocks.state,
      tabGroups: {
        ...mocks.state.tabGroups,
        main: {
          ...mocks.state.tabGroups.main,
          tabs: [{ ...mocks.state.tabGroups.main.tabs[0], isPinned: true }],
          activeTabId: 'note-1'
        }
      }
    }
    rerender()
    shortcut('Pin/Unpin tab').action()
    expect(mocks.unpinTab).toHaveBeenCalledWith('note-1', 'main')
  })

  it('no-ops active-tab-dependent shortcuts when there is no active tab or group', () => {
    mocks.state = {
      activeGroupId: 'missing',
      tabGroups: {}
    }

    renderHook(() => useTabKeyboardShortcuts())

    shortcut('Close tab').action()
    shortcut('Pin/Unpin tab').action()
    shortcut('Duplicate tab').action()

    expect(mocks.closeTab).not.toHaveBeenCalled()
    expect(mocks.pinTab).not.toHaveBeenCalled()
    expect(mocks.unpinTab).not.toHaveBeenCalled()
    expect(mocks.openTab).not.toHaveBeenCalled()
  })
})
