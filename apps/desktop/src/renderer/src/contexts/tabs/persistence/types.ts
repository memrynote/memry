/**
 * Tab Persistence Types
 * Serializable types for tab state storage
 */

import type { TabType, TabSettings, SplitLayout } from '@/contexts/tabs/types'

// =============================================================================
// STORAGE SCHEMA VERSION
// =============================================================================

/** Current schema version for migrations */
export const STORAGE_VERSION = 2

/** Storage key for tab state */
export const STORAGE_KEY = 'memry_tab_state'

// =============================================================================
// PERSISTED TYPES
// =============================================================================

/**
 * Serializable tab state for storage
 */
export interface PersistedTabState {
  /** Schema version for migrations */
  version: number
  /** Persisted tab groups */
  tabGroups: Record<string, PersistedTabGroup>
  /** Split layout configuration */
  layout: SplitLayout
  /** Active group ID */
  activeGroupId: string
  /** User settings */
  settings: TabSettings
  /** Timestamp when saved */
  savedAt: number
}

/**
 * Serializable tab group
 */
export interface PersistedTabGroup {
  /** Group ID */
  id: string
  /** Tabs in group */
  tabs: PersistedTab[]
  /** Active tab ID */
  activeTabId: string | null
}

/**
 * Serializable tab
 */
export interface PersistedTab {
  /** Tab ID */
  id: string
  /** Content type */
  type: TabType
  /** Display title */
  title: string
  /** Icon name */
  icon: string
  /** Emoji icon (overrides icon for notes) */
  emoji?: string | null
  /** Route path */
  path: string
  /** Entity ID (for notes, projects, etc.) */
  entityId?: string
  /** Whether pinned */
  isPinned: boolean
  /** Scroll position */
  scrollPosition?: number
  /** View-specific state */
  viewState?: Record<string, unknown>
}

// =============================================================================
// STORAGE INTERFACE
// =============================================================================

/**
 * Storage adapter interface
 */
export interface TabStorage {
  /** Save state to storage */
  save: (state: PersistedTabState) => Promise<void>
  /** Load state from storage */
  load: () => Promise<PersistedTabState | null>
  /** Clear stored state */
  clear: () => Promise<void>
}
