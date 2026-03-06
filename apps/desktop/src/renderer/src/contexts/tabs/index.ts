/**
 * Tab System - Barrel Export
 * Central export point for all tab-related functionality
 */

// Types
export type {
  TabType,
  Tab,
  TabGroup,
  TabSystemState,
  TabAction,
  TabSettings,
  SplitLayout,
  OpenTabOptions,
  SidebarItem
} from './types'

export { SINGLETON_TAB_TYPES, isSingletonTabType } from './types'

// Helpers
export {
  generateId,
  findExistingTab,
  findTabByEntityId,
  findTabById,
  findPreviewTab,
  getTabIcon,
  getDefaultPath,
  createDefaultTab,
  createTabFromSidebarItem,
  createTab,
  createInitialTabGroup,
  createEmptyTabGroup,
  insertSplitAtGroup,
  removeGroupFromLayout,
  getAllGroupIds,
  getGroupWidthPercentages,
  getOrderedGroupWidths,
  updateSplitRatio,
  sortTabsWithPinnedFirst,
  getInsertIndexAfterPinned,
  DEFAULT_TAB_SETTINGS,
  createInitialState
} from './helpers'

export type { FoundTab } from './helpers'

// Reducer
export { tabReducer } from './reducer'

// Context and Hooks
export {
  TabProvider,
  useTabs,
  useTabGroup,
  useActiveTab,
  useActiveGroup,
  useActiveGroupTabs,
  useTabSettings,
  useIsTabActive,
  useTabLayout,
  useTabCounts,
  useTabActions
} from './context'

// Persistence
export * from './persistence'
