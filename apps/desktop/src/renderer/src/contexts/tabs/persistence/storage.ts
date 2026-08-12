/**
 * Storage Adapters
 * Different storage backends for tab persistence
 */

import type { TabStorage, PersistedTabState } from './types'
import { STORAGE_KEY } from './types'
import { createLogger } from '@/lib/logger'

const log = createLogger('TabPersistence:Storage')

/**
 * Whether a storage write failed because the origin ran out of quota.
 *
 * Chromium — the only engine this app ships a renderer on — throws a
 * `DOMException` named `QuotaExceededError`; `QUOTA_EXCEEDED_ERR` is the legacy
 * name older WebKit builds report for the same condition. Matched by shape
 * rather than `instanceof Error`, because jsdom's `DOMException` does not
 * inherit from `Error` the way a browser's does.
 */
export const isQuotaExceededError = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return false
  const { name } = error as { name?: unknown }
  return name === 'QuotaExceededError' || name === 'QUOTA_EXCEEDED_ERR'
}

// =============================================================================
// LOCALSTORAGE ADAPTER
// =============================================================================

/**
 * LocalStorage adapter for tab persistence
 * Best for simple web apps with small state
 */
export const localStorageAdapter: TabStorage = {
  save: async (state: PersistedTabState): Promise<void> => {
    try {
      const json = JSON.stringify(state)
      localStorage.setItem(STORAGE_KEY, json)
    } catch (error) {
      log.error('Failed to save tab state to localStorage:', error)
      throw error
    }
  },

  load: async (): Promise<PersistedTabState | null> => {
    try {
      const json = localStorage.getItem(STORAGE_KEY)
      if (!json) return null

      const parsed = JSON.parse(json)

      // Basic validation
      if (!parsed.version || !parsed.tabGroups || !parsed.layout) {
        log.warn('Invalid persisted tab state, ignoring')
        return null
      }

      return parsed as PersistedTabState
    } catch (error) {
      log.error('Failed to load tab state from localStorage:', error)
      return null
    }
  },

  clear: async (): Promise<void> => {
    localStorage.removeItem(STORAGE_KEY)
  }
}

// =============================================================================
// SYNCHRONOUS STORAGE (for beforeunload)
// =============================================================================

/**
 * Synchronously save to localStorage
 * Used for beforeunload event where async isn't reliable
 */
export const saveSync = (state: PersistedTabState): void => {
  try {
    const json = JSON.stringify(state)
    localStorage.setItem(STORAGE_KEY, json)
  } catch (error) {
    log.error('Failed to save tab state synchronously:', error)
  }
}

// =============================================================================
// DEFAULT ADAPTER
// =============================================================================

/**
 * Get the default storage adapter.
 *
 * localStorage is the only backend. An IndexedDB adapter used to sit here,
 * exported but selected by nothing; it was removed rather than left to rot —
 * see #1330. If the localStorage quota ever becomes the real constraint (#1292
 * closed without moving off it), the replacement backend needs a migration read
 * from `STORAGE_KEY` and a downgrade story, which is its own change.
 */
export const getDefaultStorage = (): TabStorage => {
  return localStorageAdapter
}
