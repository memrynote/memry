import { describe, it, expect, vi } from 'vitest'
import { tabReducer } from '../reducer'
import type { Tab, TabGroup, TabSystemState } from '../types'
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
  back: [],
  forward: [],
  ...overrides
})

const makeState = (group: TabGroup): TabSystemState => ({
  tabGroups: { [group.id]: group },
  layout: { type: 'leaf', tabGroupId: group.id },
  activeGroupId: group.id,
  settings: { restoreSessionOnStart: true, tabCloseButton: 'hover' }
})

describe('tab activation history', () => {
  describe('SET_ACTIVE_TAB', () => {
    it('pushes the previous active id onto back and clears forward', () => {
      // #given a group with two tabs and an existing forward stack
      const a = makeTab({ title: 'A' })
      const b = makeTab({ title: 'B' })
      const group = makeGroup([a, b], { activeTabId: a.id, forward: ['stale-id'] })
      const state = makeState(group)

      // #when the user activates a different tab
      const next = tabReducer(state, {
        type: 'SET_ACTIVE_TAB',
        payload: { tabId: b.id, groupId: group.id }
      })

      // #then back records the prior active and forward is wiped
      expect(next.tabGroups[group.id].back).toEqual([a.id])
      expect(next.tabGroups[group.id].forward).toEqual([])
      expect(next.tabGroups[group.id].activeTabId).toBe(b.id)
    })

    it('is a history no-op when activating the already-active tab', () => {
      // #given the active tab is already A
      const a = makeTab()
      const group = makeGroup([a], { activeTabId: a.id, back: ['x'], forward: ['y'] })
      const state = makeState(group)

      // #when SET_ACTIVE_TAB targets the same tab
      const next = tabReducer(state, {
        type: 'SET_ACTIVE_TAB',
        payload: { tabId: a.id, groupId: group.id }
      })

      // #then history is preserved
      expect(next.tabGroups[group.id].back).toEqual(['x'])
      expect(next.tabGroups[group.id].forward).toEqual(['y'])
    })
  })

  describe('NAV_BACK / NAV_FORWARD', () => {
    it('NAV_BACK on empty stack returns the same state', () => {
      // #given a group with no back history
      const a = makeTab()
      const group = makeGroup([a], { activeTabId: a.id })
      const state = makeState(group)

      // #when NAV_BACK fires
      const next = tabReducer(state, { type: 'NAV_BACK', payload: { groupId: group.id } })

      // #then state is unchanged (referentially equal)
      expect(next).toBe(state)
    })

    it('round-trips a back/forward navigation', () => {
      // #given the user is on B, having come from A
      const a = makeTab({ title: 'A' })
      const b = makeTab({ title: 'B' })
      const group = makeGroup([a, b], { activeTabId: b.id, back: [a.id] })
      const state = makeState(group)

      // #when they go back, then forward
      const afterBack = tabReducer(state, {
        type: 'NAV_BACK',
        payload: { groupId: group.id }
      })
      expect(afterBack.tabGroups[group.id].activeTabId).toBe(a.id)
      expect(afterBack.tabGroups[group.id].forward).toEqual([b.id])

      const afterForward = tabReducer(afterBack, {
        type: 'NAV_FORWARD',
        payload: { groupId: group.id }
      })

      // #then they end up back on B with A in back
      expect(afterForward.tabGroups[group.id].activeTabId).toBe(b.id)
      expect(afterForward.tabGroups[group.id].back).toEqual([a.id])
      expect(afterForward.tabGroups[group.id].forward).toEqual([])
    })

    it('NAV_BACK skips ids no longer present in tabs[]', () => {
      // #given back contains a stale id (e.g. closed tab) before a valid one
      const a = makeTab({ title: 'A' })
      const c = makeTab({ title: 'C' })
      const group = makeGroup([a, c], {
        activeTabId: c.id,
        back: [a.id, 'stale-deleted-tab']
      })
      const state = makeState(group)

      // #when NAV_BACK fires
      const next = tabReducer(state, { type: 'NAV_BACK', payload: { groupId: group.id } })

      // #then the stale id is popped past, A becomes active
      expect(next.tabGroups[group.id].activeTabId).toBe(a.id)
      expect(next.tabGroups[group.id].back).toEqual([])
    })
  })

  describe('OPEN_TAB clears forward and records previous active', () => {
    it('opens a fresh note tab after a back navigation, wiping forward', () => {
      // #given user is on A with B reachable via forward
      const a = makeTab({ title: 'A', entityId: 'a' })
      const b = makeTab({ title: 'B', entityId: 'b' })
      const group = makeGroup([a, b], { activeTabId: a.id, forward: [b.id] })
      const state = makeState(group)

      // #when they open a new tab
      const next = tabReducer(state, {
        type: 'OPEN_TAB',
        payload: {
          tab: {
            type: 'note',
            title: 'C',
            icon: 'file-text',
            path: '/note/c',
            entityId: 'c',
            isPinned: false,
            isModified: false,
            isPreview: false,
            isDeleted: false
          },
          groupId: group.id
        }
      })

      // #then forward is wiped and back records A
      expect(next.tabGroups[group.id].forward).toEqual([])
      expect(next.tabGroups[group.id].back).toEqual([a.id])
    })

    it('background OPEN_TAB does not record activation history', () => {
      // #given user is on A
      const a = makeTab({ title: 'A', entityId: 'a' })
      const group = makeGroup([a], { activeTabId: a.id, back: ['previous'] })
      const state = makeState(group)

      // #when they open a tab in the background
      const next = tabReducer(state, {
        type: 'OPEN_TAB',
        payload: {
          tab: {
            type: 'note',
            title: 'B',
            icon: 'file-text',
            path: '/note/b',
            entityId: 'b',
            isPinned: false,
            isModified: false,
            isPreview: false,
            isDeleted: false
          },
          groupId: group.id,
          background: true
        }
      })

      // #then history is unchanged and active tab stays on A
      expect(next.tabGroups[group.id].activeTabId).toBe(a.id)
      expect(next.tabGroups[group.id].back).toEqual(['previous'])
      expect(next.tabGroups[group.id].forward).toEqual([])
    })
  })

  describe('CLOSE_TAB prunes history', () => {
    it('removes the closed tab id from both stacks', () => {
      // #given user has A→B→C history with C active and B in back
      const a = makeTab({ title: 'A' })
      const b = makeTab({ title: 'B' })
      const c = makeTab({ title: 'C' })
      const group = makeGroup([a, b, c], {
        activeTabId: c.id,
        back: [a.id, b.id],
        forward: [b.id]
      })
      const state = makeState(group)

      // #when B is closed
      const next = tabReducer(state, {
        type: 'CLOSE_TAB',
        payload: { tabId: b.id, groupId: group.id }
      })

      // #then b.id is gone from both stacks
      expect(next.tabGroups[group.id].back).toEqual([a.id])
      expect(next.tabGroups[group.id].forward).toEqual([])
    })
  })

  describe('history cap', () => {
    it('caps the back stack at 50 entries', () => {
      // #given a back stack at the cap limit
      const tabs = Array.from({ length: 51 }, (_, i) => makeTab({ title: `T${i}` }))
      const tail = tabs[tabs.length - 1]
      const back = tabs.slice(0, -1).map((t) => t.id)
      const group = makeGroup(tabs, { activeTabId: tail.id, back })
      const state = makeState(group)

      // #when the user activates a fresh tab
      const fresh = makeTab({ title: 'fresh' })
      const groupWithFresh = {
        ...group,
        tabs: [...tabs, fresh]
      }
      const stateWithFresh = makeState(groupWithFresh)
      const stateWithFreshAndBack = {
        ...stateWithFresh,
        tabGroups: {
          [group.id]: { ...groupWithFresh, activeTabId: tail.id, back, forward: [] }
        }
      }
      const next = tabReducer(stateWithFreshAndBack, {
        type: 'SET_ACTIVE_TAB',
        payload: { tabId: fresh.id, groupId: group.id }
      })

      // #then back is capped at 50 and the oldest entry was dropped
      expect(next.tabGroups[group.id].back.length).toBe(50)
      expect(next.tabGroups[group.id].back[0]).toBe(tabs[1].id)
      expect(next.tabGroups[group.id].back[49]).toBe(tail.id)
    })
  })
})
