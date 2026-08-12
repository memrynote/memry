/**
 * Storage Adapters
 * Different storage backends for tab persistence
 */

import type { TabStorage, PersistedTabState } from './types'
import { STORAGE_KEY } from './types'
import { createLogger } from '@/lib/logger'

const log = createLogger('TabPersistence:Storage')

const toError = (error: unknown, fallback: string): Error => {
  return error instanceof Error ? error : new Error(fallback)
}

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
// INDEXEDDB ADAPTER (Optional, for larger state)
// =============================================================================

const DB_NAME = 'memry_tabs'
const DB_VERSION = 1
const STORE_NAME = 'tabState'

/**
 * Open IndexedDB database
 */
const openDatabase = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onerror = () => reject(toError(request.error, 'Failed to open IndexedDB'))
    request.onsuccess = () => resolve(request.result)

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME)
      }
    }
  })
}

/**
 * IndexedDB adapter for tab persistence
 * Better for larger state that might exceed localStorage limits
 */
export const indexedDBAdapter: TabStorage = {
  save: async (state: PersistedTabState): Promise<void> => {
    const db = await openDatabase()

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      const request = store.put(state, 'current')

      request.onerror = () => reject(toError(request.error, 'Failed to save tab state'))
      request.onsuccess = () => resolve()
    })
  },

  load: async (): Promise<PersistedTabState | null> => {
    try {
      const db = await openDatabase()

      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly')
        const store = tx.objectStore(STORE_NAME)
        const request = store.get('current')

        request.onerror = () => reject(toError(request.error, 'Failed to load tab state'))
        request.onsuccess = () => resolve(request.result || null)
      })
    } catch (error) {
      log.error('Failed to load from IndexedDB:', error)
      return null
    }
  },

  clear: async (): Promise<void> => {
    const db = await openDatabase()

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      const request = store.delete('current')

      request.onerror = () => reject(toError(request.error, 'Failed to clear tab state'))
      request.onsuccess = () => resolve()
    })
  }
}

// =============================================================================
// DEFAULT ADAPTER
// =============================================================================

/**
 * Get the default storage adapter
 * Uses localStorage for simplicity, can be changed to IndexedDB if needed
 */
export const getDefaultStorage = (): TabStorage => {
  return localStorageAdapter
}
