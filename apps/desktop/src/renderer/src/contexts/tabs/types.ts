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
  | 'home'
  | 'inbox'
  | 'calendar'
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
  | 'graph' // Knowledge graph visualization
  | 'tags' // Tag hub (categories + tag chips)
  | 'tag' // Single tag page (table of tagged items)
  | 'agent-chat' // Agent conversation
  | 'canvas' // Spatial canvas (Excalidraw) — entity-based, one tab per canvas
  | 'virtual-note' // Ephemeral, read-only in-memory note (e.g. release notes) — never persisted or synced

/**
 * Singleton tab types - only one instance allowed
 * If user tries to open an existing singleton, focus existing tab
 */
export const SINGLETON_TAB_TYPES: TabType[] = [
  'home',
  'inbox',
  'calendar',
  'journal',
  'tasks', // New unified tasks tab
  'all-tasks', // Legacy
  'today', // Legacy
  'completed', // Legacy
  'graph',
  'tags'
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
 * One pane's saved scroll offset, stamped with the entity it was measured
 * against.
 *
 * The stamp is what makes the record safe to restore: a tab keeps its identity
 * when it navigates to another note, so an offset saved against the previous
 * entity must be discarded rather than applied to the new content.
 */
export interface TabScrollEntry {
  /** Saved scroll offset in pixels. `0` is a valid, restorable value. */
  offset: number
  /** `Tab.entityId` at the moment the offset was recorded. */
  entityId?: string
}

/**
 * Every pane's offset, keyed by the scroller it was measured against.
 *
 * Pages own several scrollers (Inbox's three sub-views, the project hub's tabs,
 * folder view's per-render-mode scrollers) and each keeps its own entry, so
 * Overview → Notes → Overview returns to where the user left Overview. A pane
 * only ever reads and writes its own key; a single-scroller page uses the
 * unkeyed slot. Bounded — see `MAX_SCROLL_PANES`.
 */
export type TabScrollPanes = Record<string, TabScrollEntry>

/**
 * LEGACY single-record shape, written by builds up to and including the one
 * that shipped `Tab.scrollState` (PR #1549). Sessions carrying it are still in
 * the wild, so it is still read: it is the entry for its own `key`, and an
 * unkeyed record belongs to the unkeyed pane. Never written any more.
 */
export interface TabScrollState {
  /** Saved scroll offset in pixels. `0` is a valid, restorable value. */
  offset: number
  /** `Tab.entityId` at the moment the offset was recorded. */
  entityId?: string
  /** Which scroller the offset was measured against. Absent = the unkeyed one. */
  key?: string
}

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
  /** Scroll position to restore (legacy, unstamped) */
  scrollPosition?: number
  /** Scroll offset to restore (legacy single-record shape, read-only now) */
  scrollState?: TabScrollState
  /** Per-pane scroll offsets to restore, each stamped with its entity */
  scrollPanes?: TabScrollPanes
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
  /** Tab activation history: ids previously active in this group, oldest → newest. In-memory only. */
  back: string[]
  /** Forward stack: tab ids re-activatable after a NAV_BACK. */
  forward: string[]
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
  /** Restore tabs from last session on app start */
  restoreSessionOnStart: boolean
  /** When to show close button: always, on hover, or only on active tab */
  tabCloseButton: 'always' | 'hover' | 'active'
}

// =============================================================================
// RECENTLY CLOSED TABS
// =============================================================================

/**
 * Snapshot of a closed tab, used to reopen it (Cmd+Shift+T).
 * In-memory only — not persisted across restarts.
 */
