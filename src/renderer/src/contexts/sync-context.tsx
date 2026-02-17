import {
  createContext,
  useContext,
  useReducer,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from 'react'
import { useAuth } from './auth-context'
import { extractErrorMessage } from '@/lib/ipc-error'
import type { LinkingRequestEvent } from '@shared/contracts/ipc-events'

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

interface SyncState {
  status: SyncStatus
  lastSyncAt: number | null
  pendingCount: number
  error: string | null
  uploadProgress: Record<string, ProgressEntry> | null
  downloadProgress: Record<string, ProgressEntry> | null
  sessionExpired: boolean
  conflicts: ConflictEntry[]
  clockSkewDetected: boolean
  initialSyncProgress: { current: number; total: number } | null
}

type SyncAction =
  | {
      type: 'STATUS_CHANGED'
      status: SyncStatus
      lastSyncAt?: number
      pendingCount: number
      error?: string
    }
  | { type: 'PAUSED'; pendingCount: number }
  | { type: 'RESUMED'; pendingCount: number }
  | { type: 'SET_ERROR'; error: string }
  | { type: 'CLEAR_ERROR' }
  | { type: 'UPLOAD_PROGRESS'; attachmentId: string; progress: number; status: string }
  | { type: 'DOWNLOAD_PROGRESS'; attachmentId: string; progress: number; status: string }
  | { type: 'SESSION_EXPIRED' }
  | { type: 'CONFLICT_DETECTED'; itemId: string; itemType: string }
  | { type: 'QUEUE_CLEARED' }
  | { type: 'CLOCK_SKEW_WARNING' }
  | { type: 'ITEM_SYNCED'; lastSyncAt: number }
  | { type: 'INITIAL_SYNC_PROGRESS'; current: number; total: number }
  | { type: 'RESET' }

const initialState: SyncState = {
  status: 'unknown',
  lastSyncAt: null,
  pendingCount: 0,
  error: null,
  uploadProgress: null,
  downloadProgress: null,
  sessionExpired: false,
  conflicts: [],
  clockSkewDetected: false,
  initialSyncProgress: null
}

function syncReducer(state: SyncState, action: SyncAction): SyncState {
  switch (action.type) {
    case 'STATUS_CHANGED':
      return {
        ...state,
        status: action.status,
        lastSyncAt: action.lastSyncAt ?? state.lastSyncAt,
        pendingCount: action.pendingCount,
        error: action.error ?? null
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
      return { ...state, lastSyncAt: action.lastSyncAt }
    case 'INITIAL_SYNC_PROGRESS':
      return { ...state, initialSyncProgress: { current: action.current, total: action.total } }
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
  const { state: authState } = useAuth()
  const [state, dispatch] = useReducer(syncReducer, initialState)
  const [linkingRequest, setLinkingRequest] = useState<LinkingRequestEvent | null>(null)

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
          error: status.error
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
          error: event.error
        })
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
        dispatch({ type: 'SESSION_EXPIRED' })
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
      window.api.onItemSynced(() => {
        if (cancelled) return
        dispatch({ type: 'ITEM_SYNCED', lastSyncAt: Date.now() })
      })
    )

    cleanups.push(
      window.api.onInitialSyncProgress((event) => {
        if (cancelled) return
        dispatch({
          type: 'INITIAL_SYNC_PROGRESS',
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

    // TODO: onKeyRotationProgress — connect in key rotation phase (Phase 5)

    return () => {
      cancelled = true
      for (const cleanup of cleanups) cleanup()
    }
  }, [authState.status])

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

  const value = useMemo<SyncContextValue>(
    () => ({ state, triggerSync, pause, resume, clearError, linkingRequest, clearLinkingRequest }),
    [state, triggerSync, pause, resume, clearError, linkingRequest, clearLinkingRequest]
  )

  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>
}
