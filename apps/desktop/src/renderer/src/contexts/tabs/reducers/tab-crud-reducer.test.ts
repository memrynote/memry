import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeGroup, tabCrudReducer } from './tab-crud-reducer'
import type { Tab, TabAction, TabGroup, TabSystemState } from '../types'

const tab = (id: string, type: Tab['type'], overrides: Partial<Tab> = {}): Tab => ({
  id,
  type,
  title: `${type}-${id}`,
  icon: type,
  path: `/${type}/${id}`,
  isPinned: false,
  isModified: false,
  isPreview: false,
  isDeleted: false,
  openedAt: 1,
  lastAccessedAt: 1,
  ...overrides
})

const group = (id: string, tabs: Tab[], activeTabId = tabs[0]?.id ?? null): TabGroup => ({
  id,
  tabs,
  activeTabId,
  isActive: id === 'g1',
  back: tabs.slice(0, -1).map((t) => t.id),
  forward: tabs.slice(1).map((t) => t.id)
})

const baseState = (overrides: Partial<TabSystemState> = {}): TabSystemState => ({
  tabGroups: {
    g1: group('g1', [
      tab('pin', 'inbox', { isPinned: true, path: '/inbox' }),
      tab('note-a', 'note', { entityId: 'note-a' }),
      tab('tasks', 'tasks', { path: '/tasks' })
    ]),
    g2: group('g2', [tab('calendar', 'calendar', { path: '/calendar' })])
  },
  layout: {
    type: 'split',
    direction: 'horizontal',
    ratio: 0.5,
    first: { type: 'leaf', tabGroupId: 'g1' },
    second: { type: 'leaf', tabGroupId: 'g2' }
  },
  activeGroupId: 'g1',
  settings: {
    restoreSessionOnStart: true,
    tabCloseButton: 'hover'
  },
  ...overrides
})

const openAction = (
  payload: TabAction & { type: 'OPEN_TAB' } extends infer T
    ? T extends { payload: infer P }
      ? P
      : never
    : never
): TabAction => ({ type: 'OPEN_TAB', payload }) as TabAction

