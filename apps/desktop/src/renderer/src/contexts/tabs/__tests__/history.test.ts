import { describe, it, expect } from 'vitest'
import { tabReducer } from '../reducer'
import type { Tab, TabGroup, TabHistoryEntry, TabSystemState } from '../types'
import { generateId, buildHistoryEntries } from '../helpers'
import { snapshotTabContent } from '../reducers/history-helpers'

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
  settings: { restoreSessionOnStart: true, tabCloseButton: 'hover' },
  recentlyClosed: []
})

/** A history entry pointing at a tab as it currently stands. */
const entryFor = (tab: Tab): TabHistoryEntry => ({
  tabId: tab.id,
  content: snapshotTabContent(tab)
})

/** An entry whose tab is gone (a closed tab left behind in a stack). */
const staleEntry = (tabId: string): TabHistoryEntry => ({
  tabId,
  content: snapshotTabContent(makeTab({ id: tabId }))
})

const tabIds = (stack: TabHistoryEntry[]): string[] => stack.map((e) => e.tabId)

/** Tab payload as callers hand it to OPEN_TAB, before ids/timestamps. */
const openPayload = (
  overrides: Partial<Tab> = {}
): Omit<Tab, 'id' | 'openedAt' | 'lastAccessedAt'> => ({
  type: 'note',
  title: 'Untitled',
  icon: 'file-text',
  path: '/note/x',
  entityId: 'x',
  isPinned: false,
  isModified: false,
  isPreview: false,
  isDeleted: false,
  ...overrides
})

