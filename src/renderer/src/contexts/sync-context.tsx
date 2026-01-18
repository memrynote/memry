/**
 * Sync Context
 *
 * Provides sync state and methods to the application.
 * Listens to IPC events from main process and exposes sync status.
 *
 * @module contexts/sync-context
 */

import {
  createContext,
  useContext,
  useCallback,
  useMemo,
  useState,
  useEffect,
  type ReactNode
} from 'react'
import type {
  SyncStatus,
  SyncStatusChangedEvent,
  SyncItemSyncedEvent,
  SyncErrorEvent
} from '../../../preload/index.d'

// =============================================================================
// Types
// =============================================================================

export interface SyncContextValue {
  // State
  isLoading: boolean
  status: SyncStatus
  isOnline: boolean
  isSyncing: boolean
  isPaused: boolean
  hasError: boolean

  // Queue info
  queueSize: number
  lastSyncAt: Date | null

  // Error info
  lastError: string | null
  errorCount: number

  // Actions
  triggerSync: (options?: { force?: boolean }) => Promise<{ success: boolean; message?: string }>
  pauseSync: () => Promise<{ success: boolean }>
  resumeSync: () => Promise<{ success: boolean }>
  refreshStatus: () => Promise<void>

  // Loading states
  isTriggeringSync: boolean
  isPausingSync: boolean
  isResumingSync: boolean
}

// =============================================================================
// Default Values
// =============================================================================

const defaultStatus: SyncStatus = {
  state: 'idle',
  lastSyncAt: null,
  pendingCount: 0,
  errorCount: 0,
  currentOperation: null
}

// =============================================================================
// Context
// =============================================================================

const SyncContext = createContext<SyncContextValue | null>(null)

// =============================================================================
// Hook
// =============================================================================

/**
 * Use the sync context.
 * Must be used within a SyncProvider.
 */
export function useSync(): SyncContextValue {
  const context = useContext(SyncContext)
  if (!context) {
    throw new Error('useSync must be used within a SyncProvider')
  }
  return context
}

/**
 * Convenience hook for sync status.
 */
export function useSyncStatus(): Pick<
  SyncContextValue,
  'status' | 'isOnline' | 'isSyncing' | 'isPaused' | 'hasError' | 'queueSize' | 'lastSyncAt'
> {
  const { status, isOnline, isSyncing, isPaused, hasError, queueSize, lastSyncAt } = useSync()
  return { status, isOnline, isSyncing, isPaused, hasError, queueSize, lastSyncAt }
}

// =============================================================================
// Provider Props
// =============================================================================

interface SyncProviderProps {
  children: ReactNode
  onItemSynced?: (event: SyncItemSyncedEvent) => void
  onError?: (event: SyncErrorEvent) => void
}

// =============================================================================
// Provider
// =============================================================================

/**
 * Sync provider component.
 * Provides sync state and methods to children.
 */
export function SyncProvider({ children, onItemSynced, onError }: SyncProviderProps) {
  // State
  const [isLoading, setIsLoading] = useState(true)
  const [status, setStatus] = useState<SyncStatus>(defaultStatus)
  const [queueSize, setQueueSize] = useState(0)
  const [lastError, setLastError] = useState<string | null>(null)

  // Loading states
  const [isTriggeringSync, setIsTriggeringSync] = useState(false)
  const [isPausingSync, setIsPausingSync] = useState(false)
  const [isResumingSync, setIsResumingSync] = useState(false)

  // Derived state
  const isOnline = status.state !== 'offline'
  const isSyncing = status.state === 'syncing'
  const isPaused = status.state === 'paused'
  const hasError = status.state === 'error' || status.errorCount > 0
  const lastSyncAt = status.lastSyncAt ? new Date(status.lastSyncAt) : null

  // Load initial status
  useEffect(() => {
    const loadStatus = async () => {
      try {
        const [statusResult, queueResult] = await Promise.all([
          window.api.sync.getStatus(),
          window.api.sync.getQueueSize()
        ])
        setStatus(statusResult)
        setQueueSize(queueResult.size)
      } catch (error) {
        console.error('[SyncContext] Failed to load status:', error)
      } finally {
        setIsLoading(false)
      }
    }

    loadStatus()
  }, [])

  // Subscribe to sync events
  useEffect(() => {
    // Status changed event
    const unsubscribeStatus = window.api.onSyncStatusChanged((event: SyncStatusChangedEvent) => {
      setStatus(event.status)
      setQueueSize(event.status.pendingCount)
    })

    // Item synced event
    const unsubscribeSynced = window.api.onSyncItemSynced((event: SyncItemSyncedEvent) => {
      onItemSynced?.(event)
    })

    // Error event
    const unsubscribeError = window.api.onSyncError((event: SyncErrorEvent) => {
      setLastError(event.error)
      onError?.(event)
    })

    return () => {
      unsubscribeStatus()
      unsubscribeSynced()
      unsubscribeError()
    }
  }, [onItemSynced, onError])

  // Actions
  const triggerSync = useCallback(async (options?: { force?: boolean }) => {
    setIsTriggeringSync(true)
    try {
      return await window.api.sync.triggerSync(options)
    } finally {
      setIsTriggeringSync(false)
    }
  }, [])

  const pauseSync = useCallback(async () => {
    setIsPausingSync(true)
    try {
      return await window.api.sync.pauseSync()
    } finally {
      setIsPausingSync(false)
    }
  }, [])

  const resumeSync = useCallback(async () => {
    setIsResumingSync(true)
    try {
      return await window.api.sync.resumeSync()
    } finally {
      setIsResumingSync(false)
    }
  }, [])

  const refreshStatus = useCallback(async () => {
    try {
      const [statusResult, queueResult] = await Promise.all([
        window.api.sync.getStatus(),
        window.api.sync.getQueueSize()
      ])
      setStatus(statusResult)
      setQueueSize(queueResult.size)
    } catch (error) {
      console.error('[SyncContext] Failed to refresh status:', error)
    }
  }, [])

  // Memoized context value
  const value = useMemo<SyncContextValue>(
    () => ({
      // State
      isLoading,
      status,
      isOnline,
      isSyncing,
      isPaused,
      hasError,

      // Queue info
      queueSize,
      lastSyncAt,

      // Error info
      lastError,
      errorCount: status.errorCount,

      // Actions
      triggerSync,
      pauseSync,
      resumeSync,
      refreshStatus,

      // Loading states
      isTriggeringSync,
      isPausingSync,
      isResumingSync
    }),
    [
      isLoading,
      status,
      isOnline,
      isSyncing,
      isPaused,
      hasError,
      queueSize,
      lastSyncAt,
      lastError,
      triggerSync,
      pauseSync,
      resumeSync,
      refreshStatus,
      isTriggeringSync,
      isPausingSync,
      isResumingSync
    ]
  )

  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>
}
