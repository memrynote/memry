import type { Tab, TabAction, TabGroup, TabSystemState } from '../types'
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
  }
>

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

      // Per-group singleton dedup: only check within the target group
      if (tab.type) {
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
        SINGLETON_TAB_TYPES.includes(tab.type) &&
        !action.payload.groupId &&
        tab.entityId === undefined
      ) {
        const existing = findExistingTab(state, tab.type)
        if (existing) {
          const existingGroup = state.tabGroups[existing.groupId]
          const updatedTabs = existingGroup.tabs.map((t) =>
            t.id === existing.tab.id ? { ...t, lastAccessedAt: Date.now() } : t
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
      if (tab.entityId) {
        const existingInGroup = findTabByEntityIdInGroup(targetGroup, tab.entityId)
        if (existingInGroup) {
          const updatedTabs = targetGroup.tabs.map((t) =>
            t.id === existingInGroup.id
              ? {
                  ...t,
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

      // Handle preview mode
      if (state.settings.previewMode && tab.isPreview) {
        const previewTabIndex = targetGroup.tabs.findIndex((t) => t.isPreview)
        if (previewTabIndex !== -1) {
          const previewTab = targetGroup.tabs[previewTabIndex]
          const newTab: Tab = {
            ...tab,
            id: generateId(),
            openedAt: Date.now(),
            lastAccessedAt: Date.now()
          }
          const newTabs = [...targetGroup.tabs]
          newTabs[previewTabIndex] = newTab

          const pruned = pruneHistory(targetGroup, new Set([previewTab.id]))
          const nextActiveId = background ? pruned.activeTabId : newTab.id
          const groupAfter =
            background || pruned.activeTabId === nextActiveId
              ? { ...pruned, tabs: newTabs, activeTabId: nextActiveId }
              : { ...recordActivation(pruned, nextActiveId), tabs: newTabs }
          return {
            ...state,
            tabGroups: { ...state.tabGroups, [groupId]: groupAfter },
            activeGroupId: background ? state.activeGroupId : groupId
          }
        }
      }

      const newTab: Tab = {
        ...tab,
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

      if (newTabs.length === 0) {
        if (Object.keys(state.tabGroups).length === 1) {
          const defaultTab = createDefaultTab()
          return {
            ...state,
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
        return closeGroup(state, groupId)
      }

      let newActiveTabId = group.activeTabId
      if (group.activeTabId === tabId) {
        const newActiveIndex = Math.min(tabIndex, newTabs.length - 1)
        newActiveTabId = newTabs[newActiveIndex].id
      }

      const pruned = pruneHistory(group, new Set([tabId]))
      return {
        ...state,
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

      return {
        ...state,
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

      return {
        ...state,
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

      if (pinnedTabs.length === 0) {
        if (Object.keys(state.tabGroups).length === 1) {
          const defaultTab = createDefaultTab()
          return {
            ...state,
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
        return closeGroup(state, groupId)
      }

      const removedIds = new Set(group.tabs.filter((t) => !t.isPinned).map((t) => t.id))
      const pruned = pruneHistory(group, removedIds)

      return {
        ...state,
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

    default:
      return state
  }
}
