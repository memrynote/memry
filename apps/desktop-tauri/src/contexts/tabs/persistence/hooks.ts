/**
 * Tab Persistence Hooks
 * Auto-save and session restore functionality
 */

import { useEffect, useRef, useCallback } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useTabs } from '@/contexts/tabs'
import type { TabSystemState } from '@/contexts/tabs/types'
import { getDefaultStorage, saveSync } from './storage'
import { serializeTabState, deserializeTabState, extractPinnedTabs } from './serialization'
import type { TabStorage } from './types'
import { registerPendingSave, unregisterPendingSave } from '@/lib/save-registry'
import { createLogger } from '@/lib/logger'

const log = createLogger('TabPersistence:Hooks')
const FLUSH_REGISTRY_KEY = 'tab-state'

// =============================================================================
// AUTO-SAVE HOOK
// =============================================================================

interface UseTabPersistenceOptions {
  /** Storage adapter to use */
  storage?: TabStorage
  /** Debounce delay in ms (default: 1000) */
  debounceMs?: number
  /** Enable auto-save (default: true) */
  enabled?: boolean
}

/**
 * Hook to auto-save tab state changes
 */
export const useTabPersistence = (options: UseTabPersistenceOptions = {}): void => {
  const { storage = getDefaultStorage(), debounceMs = 1000, enabled = true } = options
  const { state } = useTabs()
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSavedRef = useRef<string>('')
  const stateRef = useRef(state)

  // Keep ref in sync for flush registry access
  useEffect(() => {
    stateRef.current = state
  })

  // Register with flush registry so Cmd+Q saves tab state before exit
  useEffect(() => {
    if (!enabled) return

    registerPendingSave(FLUSH_REGISTRY_KEY, () => {
      const serialized = serializeTabState(stateRef.current)
      saveSync(serialized)
      log.info('flushed tab state via registry')
    })

    return () => unregisterPendingSave(FLUSH_REGISTRY_KEY)
  }, [enabled])

  // Debounced save
  useEffect(() => {
    if (!enabled) return

    const serialized = serializeTabState(state)
    const json = JSON.stringify(serialized)

    if (json === lastSavedRef.current) return

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current)
    }

    saveTimeoutRef.current = setTimeout(() => {
      void storage.save(serialized).then(() => {
        lastSavedRef.current = json
      })
    }, debounceMs)

    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current)
      }
    }
  }, [state, storage, debounceMs, enabled])

  // Save immediately on page unload (fallback)
  useEffect(() => {
    if (!enabled) return

    const handleBeforeUnload = (): void => {
      const serialized = serializeTabState(state)
      saveSync(serialized)
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [state, enabled])
}

// =============================================================================
// SESSION RESTORE HOOK
// =============================================================================

interface UseSessionRestoreResult {
  /** Whether restore is in progress */
  isRestoring: boolean
  /** Error if restore failed */
  restoreError: Error | null
  /** Manually trigger restore */
  restore: () => Promise<void>
  /** Clear stored state */
  clearStoredState: () => Promise<void>
}

interface UseSessionRestoreOptions {
  /** Storage adapter to use */
  storage?: TabStorage
  /** Auto-restore on mount (default: true) */
  autoRestore?: boolean
}

/**
 * Hook to restore session on app start
 */
export const useSessionRestore = (
  options: UseSessionRestoreOptions = {}
): UseSessionRestoreResult => {
  const { storage = getDefaultStorage(), autoRestore = true } = options
  const { dispatch, state } = useTabs()
  const hasRestoredRef = useRef(false)

  const restoreSession = useCallback(async (): Promise<void> => {
    if (hasRestoredRef.current) return

    try {
      const persisted = await storage.load()

      if (persisted) {
        const persistedTabs = Object.values(persisted.tabGroups).flatMap((g) => g.tabs)
        log.info('loaded persisted state', {
          tabCount: persistedTabs.length,
          restoreEnabled: state.settings.restoreSessionOnStart
        })
        log.debug('loaded persisted state details', {
          version: persisted.version,
          groups: Object.keys(persisted.tabGroups).length,
          tabs: persistedTabs.map((t) => t.type)
        })

        if (state.settings.restoreSessionOnStart) {
          const restored = deserializeTabState(persisted)
          const restoredTabs = Object.values((restored as TabSystemState).tabGroups).flatMap(
            (g) => g.tabs
          )
          dispatch({
            type: 'RESTORE_SESSION',
            payload: restored as TabSystemState
          })
          log.info('session restored', { count: restoredTabs.length })
          log.debug('session restored details', {
            tabs: restoredTabs.map((t) => `${t.type}:${t.entityId ?? 'none'}`)
          })
        } else {
          const pinnedTabs = extractPinnedTabs(persisted)
          if (pinnedTabs.length > 0) {
            for (const tab of pinnedTabs) {
              dispatch({
                type: 'OPEN_TAB',
                payload: {
                  tab: {
                    type: tab.type,
                    title: tab.title,
                    icon: tab.icon,
                    path: tab.path,
                    entityId: tab.entityId,
                    isPinned: true,
                    isModified: false,
                    isPreview: false,
                    isDeleted: false,
                    scrollPosition: tab.scrollPosition,
                    viewState: tab.viewState
                  },
                  background: true
                }
              })
            }
          }
          log.info('restored pinned tabs only', { count: pinnedTabs.length })
        }
      } else {
        log.info('no persisted tab state found')
      }

      hasRestoredRef.current = true
    } catch (error) {
      log.error('Failed to restore session:', error)
      throw error instanceof Error ? error : new Error('Failed to restore session')
    }
  }, [storage, state.settings.restoreSessionOnStart, dispatch])

  const autoRestoreQuery = useQuery({
    queryKey: ['tabs', 'session-restore', state.settings.restoreSessionOnStart],
    queryFn: restoreSession,
    enabled: autoRestore,
    retry: false,
    staleTime: Infinity
  })

  const restoreMutation = useMutation({
    mutationFn: restoreSession
  })

  const restore = useCallback(async (): Promise<void> => {
    await restoreMutation.mutateAsync()
  }, [restoreMutation])

  const clearStoredState = useCallback(async (): Promise<void> => {
    await storage.clear()
  }, [storage])

  const restoreError =
    autoRestoreQuery.error instanceof Error
      ? autoRestoreQuery.error
      : restoreMutation.error instanceof Error
        ? restoreMutation.error
        : null

  const isRestoring = autoRestoreQuery.isPending || restoreMutation.isPending

  return {
    isRestoring,
    restoreError,
    restore,
    clearStoredState
  }
}

// =============================================================================
// MANUAL SAVE/LOAD
// =============================================================================

/**
 * Hook for manual save/load operations
 */
export const useManualPersistence = (storage: TabStorage = getDefaultStorage()) => {
  const { state, dispatch } = useTabs()

  const save = useCallback(async (): Promise<void> => {
    const serialized = serializeTabState(state)
    await storage.save(serialized)
  }, [state, storage])

  const load = useCallback(async (): Promise<boolean> => {
    const persisted = await storage.load()
    if (persisted) {
      const restored = deserializeTabState(persisted)
      dispatch({
        type: 'RESTORE_SESSION',
        payload: restored as TabSystemState
      })
      return true
    }
    return false
  }, [storage, dispatch])

  const clear = useCallback(async (): Promise<void> => {
    await storage.clear()
  }, [storage])

  return { save, load, clear }
}
