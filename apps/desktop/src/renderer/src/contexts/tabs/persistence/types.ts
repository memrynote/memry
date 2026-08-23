/**
 * Tab Persistence Types
 * Serializable types for tab state storage
 */

import type {
  TabType,
  TabSettings,
  SplitLayout,
  TabScrollState,
  TabScrollPanes
} from '@/contexts/tabs/types'

// =============================================================================
// STORAGE SCHEMA VERSION
// =============================================================================

/** Current schema version for migrations */
export const STORAGE_VERSION = 2

/**
 * Storage key for tab state written before tabs were scoped per vault.
 *
 * Still read: an install upgrading from a build that kept one global entry has
 * its tabs here, and the first vault to look for its own key adopts them (see
 * `createLocalStorageAdapter`). Nothing writes it any more.
 */
export const STORAGE_KEY = 'memry_tab_state'

/**
 * Storage key holding one vault's tabs.
 *
 * Tabs are per-vault the way the rest of the app's vault state is: a note tab
 * in one vault means nothing in another, so each vault gets its own entry and
 * switching between them is a read, never a write to the vault being left.
 *
 * The vault path is the identity the renderer already switches on (`App` keys
 * its whole tree by it), so it is the identity used here too. A vault with no
 * path — no vault open — falls back to the legacy key, which is inert: the
 * persistence manager only mounts inside the vault-open branch.
 */
export const tabStateStorageKey = (vaultPath: string | null | undefined): string =>
  vaultPath ? `${STORAGE_KEY}:${vaultPath}` : STORAGE_KEY

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
  /** Scroll position (legacy, unstamped) */
  scrollPosition?: number
  /** Scroll offset, legacy single-record shape (still read, no longer written) */
  scrollState?: TabScrollState
  /** Per-pane scroll offsets, each stamped with its entity */
  scrollPanes?: TabScrollPanes
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
