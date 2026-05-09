import type { TabAction, TabGroup, TabSystemState } from '../types'
import { recordActivation } from './history-helpers'

type NavAction = Extract<
  TabAction,
  {
    type:
      | 'SET_ACTIVE_TAB'
      | 'SET_ACTIVE_GROUP'
      | 'GO_TO_NEXT_TAB'
      | 'GO_TO_PREVIOUS_TAB'
      | 'GO_TO_TAB_INDEX'
      | 'NAV_BACK'
      | 'NAV_FORWARD'
  }
>

const touchActiveTimestamp = (tabs: TabGroup['tabs'], activeTabId: string): TabGroup['tabs'] =>
  tabs.map((t) => (t.id === activeTabId ? { ...t, lastAccessedAt: Date.now() } : t))

export function tabNavReducer(state: TabSystemState, action: NavAction): TabSystemState {
  switch (action.type) {
    case 'SET_ACTIVE_TAB': {
      const { tabId, groupId } = action.payload
      const group = state.tabGroups[groupId]

      if (!group) return state
      if (!group.tabs.find((t) => t.id === tabId)) return state
      if (group.activeTabId === tabId) {
        return { ...state, activeGroupId: groupId }
      }

      const recorded = recordActivation(group, tabId)
      return {
        ...state,
        tabGroups: {
          ...state.tabGroups,
          [groupId]: { ...recorded, tabs: touchActiveTimestamp(recorded.tabs, tabId) }
        },
        activeGroupId: groupId
      }
    }

    case 'SET_ACTIVE_GROUP': {
      const { groupId } = action.payload

      if (!state.tabGroups[groupId]) return state

      const updatedGroups = Object.fromEntries(
        Object.entries(state.tabGroups).map(([id, group]) => [
          id,
          { ...group, isActive: id === groupId }
        ])
      )

      return { ...state, tabGroups: updatedGroups, activeGroupId: groupId }
    }

    case 'GO_TO_NEXT_TAB': {
      const { groupId } = action.payload
      const group = state.tabGroups[groupId]

      if (!group || group.tabs.length === 0) return state

      const currentIndex = group.tabs.findIndex((t) => t.id === group.activeTabId)
      const nextIndex = (currentIndex + 1) % group.tabs.length
      const nextTab = group.tabs[nextIndex]

      const recorded = recordActivation(group, nextTab.id)
      return {
        ...state,
        tabGroups: {
          ...state.tabGroups,
          [groupId]: { ...recorded, tabs: touchActiveTimestamp(recorded.tabs, nextTab.id) }
        }
      }
    }

    case 'GO_TO_PREVIOUS_TAB': {
      const { groupId } = action.payload
      const group = state.tabGroups[groupId]

      if (!group || group.tabs.length === 0) return state

      const currentIndex = group.tabs.findIndex((t) => t.id === group.activeTabId)
      const prevIndex = currentIndex === 0 ? group.tabs.length - 1 : currentIndex - 1
      const prevTab = group.tabs[prevIndex]

      const recorded = recordActivation(group, prevTab.id)
      return {
        ...state,
        tabGroups: {
          ...state.tabGroups,
          [groupId]: { ...recorded, tabs: touchActiveTimestamp(recorded.tabs, prevTab.id) }
        }
      }
    }

    case 'GO_TO_TAB_INDEX': {
      const { index, groupId } = action.payload
      const group = state.tabGroups[groupId]

      if (!group || index < 0 || index >= group.tabs.length) return state

      const targetTab = group.tabs[index]

      const recorded = recordActivation(group, targetTab.id)
      return {
        ...state,
        tabGroups: {
          ...state.tabGroups,
          [groupId]: { ...recorded, tabs: touchActiveTimestamp(recorded.tabs, targetTab.id) }
        }
      }
    }

    case 'NAV_BACK': {
      const { groupId } = action.payload
      const group = state.tabGroups[groupId]
      if (!group || group.back.length === 0) return state

      const tabIds = new Set(group.tabs.map((t) => t.id))
      let back = group.back
      let target: string | null = null
      while (back.length > 0) {
        const candidate = back[back.length - 1]
        back = back.slice(0, -1)
        if (tabIds.has(candidate)) {
          target = candidate
          break
        }
      }
      if (target === null) {
        if (back.length === group.back.length) return state
        return {
          ...state,
          tabGroups: { ...state.tabGroups, [groupId]: { ...group, back } }
        }
      }

      const forward = group.activeTabId ? [...group.forward, group.activeTabId] : group.forward

      const updated: TabGroup = {
        ...group,
        back,
        forward,
        activeTabId: target,
        tabs: touchActiveTimestamp(group.tabs, target)
      }
      return {
        ...state,
        tabGroups: { ...state.tabGroups, [groupId]: updated },
        activeGroupId: groupId
      }
    }

    case 'NAV_FORWARD': {
      const { groupId } = action.payload
      const group = state.tabGroups[groupId]
      if (!group || group.forward.length === 0) return state

      const tabIds = new Set(group.tabs.map((t) => t.id))
      let forward = group.forward
      let target: string | null = null
      while (forward.length > 0) {
        const candidate = forward[forward.length - 1]
        forward = forward.slice(0, -1)
        if (tabIds.has(candidate)) {
          target = candidate
          break
        }
      }
      if (target === null) {
        if (forward.length === group.forward.length) return state
        return {
          ...state,
          tabGroups: { ...state.tabGroups, [groupId]: { ...group, forward } }
        }
      }

      const back = group.activeTabId ? [...group.back, group.activeTabId] : group.back

      const updated: TabGroup = {
        ...group,
        back,
        forward,
        activeTabId: target,
        tabs: touchActiveTimestamp(group.tabs, target)
      }
      return {
        ...state,
        tabGroups: { ...state.tabGroups, [groupId]: updated },
        activeGroupId: groupId
      }
    }

    default:
      return state
  }
}
