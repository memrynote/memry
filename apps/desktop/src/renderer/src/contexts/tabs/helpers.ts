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
 * Is this group the last one standing, holding nothing but the default Home tab?
 *
 * This is ⌘W's floor: every other tab closes normally (a lone non-Home tab closes
 * too — the reducer puts a fresh Home in its place), and only once Home is all
 * that's left does ⌘W close the window instead of the tab.
 */
export const isLastHomeTab = (state: TabSystemState, groupId: string): boolean => {
  if (Object.keys(state.tabGroups).length !== 1) return false
  const group = state.tabGroups[groupId]
  if (!group || group.tabs.length !== 1) return false
  return group.tabs[0].type === 'home'
}

// =============================================================================
// NAVIGATION HISTORY
// =============================================================================

/**
 * A single entry in a Chrome-style back/forward history menu.
 */
export interface HistoryEntry {
  tab: Tab
  /** Number of navBack/navForward calls needed to land on this entry. */
  steps: number
}

/**
 * Build the Chrome-style back/forward history list for a group: still-open tabs
 * only, nearest-first, each annotated with how many nav steps reach it.
 *
 * `steps = entries.length + 1` is correct even with stale ids because NAV_BACK /
 * NAV_FORWARD discard any closed-tab ids they pass and land on the next still-open
 * tab — so the k-th valid entry (0-indexed) is reached by exactly k+1 calls.
 */
export const buildHistoryEntries = (
  state: TabSystemState,
  groupId: string,
  direction: 'back' | 'forward',
  limit = 10
): HistoryEntry[] => {
  const group = state.tabGroups[groupId]
  if (!group) return []
  const stack = direction === 'back' ? group.back : group.forward
  const entries: HistoryEntry[] = []
  // End of both stacks is the nearest neighbour (NAV_BACK/NAV_FORWARD pop from the end).
  for (let i = stack.length - 1; i >= 0 && entries.length < limit; i--) {
    const found = findTabById(state, stack[i])
    if (!found) continue // skip closed tabs, exactly like the reducer does
    entries.push({ tab: found.tab, steps: entries.length + 1 })
  }
  return entries
}

// =============================================================================
// TAB ICON MAPPING
// =============================================================================

/**
 * Icon mapping for tab types
 */
const TAB_ICONS: Record<TabType, string> = {
  home: 'home',
  inbox: 'inbox',
  calendar: 'calendar',
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
  graph: 'graph',
  tags: 'tag',
  tag: 'tag',
  'agent-chat': 'bot',
  canvas: 'pen-tool',
  'virtual-note': 'file-text'
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
  home: '/home',
  inbox: '/inbox',
  calendar: '/calendar',
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
    case 'agent-chat':
      return `/agent-chat/${entityId}`
    case 'canvas':
      return `/canvas/${entityId}`
    default:
      return '/'
  }
}

// =============================================================================
// TAB CREATION HELPERS
// =============================================================================

/**
 * Create a default Home tab
 */
export const createDefaultTab = (): Tab => ({
  id: generateId(),
  type: 'home',
  title: 'Home',
  icon: 'home',
  path: '/home',
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
/**
 * "New/create" intent delivered as tab viewState when opening Calendar / Inbox /
 * Tasks from a create entry point (the New menu, the new-tab +). Calendar shows
 * its new-event popover; Inbox focuses the capture field; Tasks opens the default
 * project's All list with the quick-add focused. A fresh timestamp re-fires the
 * intent on every click, even when the singleton tab already exists.
 */
export const newItemViewState = (type: 'calendar' | 'inbox' | 'tasks'): Record<string, unknown> => {
  const at = Date.now()
  if (type === 'calendar') return { createEventAt: at }
  if (type === 'inbox') return { focusCaptureAt: at }
  return { activeInternalTab: 'all', focusQuickAddAt: at }
}

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
    viewState: item.viewState,
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
    isActive: true,
    back: [],
    forward: []
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
    isActive: false,
    back: [],
    forward: []
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
    settings: { ...DEFAULT_TAB_SETTINGS },
    recentlyClosed: []
  }
}
