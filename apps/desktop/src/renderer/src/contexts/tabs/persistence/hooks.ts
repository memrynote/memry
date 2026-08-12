/**
 * Tab Persistence Hooks
 * Auto-save and session restore functionality
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import { useMutation } from '@tanstack/react-query'
import { getI18n } from 'react-i18next'
import { toast } from 'sonner'
import { useTabs } from '@/contexts/tabs'
import type { TabSystemState } from '@/contexts/tabs/types'
import { extractErrorMessage } from '@/lib/ipc-error'
import { getDefaultStorage, isQuotaExceededError, saveSync } from './storage'
import { serializeTabState, deserializeTabState, extractPinnedTabs } from './serialization'
import type { TabStorage } from './types'
import { registerPendingSave, unregisterPendingSave } from '@/lib/save-registry'
import { createLogger } from '@/lib/logger'
import { useFeatureFlags } from '@/hooks/use-feature-flags'

const log = createLogger('TabPersistence:Hooks')
const FLUSH_REGISTRY_KEY = 'tab-state'
const SAVE_FAILURE_TOAST_ID = 'tab-state-save-failed'

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
  const saveFailureNotifiedRef = useRef(false)

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

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current)
    }

    // Serialize inside the debounced callback: only the last timer of a burst
    // survives, and it closes over the newest state, so a burst of tab-state
    // changes walks the tab tree once instead of once per change.
    saveTimeoutRef.current = setTimeout(() => {
      const serialized = serializeTabState(state)
      const json = JSON.stringify(serialized)

      if (json === lastSavedRef.current) return

      // A rejected save must never escape as an unhandled rejection: the
      // adapters rethrow, so without a handler a full-quota localStorage write
      // drops the user's session on the floor with nothing but a renderer log
      // line. Handle it here, keep `lastSavedRef` on the last value that really
      // reached storage so the next state change retries, and tell the user
      // once that their tab layout is no longer being saved.
      void storage
        .save(serialized)
        .then(() => {
          lastSavedRef.current = json
          saveFailureNotifiedRef.current = false
        })
        .catch((error: unknown) => {
          log.error('Failed to save tab state:', error)
          if (saveFailureNotifiedRef.current) return
          saveFailureNotifiedRef.current = true

          const t = getI18n().getFixedT(null, 'common')
          const quota = isQuotaExceededError(error)
          toast.error(t('tabs.persistence.saveFailed'), {
            id: SAVE_FAILURE_TOAST_ID,
            description: quota
              ? t('tabs.persistence.saveFailedQuota')
              : extractErrorMessage(error, t('tabs.persistence.saveFailedGeneric'))
          })
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
      const serialized = serializeTabState(stateRef.current)
      saveSync(serialized)
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [enabled])
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
  const { flags, isLoading: flagsLoading } = useFeatureFlags()
  const hasRestoredRef = useRef(false)

  const restoreSession = useCallback(async (): Promise<void> => {
    if (hasRestoredRef.current) return

    try {
      const persisted = await storage.load()

      if (persisted) {
        if (state.settings.restoreSessionOnStart) {
          const restored = deserializeTabState(persisted, flags)
          dispatch({
            type: 'RESTORE_SESSION',
            payload: restored as TabSystemState
          })
        } else {
          const pinnedTabs = extractPinnedTabs(persisted, flags)
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
  }, [storage, state.settings.restoreSessionOnStart, dispatch, flags])

  const [autoRestoreState, setAutoRestoreState] = useState<{
    pending: boolean
    error: Error | null
  }>(() => ({ pending: autoRestore, error: null }))

  useEffect(() => {
    if (!autoRestore || flagsLoading) return

    let cancelled = false

    void restoreSession()
      .then(() => {
        if (cancelled) return
        setAutoRestoreState({ pending: false, error: null })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setAutoRestoreState({
          pending: false,
          error: error instanceof Error ? error : new Error('Failed to restore session')
        })
      })

    return () => {
      cancelled = true
    }
  }, [autoRestore, flagsLoading, restoreSession])

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
    autoRestoreState.error ??
    (restoreMutation.error instanceof Error ? restoreMutation.error : null)

  const isRestoring = autoRestoreState.pending || restoreMutation.isPending

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
