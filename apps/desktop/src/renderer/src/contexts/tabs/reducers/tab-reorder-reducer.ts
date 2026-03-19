import type { TabAction, TabSystemState } from '../types'
import { closeGroup } from './tab-crud-reducer'

type ReorderAction = Extract<TabAction, { type: 'REORDER_TABS' | 'MOVE_TAB' }>

export function tabReorderReducer(state: TabSystemState, action: ReorderAction): TabSystemState {
  switch (action.type) {
    case 'REORDER_TABS': {
      const { groupId, fromIndex, toIndex } = action.payload
      const group = state.tabGroups[groupId]

      if (!group) return state
      if (fromIndex === toIndex) return state
      if (fromIndex < 0 || fromIndex >= group.tabs.length) return state
      if (toIndex < 0 || toIndex >= group.tabs.length) return state

      const newTabs = [...group.tabs]
      const [movedTab] = newTabs.splice(fromIndex, 1)
      newTabs.splice(toIndex, 0, movedTab)

      return {
        ...state,
        tabGroups: { ...state.tabGroups, [groupId]: { ...group, tabs: newTabs } }
      }
    }

    case 'MOVE_TAB': {
      const { tabId, fromGroupId, toGroupId, toIndex } = action.payload
      const fromGroup = state.tabGroups[fromGroupId]
      const toGroup = state.tabGroups[toGroupId]

      if (!fromGroup || !toGroup) return state

      const tab = fromGroup.tabs.find((t) => t.id === tabId)
      if (!tab) return state

      const newFromTabs = fromGroup.tabs.filter((t) => t.id !== tabId)

      if (newFromTabs.length === 0 && Object.keys(state.tabGroups).length > 1) {
        const newToTabs = [
          ...toGroup.tabs.slice(0, toIndex),
          { ...tab, lastAccessedAt: Date.now() },
          ...toGroup.tabs.slice(toIndex)
        ]

        const stateWithTab = {
          ...state,
          tabGroups: {
            ...state.tabGroups,
            [toGroupId]: { ...toGroup, tabs: newToTabs, activeTabId: tab.id }
          },
          activeGroupId: toGroupId
        }

        return closeGroup(stateWithTab, fromGroupId)
      }

      const newToTabs = [
        ...toGroup.tabs.slice(0, toIndex),
        { ...tab, lastAccessedAt: Date.now() },
        ...toGroup.tabs.slice(toIndex)
      ]

      let newFromActiveTabId = fromGroup.activeTabId
      if (fromGroup.activeTabId === tabId && newFromTabs.length > 0) {
        const oldIndex = fromGroup.tabs.findIndex((t) => t.id === tabId)
        const newIndex = Math.min(oldIndex, newFromTabs.length - 1)
        newFromActiveTabId = newFromTabs[newIndex].id
      }

      return {
        ...state,
        tabGroups: {
          ...state.tabGroups,
          [fromGroupId]: { ...fromGroup, tabs: newFromTabs, activeTabId: newFromActiveTabId },
          [toGroupId]: { ...toGroup, tabs: newToTabs, activeTabId: tab.id }
        },
        activeGroupId: toGroupId
      }
    }

    default:
      return state
  }
}
