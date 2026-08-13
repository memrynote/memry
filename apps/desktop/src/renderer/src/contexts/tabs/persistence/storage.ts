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

/** Marker recording that the last quit-time write never reached storage. */
const SAVE_FAILURE_KEY = 'memry_tab_state_save_failed'

/** Why a synchronous save failed, as far as the storage layer can tell. */
export interface SyncSaveFailure {
  reason: 'quota' | 'error'
  /** Epoch ms of the failed attempt. */
  at: number
}

export type SyncSaveResult = { ok: true } | ({ ok: false } & SyncSaveFailure)

/**
 * Leave a breadcrumb the next launch can read.
 *
 * `saveSync` only ever runs while the window is going away, so there is no
 * moment left to tell the user anything. Persisting the failure is what turns
 * it from invisible into diagnosable: the restore path picks it up on the next
 * launch and explains why the tabs that came back are older than the ones the
 * user closed the app with.
 */
const recordSaveFailure = (failure: SyncSaveFailure): void => {
  try {
    localStorage.setItem(SAVE_FAILURE_KEY, JSON.stringify(failure))
  } catch (error) {
    // A few dozen bytes can still be refused on a full origin. Best effort only
    // — the quit path must never throw.
    log.warn('Failed to record tab state save failure:', error)
  }
}

const clearSaveFailure = (): void => {
  try {
    localStorage.removeItem(SAVE_FAILURE_KEY)
  } catch (error) {
    log.warn('Failed to clear tab state save failure marker:', error)
  }
}

/**
 * Read and remove the marker left by a failed quit-time save.
 * Returns null when the last quit wrote successfully.
 */
export const consumeSyncSaveFailure = (): SyncSaveFailure | null => {
  try {
    const raw = localStorage.getItem(SAVE_FAILURE_KEY)
    if (!raw) return null
    localStorage.removeItem(SAVE_FAILURE_KEY)

    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const { reason, at } = parsed as { reason?: unknown; at?: unknown }
    if (reason !== 'quota' && reason !== 'error') return null

    return { reason, at: typeof at === 'number' ? at : 0 }
  } catch (error) {
    log.warn('Failed to read tab state save failure marker:', error)
    return null
  }
}

/**
 * Synchronously save to localStorage
 * Used for beforeunload event where async isn't reliable
 *
 * Never throws: both callers run on a quit path, where an exception would be a
 * regression far worse than the failed write. The result is returned instead so
 * they can log the truth rather than claim a flush that did not happen.
 */
export const saveSync = (state: PersistedTabState): SyncSaveResult => {
  try {
    const json = JSON.stringify(state)
    localStorage.setItem(STORAGE_KEY, json)
    clearSaveFailure()
    return { ok: true }
  } catch (error) {
    log.error('Failed to save tab state synchronously:', error)
    const failure: SyncSaveFailure = {
      reason: isQuotaExceededError(error) ? 'quota' : 'error',
      at: Date.now()
    }
    recordSaveFailure(failure)
    return { ok: false, ...failure }
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
