/**
 * Tab State Serialization
 * Functions to serialize/deserialize tab state for storage
 */

import type { Tab, TabGroup, TabSystemState, SplitLayout } from '@/contexts/tabs/types'
import { createDefaultTab, generateId } from '@/contexts/tabs/helpers'
import { getGroupIdsFromLayout } from '@/components/split-view/layout-helpers'
import type { PersistedTabState, PersistedTabGroup, PersistedTab } from './types'
import { STORAGE_VERSION } from './types'
import { migratePersistedState } from './migrations'
import { featureForTabType } from '@memry/contracts/feature-flags'
import type { FeaturesSettings } from '@memry/contracts/settings-schemas'

// =============================================================================
// FEATURE FILTER
// =============================================================================

/**
 * Returns true when a tab of the given type should be restored given the
 * current feature flags.  `home` is always kept (it is the neutral launcher).
 * Non-feature tabs (note, settings, …) are always kept.
 */
export function isRestorableTabType(type: string, flags: FeaturesSettings): boolean {
  const feature = featureForTabType(type)
  if (feature === null || feature === 'home') return true
  return flags[feature]
}

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
    // Filter out preview tabs (transient) and virtual notes (ephemeral, in-memory
    // only — e.g. release notes) so neither survives a restart.
    const persistedTabs: PersistedTab[] = group.tabs
      .filter((tab) => !tab.isPreview && tab.type !== 'virtual-note')
      .map((tab) => ({
        id: tab.id,
        type: tab.type,
        title: tab.title,
        icon: tab.icon,
        emoji: tab.emoji,
        path: tab.path,
        entityId: tab.entityId,
        isPinned: tab.isPinned,
        scrollPosition: tab.scrollPosition,
        scrollState: tab.scrollState,
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
export const deserializeTabState = (
  persisted: PersistedTabState,
  flags?: FeaturesSettings
): Partial<TabSystemState> => {
  // Apply migrations if needed
  const migrated = migratePersistedState(persisted)

  const tabGroups: Record<string, TabGroup> = {}

  const persistedTabGroups = migrated.tabGroups

  for (const [groupId, group] of Object.entries(persistedTabGroups)) {
    // Filter out tabs whose feature is disabled before hydrating
    const source = flags
      ? group.tabs.filter((tab: PersistedTab) => isRestorableTabType(tab.type, flags))
      : group.tabs
    // Convert persisted tabs to full tabs
    const tabs: Tab[] = source.map((tab: PersistedTab) => ({
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
      isActive: groupId === migrated.activeGroupId,
      back: [],
      forward: []
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
      isActive: true,
      back: [],
      forward: []
    }
  }

  const layoutGroupIds = getGroupIdsFromLayout(migrated.layout)
  const allGroupIdsExist = layoutGroupIds.every((id) => tabGroups[id])

  const validLayout: SplitLayout = allGroupIdsExist
    ? migrated.layout
    : { type: 'leaf' as const, tabGroupId: Object.keys(tabGroups)[0] }

  const validActiveGroupId = tabGroups[migrated.activeGroupId]
    ? migrated.activeGroupId
    : Object.keys(tabGroups)[0]

  return {
    tabGroups,
    layout: validLayout,
    activeGroupId: validActiveGroupId,
    settings: migrated.settings,
    recentlyClosed: []
  }
}

// =============================================================================
// PINNED TABS
// =============================================================================

/**
 * Extract only pinned tabs from persisted state
 * Used when full restore is disabled
 */
export const extractPinnedTabs = (
  persisted: PersistedTabState,
  flags?: FeaturesSettings
): Tab[] => {
  const pinnedTabs: Tab[] = []

  for (const group of Object.values(persisted.tabGroups)) {
    for (const tab of group.tabs) {
      if (tab.isPinned && (flags ? isRestorableTabType(tab.type, flags) : true)) {
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
