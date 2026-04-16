import { describe, it, expect, vi } from 'vitest'
import { tabReducer } from '../reducer'
import type { TabSystemState, Tab, TabGroup, SplitLayout } from '../types'
import { generateId } from '../helpers'

vi.mock('crypto', () => ({
  randomUUID: () => `test-${Math.random().toString(36).slice(2, 10)}`
}))

const makeTab = (overrides: Partial<Tab> = {}): Tab => ({
  id: generateId(),
  type: 'note',
  title: 'Test Note',
  icon: 'file-text',
  path: '/note/test',
  entityId: `entity-${Math.random().toString(36).slice(2, 8)}`,
  isPinned: false,
  isModified: false,
  isPreview: false,
  isDeleted: false,
  openedAt: Date.now(),
  lastAccessedAt: Date.now(),
  ...overrides
})

const makeGroup = (tabs: Tab[], overrides: Partial<TabGroup> = {}): TabGroup => ({
  id: generateId(),
  tabs,
  activeTabId: tabs[0]?.id ?? null,
  isActive: true,
  ...overrides
})

const makeState = (groups: TabGroup[], layout?: SplitLayout): TabSystemState => {
  const tabGroups: Record<string, TabGroup> = {}
  groups.forEach((g) => {
    tabGroups[g.id] = g
  })
  return {
    tabGroups,
    layout: layout ?? { type: 'leaf', tabGroupId: groups[0].id },
    activeGroupId: groups[0].id,
    settings: { previewMode: false, restoreSessionOnStart: true, tabCloseButton: 'hover' }
  }
}

