/**
 * Tab System Helper Functions
 * Utility functions for tab management
 */

import type {
  Tab,
  TabType,
  TabGroup,
  TabSystemState,
  SplitLayout,
  TabSettings,
  SidebarItem,
} from './types';

// =============================================================================
// ID GENERATION
// =============================================================================

/**
 * Generate unique ID for tabs and groups
 */
export const generateId = (): string => {
  return crypto.randomUUID();
};

// =============================================================================
// TAB SEARCH HELPERS
// =============================================================================

/**
 * Result of finding a tab in the system
 */
export interface FoundTab {
  tab: Tab;
  groupId: string;
}

/**
 * Find existing tab by type (for singletons)
 * Searches all groups for a tab with matching type
 */
export const findExistingTab = (
  state: TabSystemState,
  type: TabType
): FoundTab | null => {
  for (const [groupId, group] of Object.entries(state.tabGroups)) {
    const tab = group.tabs.find((t) => t.type === type);
    if (tab) {
      return { tab, groupId };
    }
  }
  return null;
};

/**
 * Find tab by entity ID (for notes, projects, journals, etc.)
 * Used to prevent duplicate tabs for the same entity
 */
export const findTabByEntityId = (
  state: TabSystemState,
  entityId: string
): FoundTab | null => {
  for (const [groupId, group] of Object.entries(state.tabGroups)) {
    const tab = group.tabs.find((t) => t.entityId === entityId);
    if (tab) {
      return { tab, groupId };
    }
  }
  return null;
};

/**
 * Find tab by ID across all groups
 */
export const findTabById = (
  state: TabSystemState,
  tabId: string
): FoundTab | null => {
  for (const [groupId, group] of Object.entries(state.tabGroups)) {
    const tab = group.tabs.find((t) => t.id === tabId);
    if (tab) {
      return { tab, groupId };
    }
  }
  return null;
};

/**
 * Find preview tab in a group
 */
export const findPreviewTab = (group: TabGroup): Tab | null => {
  return group.tabs.find((t) => t.isPreview) || null;
};

// =============================================================================
// TAB ICON MAPPING
// =============================================================================

/**
 * Icon mapping for tab types
 */
const TAB_ICONS: Record<TabType, string> = {
  inbox: 'inbox',
  inbox2: 'inbox',
  home: 'home',
  tasks: 'list-checks',      // New unified tasks tab
  'all-tasks': 'list-checks',
  today: 'star',
  upcoming: 'calendar',
  completed: 'check-circle',
  project: 'folder',
  note: 'file-text',
  journal: 'book-open',
  search: 'search',
  settings: 'settings',
  collection: 'bookmark',
};

/**
 * Get icon name for a tab type
 */
export const getTabIcon = (type: TabType): string => {
  return TAB_ICONS[type] || 'file';
};

// =============================================================================
// TAB PATH MAPPING
// =============================================================================

/**
 * Path mapping for singleton tab types
 */
const TAB_PATHS: Partial<Record<TabType, string>> = {
  inbox: '/inbox',
  inbox2: '/inbox2',
  home: '/home',
  'all-tasks': '/tasks/all',
  today: '/tasks/today',
  upcoming: '/tasks/upcoming',
  completed: '/tasks/completed',
  settings: '/settings',
};

/**
 * Get default path for a tab type
 */
export const getDefaultPath = (type: TabType, entityId?: string): string => {
  if (TAB_PATHS[type]) {
    return TAB_PATHS[type]!;
  }

  // Dynamic paths for entity-based tabs
  switch (type) {
    case 'project':
      return `/project/${entityId}`;
    case 'note':
      return `/note/${entityId}`;
    case 'journal':
      return `/journal/${entityId}`;
    case 'search':
      return `/search/${entityId}`;
    case 'collection':
      return `/collection/${entityId}`;
    default:
      return '/';
  }
};

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
  openedAt: Date.now(),
  lastAccessedAt: Date.now(),
});

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
    path: item.path,
    entityId: item.entityId,
    isPinned: false,
    isModified: false,
    isPreview,
  };
};

/**
 * Create a new tab with generated ID and timestamps
 */
export const createTab = (
  tabData: Omit<Tab, 'id' | 'openedAt' | 'lastAccessedAt'>
): Tab => {
  return {
    ...tabData,
    id: generateId(),
    openedAt: Date.now(),
    lastAccessedAt: Date.now(),
  };
};

// =============================================================================
// TAB GROUP HELPERS
// =============================================================================

/**
 * Create initial tab group with Inbox tab
 */
export const createInitialTabGroup = (): TabGroup => {
  const initialTab = createDefaultTab();
  return {
    id: generateId(),
    tabs: [initialTab],
    activeTabId: initialTab.id,
    isActive: true,
  };
};

/**
 * Create an empty tab group (for split view)
 */
export const createEmptyTabGroup = (withDefaultTab: boolean = true): TabGroup => {
  const group: TabGroup = {
    id: generateId(),
    tabs: [],
    activeTabId: null,
    isActive: false,
  };

  if (withDefaultTab) {
    const defaultTab = createDefaultTab();
    group.tabs.push(defaultTab);
    group.activeTabId = defaultTab.id;
  }

  return group;
};

// =============================================================================
// LAYOUT HELPERS
// =============================================================================

/**
 * Insert a new split at a specific group in the layout tree
 */
