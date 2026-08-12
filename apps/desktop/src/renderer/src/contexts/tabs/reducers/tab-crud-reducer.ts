import type { ClosedTabEntry, Tab, TabAction, TabGroup, TabSystemState } from '../types'
import { SINGLETON_TAB_TYPES } from '../types'
import {
  generateId,
  findExistingTab,
  findTabByEntityId,
  createDefaultTab,
  getInsertIndexAfterPinned
} from '../helpers'
import { removeGroupFromLayout } from '@/components/split-view/layout-helpers'
import { createInitialState } from '../helpers'
import { pruneHistory, recordActivation } from './history-helpers'

type CrudAction = Extract<
  TabAction,
  {
    type:
      | 'OPEN_TAB'
      | 'CLOSE_TAB'
      | 'CLOSE_OTHER_TABS'
      | 'CLOSE_TABS_TO_RIGHT'
      | 'CLOSE_ALL_TABS'
      | 'CLOSE_GROUP'
      | 'REOPEN_CLOSED_TAB'
  }
>

/** Max number of closed-tab snapshots retained for reopen (Cmd+Shift+T). */
const MAX_RECENTLY_CLOSED = 25

/** Snapshot a tab being closed so it can be reopened later. */
const snapshotClosedTab = (tab: Tab, groupId: string, index: number): ClosedTabEntry => ({
  tab: {
    type: tab.type,
    title: tab.title,
    icon: tab.icon,
    emoji: tab.emoji,
    path: tab.path,
    entityId: tab.entityId,
    isPinned: tab.isPinned,
    isModified: false,
    isPreview: false,
    isDeleted: false,
    scrollPosition: tab.scrollPosition,
    viewState: tab.viewState
  },
  groupId,
  index,
  closedAt: Date.now()
})

/** Append closed-tab snapshots, trimming the stack to MAX_RECENTLY_CLOSED. */
const pushClosed = (
  stack: ClosedTabEntry[] | undefined,
  entries: ClosedTabEntry[]
): ClosedTabEntry[] => {
  const next = [...(stack ?? []), ...entries]
  return next.length > MAX_RECENTLY_CLOSED ? next.slice(next.length - MAX_RECENTLY_CLOSED) : next
}

/** Snapshot the tabs removed by a bulk close, in original (left→right) order. */
const snapshotRemoved = (
  group: TabGroup,
  groupId: string,
  isRemoved: (tab: Tab, index: number) => boolean
): ClosedTabEntry[] =>
  group.tabs
    .map((tab, index) => ({ tab, index }))
    .filter(({ tab, index }) => isRemoved(tab, index))
    .map(({ tab, index }) => snapshotClosedTab(tab, groupId, index))

const closeGroup = (state: TabSystemState, groupId: string): TabSystemState => {
  const { [groupId]: _removedGroup, ...remainingGroups } = state.tabGroups

  const newLayout = removeGroupFromLayout(state.layout, groupId)

  if (!newLayout) {
    return { ...createInitialState(), settings: state.settings }
  }

  let newActiveGroupId = state.activeGroupId
  if (state.activeGroupId === groupId) {
    const availableGroupIds = Object.keys(remainingGroups)
    newActiveGroupId = availableGroupIds[0] || state.activeGroupId
  }

  return {
    ...state,
    tabGroups: remainingGroups,
    layout: newLayout,
    activeGroupId: newActiveGroupId
  }
}

export { closeGroup }

const findExistingTabInGroup = (group: TabGroup, type: Tab['type']): Tab | undefined => {
  return group.tabs.find((t) => t.type === type)
}

const findTabByEntityIdInGroup = (group: TabGroup, entityId: string): Tab | undefined => {
  return group.tabs.find((t) => t.entityId === entityId)
}

