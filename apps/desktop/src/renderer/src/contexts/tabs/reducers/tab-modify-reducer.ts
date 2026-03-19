import type { TabAction, TabSystemState } from '../types'

type ModifyAction = Extract<
  TabAction,
  {
    type:
      | 'PIN_TAB'
      | 'UNPIN_TAB'
      | 'SET_TAB_MODIFIED'
      | 'SET_TAB_DELETED'
      | 'UPDATE_TAB_TITLE'
      | 'PROMOTE_PREVIEW_TAB'
  }
>

export function tabModifyReducer(state: TabSystemState, action: ModifyAction): TabSystemState {
  switch (action.type) {
    case 'PIN_TAB': {
      const { tabId, groupId } = action.payload
      const group = state.tabGroups[groupId]
      if (!group) return state

      const tabIndex = group.tabs.findIndex((t) => t.id === tabId)
      if (tabIndex === -1) return state

      const tab = { ...group.tabs[tabIndex], isPinned: true, isPreview: false }
      let newTabs = group.tabs.filter((t) => t.id !== tabId)

      const lastPinnedIndex = newTabs.findLastIndex((t) => t.isPinned)
      newTabs = [
        ...newTabs.slice(0, lastPinnedIndex + 1),
        tab,
        ...newTabs.slice(lastPinnedIndex + 1)
      ]

      return {
        ...state,
        tabGroups: { ...state.tabGroups, [groupId]: { ...group, tabs: newTabs } }
      }
    }

    case 'UNPIN_TAB': {
      const { tabId, groupId } = action.payload
      const group = state.tabGroups[groupId]
      if (!group) return state

      const tabIndex = group.tabs.findIndex((t) => t.id === tabId)
      if (tabIndex === -1) return state

      const tab = { ...group.tabs[tabIndex], isPinned: false }
      let newTabs = group.tabs.filter((t) => t.id !== tabId)

      const lastPinnedIndex = newTabs.findLastIndex((t) => t.isPinned)
      newTabs = [
        ...newTabs.slice(0, lastPinnedIndex + 1),
        tab,
        ...newTabs.slice(lastPinnedIndex + 1)
      ]

      return {
        ...state,
        tabGroups: { ...state.tabGroups, [groupId]: { ...group, tabs: newTabs } }
      }
    }

    case 'SET_TAB_MODIFIED': {
      const { tabId, groupId, isModified } = action.payload
      const group = state.tabGroups[groupId]
      if (!group) return state

      return {
        ...state,
        tabGroups: {
          ...state.tabGroups,
          [groupId]: {
            ...group,
            tabs: group.tabs.map((t) => (t.id === tabId ? { ...t, isModified } : t))
          }
        }
      }
    }

    case 'SET_TAB_DELETED': {
      const { tabId, groupId, isDeleted } = action.payload
      const group = state.tabGroups[groupId]
      if (!group) return state

      return {
        ...state,
        tabGroups: {
          ...state.tabGroups,
          [groupId]: {
            ...group,
            tabs: group.tabs.map((t) => (t.id === tabId ? { ...t, isDeleted } : t))
          }
        }
      }
    }

    case 'UPDATE_TAB_TITLE': {
      const { tabId, groupId, title } = action.payload
      const group = state.tabGroups[groupId]
      if (!group) return state

      return {
        ...state,
        tabGroups: {
          ...state.tabGroups,
          [groupId]: {
            ...group,
            tabs: group.tabs.map((t) => (t.id === tabId ? { ...t, title } : t))
          }
        }
      }
    }

    case 'PROMOTE_PREVIEW_TAB': {
      const { tabId, groupId } = action.payload
      const group = state.tabGroups[groupId]
      if (!group) return state

      return {
        ...state,
        tabGroups: {
          ...state.tabGroups,
          [groupId]: {
            ...group,
            tabs: group.tabs.map((t) => (t.id === tabId ? { ...t, isPreview: false } : t))
          }
        }
      }
    }

    default:
      return state
  }
}
