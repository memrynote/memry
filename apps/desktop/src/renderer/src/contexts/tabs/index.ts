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
  SplitDirection,
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
  getTabIcon,
  getDefaultPath,
  createDefaultTab,
  createTabFromSidebarItem,
  createTab,
  createInitialTabGroup,
  createEmptyTabGroup,
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

export type { TabCloseGuard } from './close-guard'

// Persistence
export * from './persistence'
