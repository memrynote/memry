/**
 * Sidebar Navigation Hook
 * Handles opening sidebar items in tabs with proper behavior
 *
 * PERFORMANCE: This hook has been optimized to prevent cascade re-renders:
 * 1. Uses useTabActions instead of useTabs for stable action references
 * 2. Uses optimized useIsItemActive hook for active state checking
 * 3. State access is done via refs to keep callbacks stable
 */

import { useCallback, useRef, useEffect } from 'react'
import { useTabs, useTabActions, useTabSettings } from '@/contexts/tabs'
import {
  findExistingTab,
  findTabByEntityId,
  createTabFromSidebarItem
} from '@/contexts/tabs/helpers'
import { SINGLETON_TAB_TYPES } from '@/contexts/tabs/types'
import type { Tab, TabSystemState, SidebarItem } from '@/contexts/tabs/types'
import { useIsItemActive } from './use-is-item-active'

// =============================================================================
// TYPES
// =============================================================================

/**
 * Options for opening a sidebar item
 */
export interface OpenSidebarItemOptions {
  /** Force open in new tab */
  inNewTab?: boolean
  /** Don't focus the new tab */
  inBackground?: boolean
  /** Open in split view */
  toTheSide?: boolean
  /** Override preview mode */
  isPreview?: boolean
}

/**
 * Result of finding an existing tab for an item
 */
interface FoundTabResult {
  tab: Tab
  groupId: string
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Find existing tab for a sidebar item
 * Checks singletons by type, content items by entityId
 */
export const findExistingTabForItem = (
  state: TabSystemState,
  item: SidebarItem
): FoundTabResult | null => {
  // For singletons, check by type
  if (SINGLETON_TAB_TYPES.includes(item.type)) {
    return findExistingTab(state, item.type)
  }

  // For content items, check by entityId
  if (item.entityId) {
    return findTabByEntityId(state, item.entityId)
  }

  // Fallback: check by path
  for (const [groupId, group] of Object.entries(state.tabGroups)) {
    const tab = group.tabs.find((t) => t.path === item.path)
    if (tab) {
      return { tab, groupId }
    }
  }

  return null
}

/**
 * Check if a sidebar item is currently open in any tab
 */
export const isItemOpenInTab = (state: TabSystemState, item: SidebarItem): boolean => {
  return findExistingTabForItem(state, item) !== null
}

/**
 * Check if a sidebar item matches the active tab
 */
export const isItemActiveTab = (state: TabSystemState, item: SidebarItem): boolean => {
  const activeGroup = state.tabGroups[state.activeGroupId]
  if (!activeGroup || !activeGroup.activeTabId) return false

  const activeTab = activeGroup.tabs.find((t) => t.id === activeGroup.activeTabId)
  if (!activeTab) return false

  // For singletons, match by type
  if (SINGLETON_TAB_TYPES.includes(item.type)) {
    return activeTab.type === item.type
  }

  // For content items, match by entityId
  if (item.entityId) {
    return activeTab.entityId === item.entityId
  }

  // Fallback to path match
  return activeTab.path === item.path
}

// =============================================================================
// HOOK
// =============================================================================

/**
 * Hook for sidebar navigation with tab integration
 *
 * PERFORMANCE OPTIMIZATION:
 * - Uses useTabActions for stable action references (no re-renders on state change)
 * - Uses useIsItemActive for optimized active state checking
 * - State ref pattern keeps openSidebarItem callback stable
 */
export const useSidebarNavigation = () => {
  // PERFORMANCE: useTabActions returns stable references - doesn't trigger re-renders
  const { openTab, setActiveTab, splitView, dispatch } = useTabActions()
  // We still need state for finding existing tabs, but access it via ref
  const { state } = useTabs()
  const settings = useTabSettings()
  // PERFORMANCE: Optimized active item checking - stable callback reference
  const isActiveItem = useIsItemActive()

  // Use refs for state to avoid recreating callbacks
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  })

  /**
   * Open a sidebar item in a tab
   */
  const openSidebarItem = useCallback(
    (item: SidebarItem, options: OpenSidebarItemOptions = {}) => {
      const { inNewTab, inBackground, toTheSide, isPreview } = options
      const currentState = stateRef.current
      const currentSettings = settings

      // Determine if we should use preview mode
      const shouldBePreview = isPreview ?? (currentSettings.previewMode && !inNewTab)

      // Determine if should open in new tab or replace current
      // Default behavior: replace current tab
      // New tab only when: Cmd/Ctrl+Click (inNewTab=true), right-click "Open in New Tab", or toTheSide
      const shouldOpenNewTab = inNewTab ?? false
      const shouldReplaceActive = !shouldOpenNewTab && !toTheSide

      // Check for existing tab
      const existingTab = findExistingTabForItem(currentState, item)

      if (existingTab && !shouldOpenNewTab && !toTheSide) {
        // Focus existing tab
        setActiveTab(existingTab.tab.id, existingTab.groupId)

        // If it was a preview and we double-clicked, promote it
        if (existingTab.tab.isPreview && !shouldBePreview) {
          dispatch({
            type: 'PROMOTE_PREVIEW_TAB',
            payload: { tabId: existingTab.tab.id, groupId: existingTab.groupId }
          })
        }
        return
      }

      // Create tab data from sidebar item
      const tabData = createTabFromSidebarItem(item, shouldBePreview)

      if (toTheSide) {
        // Create split and open in new pane
        splitView('horizontal', currentState.activeGroupId)
        // The new group will be active, so opening a tab there
        // Note: This is a simplification - ideally we'd wait for the split
        // and then open the tab in the new pane
        setTimeout(() => {
          openTab(tabData, { background: inBackground })
        }, 0)
      } else {
        // Open tab - replace current tab unless explicitly opening new tab
        openTab(tabData, { background: inBackground, replaceActive: shouldReplaceActive })
      }
    },
    [openTab, setActiveTab, splitView, dispatch, settings]
  )

  /**
   * Open a sidebar item as a pinned tab
   */
  const openAsPin = useCallback(
    (item: SidebarItem) => {
      const tabData = createTabFromSidebarItem(item, false)
      openTab({ ...tabData, isPinned: true })
    },
    [openTab]
  )

  /**
   * Copy internal link for a sidebar item
   */
  const copyItemLink = useCallback((item: SidebarItem) => {
    const link = `memry://${item.path}`
    navigator.clipboard.writeText(link)
  }, [])

  /**
   * Check if item is open in any tab
   * Note: This reads from state ref for accurate results without callback instability
   */
  const isOpenInTab = useCallback((item: SidebarItem): boolean => {
    return isItemOpenInTab(stateRef.current, item)
  }, [])

  // isActiveItem is now provided by useIsItemActive hook (optimized, stable reference)

  return {
    openSidebarItem,
    openAsPin,
    copyItemLink,
    isOpenInTab,
    isActiveItem, // From useIsItemActive - stable reference
    settings
  }
}

export default useSidebarNavigation
