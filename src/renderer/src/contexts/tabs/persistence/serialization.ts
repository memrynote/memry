/**
 * Tab State Serialization
 * Functions to serialize/deserialize tab state for storage
 */

import type { Tab, TabGroup, TabSystemState } from '@/contexts/tabs/types'
import { createDefaultTab, generateId } from '@/contexts/tabs/helpers'
import type { PersistedTabState, PersistedTabGroup, PersistedTab } from './types'
import { STORAGE_VERSION } from './types'
import { migratePersistedState } from './migrations'

// =============================================================================
// SERIALIZE
// =============================================================================

/**
 * Serialize tab state for storage
 * Filters out preview tabs and transient state
 */
export const serializeTabState = (state: TabSystemState): PersistedTabState => {
  const tabGroups: Record<string, PersistedTabGroup> = {}

  for (const [groupId, group] of Object.entries(state.tabGroups)) {
    // Filter out preview tabs - they shouldn't persist
    const persistedTabs: PersistedTab[] = group.tabs
      .filter((tab) => !tab.isPreview)
      .map((tab) => ({
        id: tab.id,
        type: tab.type,
        title: tab.title,
        icon: tab.icon,
        path: tab.path,
        entityId: tab.entityId,
        isPinned: tab.isPinned,
        scrollPosition: tab.scrollPosition,
        viewState: tab.viewState
      }))

    // Only persist groups that have tabs
    if (persistedTabs.length > 0) {
      tabGroups[groupId] = {
        id: group.id,
        tabs: persistedTabs,
        activeTabId: group.activeTabId
      }
    }
  }

  return {
    version: STORAGE_VERSION,
    tabGroups,
    layout: state.layout,
    activeGroupId: state.activeGroupId,
    settings: state.settings,
    savedAt: Date.now()
  }
}

// =============================================================================
// DESERIALIZE
// =============================================================================

/**
 * Deserialize tab state from storage
 * Applies migrations and validates data
 */
export const deserializeTabState = (persisted: PersistedTabState): Partial<TabSystemState> => {
  // Apply migrations if needed
  const migrated = migratePersistedState(persisted)

  const tabGroups: Record<string, TabGroup> = {}

  const persistedTabGroups = migrated.tabGroups as Record<string, PersistedTabGroup>

  for (const [groupId, group] of Object.entries(persistedTabGroups)) {
    // Convert persisted tabs to full tabs
    const tabs: Tab[] = group.tabs.map((tab: PersistedTab) => ({
      ...tab,
      isModified: false,
      isPreview: false,
      isDeleted: false,
      openedAt: Date.now(),
      lastAccessedAt: Date.now()
    }))

    // Ensure at least one tab per group
    const finalTabs = tabs.length > 0 ? tabs : [createDefaultTab()]

    // Validate activeTabId
    const activeTabId =
      group.activeTabId && finalTabs.some((t) => t.id === group.activeTabId)
        ? group.activeTabId
        : finalTabs[0].id

    tabGroups[groupId] = {
      id: group.id,
      tabs: finalTabs,
      activeTabId,
      isActive: groupId === migrated.activeGroupId
    }
  }

  // Ensure at least one group exists
  if (Object.keys(tabGroups).length === 0) {
    const defaultGroupId = generateId()
    const defaultTab = createDefaultTab()
    tabGroups[defaultGroupId] = {
      id: defaultGroupId,
      tabs: [defaultTab],
      activeTabId: defaultTab.id,
      isActive: true
    }
  }

  return {
    tabGroups,
    layout: migrated.layout,
    activeGroupId: migrated.activeGroupId,
    settings: migrated.settings
  }
}

// =============================================================================
// PINNED TABS
// =============================================================================

/**
 * Extract only pinned tabs from persisted state
 * Used when full restore is disabled
 */
export const extractPinnedTabs = (persisted: PersistedTabState): Tab[] => {
  const pinnedTabs: Tab[] = []

  for (const group of Object.values(persisted.tabGroups)) {
    for (const tab of group.tabs) {
      if (tab.isPinned) {
        pinnedTabs.push({
          ...tab,
          isModified: false,
          isPreview: false,
          isDeleted: false,
          openedAt: Date.now(),
          lastAccessedAt: Date.now()
        })
      }
    }
  }

  return pinnedTabs
}
