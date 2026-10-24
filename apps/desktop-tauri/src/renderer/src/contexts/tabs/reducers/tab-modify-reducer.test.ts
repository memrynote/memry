import { describe, expect, it } from 'vitest'
import { tabModifyReducer } from './tab-modify-reducer'
import type { Tab, TabGroup, TabSystemState } from '../types'

const tab = (overrides: Partial<Tab> = {}): Tab => ({
  id: 'tab-a',
  type: 'note',
  title: 'A',
  icon: 'file-text',
  path: '/notes/a',
  entityId: 'note-a',
  isPinned: false,
  isModified: false,
  isPreview: false,
  isDeleted: false,
  openedAt: 1,
  lastAccessedAt: 1,
  ...overrides
})

const group = (tabs: Tab[], overrides: Partial<TabGroup> = {}): TabGroup => ({
  id: 'group-a',
  tabs,
  activeTabId: tabs[0]?.id ?? null,
  isActive: true,
  back: [],
  forward: [],
  ...overrides
})

const stateWith = (tabs: Tab[]): TabSystemState => ({
  tabGroups: {
    'group-a': group(tabs)
  },
  layout: { type: 'leaf', tabGroupId: 'group-a' },
  activeGroupId: 'group-a',
  settings: {
    restoreSessionOnStart: true,
    tabCloseButton: 'hover'
  }
})

describe('tabModifyReducer', () => {
  it('pins preview tabs after the existing pinned block and ignores missing groups or tabs', () => {
    const state = stateWith([
      tab({ id: 'pinned', title: 'Pinned', isPinned: true }),
      tab({ id: 'target', title: 'Target', isPreview: true }),
      tab({ id: 'tail', title: 'Tail' })
    ])

    expect(
      tabModifyReducer(state, {
        type: 'PIN_TAB',
        payload: { groupId: 'missing', tabId: 'target' }
      })
    ).toBe(state)
    expect(
      tabModifyReducer(state, {
        type: 'PIN_TAB',
        payload: { groupId: 'group-a', tabId: 'missing' }
      })
    ).toBe(state)

    const result = tabModifyReducer(state, {
      type: 'PIN_TAB',
      payload: { groupId: 'group-a', tabId: 'target' }
    })

    expect(result.tabGroups['group-a'].tabs.map((entry) => entry.id)).toEqual([
      'pinned',
      'target',
      'tail'
    ])
    expect(result.tabGroups['group-a'].tabs[1]).toEqual(
      expect.objectContaining({ isPinned: true, isPreview: false })
    )
  })

  it('unpins tabs immediately after the remaining pinned block', () => {
    const state = stateWith([
      tab({ id: 'pinned-a', isPinned: true }),
      tab({ id: 'target', isPinned: true }),
      tab({ id: 'normal' })
    ])

    const result = tabModifyReducer(state, {
      type: 'UNPIN_TAB',
      payload: { groupId: 'group-a', tabId: 'target' }
    })

    expect(result.tabGroups['group-a'].tabs.map((entry) => entry.id)).toEqual([
      'pinned-a',
      'target',
      'normal'
    ])
    expect(result.tabGroups['group-a'].tabs[1].isPinned).toBe(false)
  })

  it('updates modified, deleted, and title flags without disturbing other tabs', () => {
    let state = stateWith([tab({ id: 'target' }), tab({ id: 'other', title: 'Other' })])

    state = tabModifyReducer(state, {
      type: 'SET_TAB_MODIFIED',
      payload: { groupId: 'group-a', tabId: 'target', isModified: true }
    })
    state = tabModifyReducer(state, {
      type: 'SET_TAB_DELETED',
      payload: { groupId: 'group-a', tabId: 'target', isDeleted: true }
    })
    state = tabModifyReducer(state, {
      type: 'UPDATE_TAB_TITLE',
      payload: { groupId: 'group-a', tabId: 'target', title: 'Renamed' }
    })

    expect(state.tabGroups['group-a'].tabs[0]).toEqual(
      expect.objectContaining({
        title: 'Renamed',
        isModified: true,
        isDeleted: true
      })
    )
    expect(state.tabGroups['group-a'].tabs[1]).toEqual(expect.objectContaining({ title: 'Other' }))
  })

  describe('SET_TAB_ENTITY', () => {
    it('writes entityId and path onto the target tab', () => {
      const state = stateWith([
        tab({ id: 'target', type: 'template-editor', path: '/templates/new', entityId: undefined }),
        tab({ id: 'other', title: 'Other' })
      ])

      const result = tabModifyReducer(state, {
        type: 'SET_TAB_ENTITY',
        payload: {
          tabId: 'target',
          groupId: 'group-a',
          entityId: 'tpl-42',
          path: '/templates/tpl-42'
        }
      })

      expect(result.tabGroups['group-a'].tabs[0]).toEqual(
        expect.objectContaining({ entityId: 'tpl-42', path: '/templates/tpl-42' })
      )
    })

    it('leaves other tabs untouched', () => {
      const state = stateWith([
        tab({ id: 'target', type: 'template-editor', path: '/templates/new', entityId: undefined }),
        tab({ id: 'other', title: 'Other', path: '/notes/other', entityId: 'note-other' })
      ])

      const result = tabModifyReducer(state, {
        type: 'SET_TAB_ENTITY',
        payload: {
          tabId: 'target',
          groupId: 'group-a',
          entityId: 'tpl-42',
          path: '/templates/tpl-42'
        }
      })

      expect(result.tabGroups['group-a'].tabs[1]).toEqual(
        expect.objectContaining({ path: '/notes/other', entityId: 'note-other' })
      )
    })
  })
})