export function tabCrudReducer(state: TabSystemState, action: CrudAction): TabSystemState {
  switch (action.type) {
    case 'OPEN_TAB': {
      const {
        tab,
        groupId = state.activeGroupId,
        position,
        background,
        forceNew,
        replaceActive
      } = action.payload
      const targetGroup = state.tabGroups[groupId]

      if (!targetGroup) return state

      if (replaceActive && targetGroup.activeTabId) {
        const activeTabIndex = targetGroup.tabs.findIndex((t) => t.id === targetGroup.activeTabId)
        if (activeTabIndex !== -1) {
          const activeTab = targetGroup.tabs[activeTabIndex]
          if (!activeTab.isPinned) {
            const newTab: Tab = {
              ...tab,
              isPreview: false,
              id: generateId(),
              openedAt: Date.now(),
              lastAccessedAt: Date.now()
            }
            const newTabs = [...targetGroup.tabs]
            newTabs[activeTabIndex] = newTab

            const pruned = pruneHistory(targetGroup, new Set([activeTab.id]))
            return {
              ...state,
              tabGroups: {
                ...state.tabGroups,
                [groupId]: { ...pruned, tabs: newTabs, activeTabId: newTab.id }
              }
            }
          }
        }
      }

      // `forceNew` is an explicit "I want another tab" (sidebar Open in New Tab,
      // Cmd/Ctrl-click, middle-click). It skips every dedup/focus branch below so
      // the open falls through to the mint-a-new-tab path.
      // Per-group singleton dedup: only check within the target group
      if (!forceNew && tab.type) {
        const existingInGroup = findExistingTabInGroup(targetGroup, tab.type)
        if (
          existingInGroup &&
          tab.entityId === undefined &&
          existingInGroup.entityId === undefined
        ) {
          // Singleton-like dedup within group (e.g. inbox, settings)
          // Only dedup non-entity tabs to avoid cross-type collisions
          const isSameKind = existingInGroup.type === tab.type && existingInGroup.path === tab.path
          if (isSameKind) {
            const updatedTabs = targetGroup.tabs.map((t) =>
              t.id === existingInGroup.id
                ? {
                    ...t,
                    isPreview: false,
                    lastAccessedAt: Date.now(),
                    ...(tab.viewState && { viewState: { ...t.viewState, ...tab.viewState } })
                  }
                : t
            )
            const groupAfter = background
              ? { ...targetGroup, tabs: updatedTabs }
              : { ...recordActivation(targetGroup, existingInGroup.id), tabs: updatedTabs }
            return {
              ...state,
              tabGroups: { ...state.tabGroups, [groupId]: groupAfter },
              activeGroupId: background ? state.activeGroupId : groupId
            }
          }
        }
      }

      // Cross-group singleton focus: when no explicit groupId, find singleton anywhere
      if (
        !forceNew &&
        SINGLETON_TAB_TYPES.includes(tab.type) &&
        !action.payload.groupId &&
        tab.entityId === undefined
      ) {
        const existing = findExistingTab(state, tab.type)
        if (existing) {
          const existingGroup = state.tabGroups[existing.groupId]
          const updatedTabs = existingGroup.tabs.map((t) =>
            t.id === existing.tab.id ? { ...t, isPreview: false, lastAccessedAt: Date.now() } : t
          )
          const groupAfter = background
            ? { ...existingGroup, tabs: updatedTabs }
            : { ...recordActivation(existingGroup, existing.tab.id), tabs: updatedTabs }
          return {
            ...state,
            tabGroups: { ...state.tabGroups, [existing.groupId]: groupAfter },
            activeGroupId: background ? state.activeGroupId : existing.groupId
          }
        }
      }

      // Per-group entityId dedup
      if (!forceNew && tab.entityId) {
        const existingInGroup = findTabByEntityIdInGroup(targetGroup, tab.entityId)
        if (existingInGroup) {
          const updatedTabs = targetGroup.tabs.map((t) =>
            t.id === existingInGroup.id
              ? {
                  ...t,
                  isPreview: false,
                  lastAccessedAt: Date.now(),
                  ...(tab.viewState && {
                    viewState: { ...t.viewState, ...tab.viewState }
                  })
                }
              : t
          )
          const groupAfter = background
            ? { ...targetGroup, tabs: updatedTabs }
            : { ...recordActivation(targetGroup, existingInGroup.id), tabs: updatedTabs }
          return {
            ...state,
            tabGroups: { ...state.tabGroups, [groupId]: groupAfter },
            activeGroupId: background ? state.activeGroupId : groupId
          }
        }

        // Cross-group: if tab already open elsewhere and no explicit groupId was given,
        // focus the existing tab (preserves familiar UX for entity tabs)
        if (!action.payload.groupId) {
          const existingElsewhere = findTabByEntityId(state, tab.entityId)
          if (existingElsewhere) {
            const elsewhereGroup = state.tabGroups[existingElsewhere.groupId]
            const updatedTabs = elsewhereGroup.tabs.map((t) =>
              t.id === existingElsewhere.tab.id
                ? {
                    ...t,
                    isPreview: false,
                    lastAccessedAt: Date.now(),
                    ...(tab.viewState && {
                      viewState: { ...t.viewState, ...tab.viewState }
                    })
                  }
                : t
            )
            const groupAfter = background
              ? { ...elsewhereGroup, tabs: updatedTabs }
              : { ...recordActivation(elsewhereGroup, existingElsewhere.tab.id), tabs: updatedTabs }
            return {
              ...state,
              tabGroups: { ...state.tabGroups, [existingElsewhere.groupId]: groupAfter },
              activeGroupId: background ? state.activeGroupId : existingElsewhere.groupId
            }
          }
        }
      }

      const newTab: Tab = {
        ...tab,
        isPreview: false,
        id: generateId(),
        openedAt: Date.now(),
        lastAccessedAt: Date.now()
      }

      let insertIndex = position ?? targetGroup.tabs.length

      if (!tab.isPinned) {
        const afterPinnedIndex = getInsertIndexAfterPinned(targetGroup.tabs)
        insertIndex = Math.max(insertIndex, afterPinnedIndex)
      }

      insertIndex = Math.min(insertIndex, targetGroup.tabs.length)

      const newTabs = [
        ...targetGroup.tabs.slice(0, insertIndex),
        newTab,
        ...targetGroup.tabs.slice(insertIndex)
      ]

      const groupAfter = background
        ? { ...targetGroup, tabs: newTabs }
        : { ...recordActivation(targetGroup, newTab.id), tabs: newTabs }
      return {
        ...state,
        tabGroups: { ...state.tabGroups, [groupId]: groupAfter },
        activeGroupId: background ? state.activeGroupId : groupId
      }
    }

    case 'CLOSE_TAB': {
      const { tabId, groupId } = action.payload
      const group = state.tabGroups[groupId]

      if (!group) return state

      const tabIndex = group.tabs.findIndex((t) => t.id === tabId)
      if (tabIndex === -1) return state

      const newTabs = group.tabs.filter((t) => t.id !== tabId)
      const recentlyClosed = pushClosed(state.recentlyClosed, [
        snapshotClosedTab(group.tabs[tabIndex], groupId, tabIndex)
      ])

      if (newTabs.length === 0) {
        if (Object.keys(state.tabGroups).length === 1) {
          const defaultTab = createDefaultTab()
          return {
            ...state,
            recentlyClosed,
            tabGroups: {
              [groupId]: {
                ...group,
                tabs: [defaultTab],
                activeTabId: defaultTab.id,
                back: [],
                forward: []
              }
            }
          }
        }
        return closeGroup({ ...state, recentlyClosed }, groupId)
      }

      let newActiveTabId = group.activeTabId
      if (group.activeTabId === tabId) {
        const newActiveIndex = Math.min(tabIndex, newTabs.length - 1)
        newActiveTabId = newTabs[newActiveIndex].id
      }

      const pruned = pruneHistory(group, new Set([tabId]))
      return {
        ...state,
        recentlyClosed,
        tabGroups: {
          ...state.tabGroups,
          [groupId]: { ...pruned, tabs: newTabs, activeTabId: newActiveTabId }
        }
      }
    }

    case 'CLOSE_OTHER_TABS': {
      const { tabId, groupId } = action.payload
      const group = state.tabGroups[groupId]

      if (!group) return state
      if (!group.tabs.find((t) => t.id === tabId)) return state

      const tabsToKeep = group.tabs.filter((t) => t.id === tabId || t.isPinned)
      const removedIds = new Set(group.tabs.filter((t) => !tabsToKeep.includes(t)).map((t) => t.id))
      const pruned = pruneHistory(group, removedIds)
      const recentlyClosed = pushClosed(
        state.recentlyClosed,
        snapshotRemoved(group, groupId, (t) => removedIds.has(t.id))
      )

      return {
        ...state,
        recentlyClosed,
        tabGroups: {
          ...state.tabGroups,
          [groupId]: { ...pruned, tabs: tabsToKeep, activeTabId: tabId }
        }
      }
    }

    case 'CLOSE_TABS_TO_RIGHT': {
      const { tabId, groupId } = action.payload
      const group = state.tabGroups[groupId]

      if (!group) return state

      const tabIndex = group.tabs.findIndex((t) => t.id === tabId)
      if (tabIndex === -1) return state

      const tabsToKeep = group.tabs.filter((t, i) => i <= tabIndex || t.isPinned)
      const removedIds = new Set(group.tabs.filter((t) => !tabsToKeep.includes(t)).map((t) => t.id))
      const pruned = pruneHistory(group, removedIds)
      const recentlyClosed = pushClosed(
        state.recentlyClosed,
        snapshotRemoved(group, groupId, (t) => removedIds.has(t.id))
      )

      return {
        ...state,
        recentlyClosed,
        tabGroups: {
          ...state.tabGroups,
          [groupId]: { ...pruned, tabs: tabsToKeep }
        }
      }
    }

    case 'CLOSE_ALL_TABS': {
      const { groupId } = action.payload
      const group = state.tabGroups[groupId]

      if (!group) return state

      const pinnedTabs = group.tabs.filter((t) => t.isPinned)
      const recentlyClosed = pushClosed(
        state.recentlyClosed,
        snapshotRemoved(group, groupId, (t) => !t.isPinned)
      )

      if (pinnedTabs.length === 0) {
        if (Object.keys(state.tabGroups).length === 1) {
          const defaultTab = createDefaultTab()
          return {
            ...state,
            recentlyClosed,
            tabGroups: {
              [groupId]: {
                ...group,
                tabs: [defaultTab],
                activeTabId: defaultTab.id,
                back: [],
                forward: []
              }
            }
          }
        }
        return closeGroup({ ...state, recentlyClosed }, groupId)
      }

      const removedIds = new Set(group.tabs.filter((t) => !t.isPinned).map((t) => t.id))
      const pruned = pruneHistory(group, removedIds)

      return {
        ...state,
        recentlyClosed,
        tabGroups: {
          ...state.tabGroups,
          [groupId]: { ...pruned, tabs: pinnedTabs, activeTabId: pinnedTabs[0]?.id || null }
        }
      }
    }

    case 'CLOSE_GROUP': {
      const { groupId } = action.payload

      if (Object.keys(state.tabGroups).length === 1) return state

      if (!state.tabGroups[groupId]) return state

      return closeGroup(state, groupId)
    }

    case 'REOPEN_CLOSED_TAB': {
      const stack = state.recentlyClosed ?? []
      if (stack.length === 0) return state

      const entry = stack[stack.length - 1]
      const recentlyClosed = stack.slice(0, -1)

      // Reopen into the original group if it still exists, else the active group.
      const targetGroupId = state.tabGroups[entry.groupId] ? entry.groupId : state.activeGroupId
      const group = state.tabGroups[targetGroupId]
      if (!group) return { ...state, recentlyClosed }

      const snap = entry.tab

      // If the entity/singleton is already open in the target group, focus it
      // instead of creating a duplicate (mirrors OPEN_TAB dedup).
      const existing = snap.entityId
        ? findTabByEntityIdInGroup(group, snap.entityId)
        : group.tabs.find(
            (t) => t.entityId === undefined && t.type === snap.type && t.path === snap.path
          )
      if (existing) {
        return {
          ...state,
          recentlyClosed,
          activeGroupId: targetGroupId,
          tabGroups: {
            ...state.tabGroups,
            [targetGroupId]: recordActivation(group, existing.id)
          }
        }
      }

      const newTab: Tab = {
        ...snap,
        isPreview: false,
        id: generateId(),
        openedAt: Date.now(),
        lastAccessedAt: Date.now()
      }

      let insertIndex = Math.min(entry.index, group.tabs.length)
      if (!snap.isPinned) {
        insertIndex = Math.max(insertIndex, getInsertIndexAfterPinned(group.tabs))
      }
      insertIndex = Math.min(insertIndex, group.tabs.length)

      const newTabs = [
        ...group.tabs.slice(0, insertIndex),
        newTab,
        ...group.tabs.slice(insertIndex)
      ]

      return {
        ...state,
        recentlyClosed,
        activeGroupId: targetGroupId,
        tabGroups: {
          ...state.tabGroups,
          [targetGroupId]: { ...recordActivation(group, newTab.id), tabs: newTabs }
        }
      }
    }

    default:
      return state
  }
}
