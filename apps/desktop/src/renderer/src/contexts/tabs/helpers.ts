/**
 * Tab System Helper Functions
 * Utility functions for tab management
 */

import type { Tab, TabType, TabGroup, TabSystemState, TabSettings, SidebarItem } from './types'

// =============================================================================
// ID GENERATION
// =============================================================================

/**
 * Generate unique ID for tabs and groups
 */
export const generateId = (): string => {
  return crypto.randomUUID()
}

// =============================================================================
// TAB SEARCH HELPERS
// =============================================================================

/**
 * Result of finding a tab in the system
 */
export interface FoundTab {
  tab: Tab
  groupId: string
}

/**
 * Find existing tab by type (for singletons)
 * Searches all groups for a tab with matching type
 */
export const findExistingTab = (state: TabSystemState, type: TabType): FoundTab | null => {
  for (const [groupId, group] of Object.entries(state.tabGroups)) {
    const tab = group.tabs.find((t) => t.type === type)
    if (tab) {
      return { tab, groupId }
    }
  }
  return null
}

/**
 * Find tab by entity ID (for notes, projects, journals, etc.)
 * Used to prevent duplicate tabs for the same entity
 */
export const findTabByEntityId = (state: TabSystemState, entityId: string): FoundTab | null => {
  for (const [groupId, group] of Object.entries(state.tabGroups)) {
    const tab = group.tabs.find((t) => t.entityId === entityId)
    if (tab) {
      return { tab, groupId }
    }
  }
  return null
}

/**
 * Find tab by ID across all groups
 */
export const findTabById = (state: TabSystemState, tabId: string): FoundTab | null => {
  for (const [groupId, group] of Object.entries(state.tabGroups)) {
    const tab = group.tabs.find((t) => t.id === tabId)
    if (tab) {
      return { tab, groupId }
    }
  }
  return null
}

/**
 * Find preview tab in a group
 */
export const findPreviewTab = (group: TabGroup): Tab | null => {
  return group.tabs.find((t) => t.isPreview) || null
}

// =============================================================================
// TAB ICON MAPPING
// =============================================================================

/**
 * Icon mapping for tab types
 */
const TAB_ICONS: Record<TabType, string> = {
  inbox: 'inbox',
  tasks: 'list-checks',
  'all-tasks': 'list-checks',
  today: 'star',
  completed: 'check-circle',
  project: 'folder',
  note: 'file-text',
  file: 'file',
  folder: 'folder',
  journal: 'book-open',
  search: 'search',
  collection: 'bookmark',
  'template-editor': 'layout-template',
  templates: 'layout-template',
  graph: 'git-graph'
}

/**
 * Get icon name for a tab type
 */
export const getTabIcon = (type: TabType): string => {
  return TAB_ICONS[type] || 'file'
}

// =============================================================================
// TAB PATH MAPPING
// =============================================================================

/**
 * Path mapping for singleton tab types
 */
const TAB_PATHS: Partial<Record<TabType, string>> = {
  inbox: '/inbox',
  'all-tasks': '/tasks/all',
  today: '/tasks/today',
  completed: '/tasks/completed'
}

/**
 * Get default path for a tab type
 */
export const getDefaultPath = (type: TabType, entityId?: string): string => {
  if (TAB_PATHS[type]) {
    return TAB_PATHS[type]
  }

  // Dynamic paths for entity-based tabs
  switch (type) {
    case 'project':
      return `/project/${entityId}`
    case 'note':
      return `/note/${entityId}`
    case 'journal':
      return `/journal/${entityId}`
    case 'search':
      return `/search/${entityId}`
    case 'collection':
      return `/collection/${entityId}`
    default:
      return '/'
  }
}

// =============================================================================
// TAB CREATION HELPERS
// =============================================================================

/**
 * Create a default Inbox tab
 */
export const createDefaultTab = (): Tab => ({
  id: generateId(),
  type: 'inbox',
  title: 'Inbox',
  icon: 'inbox',
  path: '/inbox',
  isPinned: false,
  isModified: false,
  isPreview: false,
  isDeleted: false,
  openedAt: Date.now(),
  lastAccessedAt: Date.now()
})

/**
 * Create a tab from sidebar item
 */
export const createTabFromSidebarItem = (
  item: SidebarItem,
  isPreview: boolean = false
): Omit<Tab, 'id' | 'openedAt' | 'lastAccessedAt'> => {
  return {
    type: item.type,
    title: item.title,
    icon: item.icon || getTabIcon(item.type),
    emoji: item.emoji,
    path: item.path,
    entityId: item.entityId,
    isPinned: false,
    isModified: false,
    isPreview,
    isDeleted: false
  }
}

/**
 * Create a new tab with generated ID and timestamps
 */
export const createTab = (tabData: Omit<Tab, 'id' | 'openedAt' | 'lastAccessedAt'>): Tab => {
  return {
    ...tabData,
    id: generateId(),
    openedAt: Date.now(),
    lastAccessedAt: Date.now()
  }
}

// =============================================================================
// TAB GROUP HELPERS
// =============================================================================

/**
 * Create initial tab group with Inbox tab
 */
export const createInitialTabGroup = (): TabGroup => {
  const initialTab = createDefaultTab()
  return {
    id: generateId(),
    tabs: [initialTab],
    activeTabId: initialTab.id,
    isActive: true
  }
}

/**
 * Create an empty tab group (for split view)
 */
export const createEmptyTabGroup = (withDefaultTab: boolean = true): TabGroup => {
  const group: TabGroup = {
    id: generateId(),
    tabs: [],
    activeTabId: null,
    isActive: false
  }

  if (withDefaultTab) {
    const defaultTab = createDefaultTab()
    group.tabs.push(defaultTab)
    group.activeTabId = defaultTab.id
  }

  return group
}

// =============================================================================
// TAB SORTING HELPERS
// =============================================================================

/**
 * Sort tabs with pinned tabs first
 */
export const sortTabsWithPinnedFirst = (tabs: Tab[]): Tab[] => {
  const pinned = tabs.filter((t) => t.isPinned)
  const unpinned = tabs.filter((t) => !t.isPinned)
  return [...pinned, ...unpinned]
}

/**
 * Get the index where a new unpinned tab should be inserted
 * (after all pinned tabs)
 */
export const getInsertIndexAfterPinned = (tabs: Tab[]): number => {
  const lastPinnedIndex = tabs.findLastIndex((t) => t.isPinned)
  return lastPinnedIndex + 1
}

// =============================================================================
// INITIAL STATE
// =============================================================================

/**
 * Default tab settings
 */
export const DEFAULT_TAB_SETTINGS: TabSettings = {
  previewMode: false,
  restoreSessionOnStart: true,
  tabCloseButton: 'hover'
}

/**
 * Create the initial tab system state
 */
export const createInitialState = (): TabSystemState => {
  const initialGroup = createInitialTabGroup()

  return {
    tabGroups: {
      [initialGroup.id]: initialGroup
    },
    layout: {
      type: 'leaf',
      tabGroupId: initialGroup.id
    },
    activeGroupId: initialGroup.id,
    settings: { ...DEFAULT_TAB_SETTINGS }
  }
}
