import type { SplitDirection, SplitLayout, TabAction, TabGroup, TabSystemState } from '../types'
import { generateId, createDefaultTab } from '../helpers'
import { insertSplitAtGroup } from '@/components/split-view/layout-helpers'
import { closeGroup } from './tab-crud-reducer'

type LayoutAction = Extract<
  TabAction,
  {
    type:
      | 'SPLIT_VIEW'
      | 'RESIZE_SPLIT'
      | 'CLOSE_SPLIT'
      | 'MOVE_TAB_TO_NEW_SPLIT'
      | 'SET_LAYOUT'
      | 'TOGGLE_MAXIMIZE_GROUP'
      | 'RESET_SPLIT_RATIOS'
  }
>

const resetRatiosInTree = (layout: SplitLayout): SplitLayout => {
  if (layout.type === 'leaf') return layout
  return {
    ...layout,
    ratio: 0.5,
    first: resetRatiosInTree(layout.first),
    second: resetRatiosInTree(layout.second)
  }
}

export function layoutReducer(state: TabSystemState, action: LayoutAction): TabSystemState {
  switch (action.type) {
    case 'SPLIT_VIEW': {
      const { direction, groupId } = action.payload

      const sourceGroup = state.tabGroups[groupId]
      if (!sourceGroup) return state

      // Clone the active tab into the new pane (never empty)
      const activeTab = sourceGroup.tabs.find((t) => t.id === sourceGroup.activeTabId)
      const clonedTab = activeTab
        ? {
            ...activeTab,
            id: generateId(),
            openedAt: Date.now(),
            lastAccessedAt: Date.now()
          }
        : createDefaultTab()

      const newGroup: TabGroup = {
        id: generateId(),
        tabs: [clonedTab],
        activeTabId: clonedTab.id,
        isActive: false
      }

      const newLayout = insertSplitAtGroup(state.layout, groupId, newGroup.id, direction)

      return {
        ...state,
        tabGroups: { ...state.tabGroups, [newGroup.id]: newGroup },
        layout: newLayout
      }
    }

    case 'RESIZE_SPLIT': {
      const { path, ratio } = action.payload
      const clampedRatio = Math.max(0.1, Math.min(0.9, ratio))

      const updateRatio = (layout: typeof state.layout, depth: number): typeof state.layout => {
        if (layout.type === 'leaf') return layout
        if (depth === path.length) {
          return { ...layout, ratio: clampedRatio }
        }
        if (path[depth] === 0) {
          return { ...layout, first: updateRatio(layout.first, depth + 1) }
        }
        return { ...layout, second: updateRatio(layout.second, depth + 1) }
      }

      return { ...state, layout: updateRatio(state.layout, 0) }
    }

    case 'CLOSE_SPLIT': {
      const { groupId } = action.payload
      if (Object.keys(state.tabGroups).length <= 1) return state
      return closeGroup(state, groupId)
    }

    case 'MOVE_TAB_TO_NEW_SPLIT': {
      const { tabId, fromGroupId, direction } = action.payload
      const fromGroup = state.tabGroups[fromGroupId]

      if (!fromGroup) return state

      const tab = fromGroup.tabs.find((t) => t.id === tabId)
      if (!tab) return state

      if (fromGroup.tabs.length === 1 && Object.keys(state.tabGroups).length === 1) {
        return state
      }

      const newGroup: TabGroup = {
        id: generateId(),
        tabs: [{ ...tab, lastAccessedAt: Date.now() }],
        activeTabId: tab.id,
        isActive: false
      }

      const newFromTabs = fromGroup.tabs.filter((t) => t.id !== tabId)

      // Map direction to split type
      const splitDirection: SplitDirection =
        direction === 'up' || direction === 'down' ? 'vertical' : 'horizontal'

      const isFirst = direction === 'left' || direction === 'up'

      const insertSplit = (layout: typeof state.layout): typeof state.layout => {
        if (layout.type === 'leaf' && layout.tabGroupId === fromGroupId) {
          return {
            type: 'split',
            direction: splitDirection,
            ratio: 0.5,
            first: isFirst
              ? { type: 'leaf', tabGroupId: newGroup.id }
              : { type: 'leaf', tabGroupId: fromGroupId },
            second: isFirst
              ? { type: 'leaf', tabGroupId: fromGroupId }
              : { type: 'leaf', tabGroupId: newGroup.id }
          }
        }
        if (layout.type === 'split') {
          return {
            ...layout,
            first: insertSplit(layout.first),
            second: insertSplit(layout.second)
          }
        }
        return layout
      }

      if (newFromTabs.length === 0) {
        return {
          ...state,
          tabGroups: {
            ...state.tabGroups,
            [newGroup.id]: { ...newGroup, isActive: true }
          },
          layout: { type: 'leaf', tabGroupId: newGroup.id },
          activeGroupId: newGroup.id
        }
      }

      let newFromActiveTabId = fromGroup.activeTabId
      if (fromGroup.activeTabId === tabId) {
        const oldIndex = fromGroup.tabs.findIndex((t) => t.id === tabId)
        const newIndex = Math.min(oldIndex, newFromTabs.length - 1)
        newFromActiveTabId = newFromTabs[newIndex].id
      }

      return {
        ...state,
        tabGroups: {
          ...state.tabGroups,
          [fromGroupId]: { ...fromGroup, tabs: newFromTabs, activeTabId: newFromActiveTabId },
          [newGroup.id]: newGroup
        },
        layout: insertSplit(state.layout),
        activeGroupId: newGroup.id
      }
    }

    case 'SET_LAYOUT': {
      const { tabGroups, layout, activeGroupId } = action.payload
      return { ...state, tabGroups, layout, activeGroupId }
    }

    case 'TOGGLE_MAXIMIZE_GROUP': {
      const { groupId } = action.payload
      if (!state.tabGroups[groupId]) return state

      if (state.isMaximized && state.preMaximizeLayout) {
        return {
          ...state,
          layout: state.preMaximizeLayout,
          isMaximized: false,
          preMaximizeLayout: undefined
        }
      }

      if (state.layout.type === 'leaf') return state

      return {
        ...state,
        preMaximizeLayout: state.layout,
        layout: { type: 'leaf', tabGroupId: groupId },
        activeGroupId: groupId,
        isMaximized: true
      }
    }

    case 'RESET_SPLIT_RATIOS': {
      if (state.layout.type === 'leaf') return state
      return { ...state, layout: resetRatiosInTree(state.layout) }
    }

    default:
      return state
  }
}
