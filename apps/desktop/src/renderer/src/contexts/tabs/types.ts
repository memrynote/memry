/**
 * Tab System Type Definitions
 * VS Code-style tab management for PKM application
 */

// =============================================================================
// TAB TYPE ENUM
// =============================================================================

/**
 * Content types that can be opened in tabs
 */
export type TabType =
  | 'inbox'
  | 'tasks' // New unified tasks tab
  | 'all-tasks' // Legacy - kept for backwards compatibility
  | 'today' // Legacy - kept for backwards compatibility
  | 'completed' // Legacy - kept for backwards compatibility
  | 'project' // Legacy - kept for backwards compatibility
  | 'note'
  | 'file' // Non-markdown files (PDF, image, audio, video)
  | 'folder' // Folder view (Bases-like database view)
  | 'journal'
  | 'search'
  | 'collection'
  | 'template-editor' // Template editing (Phase 15)
  | 'templates' // Template list/management (Phase 15)
  | 'graph' // Knowledge graph visualization

/**
 * Singleton tab types - only one instance allowed
 * If user tries to open an existing singleton, focus existing tab
 */
export const SINGLETON_TAB_TYPES: TabType[] = [
  'inbox',
  'journal',
  'tasks', // New unified tasks tab
  'all-tasks', // Legacy
  'today', // Legacy
  'completed', // Legacy
  'templates', // Template list
  'graph'
]

/**
 * Check if a tab type is singleton
 */
export const isSingletonTabType = (type: TabType): boolean => {
  return SINGLETON_TAB_TYPES.includes(type)
}

// =============================================================================
// TAB INTERFACE
// =============================================================================

/**
 * Individual tab interface
 */
export interface Tab {
  /** Unique identifier (uuid) */
  id: string
  /** Content type */
  type: TabType
  /** Display title */
  title: string
  /** Icon name (icon) */
  icon: string
  /** Emoji icon (overrides icon for notes) */
  emoji?: string | null
  /** Route/path for navigation */
  path: string
  /** ID of note/project/journal if applicable */
  entityId?: string

  // State
  /** Pinned tabs stay leftmost */
  isPinned: boolean
  /** Has unsaved changes (for notes) */
  isModified: boolean
  /** Preview mode - single-click, replaced on next open */
  isPreview: boolean
  /** Entity was deleted externally (show strikethrough) */
  isDeleted: boolean

  // Preserved state
  /** Scroll position to restore */
  scrollPosition?: number
  /** View-specific state (filters, expanded sections, etc.) */
  viewState?: Record<string, unknown>

  // Metadata
  /** Timestamp when opened */
  openedAt: number
  /** Timestamp of last focus */
  lastAccessedAt: number
}

// =============================================================================
// TAB GROUP & LAYOUT
// =============================================================================

/**
 * A group of tabs (one tab group per split pane)
 */
export interface TabGroup {
  /** Unique identifier */
  id: string
  /** Tabs in this group */
  tabs: Tab[]
  /** Currently active tab in group */
  activeTabId: string | null
  /** Is this the focused group? */
  isActive: boolean
}

/**
 * Direction of a split between two panes
 */
export type SplitDirection = 'horizontal' | 'vertical'

/**
 * Split layout tree structure (recursive)
 * Represents how tab groups are arranged in split views
 */
export type SplitLayout =
  | { type: 'leaf'; tabGroupId: string }
  | {
      type: 'split'
      direction: SplitDirection
      ratio: number
      first: SplitLayout
      second: SplitLayout
    }

// =============================================================================
// TAB SETTINGS
// =============================================================================

/**
 * User preferences for tab behavior
 */
export interface TabSettings {
  /** Single-click opens preview, double-click opens permanent */
  previewMode: boolean
  /** Restore tabs from last session on app start */
  restoreSessionOnStart: boolean
  /** When to show close button: always, on hover, or only on active tab */
  tabCloseButton: 'always' | 'hover' | 'active'
}

// =============================================================================
// TAB SYSTEM STATE
// =============================================================================

/**
 * Complete tab system state
 */
export interface TabSystemState {
  /** Tab groups (one per split pane) */
  tabGroups: Record<string, TabGroup>
  /** Layout tree defining split arrangement */
  layout: SplitLayout
  /** Currently focused group ID */
  activeGroupId: string
  /** User preferences */
  settings: TabSettings
}

// =============================================================================
// TAB ACTIONS
// =============================================================================

/**
 * Options for opening a tab
 */
