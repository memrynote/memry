import { describe, it, expect } from 'vitest'
import {
  buildHistoryEntries,
  createDefaultTab,
  DEFAULT_TAB_SETTINGS,
  isLastHomeTab
} from './helpers'
import { SINGLETON_TAB_TYPES } from './types'
import type { Tab, TabType, TabSystemState } from './types'

describe('home tab', () => {
  it('home is a singleton tab type', () => {
    expect(SINGLETON_TAB_TYPES).toContain('home')
  })
  it('default tab is home', () => {
    expect(createDefaultTab().type).toBe('home')
  })
})

// -- isLastHomeTab ------------------------------------------------------------

const mkTypedTab = (id: string, type: TabType): Tab => ({
  ...mkTab(id),
  type,
  path: `/${type}`
})

const mkGroupedState = (groups: Record<string, Tab[]>): TabSystemState => {
  const groupIds = Object.keys(groups)
  return {
    tabGroups: Object.fromEntries(
      groupIds.map((id) => [
        id,
        {
          id,
          tabs: groups[id],
          activeTabId: groups[id][0]?.id ?? null,
          isActive: true,
          back: [],
          forward: []
        }
      ])
    ),
    layout: { type: 'leaf', tabGroupId: groupIds[0] },
    activeGroupId: groupIds[0],
    settings: { ...DEFAULT_TAB_SETTINGS },
    recentlyClosed: []
  }
}

describe('isLastHomeTab', () => {
  it('is true for the sole Home tab of the only group', () => {
    const state = mkGroupedState({ g1: [mkTypedTab('home', 'home')] })
    expect(isLastHomeTab(state, 'g1')).toBe(true)
  })

  it('is false while another tab is still open beside Home', () => {
    const state = mkGroupedState({ g1: [mkTypedTab('home', 'home'), mkTypedTab('n1', 'note')] })
    expect(isLastHomeTab(state, 'g1')).toBe(false)
  })

  it('is false for a lone non-Home tab', () => {
    const state = mkGroupedState({ g1: [mkTypedTab('inbox', 'inbox')] })
    expect(isLastHomeTab(state, 'g1')).toBe(false)
  })

  it('is false while a split keeps a second group open', () => {
    const state = mkGroupedState({
      g1: [mkTypedTab('home', 'home')],
      g2: [mkTypedTab('home-2', 'home')]
    })
    expect(isLastHomeTab(state, 'g1')).toBe(false)
  })

  it('is false for an unknown group', () => {
    const state = mkGroupedState({ g1: [mkTypedTab('home', 'home')] })
    expect(isLastHomeTab(state, 'nope')).toBe(false)
  })
})

// -- buildHistoryEntries ------------------------------------------------------

const mkTab = (id: string): Tab => ({
  id,
  type: 'note',
  title: `Note ${id}`,
  icon: 'file-text',
  path: `/note/${id}`,
  isPinned: false,
  isModified: false,
  isPreview: false,
  isDeleted: false,
  openedAt: 0,
  lastAccessedAt: 0
})

const mkState = (tabIds: string[], back: string[], forward: string[]): TabSystemState => ({
  tabGroups: {
    g1: {
      id: 'g1',
      tabs: tabIds.map(mkTab),
      activeTabId: tabIds[tabIds.length - 1] ?? null,
      isActive: true,
      back,
      forward
    }
  },
  layout: { type: 'leaf', tabGroupId: 'g1' },
  activeGroupId: 'g1',
  settings: { ...DEFAULT_TAB_SETTINGS },
  recentlyClosed: []
})

describe('buildHistoryEntries', () => {
  it('returns valid back entries nearest-first with steps 1..N', () => {
    // back is oldest→newest; nearest (newest) is the end.
    const state = mkState(['a', 'b', 'c', 'd'], ['a', 'b', 'c'], [])
    const entries = buildHistoryEntries(state, 'g1', 'back')
    expect(entries.map((e) => e.tab.id)).toEqual(['c', 'b', 'a'])
    expect(entries.map((e) => e.steps)).toEqual([1, 2, 3])
  })

  it('skips closed (stale) ids without consuming a step', () => {
    // 'x' and 'z' are no longer open tabs → dropped, steps stay contiguous.
    const state = mkState(['a', 'b', 'd'], ['a', 'x', 'b', 'z'], [])
    const entries = buildHistoryEntries(state, 'g1', 'back')
    expect(entries.map((e) => e.tab.id)).toEqual(['b', 'a'])
    expect(entries.map((e) => e.steps)).toEqual([1, 2])
  })

  it('caps the list at the limit', () => {
    const ids = Array.from({ length: 15 }, (_, i) => `t${i}`)
    const state = mkState(ids, ids.slice(0, 14), [])
    const entries = buildHistoryEntries(state, 'g1', 'back')
    expect(entries).toHaveLength(10)
    expect(entries[0].steps).toBe(1)
    expect(entries[9].steps).toBe(10)
  })

  it('reads the forward stack nearest-first', () => {
    const state = mkState(['a', 'b', 'c'], [], ['a', 'b'])
    const entries = buildHistoryEntries(state, 'g1', 'forward')
    expect(entries.map((e) => e.tab.id)).toEqual(['b', 'a'])
    expect(entries.map((e) => e.steps)).toEqual([1, 2])
  })

  it('returns [] for an unknown group or empty stack', () => {
    const state = mkState(['a'], [], [])
    expect(buildHistoryEntries(state, 'nope', 'back')).toEqual([])
    expect(buildHistoryEntries(state, 'g1', 'back')).toEqual([])
  })
})
