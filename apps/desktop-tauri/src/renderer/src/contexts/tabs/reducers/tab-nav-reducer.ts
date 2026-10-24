import type { TabAction, TabGroup, TabHistoryEntry, TabSystemState } from '../types'
import { pushCurrentPosition, recordActivation, restoreHistoryEntry } from './history-helpers'

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

/**
 * Pop one step off `direction`, put the pane where that entry says, and push
 * where the pane WAS onto the opposite stack.
 *
 * Both directions are the same walk with the stacks swapped, so they share one
 * implementation — they drifted apart too easily as two copies.
 *
 * Two things move, not one: the active tab (`entry.tabId`) and that tab's
 * contents (`entry.content`). The second is what makes back work after a
 * same-tab open, where every entry names the tab the user is already on and
 * only the contents differ (#2207).
 *
 * Entries whose tab has since been closed are skipped, exactly as before —
 * `buildHistoryEntries` counts steps on the same rule.
 */
const navigateHistory = (
  state: TabSystemState,
  groupId: string,
  direction: 'back' | 'forward'
): TabSystemState => {
  const group = state.tabGroups[groupId]
  if (!group) return state

  const source = direction === 'back' ? group.back : group.forward
  if (source.length === 0) return state

  const tabIds = new Set(group.tabs.map((t) => t.id))
  let remaining = source
  let entry: TabHistoryEntry | null = null
  while (remaining.length > 0) {
    const candidate = remaining[remaining.length - 1]
    remaining = remaining.slice(0, -1)
    if (tabIds.has(candidate.tabId)) {
      entry = candidate
      break
    }
  }

  // Nothing reachable left: keep the stale entries we burned through popped off
  // so the button stops offering a navigation that cannot happen.
  if (entry === null) {
    if (remaining.length === source.length) return state
    const drained =
      direction === 'back' ? { ...group, back: remaining } : { ...group, forward: remaining }
    return { ...state, tabGroups: { ...state.tabGroups, [groupId]: drained } }
  }

  const opposite = pushCurrentPosition(group, direction === 'back' ? group.forward : group.back)
  const tabs = touchActiveTimestamp(restoreHistoryEntry(group.tabs, entry), entry.tabId)

  const updated: TabGroup = {
    ...group,
    back: direction === 'back' ? remaining : opposite,
    forward: direction === 'back' ? opposite : remaining,
    activeTabId: entry.tabId,
    tabs
  }
  return {
    ...state,
    tabGroups: { ...state.tabGroups, [groupId]: updated },
    activeGroupId: groupId
  }
}

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
      return navigateHistory(state, groupId, 'back')
    }

    case 'NAV_FORWARD': {
      const { groupId } = action.payload
      return navigateHistory(state, groupId, 'forward')
    }

    default:
      return state
  }
}
