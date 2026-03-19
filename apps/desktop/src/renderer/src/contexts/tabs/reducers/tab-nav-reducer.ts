import type { TabAction, TabSystemState } from '../types'

type NavAction = Extract<
  TabAction,
  {
    type:
      | 'SET_ACTIVE_TAB'
      | 'SET_ACTIVE_GROUP'
      | 'GO_TO_NEXT_TAB'
      | 'GO_TO_PREVIOUS_TAB'
      | 'GO_TO_TAB_INDEX'
  }
>

export function tabNavReducer(state: TabSystemState, action: NavAction): TabSystemState {
  switch (action.type) {
    case 'SET_ACTIVE_TAB': {
      const { tabId, groupId } = action.payload
      const group = state.tabGroups[groupId]

      if (!group) return state
      if (!group.tabs.find((t) => t.id === tabId)) return state

      return {
        ...state,
        tabGroups: {
          ...state.tabGroups,
          [groupId]: {
            ...group,
            activeTabId: tabId,
            tabs: group.tabs.map((t) => (t.id === tabId ? { ...t, lastAccessedAt: Date.now() } : t))
          }
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

      return {
        ...state,
        tabGroups: {
          ...state.tabGroups,
          [groupId]: {
            ...group,
            activeTabId: nextTab.id,
            tabs: group.tabs.map((t) =>
              t.id === nextTab.id ? { ...t, lastAccessedAt: Date.now() } : t
            )
          }
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

      return {
        ...state,
        tabGroups: {
          ...state.tabGroups,
          [groupId]: {
            ...group,
            activeTabId: prevTab.id,
            tabs: group.tabs.map((t) =>
              t.id === prevTab.id ? { ...t, lastAccessedAt: Date.now() } : t
            )
          }
        }
      }
    }

    case 'GO_TO_TAB_INDEX': {
      const { index, groupId } = action.payload
      const group = state.tabGroups[groupId]

      if (!group || index < 0 || index >= group.tabs.length) return state

      const targetTab = group.tabs[index]

      return {
        ...state,
        tabGroups: {
          ...state.tabGroups,
          [groupId]: {
            ...group,
            activeTabId: targetTab.id,
            tabs: group.tabs.map((t) =>
              t.id === targetTab.id ? { ...t, lastAccessedAt: Date.now() } : t
            )
          }
        }
      }
    }

    default:
      return state
  }
}
