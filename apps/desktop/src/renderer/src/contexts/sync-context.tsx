import {
  createContext,
  useContext,
  useReducer,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { toast } from 'sonner'
import { useAuth } from './auth-context'
import { extractErrorMessage } from '@/lib/ipc-error'
import { DeviceRevokedDialog } from '@/components/sync/device-revoked-dialog'
import type { InitialSyncPhase, LinkingRequestEvent } from '@memry/contracts/ipc-events'

type SyncStatus = 'idle' | 'syncing' | 'paused' | 'error' | 'offline' | 'unknown'

interface ProgressEntry {
  progress: number
  status: string
}

interface ConflictEntry {
  itemId: string
  itemType: string
  detectedAt: number
}

interface SyncActivity {
  pushCount: number
  pullCount: number
}

interface SyncState {
  status: SyncStatus
  lastSyncAt: number | null
  pendingCount: number
  error: string | null
  offlineSince: number | null
  uploadProgress: Record<string, ProgressEntry> | null
  downloadProgress: Record<string, ProgressEntry> | null
  sessionExpired: boolean
  deviceRevoked: { unsyncedCount: number } | null
  conflicts: ConflictEntry[]
  clockSkewDetected: boolean
  initialSyncProgress: { phase: InitialSyncPhase; current: number; total: number } | null
  syncActivity: SyncActivity
}

type SyncAction =
  | {
      type: 'STATUS_CHANGED'
      status: SyncStatus
      lastSyncAt?: number
      pendingCount: number
      error?: string
      offlineSince?: number
    }
  | { type: 'PAUSED'; pendingCount: number }
  | { type: 'RESUMED'; pendingCount: number }
  | { type: 'SET_ERROR'; error: string }
  | { type: 'CLEAR_ERROR' }
  | { type: 'UPLOAD_PROGRESS'; attachmentId: string; progress: number; status: string }
  | { type: 'DOWNLOAD_PROGRESS'; attachmentId: string; progress: number; status: string }
  | { type: 'SESSION_EXPIRED' }
  | { type: 'DEVICE_REVOKED'; unsyncedCount: number }
  | { type: 'CONFLICT_DETECTED'; itemId: string; itemType: string }
  | { type: 'QUEUE_CLEARED' }
  | { type: 'CLOCK_SKEW_WARNING' }
  | { type: 'ITEM_SYNCED'; lastSyncAt: number; operation: 'push' | 'pull' }
  | { type: 'INITIAL_SYNC_PROGRESS'; phase: InitialSyncPhase; current: number; total: number }
  | { type: 'RESET' }

const initialState: SyncState = {
  status: 'unknown',
  lastSyncAt: null,
  pendingCount: 0,
  error: null,
  offlineSince: null,
  uploadProgress: null,
  downloadProgress: null,
  sessionExpired: false,
  deviceRevoked: null,
  conflicts: [],
  clockSkewDetected: false,
  initialSyncProgress: null,
  syncActivity: { pushCount: 0, pullCount: 0 }
}

function syncReducer(state: SyncState, action: SyncAction): SyncState {
  switch (action.type) {
    case 'STATUS_CHANGED': {
      const leavingSyncing = state.status === 'syncing' && action.status !== 'syncing'
      return {
        ...state,
        status: action.status,
        lastSyncAt: action.lastSyncAt ?? state.lastSyncAt,
        pendingCount: action.pendingCount,
        error: action.error ?? null,
        offlineSince: action.offlineSince ?? null,
        syncActivity: leavingSyncing ? { pushCount: 0, pullCount: 0 } : state.syncActivity
      }
    }
    case 'PAUSED':
      return { ...state, status: 'paused', pendingCount: action.pendingCount }
    case 'RESUMED':
      return { ...state, status: 'idle', pendingCount: action.pendingCount }
    case 'SET_ERROR':
      return { ...state, status: 'error', error: action.error }
    case 'CLEAR_ERROR':
      return {
        ...state,
        error: null,
        status: state.status === 'error' ? 'idle' : state.status
      }
    case 'UPLOAD_PROGRESS':
      return {
        ...state,
        uploadProgress: {
          ...state.uploadProgress,
          [action.attachmentId]: { progress: action.progress, status: action.status }
        }
      }
    case 'DOWNLOAD_PROGRESS':
      return {
        ...state,
        downloadProgress: {
          ...state.downloadProgress,
          [action.attachmentId]: { progress: action.progress, status: action.status }
        }
      }
    case 'SESSION_EXPIRED':
      return { ...state, sessionExpired: true, status: 'error', error: 'Session expired' }
    case 'DEVICE_REVOKED':
      return {
        ...state,
        deviceRevoked: { unsyncedCount: action.unsyncedCount },
        status: 'error',
        error: 'This device has been removed'
      }
    case 'CONFLICT_DETECTED':
      return {
        ...state,
        conflicts: [
          ...state.conflicts,
          { itemId: action.itemId, itemType: action.itemType, detectedAt: Date.now() }
        ]
      }
    case 'QUEUE_CLEARED':
      return { ...state, pendingCount: 0 }
    case 'CLOCK_SKEW_WARNING':
      return { ...state, clockSkewDetected: true }
    case 'ITEM_SYNCED':
      return {
        ...state,
        lastSyncAt: action.lastSyncAt,
        syncActivity: {
          pushCount: state.syncActivity.pushCount + (action.operation === 'push' ? 1 : 0),
          pullCount: state.syncActivity.pullCount + (action.operation === 'pull' ? 1 : 0)
        }
      }
    case 'INITIAL_SYNC_PROGRESS':
      if (action.phase === 'complete') return { ...state, initialSyncProgress: null }
      return {
        ...state,
        initialSyncProgress: {
          phase: action.phase,
          current: action.current,
          total: action.total
        }
      }
    case 'RESET':
      return initialState
    default:
      return state
  }
}

interface SyncContextValue {
  state: SyncState
  triggerSync: () => Promise<void>
  pause: () => Promise<void>
  resume: () => Promise<void>
  clearError: () => void
  linkingRequest: LinkingRequestEvent | null
  clearLinkingRequest: () => void
  dismissDeviceRevoked: () => void
}

const SyncContext = createContext<SyncContextValue | null>(null)

export function useSync(): SyncContextValue {
  const context = useContext(SyncContext)
  if (!context) {
    throw new Error('useSync must be used within a SyncProvider')
  }
  return context
}

interface SyncProviderProps {
  children: ReactNode
}

export function SyncProvider({ children }: SyncProviderProps): React.JSX.Element {
  const { state: authState, logout } = useAuth()
  const [state, dispatch] = useReducer(syncReducer, initialState)
  const [linkingRequest, setLinkingRequest] = useState<LinkingRequestEvent | null>(null)
  const sessionExpiredRef = useRef(state.sessionExpired)
  sessionExpiredRef.current = state.sessionExpired

  useEffect(() => {
    if (authState.status !== 'authenticated') {
      dispatch({ type: 'RESET' })
      return
    }

    let cancelled = false

    const init = async (): Promise<void> => {
      try {
        const status = await window.api.syncOps.getStatus()
        if (cancelled) return
        dispatch({
          type: 'STATUS_CHANGED',
          status: status.status as SyncStatus,
          lastSyncAt: status.lastSyncAt,
          pendingCount: status.pendingCount,
          error: status.error,
          offlineSince: status.offlineSince
        })
      } catch {
        if (!cancelled) {
          dispatch({ type: 'SET_ERROR', error: 'Failed to fetch sync status' })
        }
      }
    }
    void init()

    const cleanups: Array<() => void> = []

    cleanups.push(
      window.api.onSyncStatusChanged((event) => {
        if (cancelled) return
        dispatch({
          type: 'STATUS_CHANGED',
          status: event.status as SyncStatus,
          lastSyncAt: event.lastSyncAt,
          pendingCount: event.pendingCount,
          error: event.error,
          offlineSince: event.offlineSince
        })
        if (event.errorCategory === 'storage_quota_exceeded') {
          toast.error('Storage full — free up space or upgrade your plan', { duration: 10000 })
        }
      })
    )

    cleanups.push(
      window.api.onSyncPaused((event) => {
        if (cancelled) return
        dispatch({ type: 'PAUSED', pendingCount: event.pendingCount })
      })
    )

    cleanups.push(
      window.api.onSyncResumed((event) => {
        if (cancelled) return
        dispatch({ type: 'RESUMED', pendingCount: event.pendingCount })
      })
    )

    cleanups.push(
      window.api.onUploadProgress((event) => {
        if (cancelled) return
        dispatch({
          type: 'UPLOAD_PROGRESS',
          attachmentId: event.attachmentId,
          progress: event.progress,
          status: event.status
        })
      })
    )

    cleanups.push(
      window.api.onDownloadProgress((event) => {
        if (cancelled) return
        dispatch({
          type: 'DOWNLOAD_PROGRESS',
          attachmentId: event.attachmentId,
          progress: event.progress,
          status: event.status
        })
      })
    )

    cleanups.push(
      window.api.onSessionExpired(() => {
        if (cancelled) return
        if (!sessionExpiredRef.current) {
          toast.error('Session expired — sign in again', { duration: 8000 })
        }
        dispatch({ type: 'SESSION_EXPIRED' })
      })
    )

    cleanups.push(
      window.api.onDeviceRevoked((event) => {
        if (cancelled) return
        dispatch({ type: 'DEVICE_REVOKED', unsyncedCount: event.unsyncedCount })
      })
    )

    cleanups.push(
      window.api.onConflictDetected((event) => {
        if (cancelled) return
        dispatch({ type: 'CONFLICT_DETECTED', itemId: event.itemId, itemType: event.type })
      })
    )

    cleanups.push(
      window.api.onQueueCleared(() => {
        if (cancelled) return
        dispatch({ type: 'QUEUE_CLEARED' })
      })
    )

    cleanups.push(
      window.api.onClockSkewWarning(() => {
        if (cancelled) return
        dispatch({ type: 'CLOCK_SKEW_WARNING' })
      })
    )

    cleanups.push(
      window.api.onItemSynced((event) => {
        if (cancelled) return
        dispatch({ type: 'ITEM_SYNCED', lastSyncAt: Date.now(), operation: event.operation })
      })
    )

    cleanups.push(
      window.api.onInitialSyncProgress((event) => {
        if (cancelled) return
        dispatch({
          type: 'INITIAL_SYNC_PROGRESS',
          phase: event.phase,
          current: event.processedItems,
          total: event.totalItems
        })
      })
    )

    cleanups.push(
      window.api.onLinkingRequest((event) => {
        if (cancelled) return
        setLinkingRequest(event)
      })
    )

    cleanups.push(
      window.api.onLinkingApproved(() => {
        if (cancelled) return
        setLinkingRequest(null)
      })
    )

    cleanups.push(
      window.api.onKeyRotationProgress((event) => {
        if (cancelled) return
        if (event.phase === 'complete') {
          dispatch({ type: 'CLEAR_ERROR' })
        } else if (event.error) {
          dispatch({ type: 'SET_ERROR', error: event.error })
        }
      })
    )

    cleanups.push(
      window.api.onSecurityWarning((event) => {
        if (cancelled) return
        const message = event.permanent
          ? 'A sync item could not be verified and has been quarantined for security.'
          : 'A sync item failed signature verification and will be retried.'
        toast.error(message, { duration: 8000 })
      })
    )

    cleanups.push(
      window.api.onCertificatePinFailed(() => {
        if (cancelled) return
        toast.error(
          'Secure connection to sync server could not be verified. Syncing has been paused for your protection.',
          { duration: 15000 }
        )
      })
    )

    return () => {
      cancelled = true
      for (const cleanup of cleanups) cleanup()
    }
  }, [authState.status])

  useEffect(() => {
    if (authState.status === 'authenticated' && state.sessionExpired) {
      dispatch({ type: 'CLEAR_ERROR' })
      void window.api.syncOps.triggerSync().catch(() => {})
    }
  }, [authState.status, state.sessionExpired])

  const triggerSync = useCallback(async (): Promise<void> => {
    if (authState.status !== 'authenticated') return
    try {
      await window.api.syncOps.triggerSync()
    } catch (err) {
      dispatch({ type: 'SET_ERROR', error: extractErrorMessage(err, 'Sync failed') })
    }
  }, [authState.status])

  const pause = useCallback(async (): Promise<void> => {
    if (authState.status !== 'authenticated') return
    try {
      await window.api.syncOps.pause()
    } catch (err) {
      dispatch({ type: 'SET_ERROR', error: extractErrorMessage(err, 'Failed to pause sync') })
    }
  }, [authState.status])

  const resume = useCallback(async (): Promise<void> => {
    if (authState.status !== 'authenticated') return
    try {
      await window.api.syncOps.resume()
    } catch (err) {
      dispatch({ type: 'SET_ERROR', error: extractErrorMessage(err, 'Failed to resume sync') })
    }
  }, [authState.status])

  const clearError = useCallback(() => {
    dispatch({ type: 'CLEAR_ERROR' })
  }, [])

  const clearLinkingRequest = useCallback(() => {
    setLinkingRequest(null)
  }, [])

  const dismissDeviceRevoked = useCallback(() => {
    dispatch({ type: 'RESET' })
  }, [])

  const value = useMemo<SyncContextValue>(
    () => ({
      state,
      triggerSync,
      pause,
      resume,
      clearError,
      linkingRequest,
      clearLinkingRequest,
      dismissDeviceRevoked
    }),
    [
      state,
      triggerSync,
      pause,
      resume,
      clearError,
      linkingRequest,
      clearLinkingRequest,
      dismissDeviceRevoked
    ]
  )

  const handleDeviceRevokedExport = useCallback(async () => {
    toast.info('Local data export is not yet implemented', { duration: 5000 })
  }, [])

  const handleDeviceRevokedSignOut = useCallback(() => {
    void logout()
  }, [logout])

  return (
    <SyncContext.Provider value={value}>
      {children}
      <DeviceRevokedDialog
        open={state.deviceRevoked !== null}
        unsyncedCount={state.deviceRevoked?.unsyncedCount ?? 0}
        onExport={handleDeviceRevokedExport}
        onSignOut={handleDeviceRevokedSignOut}
      />
    </SyncContext.Provider>
  )
}