export const insertSplitAtGroup = (
  layout: SplitLayout,
  targetGroupId: string,
  newGroupId: string,
  direction: 'horizontal'
): SplitLayout => {
  if (layout.type === 'leaf') {
    if (layout.tabGroupId === targetGroupId) {
      // Found the target - create split
      return {
        type: direction,
        ratio: 0.5,
        first: { type: 'leaf', tabGroupId: targetGroupId },
        second: { type: 'leaf', tabGroupId: newGroupId },
      };
    }
    return layout;
  }

  // Recursively search in nested layouts
  return {
    ...layout,
    first: insertSplitAtGroup(layout.first, targetGroupId, newGroupId, direction),
    second: insertSplitAtGroup(layout.second, targetGroupId, newGroupId, direction),
  };
};

/**
 * Remove group from layout tree
 * Returns null if the group was the only one (root leaf)
 */
export const removeGroupFromLayout = (
  layout: SplitLayout,
  groupId: string
): SplitLayout | null => {
  if (layout.type === 'leaf') {
    return layout.tabGroupId === groupId ? null : layout;
  }

  const first = removeGroupFromLayout(layout.first, groupId);
  const second = removeGroupFromLayout(layout.second, groupId);

  // If one side was removed, return the other
  if (!first) return second;
  if (!second) return first;

  // Both sides exist, return updated layout
  return { ...layout, first, second };
};

/**
 * Find all group IDs in a layout
 */
export const getAllGroupIds = (layout: SplitLayout): string[] => {
  if (layout.type === 'leaf') {
    return [layout.tabGroupId];
  }
  return [...getAllGroupIds(layout.first), ...getAllGroupIds(layout.second)];
};

/**
 * Calculate the width percentage each tab group should occupy in the header
 * This accounts for:
 * - Horizontal splits: ratio determines width distribution
 * - Vertical splits: children share parent's width equally
 * - Nested splits: widths are calculated multiplicatively
 *
 * @param layout - The split layout tree
 * @returns Map of groupId to width percentage (0-100)
 */
export const getGroupWidthPercentages = (
  layout: SplitLayout
): Map<string, number> => {
  const result = new Map<string, number>();

  const traverse = (node: SplitLayout, availableWidth: number): void => {
    if (node.type === 'leaf') {
      // Leaf node: this group gets the full available width
      result.set(node.tabGroupId, availableWidth);
      return;
    }

    // Horizontal split: divide width by ratio
    const firstWidth = availableWidth * node.ratio;
    const secondWidth = availableWidth * (1 - node.ratio);
    traverse(node.first, firstWidth);
    traverse(node.second, secondWidth);
  };

  traverse(layout, 100);
  return result;
};

/**
 * Get ordered group IDs with their widths for header rendering
 * Groups are ordered left-to-right as they appear in the layout
 * Vertical splits are flattened (both get same width)
 *
 * @param layout - The split layout tree
 * @returns Array of { groupId, width } objects in display order
 */
export const getOrderedGroupWidths = (
  layout: SplitLayout
): Array<{ groupId: string; width: number }> => {
  const result: Array<{ groupId: string; width: number }> = [];

  const traverse = (node: SplitLayout, availableWidth: number): void => {
    if (node.type === 'leaf') {
      result.push({ groupId: node.tabGroupId, width: availableWidth });
      return;
    }

    // Horizontal split: first on left, second on right
    const firstWidth = availableWidth * node.ratio;
    const secondWidth = availableWidth * (1 - node.ratio);
    traverse(node.first, firstWidth);
    traverse(node.second, secondWidth);
  };

  traverse(layout, 100);
  return result;
};

/**
 * Update split ratio at a specific path in the layout tree
 * Path is an array of indices (0 = first, 1 = second) for each level
 */
export const updateSplitRatio = (
  layout: SplitLayout,
  path: number[],
  ratio: number
): SplitLayout => {
  if (path.length === 0 || layout.type === 'leaf') {
    return layout;
  }

  const [currentIndex, ...remainingPath] = path;

  if (layout.type === 'horizontal') {
    // If we're at the target level (remainingPath is empty), update ratio
    if (remainingPath.length === 0) {
      return { ...layout, ratio };
    }

    // Otherwise, continue recursing
    if (currentIndex === 0) {
      return {
        ...layout,
        first: updateSplitRatio(layout.first, remainingPath, ratio),
      };
    } else {
      return {
        ...layout,
        second: updateSplitRatio(layout.second, remainingPath, ratio),
      };
    }
  }

  return layout;
};

// =============================================================================
// TAB SORTING HELPERS
// =============================================================================

/**
 * Sort tabs with pinned tabs first
 */
export const sortTabsWithPinnedFirst = (tabs: Tab[]): Tab[] => {
  const pinned = tabs.filter((t) => t.isPinned);
  const unpinned = tabs.filter((t) => !t.isPinned);
  return [...pinned, ...unpinned];
};

/**
 * Get the index where a new unpinned tab should be inserted
 * (after all pinned tabs)
 */
export const getInsertIndexAfterPinned = (tabs: Tab[]): number => {
  const lastPinnedIndex = tabs.findLastIndex((t) => t.isPinned);
  return lastPinnedIndex + 1;
};

// =============================================================================
// INITIAL STATE
// =============================================================================

/**
 * Default tab settings
 */
export const DEFAULT_TAB_SETTINGS: TabSettings = {
  openInNewTab: 'modifier',
  previewMode: true,
  showPinnedTabsFirst: true,
  maxRecentlyClosed: 10,
  restoreSessionOnStart: true,
  tabCloseButton: 'hover',
};

/**
 * Create the initial tab system state
 */
export const createInitialState = (): TabSystemState => {
  const initialGroup = createInitialTabGroup();

  return {
    tabGroups: {
      [initialGroup.id]: initialGroup,
    },
    layout: {
      type: 'leaf',
      tabGroupId: initialGroup.id,
    },
    activeGroupId: initialGroup.id,
    recentlyClosed: [],
    settings: { ...DEFAULT_TAB_SETTINGS },
  };
};