export interface ClosedTabEntry {
  /** Serializable snapshot of the closed tab */
  tab: Omit<Tab, 'id' | 'openedAt' | 'lastAccessedAt'>
  /** Group the tab was closed from */
  groupId: string
  /** Original position within that group's tabs */
  index: number
  /** Timestamp when closed */
  closedAt: number
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
  /** Whether the active group is currently maximized (siblings hidden) */
  isMaximized?: boolean
  /** Snapshot of layout before maximize, used to restore on toggle-off */
  preMaximizeLayout?: SplitLayout
  /** LIFO stack of recently closed tabs (in-memory, for reopen). */
  recentlyClosed: ClosedTabEntry[]
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
        /** Skip every dedup/focus branch and always mint a new tab */
        forceNew?: boolean
        /** Replace the currently active tab instead of creating a new one */
        replaceActive?: boolean
      }
    }
  | { type: 'CLOSE_TAB'; payload: { tabId: string; groupId: string } }
  /** Every tab showing an entity that no longer exists — see the reducer case. */
  | { type: 'CLOSE_TABS_BY_ENTITY'; payload: { entityId: string } }
  | { type: 'CLOSE_OTHER_TABS'; payload: { tabId: string; groupId: string } }
  | { type: 'CLOSE_TABS_TO_RIGHT'; payload: { tabId: string; groupId: string } }
  | { type: 'CLOSE_ALL_TABS'; payload: { groupId: string } }
  | { type: 'CLOSE_GROUP'; payload: { groupId: string } }
  | { type: 'REOPEN_CLOSED_TAB' }

  // Tab navigation
  | { type: 'SET_ACTIVE_TAB'; payload: { tabId: string; groupId: string } }
  | { type: 'SET_ACTIVE_GROUP'; payload: { groupId: string } }
  | { type: 'GO_TO_NEXT_TAB'; payload: { groupId: string } }
  | { type: 'GO_TO_PREVIOUS_TAB'; payload: { groupId: string } }
  | { type: 'GO_TO_TAB_INDEX'; payload: { index: number; groupId: string } }
  | { type: 'NAV_BACK'; payload: { groupId: string } }
  | { type: 'NAV_FORWARD'; payload: { groupId: string } }

  // Tab modification
  | { type: 'PIN_TAB'; payload: { tabId: string; groupId: string } }
  | { type: 'UNPIN_TAB'; payload: { tabId: string; groupId: string } }
  | { type: 'SET_TAB_MODIFIED'; payload: { tabId: string; groupId: string; isModified: boolean } }
  | { type: 'SET_TAB_DELETED'; payload: { tabId: string; groupId: string; isDeleted: boolean } }
  | { type: 'UPDATE_TAB_TITLE'; payload: { tabId: string; groupId: string; title: string } }
  | {
      type: 'SET_TAB_ENTITY'
      payload: { tabId: string; groupId: string; entityId: string; path: string }
    }

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
        scrollState?: TabScrollState
        /** Patch: merged over the tab's existing panes, never replaces them. */
        scrollPanes?: TabScrollPanes
        viewState?: Record<string, unknown>
      }
    }

  // Split view
  | {
      type: 'SPLIT_VIEW'
      /**
       * `newGroupId` lets the caller name the pane before it exists, so it can
       * target it in the same dispatch batch. Omitted, the reducer mints one.
       *
       * `cloneActiveTab` defaults to true: a split from the keyboard or the tab
       * menu wants the pane to arrive holding what you were already looking at.
       * A caller that opens something specific into the new pane passes false,
       * otherwise the pane arrives with a clone it never asked for and the tab
       * it did ask for lands beside it.
       */
      payload: {
        direction: SplitDirection
        groupId: string
        newGroupId?: string
        cloneActiveTab?: boolean
      }
    }
  | { type: 'RESIZE_SPLIT'; payload: { path: number[]; ratio: number } }
  | { type: 'CLOSE_SPLIT'; payload: { groupId: string } }
  | { type: 'TOGGLE_MAXIMIZE_GROUP'; payload: { groupId: string } }
  | { type: 'RESET_SPLIT_RATIOS' }
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
  /** Per-view intent delivered on open (e.g. focus input, show popover) */
  viewState?: Record<string, unknown>
}