describe('tabCrudReducer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-10T00:00:00.000Z'))
    let nextId = 0
    vi.stubGlobal('crypto', {
      randomUUID: vi.fn(() => `generated-${++nextId}`)
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('opens tabs through replace, singleton, entity, insertion, and background paths', () => {
    const state = baseState()

    expect(
      tabCrudReducer(
        state,
        openAction({
          groupId: 'missing',
          tab: {
            type: 'note',
            title: 'Missing',
            icon: 'file',
            path: '/note/missing',
            isPinned: false,
            isModified: false,
            isPreview: false,
            isDeleted: false
          }
        })
      )
    ).toBe(state)

    const replaceState = {
      ...state,
      tabGroups: {
        ...state.tabGroups,
        g1: { ...state.tabGroups.g1, activeTabId: 'note-a' }
      }
    }
    const replaced = tabCrudReducer(
      replaceState,
      openAction({
        replaceActive: true,
        tab: {
          type: 'note',
          title: 'Replacement',
          icon: 'file',
          path: '/note/replacement',
          entityId: 'replacement',
          isPinned: false,
          isModified: false,
          isPreview: false,
          isDeleted: false
        }
      })
    )
    expect(replaced.tabGroups.g1.activeTabId).toBe('generated-1')
    expect(replaced.tabGroups.g1.tabs.map((t) => t.id)).toEqual(['pin', 'generated-1', 'tasks'])

    const sameGroupSingleton = tabCrudReducer(
      state,
      openAction({
        groupId: 'g1',
        tab: {
          type: 'tasks',
          title: 'Tasks',
          icon: 'tasks',
          path: '/tasks',
          isPinned: false,
          isModified: false,
          isPreview: false,
          isDeleted: false,
          viewState: { filter: 'today' }
        }
      })
    )
    expect(sameGroupSingleton.tabGroups.g1.activeTabId).toBe('tasks')
    expect(sameGroupSingleton.tabGroups.g1.tabs.find((t) => t.id === 'tasks')?.viewState).toEqual({
      filter: 'today'
    })

    const crossGroupSingleton = tabCrudReducer(
      { ...state, activeGroupId: 'g2' },
      openAction({
        tab: {
          type: 'tasks',
          title: 'Tasks',
          icon: 'tasks',
          path: '/tasks',
          isPinned: false,
          isModified: false,
          isPreview: false,
          isDeleted: false
        }
      })
    )
    expect(crossGroupSingleton.activeGroupId).toBe('g1')
    expect(crossGroupSingleton.tabGroups.g1.activeTabId).toBe('tasks')

    const sameEntity = tabCrudReducer(
      state,
      openAction({
        groupId: 'g1',
        background: true,
        tab: {
          type: 'note',
          title: 'Note A updated',
          icon: 'file',
          path: '/note/a',
          entityId: 'note-a',
          isPinned: false,
          isModified: false,
          isPreview: false,
          isDeleted: false,
          viewState: { scroll: 42 }
        }
      })
    )
    expect(sameEntity.activeGroupId).toBe('g1')
    expect(sameEntity.tabGroups.g1.activeTabId).toBe('pin')
    expect(sameEntity.tabGroups.g1.tabs.find((t) => t.id === 'note-a')?.viewState).toEqual({
      scroll: 42
    })

    const crossEntity = tabCrudReducer(
      { ...state, activeGroupId: 'g2' },
      openAction({
        tab: {
          type: 'note',
          title: 'Note A',
          icon: 'file',
          path: '/note/a',
          entityId: 'note-a',
          isPinned: false,
          isModified: false,
          isPreview: false,
          isDeleted: false
        }
      })
    )
    expect(crossEntity.activeGroupId).toBe('g1')
    expect(crossEntity.tabGroups.g1.activeTabId).toBe('note-a')

    const inserted = tabCrudReducer(
      state,
      openAction({
        position: 0,
        tab: {
          type: 'folder',
          title: 'Folder',
          icon: 'folder',
          path: '/folder/work',
          entityId: 'folder-work',
          isPinned: false,
          isModified: false,
          isPreview: false,
          isDeleted: false
        }
      })
    )
    expect(inserted.tabGroups.g1.tabs.map((t) => t.id)).toEqual([
      'pin',
      'generated-2',
      'note-a',
      'tasks'
    ])
    expect(inserted.tabGroups.g1.activeTabId).toBe('generated-2')
  })

  it('normalizes preview opens into permanent tabs without replacing legacy preview tabs', () => {
    const state = baseState({
      tabGroups: {
        g1: group('g1', [tab('preview', 'note', { isPreview: true, entityId: 'old' })]),
        g2: baseState().tabGroups.g2
      }
    })

    const next = tabCrudReducer(
      state,
      openAction({
        tab: {
          type: 'note',
          title: 'New note',
          icon: 'file',
          path: '/note/new',
          entityId: 'new',
          isPinned: false,
          isModified: false,
          isPreview: true,
          isDeleted: false
        }
      })
    )

    expect(next.tabGroups.g1.tabs.map((t) => t.id)).toEqual(['preview', 'generated-1'])
    expect(next.tabGroups.g1.tabs[1]).toMatchObject({
      entityId: 'new',
      isPreview: false
    })
    expect(next.tabGroups.g1.activeTabId).toBe('generated-1')
  })

  it('closes tabs, preserves pinned tabs, and resets single empty groups', () => {
    const state = baseState()

    expect(
      tabCrudReducer(state, { type: 'CLOSE_TAB', payload: { tabId: 'missing', groupId: 'g1' } })
    ).toBe(state)

    const closedActive = tabCrudReducer(state, {
      type: 'CLOSE_TAB',
      payload: { tabId: 'pin', groupId: 'g1' }
    })
    expect(closedActive.tabGroups.g1.activeTabId).toBe('note-a')
    expect(closedActive.tabGroups.g1.tabs.map((t) => t.id)).toEqual(['note-a', 'tasks'])

    const onlyGroup = baseState({
      tabGroups: { g1: group('g1', [tab('only', 'note')]) },
      layout: { type: 'leaf', tabGroupId: 'g1' },
      activeGroupId: 'g1'
    })
    const reset = tabCrudReducer(onlyGroup, {
      type: 'CLOSE_TAB',
      payload: { tabId: 'only', groupId: 'g1' }
    })
    expect(reset.tabGroups.g1.tabs).toHaveLength(1)
    expect(reset.tabGroups.g1.tabs[0].type).toBe('inbox')

    const closeOthers = tabCrudReducer(state, {
      type: 'CLOSE_OTHER_TABS',
      payload: { tabId: 'note-a', groupId: 'g1' }
    })
    expect(closeOthers.tabGroups.g1.tabs.map((t) => t.id)).toEqual(['pin', 'note-a'])
    expect(closeOthers.tabGroups.g1.activeTabId).toBe('note-a')

    const closeRight = tabCrudReducer(state, {
      type: 'CLOSE_TABS_TO_RIGHT',
      payload: { tabId: 'note-a', groupId: 'g1' }
    })
    expect(closeRight.tabGroups.g1.tabs.map((t) => t.id)).toEqual(['pin', 'note-a'])

    const closeAllWithPinned = tabCrudReducer(state, {
      type: 'CLOSE_ALL_TABS',
      payload: { groupId: 'g1' }
    })
    expect(closeAllWithPinned.tabGroups.g1.tabs.map((t) => t.id)).toEqual(['pin'])
    expect(closeAllWithPinned.tabGroups.g1.activeTabId).toBe('pin')
  })

  it('closes groups through explicit and empty-tab paths while guarding invalid closes', () => {
    const state = baseState({
      tabGroups: {
        g1: group('g1', [tab('one', 'note')]),
        g2: group('g2', [tab('two', 'calendar')])
      }
    })

    const closedByLastTab = tabCrudReducer(state, {
      type: 'CLOSE_TAB',
      payload: { tabId: 'one', groupId: 'g1' }
    })
    expect(closedByLastTab.tabGroups.g1).toBeUndefined()
    expect(closedByLastTab.activeGroupId).toBe('g2')
    expect(closedByLastTab.layout).toEqual({ type: 'leaf', tabGroupId: 'g2' })

    expect(tabCrudReducer(state, { type: 'CLOSE_GROUP', payload: { groupId: 'missing' } })).toBe(
      state
    )

    const singleGroup = baseState({
      tabGroups: { g1: group('g1', [tab('one', 'note')]) },
      layout: { type: 'leaf', tabGroupId: 'g1' }
    })
    expect(tabCrudReducer(singleGroup, { type: 'CLOSE_GROUP', payload: { groupId: 'g1' } })).toBe(
      singleGroup
    )

    const closedExplicitly = tabCrudReducer(state, {
      type: 'CLOSE_GROUP',
      payload: { groupId: 'g2' }
    })
    expect(closedExplicitly.tabGroups.g2).toBeUndefined()
    expect(closedExplicitly.layout).toEqual({ type: 'leaf', tabGroupId: 'g1' })

    const noLayout = closeGroup(
      {
        ...state,
        layout: { type: 'leaf', tabGroupId: 'g1' }
      },
      'g1'
    )
    expect(Object.values(noLayout.tabGroups)[0].tabs[0].type).toBe('inbox')
    expect(noLayout.settings).toEqual(state.settings)
  })
})
