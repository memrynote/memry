/**
 * Sync Context (T100)
 * Global state management for sync engine status and operations
 */

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  useEffect,
  type ReactNode
} from 'react'
import type { SyncStatus } from '@shared/contracts/sync-api'
import type { SyncStatusChangedEvent, SyncErrorEvent } from '@shared/contracts/ipc-sync'
import { useAuth } from './auth-context'

function isSyncStatusChangedEvent(event: unknown): event is SyncStatusChangedEvent {
  if (typeof event !== 'object' || event === null) return false
  const e = event as Record<string, unknown>
  return (
    typeof e.previousStatus === 'string' &&
    typeof e.currentStatus === 'string' &&
    typeof e.timestamp === 'number'
  )
}

function isSyncErrorEvent(event: unknown): event is SyncErrorEvent {
  if (typeof event !== 'object' || event === null) return false
  const e = event as Record<string, unknown>
  return typeof e.error === 'string' && typeof e.recoverable === 'boolean'
}

export interface SyncContextValue {
  status: SyncStatus
  lastSyncAt: number | undefined
  pendingCount: number
  isOnline: boolean
  lastError: string | undefined
  triggerSync: () => Promise<void>
  pauseSync: () => void
  resumeSync: () => void
}

interface SyncProviderProps {
  children: ReactNode
}

const SyncContext = createContext<SyncContextValue | null>(null)

export function useSyncContext(): SyncContextValue {
  const context = useContext(SyncContext)
  if (!context) {
    throw new Error('useSyncContext must be used within a SyncProvider')
  }
  return context
}

export function SyncProvider({ children }: SyncProviderProps): React.JSX.Element {
  const { isAuthenticated } = useAuth()
  const [status, setStatus] = useState<SyncStatus>('idle')
  const [lastSyncAt, setLastSyncAt] = useState<number | undefined>(undefined)
  const [pendingCount, setPendingCount] = useState(0)
  const [isOnline, setIsOnline] = useState(true)
  const [lastError, setLastError] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (!isAuthenticated) {
      setStatus('idle')
      setLastSyncAt(undefined)
      setPendingCount(0)
      setLastError(undefined)
      return
    }

    let cancelled = false

    const loadInitialState = async (): Promise<void> => {
      try {
        const response = await window.api.sync.getStatus()
        if (cancelled) return
        if (response?.state) {
          setStatus(response.state.syncStatus)
          setLastSyncAt(response.state.lastSyncAt)
          setPendingCount(response.state.pendingCount)
          setLastError(response.state.lastError)
        }
        if (response) {
          setIsOnline(response.isOnline)
        }
      } catch (error) {
        if (!cancelled) {
          console.error('[SyncContext] Failed to load initial state:', error)
        }
      }
    }
    loadInitialState()

    return () => {
      cancelled = true
    }
  }, [isAuthenticated])

  useEffect(() => {
    if (!isAuthenticated) return

    const unsubscribeStatus = window.api.onSyncStatusChanged((event: unknown) => {
      if (!isSyncStatusChangedEvent(event)) {
        console.warn('[SyncContext] Invalid status event received:', event)
        return
      }
      setStatus(event.currentStatus)
      if (event.currentStatus === 'idle') {
        setLastSyncAt(event.timestamp)
        setLastError(undefined)
      }
      setIsOnline(event.currentStatus !== 'offline')
    })

    const unsubscribeError = window.api.onSyncError((event: unknown) => {
      if (!isSyncErrorEvent(event)) {
        console.warn('[SyncContext] Invalid error event received:', event)
        return
      }
      setLastError(event.error)
      setStatus('error')
    })

    const unsubscribeItemSynced = window.api.onItemSynced(() => {
      window.api.sync
        .getQueueSize()
        .then((response) => {
          if (response) {
            setPendingCount(response.size)
          }
        })
        .catch((error) => {
          console.error('[SyncContext] Failed to get queue size:', error)
        })
    })

    return () => {
      unsubscribeStatus()
      unsubscribeError()
      unsubscribeItemSynced()
    }
  }, [isAuthenticated])

  const triggerSync = useCallback(async (): Promise<void> => {
    try {
      await window.api.sync.trigger()
    } catch (error) {
      console.error('[SyncContext] Failed to trigger sync:', error)
    }
  }, [])

  const pauseSync = useCallback((): void => {
    window.api.sync.pause().catch((error) => {
      console.error('[SyncContext] Failed to pause sync:', error)
    })
  }, [])

  const resumeSync = useCallback((): void => {
    window.api.sync.resume().catch((error) => {
      console.error('[SyncContext] Failed to resume sync:', error)
    })
  }, [])

  const value = useMemo<SyncContextValue>(
    () => ({
      status,
      lastSyncAt,
      pendingCount,
      isOnline,
      lastError,
      triggerSync,
      pauseSync,
      resumeSync
    }),
    [status, lastSyncAt, pendingCount, isOnline, lastError, triggerSync, pauseSync, resumeSync]
  )

  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>
}

export default SyncProvider