describe('tab activation history', () => {
  describe('SET_ACTIVE_TAB', () => {
    it('pushes the previous active id onto back and clears forward', () => {
      // #given a group with two tabs and an existing forward stack
      const a = makeTab({ title: 'A' })
      const b = makeTab({ title: 'B' })
      const group = makeGroup([a, b], { activeTabId: a.id, forward: [staleEntry('stale-id')] })
      const state = makeState(group)

      // #when the user activates a different tab
      const next = tabReducer(state, {
        type: 'SET_ACTIVE_TAB',
        payload: { tabId: b.id, groupId: group.id }
      })

      // #then back records the prior active and forward is wiped
      expect(tabIds(next.tabGroups[group.id].back)).toEqual([a.id])
      expect(next.tabGroups[group.id].forward).toEqual([])
      expect(next.tabGroups[group.id].activeTabId).toBe(b.id)
    })

    it('is a history no-op when activating the already-active tab', () => {
      // #given the active tab is already A
      const a = makeTab()
      const group = makeGroup([a], {
        activeTabId: a.id,
        back: [staleEntry('x')],
        forward: [staleEntry('y')]
      })
      const state = makeState(group)

      // #when SET_ACTIVE_TAB targets the same tab
      const next = tabReducer(state, {
        type: 'SET_ACTIVE_TAB',
        payload: { tabId: a.id, groupId: group.id }
      })

      // #then history is preserved
      expect(tabIds(next.tabGroups[group.id].back)).toEqual(['x'])
      expect(tabIds(next.tabGroups[group.id].forward)).toEqual(['y'])
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
      const group = makeGroup([a, b], { activeTabId: b.id, back: [entryFor(a)] })
      const state = makeState(group)

      // #when they go back, then forward
      const afterBack = tabReducer(state, {
        type: 'NAV_BACK',
        payload: { groupId: group.id }
      })
      expect(afterBack.tabGroups[group.id].activeTabId).toBe(a.id)
      expect(tabIds(afterBack.tabGroups[group.id].forward)).toEqual([b.id])

      const afterForward = tabReducer(afterBack, {
        type: 'NAV_FORWARD',
        payload: { groupId: group.id }
      })

      // #then they end up back on B with A in back
      expect(afterForward.tabGroups[group.id].activeTabId).toBe(b.id)
      expect(tabIds(afterForward.tabGroups[group.id].back)).toEqual([a.id])
      expect(afterForward.tabGroups[group.id].forward).toEqual([])
    })

    it('NAV_BACK skips ids no longer present in tabs[]', () => {
      // #given back contains a stale id (e.g. closed tab) before a valid one
      const a = makeTab({ title: 'A' })
      const c = makeTab({ title: 'C' })
      const group = makeGroup([a, c], {
        activeTabId: c.id,
        back: [entryFor(a), staleEntry('stale-deleted-tab')]
      })
      const state = makeState(group)

      // #when NAV_BACK fires
      const next = tabReducer(state, { type: 'NAV_BACK', payload: { groupId: group.id } })

      // #then the stale id is popped past, A becomes active
      expect(next.tabGroups[group.id].activeTabId).toBe(a.id)
      expect(next.tabGroups[group.id].back).toEqual([])
    })
  })

  /**
   * #2207: opening a note in the SAME tab kept the tab's id, so the active id
   * never changed and nothing was ever recorded — back and forward did nothing.
   */
  describe('same-tab navigation (#2207)', () => {
    const reuseOpen = (state: TabSystemState, groupId: string, tab: Partial<Tab>): TabSystemState =>
      tabReducer(state, {
        type: 'OPEN_TAB',
        payload: { tab: openPayload(tab), groupId, reuseActiveTab: true }
      })

    it('records a back entry when a note replaces the active tab in place', () => {
      // #given the user is reading note A in the only tab
      const a = makeTab({ title: 'A', entityId: 'a', path: '/note/a' })
      const group = makeGroup([a], { activeTabId: a.id })
      const state = makeState(group)

      // #when they follow a link to B, which reuses the same tab
      const next = reuseOpen(state, group.id, { title: 'B', entityId: 'b', path: '/note/b' })
      const after = next.tabGroups[group.id]

      // #then the tab still has one id, but back now knows where it came from
      expect(after.tabs).toHaveLength(1)
      expect(after.tabs[0].id).toBe(a.id)
      expect(after.tabs[0].entityId).toBe('b')
      expect(after.back).toHaveLength(1)
      expect(after.back[0]).toEqual({ tabId: a.id, content: snapshotTabContent(a) })
    })

    it('back lands on A again, with the scroll it was left at', () => {
      // #given A was scrolled before the user navigated away in the same tab
      const a = makeTab({
        title: 'A',
        entityId: 'a',
        path: '/note/a',
        scrollPanes: { '': { offset: 420, entityId: 'a' } }
      })
      const group = makeGroup([a], { activeTabId: a.id })
      const opened = reuseOpen(makeState(group), group.id, {
        title: 'B',
        entityId: 'b',
        path: '/note/b'
      })

      // #when they press back
      const back = tabReducer(opened, { type: 'NAV_BACK', payload: { groupId: group.id } })
      const tab = back.tabGroups[group.id].tabs[0]

      // #then the one tab shows A again, at offset 420
      expect(back.tabGroups[group.id].activeTabId).toBe(a.id)
      expect(tab.entityId).toBe('a')
      expect(tab.title).toBe('A')
      expect(tab.path).toBe('/note/a')
      expect(tab.scrollPanes).toEqual({ '': { offset: 420, entityId: 'a' } })
    })

    it('forward returns to B in that same tab', () => {
      // #given the user went A → B in one tab and pressed back
      const a = makeTab({ title: 'A', entityId: 'a', path: '/note/a' })
      const group = makeGroup([a], { activeTabId: a.id })
      const opened = reuseOpen(makeState(group), group.id, {
        title: 'B',
        entityId: 'b',
        path: '/note/b'
      })
      const back = tabReducer(opened, { type: 'NAV_BACK', payload: { groupId: group.id } })
      expect(back.tabGroups[group.id].tabs[0].entityId).toBe('a')

      // #when they press forward
      const forward = tabReducer(back, { type: 'NAV_FORWARD', payload: { groupId: group.id } })
      const tab = forward.tabGroups[group.id].tabs[0]

      // #then B is back, still in the same single tab, and back holds A
      expect(forward.tabGroups[group.id].tabs).toHaveLength(1)
      expect(tab.id).toBe(a.id)
      expect(tab.entityId).toBe('b')
      expect(tab.title).toBe('B')
      expect(tabIds(forward.tabGroups[group.id].back)).toEqual([a.id])
      expect(forward.tabGroups[group.id].forward).toEqual([])
    })

    it('walks back through a chain of same-tab opens, one note per press', () => {
      // #given A → B → C, all in one tab
      const a = makeTab({ title: 'A', entityId: 'a', path: '/note/a' })
      const group = makeGroup([a], { activeTabId: a.id })
      let state = reuseOpen(makeState(group), group.id, {
        title: 'B',
        entityId: 'b',
        path: '/note/b'
      })
      state = reuseOpen(state, group.id, { title: 'C', entityId: 'c', path: '/note/c' })
      expect(tabIds(state.tabGroups[group.id].back)).toEqual([a.id, a.id])

      // #when they press back twice
      const once = tabReducer(state, { type: 'NAV_BACK', payload: { groupId: group.id } })
      expect(once.tabGroups[group.id].tabs[0].entityId).toBe('b')

      const twice = tabReducer(once, { type: 'NAV_BACK', payload: { groupId: group.id } })

      // #then they arrive at A, with B and C reachable forward
      expect(twice.tabGroups[group.id].tabs[0].entityId).toBe('a')
      expect(twice.tabGroups[group.id].back).toEqual([])
      expect(twice.tabGroups[group.id].forward).toHaveLength(2)
    })

    it('mixes same-tab and cross-tab steps in one stack', () => {
      // #given the user is on tab 1 (note A) and switches to tab 2 (note B),
      // then follows a link to C inside tab 2
      const a = makeTab({ title: 'A', entityId: 'a', path: '/note/a' })
      const b = makeTab({ title: 'B', entityId: 'b', path: '/note/b' })
      const group = makeGroup([a, b], { activeTabId: a.id })
      let state = tabReducer(makeState(group), {
        type: 'SET_ACTIVE_TAB',
        payload: { tabId: b.id, groupId: group.id }
      })
      state = reuseOpen(state, group.id, { title: 'C', entityId: 'c', path: '/note/c' })

      // #when they press back twice
      const once = tabReducer(state, { type: 'NAV_BACK', payload: { groupId: group.id } })
      // #then the first press undoes the in-tab navigation, not the tab switch
      expect(once.tabGroups[group.id].activeTabId).toBe(b.id)
      expect(once.tabGroups[group.id].tabs[1].entityId).toBe('b')

      const twice = tabReducer(once, { type: 'NAV_BACK', payload: { groupId: group.id } })
      // #then the second press returns to the other tab
      expect(twice.tabGroups[group.id].activeTabId).toBe(a.id)
    })

    it('records nothing when the same entity is converted in place', () => {
      // #given a note tab that turns out to hold a binary — pages/note.tsx swaps
      // it for the file viewer with replaceActive, same entityId
      const a = makeTab({ title: 'A', entityId: 'a', path: '/note/a' })
      const group = makeGroup([a], { activeTabId: a.id })

      // #when the conversion runs
      const next = tabReducer(makeState(group), {
        type: 'OPEN_TAB',
        payload: {
          tab: openPayload({ type: 'file', title: 'A', entityId: 'a', path: '/file/a' }),
          groupId: group.id,
          replaceActive: true
        }
      })

      // #then no history entry is pushed: back would return to the note view,
      // which re-probes and converts again — a back button that loops
      expect(next.tabGroups[group.id].back).toEqual([])
      expect(next.tabGroups[group.id].tabs[0].type).toBe('file')
    })

    it('records a back entry when replaceActive swaps in a different entity', () => {
      // #given the user is on A
      const a = makeTab({ title: 'A', entityId: 'a', path: '/note/a' })
      const group = makeGroup([a], { activeTabId: a.id })

      // #when a different entity replaces the active tab
      const next = tabReducer(makeState(group), {
        type: 'OPEN_TAB',
        payload: {
          tab: openPayload({ title: 'B', entityId: 'b', path: '/note/b' }),
          groupId: group.id,
          replaceActive: true
        }
      })

      // #then that IS a navigation and is recorded
      expect(tabIds(next.tabGroups[group.id].back)).toEqual([a.id])
    })

    it('clears forward when a same-tab open follows a back', () => {
      // #given the user went A → B and pressed back to A
      const a = makeTab({ title: 'A', entityId: 'a', path: '/note/a' })
      const group = makeGroup([a], { activeTabId: a.id })
      const opened = reuseOpen(makeState(group), group.id, {
        title: 'B',
        entityId: 'b',
        path: '/note/b'
      })
      const back = tabReducer(opened, { type: 'NAV_BACK', payload: { groupId: group.id } })
      expect(back.tabGroups[group.id].forward).toHaveLength(1)

      // #when they navigate somewhere new instead of going forward
      const next = reuseOpen(back, group.id, { title: 'C', entityId: 'c', path: '/note/c' })

      // #then the forward branch is gone, exactly as a browser does
      expect(next.tabGroups[group.id].forward).toEqual([])
      expect(tabIds(next.tabGroups[group.id].back)).toEqual([a.id])
    })

    it('lists the snapshot title in the back menu, not the tab as it looks now', () => {
      // #given A → B in one tab, so the only tab is showing B
      const a = makeTab({ title: 'A', entityId: 'a', path: '/note/a' })
      const group = makeGroup([a], { activeTabId: a.id })
      const state = reuseOpen(makeState(group), group.id, {
        title: 'B',
        entityId: 'b',
        path: '/note/b'
      })

      // #when the back menu is built
      const entries = buildHistoryEntries(state, group.id, 'back')

      // #then it offers "A" — reading the live tab would list B, the note the
      // user is already on
      expect(entries).toHaveLength(1)
      expect(entries[0].tab.title).toBe('A')
      expect(entries[0].tab.entityId).toBe('a')
      expect(entries[0].steps).toBe(1)
    })

    it('drops history entries for an entity that was deleted', () => {
      // #given A → B in one tab, so A survives only inside the back stack
      const a = makeTab({ title: 'A', entityId: 'a', path: '/note/a' })
      const group = makeGroup([a], { activeTabId: a.id })
      const state = reuseOpen(makeState(group), group.id, {
        title: 'B',
        entityId: 'b',
        path: '/note/b'
      })
      expect(state.tabGroups[group.id].back).toHaveLength(1)

      // #when A is deleted
      const next = tabReducer(state, {
        type: 'CLOSE_TABS_BY_ENTITY',
        payload: { entityId: 'a' }
      })

      // #then back can no longer navigate onto the tombstone
      expect(next.tabGroups[group.id].back).toEqual([])
    })
  })

  describe('OPEN_TAB clears forward and records previous active', () => {
    it('opens a fresh note tab after a back navigation, wiping forward', () => {
      // #given user is on A with B reachable via forward
      const a = makeTab({ title: 'A', entityId: 'a' })
      const b = makeTab({ title: 'B', entityId: 'b' })
      const group = makeGroup([a, b], { activeTabId: a.id, forward: [entryFor(b)] })
      const state = makeState(group)

      // #when they open a new tab
      const next = tabReducer(state, {
        type: 'OPEN_TAB',
        payload: {
          tab: openPayload({ title: 'C', path: '/note/c', entityId: 'c' }),
          groupId: group.id
        }
      })

      // #then forward is wiped and back records A
      expect(next.tabGroups[group.id].forward).toEqual([])
      expect(tabIds(next.tabGroups[group.id].back)).toEqual([a.id])
    })

    it('background OPEN_TAB does not record activation history', () => {
      // #given user is on A
      const a = makeTab({ title: 'A', entityId: 'a' })
      const group = makeGroup([a], { activeTabId: a.id, back: [staleEntry('previous')] })
      const state = makeState(group)

      // #when they open a tab in the background
      const next = tabReducer(state, {
        type: 'OPEN_TAB',
        payload: {
          tab: openPayload({ title: 'B', path: '/note/b', entityId: 'b' }),
          groupId: group.id,
          background: true
        }
      })

      // #then history is unchanged and active tab stays on A
      expect(next.tabGroups[group.id].activeTabId).toBe(a.id)
      expect(tabIds(next.tabGroups[group.id].back)).toEqual(['previous'])
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
        back: [entryFor(a), entryFor(b)],
        forward: [entryFor(b)]
      })
      const state = makeState(group)

      // #when B is closed
      const next = tabReducer(state, {
        type: 'CLOSE_TAB',
        payload: { tabId: b.id, groupId: group.id }
      })

      // #then b.id is gone from both stacks
      expect(tabIds(next.tabGroups[group.id].back)).toEqual([a.id])
      expect(next.tabGroups[group.id].forward).toEqual([])
    })
  })

  describe('history cap', () => {
    it('caps the back stack at 50 entries', () => {
      // #given a back stack at the cap limit
      const tabs = Array.from({ length: 51 }, (_, i) => makeTab({ title: `T${i}` }))
      const tail = tabs[tabs.length - 1]
      const back = tabs.slice(0, -1).map(entryFor)
      const group = makeGroup(tabs, { activeTabId: tail.id, back })

      // #when the user activates a fresh tab
      const fresh = makeTab({ title: 'fresh' })
      const groupWithFresh = { ...group, tabs: [...tabs, fresh] }
      const stateWithFreshAndBack = {
        ...makeState(groupWithFresh),
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
      expect(next.tabGroups[group.id].back[0].tabId).toBe(tabs[1].id)
      expect(next.tabGroups[group.id].back[49].tabId).toBe(tail.id)
    })
  })
})