export interface OpenTabOptions {
  /** Target group ID (defaults to active group) */
  groupId?: string
  /** Position to insert tab at */
  position?: number
  /** Don't focus the new tab */
  background?: boolean
  /** Open even if singleton exists */
  forceNew?: boolean
  /** Replace the currently active tab instead of creating a new one */
  replaceActive?: boolean
}

/**
 * All actions that can modify tab state
 */
export type TabAction =
  // Tab CRUD
  | {
      type: 'OPEN_TAB'
      payload: {
        tab: Omit<Tab, 'id' | 'openedAt' | 'lastAccessedAt'>
        groupId?: string
        position?: number
        background?: boolean
        /** Replace the currently active tab instead of creating a new one */
        replaceActive?: boolean
      }
    }
  | { type: 'CLOSE_TAB'; payload: { tabId: string; groupId: string } }
  | { type: 'CLOSE_OTHER_TABS'; payload: { tabId: string; groupId: string } }
  | { type: 'CLOSE_TABS_TO_RIGHT'; payload: { tabId: string; groupId: string } }
  | { type: 'CLOSE_ALL_TABS'; payload: { groupId: string } }
  | { type: 'CLOSE_GROUP'; payload: { groupId: string } }

  // Tab navigation
  | { type: 'SET_ACTIVE_TAB'; payload: { tabId: string; groupId: string } }
  | { type: 'SET_ACTIVE_GROUP'; payload: { groupId: string } }
  | { type: 'GO_TO_NEXT_TAB'; payload: { groupId: string } }
  | { type: 'GO_TO_PREVIOUS_TAB'; payload: { groupId: string } }
  | { type: 'GO_TO_TAB_INDEX'; payload: { index: number; groupId: string } }

  // Tab modification
  | { type: 'PIN_TAB'; payload: { tabId: string; groupId: string } }
  | { type: 'UNPIN_TAB'; payload: { tabId: string; groupId: string } }
  | { type: 'SET_TAB_MODIFIED'; payload: { tabId: string; groupId: string; isModified: boolean } }
  | { type: 'SET_TAB_DELETED'; payload: { tabId: string; groupId: string; isDeleted: boolean } }
  | { type: 'UPDATE_TAB_TITLE'; payload: { tabId: string; groupId: string; title: string } }
  | { type: 'PROMOTE_PREVIEW_TAB'; payload: { tabId: string; groupId: string } }

  // Tab reordering
  | {
      type: 'MOVE_TAB'
      payload: { tabId: string; fromGroupId: string; toGroupId: string; toIndex: number }
    }
  | { type: 'REORDER_TABS'; payload: { groupId: string; fromIndex: number; toIndex: number } }

  // Tab state preservation
  | {
      type: 'SAVE_TAB_STATE'
      payload: {
        tabId: string
        groupId: string
        scrollPosition?: number
        viewState?: Record<string, unknown>
      }
    }

  // Split view
  | { type: 'SPLIT_VIEW'; payload: { direction: SplitDirection; groupId: string } }
  | { type: 'RESIZE_SPLIT'; payload: { path: number[]; ratio: number } }
  | { type: 'CLOSE_SPLIT'; payload: { groupId: string } }
  | {
      type: 'MOVE_TAB_TO_NEW_SPLIT'
      payload: {
        tabId: string
        fromGroupId: string
        /** Target group to split (if different from fromGroupId) */
        targetGroupId?: string
        direction: SplitDirection | 'left' | 'right' | 'up' | 'down'
        /** Position of new pane relative to target */
        position?: 'first' | 'second'
      }
    }
  | {
      type: 'SET_LAYOUT'
      payload: {
        tabGroups: Record<string, TabGroup>
        layout: SplitLayout
        activeGroupId: string
      }
    }

  // Settings
  | { type: 'UPDATE_SETTINGS'; payload: Partial<TabSettings> }

  // Session
  | { type: 'RESTORE_SESSION'; payload: TabSystemState }
  | { type: 'RESET_TO_DEFAULT' }

// =============================================================================
// SIDEBAR INTEGRATION
// =============================================================================

/**
 * Sidebar item that can be opened as a tab
 */
export interface SidebarItem {
  /** Unique identifier (optional - will be generated if not provided) */
  id?: string
  /** Content type */
  type: TabType
  /** Display title */
  title: string
  /** Icon name (icon) */
  icon?: string
  /** Emoji icon (overrides icon for notes) */
  emoji?: string | null
  /** Route/path for navigation */
  path: string
  /** Entity ID for notes/projects/journals */
  entityId?: string
  /** Color for projects (hex or name) */
  color?: string
  /** Item count (e.g., task count) */
  count?: number
  /** Nested children items */
  children?: SidebarItem[]
}
