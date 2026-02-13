import {
  createContext,
  useContext,
  useReducer,
  useCallback,
  useEffect,
  useMemo,
  type ReactNode
} from 'react'
import { useAuth } from './auth-context'
import { extractErrorMessage } from '@/lib/ipc-error'

type SyncStatus = 'idle' | 'syncing' | 'paused' | 'error' | 'offline' | 'unknown'

interface SyncState {
  status: SyncStatus
  lastSyncAt: number | null
  pendingCount: number
  error: string | null
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
  | { type: 'RESET' }

const initialState: SyncState = {
  status: 'unknown',
  lastSyncAt: null,
  pendingCount: 0,
  error: null
}

function syncReducer(state: SyncState, action: SyncAction): SyncState {
  switch (action.type) {
    case 'STATUS_CHANGED':
      return {
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

  const value = useMemo<SyncContextValue>(
    () => ({ state, triggerSync, pause, resume, clearError }),
    [state, triggerSync, pause, resume, clearError]
  )

  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>
}