describe('tabReducer', () => {
  describe('SPLIT_VIEW', () => {
    it('clones the active tab into the new pane', () => {
      const tab = makeTab({ type: 'note', title: 'My Note', entityId: 'e1' })
      const group = makeGroup([tab])
      const state = makeState([group])

      const result = tabReducer(state, {
        type: 'SPLIT_VIEW',
        payload: { direction: 'horizontal', groupId: group.id }
      })

      const groupIds = Object.keys(result.tabGroups)
      expect(groupIds).toHaveLength(2)

      const newGroupId = groupIds.find((id) => id !== group.id)!
      const newGroup = result.tabGroups[newGroupId]
      expect(newGroup.tabs).toHaveLength(1)
      expect(newGroup.tabs[0].type).toBe('note')
      expect(newGroup.tabs[0].title).toBe('My Note')
      expect(newGroup.tabs[0].id).not.toBe(tab.id) // different ID = cloned
    })

    it('creates horizontal split layout', () => {
      const tab = makeTab()
      const group = makeGroup([tab])
      const state = makeState([group])

      const result = tabReducer(state, {
        type: 'SPLIT_VIEW',
        payload: { direction: 'horizontal', groupId: group.id }
      })

      expect(result.layout.type).toBe('split')
      if (result.layout.type === 'split') {
        expect(result.layout.direction).toBe('horizontal')
        expect(result.layout.ratio).toBe(0.5)
      }
    })

    it('creates vertical split layout', () => {
      const tab = makeTab()
      const group = makeGroup([tab])
      const state = makeState([group])

      const result = tabReducer(state, {
        type: 'SPLIT_VIEW',
        payload: { direction: 'vertical', groupId: group.id }
      })

      expect(result.layout.type).toBe('split')
      if (result.layout.type === 'split') {
        expect(result.layout.direction).toBe('vertical')
      }
    })

    it('splits nested tree correctly', () => {
      const tab1 = makeTab()
      const tab2 = makeTab()
      const g1 = makeGroup([tab1])
      const g2 = makeGroup([tab2], { isActive: false })
      const layout: SplitLayout = {
        type: 'split',
        direction: 'horizontal',
        ratio: 0.5,
        first: { type: 'leaf', tabGroupId: g1.id },
        second: { type: 'leaf', tabGroupId: g2.id }
      }
      const state = makeState([g1, g2], layout)

      const result = tabReducer(state, {
        type: 'SPLIT_VIEW',
        payload: { direction: 'vertical', groupId: g2.id }
      })

      // g2 should now be split vertically
      expect(result.layout.type).toBe('split')
      if (result.layout.type === 'split') {
        expect(result.layout.second.type).toBe('split')
        if (result.layout.second.type === 'split') {
          expect(result.layout.second.direction).toBe('vertical')
        }
      }
    })

    it('creates a default tab if source group has no active tab', () => {
      const group: TabGroup = {
        id: generateId(),
        tabs: [],
        activeTabId: null,
        isActive: true
      }
      const state = makeState([group])

      const result = tabReducer(state, {
        type: 'SPLIT_VIEW',
        payload: { direction: 'horizontal', groupId: group.id }
      })

      const newGroupId = Object.keys(result.tabGroups).find((id) => id !== group.id)!
      const newGroup = result.tabGroups[newGroupId]
      expect(newGroup.tabs).toHaveLength(1)
      expect(newGroup.tabs[0].type).toBe('inbox')
    })
  })

  describe('OPEN_TAB — per-group singleton dedup', () => {
    it('allows same singleton type in different groups', () => {
      const inboxTab = makeTab({ type: 'inbox', path: '/inbox', entityId: undefined })
      const g1 = makeGroup([inboxTab])
      const g2 = makeGroup([makeTab()], { isActive: false })
      const layout: SplitLayout = {
        type: 'split',
        direction: 'horizontal',
        ratio: 0.5,
        first: { type: 'leaf', tabGroupId: g1.id },
        second: { type: 'leaf', tabGroupId: g2.id }
      }
      const state = makeState([g1, g2], layout)

      const result = tabReducer(state, {
        type: 'OPEN_TAB',
        payload: {
          tab: {
            type: 'inbox',
            title: 'Inbox',
            icon: 'inbox',
            path: '/inbox',
            isPinned: false,
            isModified: false,
            isPreview: false,
            isDeleted: false
          },
          groupId: g2.id
        }
      })

      // g2 should have the inbox tab now
      const g2Tabs = result.tabGroups[g2.id].tabs
      expect(g2Tabs.some((t) => t.type === 'inbox')).toBe(true)
    })

    it('deduplicates by entityId within same group only', () => {
      const noteTab = makeTab({ type: 'note', entityId: 'note-1' })
      const g1 = makeGroup([noteTab])
      const state = makeState([g1])

      const result = tabReducer(state, {
        type: 'OPEN_TAB',
        payload: {
          tab: {
            type: 'note',
            title: 'Same Note',
            icon: 'file-text',
            path: '/note/note-1',
            entityId: 'note-1',
            isPinned: false,
            isModified: false,
            isPreview: false,
            isDeleted: false
          },
          groupId: g1.id
        }
      })

      // Should focus existing, not create new
      expect(result.tabGroups[g1.id].tabs).toHaveLength(1)
      expect(result.tabGroups[g1.id].activeTabId).toBe(noteTab.id)
    })
  })

  describe('CLOSE_SPLIT', () => {
    it('collapses tree when closing leaf', () => {
      const g1 = makeGroup([makeTab()])
      const g2 = makeGroup([makeTab()], { isActive: false })
      const layout: SplitLayout = {
        type: 'split',
        direction: 'horizontal',
        ratio: 0.5,
        first: { type: 'leaf', tabGroupId: g1.id },
        second: { type: 'leaf', tabGroupId: g2.id }
      }
      const state = makeState([g1, g2], layout)

      const result = tabReducer(state, {
        type: 'CLOSE_SPLIT',
        payload: { groupId: g2.id }
      })

      expect(Object.keys(result.tabGroups)).toHaveLength(1)
      expect(result.layout.type).toBe('leaf')
    })

    it('preserves sibling subtree', () => {
      const g1 = makeGroup([makeTab()])
      const g2 = makeGroup([makeTab()], { isActive: false })
      const g3 = makeGroup([makeTab()], { isActive: false })
      const layout: SplitLayout = {
        type: 'split',
        direction: 'horizontal',
        ratio: 0.5,
        first: { type: 'leaf', tabGroupId: g1.id },
        second: {
          type: 'split',
          direction: 'vertical',
          ratio: 0.5,
          first: { type: 'leaf', tabGroupId: g2.id },
          second: { type: 'leaf', tabGroupId: g3.id }
        }
      }
      const state = makeState([g1, g2, g3], layout)

      const result = tabReducer(state, {
        type: 'CLOSE_SPLIT',
        payload: { groupId: g2.id }
      })

      expect(Object.keys(result.tabGroups)).toHaveLength(2)
      // g3 should still exist in layout
      if (result.layout.type === 'split') {
        expect(result.layout.second.type).toBe('leaf')
        if (result.layout.second.type === 'leaf') {
          expect(result.layout.second.tabGroupId).toBe(g3.id)
        }
      }
    })

    it('does not close the last group', () => {
      const g1 = makeGroup([makeTab()])
      const state = makeState([g1])

      const result = tabReducer(state, {
        type: 'CLOSE_SPLIT',
        payload: { groupId: g1.id }
      })

      expect(result).toBe(state)
    })
  })

  describe('RESIZE_SPLIT', () => {
    it('updates ratio at correct depth path', () => {
      const g1 = makeGroup([makeTab()])
      const g2 = makeGroup([makeTab()], { isActive: false })
      const layout: SplitLayout = {
        type: 'split',
        direction: 'horizontal',
        ratio: 0.5,
        first: { type: 'leaf', tabGroupId: g1.id },
        second: { type: 'leaf', tabGroupId: g2.id }
      }
      const state = makeState([g1, g2], layout)

      const result = tabReducer(state, {
        type: 'RESIZE_SPLIT',
        payload: { path: [], ratio: 0.7 }
      })

      if (result.layout.type === 'split') {
        expect(result.layout.ratio).toBe(0.7)
      }
    })

    it('clamps ratio between 0.1 and 0.9', () => {
      const g1 = makeGroup([makeTab()])
      const g2 = makeGroup([makeTab()], { isActive: false })
      const layout: SplitLayout = {
        type: 'split',
        direction: 'horizontal',
        ratio: 0.5,
        first: { type: 'leaf', tabGroupId: g1.id },
        second: { type: 'leaf', tabGroupId: g2.id }
      }
      const state = makeState([g1, g2], layout)

      const result = tabReducer(state, {
        type: 'RESIZE_SPLIT',
        payload: { path: [], ratio: 0.95 }
      })

      if (result.layout.type === 'split') {
        expect(result.layout.ratio).toBe(0.9)
      }
    })
  })

  describe('MOVE_TAB_TO_NEW_SPLIT', () => {
    it('creates vertical split for up/down direction', () => {
      const tab1 = makeTab()
      const tab2 = makeTab()
      const g1 = makeGroup([tab1, tab2])
      const state = makeState([g1])

      const result = tabReducer(state, {
        type: 'MOVE_TAB_TO_NEW_SPLIT',
        payload: {
          tabId: tab2.id,
          fromGroupId: g1.id,
          direction: 'down'
        }
      })

      expect(result.layout.type).toBe('split')
      if (result.layout.type === 'split') {
        expect(result.layout.direction).toBe('vertical')
        // 'down' → tab goes to second position
        expect(result.layout.first.type).toBe('leaf')
        if (result.layout.first.type === 'leaf') {
          expect(result.layout.first.tabGroupId).toBe(g1.id)
        }
      }
    })

    it('creates horizontal split for left/right direction', () => {
      const tab1 = makeTab()
      const tab2 = makeTab()
      const g1 = makeGroup([tab1, tab2])
      const state = makeState([g1])

      const result = tabReducer(state, {
        type: 'MOVE_TAB_TO_NEW_SPLIT',
        payload: {
          tabId: tab2.id,
          fromGroupId: g1.id,
          direction: 'left'
        }
      })

      expect(result.layout.type).toBe('split')
      if (result.layout.type === 'split') {
        expect(result.layout.direction).toBe('horizontal')
        // 'left' → new group in first position
        if (result.layout.first.type === 'leaf') {
          expect(result.layout.first.tabGroupId).not.toBe(g1.id)
        }
      }
    })
  })

  describe('TOGGLE_MAXIMIZE_GROUP', () => {
    it('collapses layout to the active group and stashes the prior layout', () => {
      // #given a 2-pane split layout
      const g1 = makeGroup([makeTab({ title: 'A' })])
      const g2 = makeGroup([makeTab({ title: 'B' })], { isActive: false })
      const layout: SplitLayout = {
        type: 'split',
        direction: 'horizontal',
        ratio: 0.5,
        first: { type: 'leaf', tabGroupId: g1.id },
        second: { type: 'leaf', tabGroupId: g2.id }
      }
      const state = makeState([g1, g2], layout)

      // #when maximize is toggled on g1
      const result = tabReducer(state, {
        type: 'TOGGLE_MAXIMIZE_GROUP',
        payload: { groupId: g1.id }
      })

      // #then layout collapses to just g1, flag is set, original layout stashed
      expect(result.isMaximized).toBe(true)
      expect(result.layout).toEqual({ type: 'leaf', tabGroupId: g1.id })
      expect(result.preMaximizeLayout).toEqual(layout)
      expect(result.activeGroupId).toBe(g1.id)
    })

    it('restores the prior layout when toggled a second time', () => {
      // #given a maximized state
      const g1 = makeGroup([makeTab()])
      const g2 = makeGroup([makeTab()], { isActive: false })
      const originalLayout: SplitLayout = {
        type: 'split',
        direction: 'vertical',
        ratio: 0.5,
        first: { type: 'leaf', tabGroupId: g1.id },
        second: { type: 'leaf', tabGroupId: g2.id }
      }
      const maximized: TabSystemState = {
        ...makeState([g1, g2], { type: 'leaf', tabGroupId: g1.id }),
        isMaximized: true,
        preMaximizeLayout: originalLayout
      }

      // #when toggle fires again
      const result = tabReducer(maximized, {
        type: 'TOGGLE_MAXIMIZE_GROUP',
        payload: { groupId: g1.id }
      })

      // #then the original split is restored and flags are cleared
      expect(result.isMaximized).toBe(false)
      expect(result.preMaximizeLayout).toBeUndefined()
      expect(result.layout).toEqual(originalLayout)
    })

    it('is a no-op when the layout is already a single leaf and not maximized', () => {
      // #given a single-pane layout
      const g = makeGroup([makeTab()])
      const state = makeState([g])

      // #when toggle fires
      const result = tabReducer(state, {
        type: 'TOGGLE_MAXIMIZE_GROUP',
        payload: { groupId: g.id }
      })

      // #then state is unchanged
      expect(result).toBe(state)
    })

    it('ignores unknown group ids', () => {
      // #given a split layout
      const g1 = makeGroup([makeTab()])
      const g2 = makeGroup([makeTab()], { isActive: false })
      const state = makeState([g1, g2], {
        type: 'split',
        direction: 'horizontal',
        ratio: 0.5,
        first: { type: 'leaf', tabGroupId: g1.id },
        second: { type: 'leaf', tabGroupId: g2.id }
      })

      // #when toggle fires for a non-existent group
      const result = tabReducer(state, {
        type: 'TOGGLE_MAXIMIZE_GROUP',
        payload: { groupId: 'does-not-exist' }
      })

      // #then state is unchanged
      expect(result).toBe(state)
    })
  })

  describe('RESET_SPLIT_RATIOS', () => {
    it('sets every ratio in the tree back to 0.5', () => {
      // #given a nested split with non-even ratios
      const g1 = makeGroup([makeTab()])
      const g2 = makeGroup([makeTab()], { isActive: false })
      const g3 = makeGroup([makeTab()], { isActive: false })
      const layout: SplitLayout = {
        type: 'split',
        direction: 'horizontal',
        ratio: 0.8,
        first: { type: 'leaf', tabGroupId: g1.id },
        second: {
          type: 'split',
          direction: 'vertical',
          ratio: 0.2,
          first: { type: 'leaf', tabGroupId: g2.id },
          second: { type: 'leaf', tabGroupId: g3.id }
        }
      }
      const state = makeState([g1, g2, g3], layout)

      // #when reset fires
      const result = tabReducer(state, { type: 'RESET_SPLIT_RATIOS' })

      // #then every split ratio is 0.5
      expect(result.layout.type).toBe('split')
      if (result.layout.type === 'split') {
        expect(result.layout.ratio).toBe(0.5)
        if (result.layout.second.type === 'split') {
          expect(result.layout.second.ratio).toBe(0.5)
        }
      }
    })

    it('is a no-op for single-leaf layouts', () => {
      // #given a single-pane layout
      const g = makeGroup([makeTab()])
      const state = makeState([g])

      // #when reset fires
      const result = tabReducer(state, { type: 'RESET_SPLIT_RATIOS' })

      // #then state is unchanged
      expect(result).toBe(state)
    })
  })
})
