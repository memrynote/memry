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
import { onVaultStatusChanged } from '@/services/vault-service'
import { extractErrorMessage } from '@/lib/ipc-error'
import { DeviceRevokedDialog } from '@/components/sync/device-revoked-dialog'
import { VaultRecoveryDialog } from '@/components/sync/vault-recovery-dialog'
import { SessionExpiredDialog } from '@/components/sync/session-expired-dialog'
import type {
  InitialSyncPhase,
  LinkingRequestEvent,
  VaultRecoveryNeededEvent
} from '@memry/contracts/ipc-events'
import { useT } from '@memry/i18n/renderer'
import type { SyncStatus } from '@/sync/collaboration-status'

interface ProgressEntry {
  progress: number
  status: string
  /** Set once the transfer ends; the prune sweep drops it after the retention window. */
  completedAt?: number
}

/**
 * Terminal statuses main sends when a transfer is over. They are the only
 * end-of-transfer signal for a transfer that dies below 100% — a failed or
 * abandoned one — so they must mark the entry finishable exactly like a full
 * bar does, or its file-block overlay stays pinned for the life of the window.
 * An age heuristic cannot stand in for them: 'waiting_network' is legitimately
 * silent for long stretches and is still live.
 */
const TERMINAL_TRANSFER_STATUSES = new Set(['completed', 'failed'])

/**
 * How long a finished transfer's entry survives so the progress UI can settle.
 * A full bar also counts as finished: main reaches 100% before the last
 * server round-trip, so the terminal event can still be several seconds out.
 */
export const SYNC_PROGRESS_RETENTION_MS = 5_000
/**
 * The cap is what bounds memory; this TTL is purely a staleness policy, so it
 * is deliberately generous — expiring a conflict only ever retracts a warning
 * the user may not have read yet.
 */
export const SYNC_CONFLICT_TTL_MS = 24 * 60 * 60 * 1_000
export const SYNC_CONFLICT_CAP = 100
const PRUNE_INTERVAL_MS = 5_000

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
  | { type: 'SESSION_EXPIRED'; error: string }
  | { type: 'DEVICE_REVOKED'; unsyncedCount: number; error: string }
  | { type: 'CONFLICT_DETECTED'; itemId: string; itemType: string }
  | { type: 'CLEAR_CONFLICTS' }
  | { type: 'PRUNE_STALE'; now: number }
  | { type: 'QUEUE_CLEARED' }
  | { type: 'CLOCK_SKEW_WARNING' }
  | { type: 'ITEM_SYNCED'; lastSyncAt: number; operation: 'push' | 'pull' }
  | { type: 'INITIAL_SYNC_PROGRESS'; phase: InitialSyncPhase; current: number; total: number }
  | { type: 'RESET' }

export const initialState: SyncState = {
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

function recordProgress(
  current: Record<string, ProgressEntry> | null,
  attachmentId: string,
  progress: number,
  status: string
): Record<string, ProgressEntry> {
  const finished = progress >= 100 || TERMINAL_TRANSFER_STATUSES.has(status)
  const entry: ProgressEntry = finished
    ? { progress, status, completedAt: Date.now() }
    : { progress, status }
  return { ...current, [attachmentId]: entry }
}

/** Returns the same reference when nothing expired, so the reducer can bail out. */
function pruneProgress(
  current: Record<string, ProgressEntry> | null,
  now: number
): Record<string, ProgressEntry> | null {
  if (!current) return current
  const kept = Object.entries(current).filter(
    ([, entry]) =>
      entry.completedAt === undefined || now - entry.completedAt < SYNC_PROGRESS_RETENTION_MS
  )
  if (kept.length === Object.keys(current).length) return current
  return kept.length > 0 ? Object.fromEntries(kept) : null
}

/** Returns the same reference when nothing expired, so the reducer can bail out. */
function pruneConflicts(conflicts: ConflictEntry[], now: number): ConflictEntry[] {
  const fresh = conflicts.filter((entry) => now - entry.detectedAt < SYNC_CONFLICT_TTL_MS)
  return fresh.length === conflicts.length ? conflicts : fresh
}

export function syncReducer(state: SyncState, action: SyncAction): SyncState {
  switch (action.type) {
    case 'STATUS_CHANGED': {
      const leavingSyncing = state.status === 'syncing' && action.status !== 'syncing'
      // A pull that dies in a rethrowing failure category (offline, rate-limit,
      // auth) never reaches phase:'complete', so the last INITIAL_SYNC_PROGRESS
      // event would outlive its transfer and keep the skeleton and the
      // pending-body hint pinned over a dead one. These statuses are
      // terminal-for-now, so they retire the progress. 'idle' is deliberately
      // NOT included: releaseLock emits a transient idle blip between the
      // pull→push phases mid-fullSync, and clearing on it would flicker the
      // progress UI on every healthy cycle.
      const transferEnded =
        action.status === 'error' || action.status === 'offline' || action.status === 'paused'
      return {
        ...state,
        status: action.status,
        lastSyncAt: action.lastSyncAt ?? state.lastSyncAt,
        pendingCount: action.pendingCount,
        error: action.error ?? null,
        offlineSince: action.offlineSince ?? null,
        initialSyncProgress: transferEnded ? null : state.initialSyncProgress,
        syncActivity: leavingSyncing ? { pushCount: 0, pullCount: 0 } : state.syncActivity
      }
    }
    case 'PAUSED':
      return {
        ...state,
        status: 'paused',
        pendingCount: action.pendingCount,
        initialSyncProgress: null
      }
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
        uploadProgress: recordProgress(
          state.uploadProgress,
          action.attachmentId,
          action.progress,
          action.status
        )
      }
    case 'DOWNLOAD_PROGRESS':
      return {
        ...state,
        downloadProgress: recordProgress(
          state.downloadProgress,
          action.attachmentId,
          action.progress,
          action.status
        )
      }
    case 'SESSION_EXPIRED':
      return { ...state, sessionExpired: true, status: 'error', error: action.error }
    case 'DEVICE_REVOKED':
      return {
        ...state,
        deviceRevoked: { unsyncedCount: action.unsyncedCount },
        status: 'error',
        error: action.error
      }
    case 'CONFLICT_DETECTED': {
      const now = Date.now()
      // Every pull that re-detects the same item emits again, so an item that
      // ping-pongs between devices used to append an entry per round. Key by
      // item: the popover counts conflicting *items*, and one noisy note can
      // no longer push 99 genuinely distinct conflicts out of the cap.
      const kept = pruneConflicts(state.conflicts, now).filter(
        (entry) => entry.itemId !== action.itemId || entry.itemType !== action.itemType
      )
      const next = [...kept, { itemId: action.itemId, itemType: action.itemType, detectedAt: now }]
      return {
        ...state,
        conflicts:
          next.length > SYNC_CONFLICT_CAP ? next.slice(next.length - SYNC_CONFLICT_CAP) : next
      }
    }
    case 'CLEAR_CONFLICTS':
      return state.conflicts.length === 0 ? state : { ...state, conflicts: [] }
    case 'PRUNE_STALE': {
      const uploadProgress = pruneProgress(state.uploadProgress, action.now)
      const downloadProgress = pruneProgress(state.downloadProgress, action.now)
      const conflicts = pruneConflicts(state.conflicts, action.now)
      if (
        uploadProgress === state.uploadProgress &&
        downloadProgress === state.downloadProgress &&
        conflicts === state.conflicts
      ) {
        return state
      }
      return { ...state, uploadProgress, downloadProgress, conflicts }
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
  clearConflicts: () => void
  linkingRequest: LinkingRequestEvent | null
  clearLinkingRequest: () => void
  dismissDeviceRevoked: () => void
  vaultRecovery: VaultRecoveryNeededEvent | null
  clearVaultRecovery: () => void
}

const SyncContext = createContext<SyncContextValue | null>(null)

export function useSync(): SyncContextValue {
  const context = useContext(SyncContext)
  if (!context) {
    throw new Error('useSync must be used within a SyncProvider')
  }
  return context
}

/**
 * Tolerant variant for components that merely ENHANCE their rendering with
 * sync state (initial-sync skeletons, pending-body hints) and must not couple
 * their mountability to the provider — canvas embeds and unit tests render
 * them without one. `null` means "no sync information", which every caller
 * treats exactly like "no sync in progress".
 */
export function useSyncOptional(): SyncContextValue | null {
  return useContext(SyncContext)
}

interface SyncProviderProps {
  children: ReactNode
}

export function SyncProvider({ children }: SyncProviderProps): React.JSX.Element {
  const { state: authState, logout } = useAuth()
  const { t } = useT('errors')
  const { t: tSettings } = useT('settings')
  const [state, dispatch] = useReducer(syncReducer, initialState)
  const [linkingRequest, setLinkingRequest] = useState<LinkingRequestEvent | null>(null)
  const [vaultRecovery, setVaultRecovery] = useState<VaultRecoveryNeededEvent | null>(null)
  const [reauthRequired, setReauthRequired] = useState(false)
  const sessionExpiredRef = useRef(state.sessionExpired)
  useEffect(() => {
    sessionExpiredRef.current = state.sessionExpired
  }, [state.sessionExpired])

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
        const error = status.error ? extractErrorMessage(status.error, '') : undefined
        dispatch({
          type: 'STATUS_CHANGED',
          status: status.status as SyncStatus,
          lastSyncAt: status.lastSyncAt,
          pendingCount: status.pendingCount,
          error,
          offlineSince: status.offlineSince
        })
      } catch {
        if (!cancelled) {
          dispatch({ type: 'SET_ERROR', error: t('sync.statusFetchFailed') })
        }
      }
    }
    void init()

    const cleanups: Array<() => void> = []

    cleanups.push(
      window.api.onSyncStatusChanged((event) => {
        if (cancelled) return
        const error = event.error ? extractErrorMessage(event.error, '') : undefined
        dispatch({
          type: 'STATUS_CHANGED',
          status: event.status as SyncStatus,
          lastSyncAt: event.lastSyncAt,
          pendingCount: event.pendingCount,
          error,
          offlineSince: event.offlineSince
        })
        if (event.errorCategory === 'storage_quota_exceeded') {
          toast.error(t('sync.storageQuotaExceeded'), { duration: 10000 })
        }
        if (event.errorCategory === 'file_too_large') {
          toast.error(t('sync.fileTooLarge'), { duration: 10000 })
        }
        if (event.errorCategory === 'note_too_large') {
          // An older main process sends no title; the unnamed message is the
          // fallback, not the default.
          toast.error(
            event.errorNoteTitle
              ? t('sync.noteTooLargeNamed', { title: event.errorNoteTitle })
              : t('sync.noteTooLarge'),
            { duration: 10000 }
          )
        }
      })
    )

    // Attachment upload failures were emitted to this channel with no listener,
    // so a 58-day outage was completely silent to the user. Surface it.
    cleanups.push(
      window.api.onAttachmentUploadFailed((event) => {
        if (cancelled) return
        // A file over the plan limit has an actionable cause, and the generic
        // "it stays on this device" hides it. Older main processes send no
        // category, so anything else keeps the generic message.
        if (event.errorCategory === 'file_too_large') {
          toast.error(t('sync.fileTooLarge'), { duration: 10000 })
          return
        }
        const filename = event.diskPath.split(/[\\/]/).pop() ?? event.diskPath
        toast.error(t('sync.attachmentUploadFailed', { filename }), { duration: 10000 })
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
      window.api.onSessionExpired((event) => {
        if (cancelled) return
        // A rejected refresh token can never recover — the toast is too easy to
        // miss for a session that is over, so escalate to a blocking prompt.
        if (event.reason === 'refresh_rejected') {
          setReauthRequired(true)
        } else if (!sessionExpiredRef.current) {
          toast.error(t('sync.authExpired'), { duration: 8000 })
        }
        dispatch({ type: 'SESSION_EXPIRED', error: t('sync.authExpired') })
      })
    )

    cleanups.push(
      window.api.onDeviceRevoked((event) => {
        if (cancelled) return
        dispatch({
          type: 'DEVICE_REVOKED',
          unsyncedCount: event.unsyncedCount,
          error: t('sync.deviceRevoked')
        })
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
      window.api.onSecurityWarning((event) => {
        if (cancelled) return
        const message = event.permanent
          ? t('sync.securityQuarantinePermanent')
          : t('sync.securityQuarantineRetry')
        toast.error(message, { duration: 8000 })
      })
    )

    cleanups.push(
      window.api.onCertificatePinFailed(() => {
        if (cancelled) return
        toast.error(t('sync.certificatePinPaused'), { duration: 15000 })
      })
    )

    cleanups.push(
      window.api.onVaultRecoveryNeeded((event) => {
        if (cancelled) return
        setVaultRecovery(event)
      })
    )

    return () => {
      cancelled = true
      for (const cleanup of cleanups) cleanup()
    }
  }, [authState.status, t])

  // Progress and conflict entries used to accumulate for the whole session and
  // only cleared on logout. Sweep them on a timer; the reducer returns the same
  // state object when nothing expired, so an idle sweep costs no rerender.
  useEffect(() => {
    if (authState.status !== 'authenticated') return
    const timer = setInterval(() => {
      dispatch({ type: 'PRUNE_STALE', now: Date.now() })
    }, PRUNE_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [authState.status])

  useEffect(() => {
    if (authState.status === 'authenticated' && state.sessionExpired) {
      dispatch({ type: 'CLEAR_ERROR' })
      void window.api.syncOps.triggerSync().catch(() => {})
    }
  }, [authState.status, state.sessionExpired])

  // A vault switch keeps this window alive but swaps every note, cursor and
  // sync counter under it — including any initial-sync progress the previous
  // vault left behind (its transfer died below 100% or is simply no longer
  // THIS transfer). Main re-emits vault status on open and close; a change of
  // path resets the whole sync panel so stale progress is never shown for
  // vault B. The first event only sets the baseline: at mount the state was
  // just fetched fresh, and remounts must not clear a live transfer. Events
  // that keep the same path (indexing ticks, error flags) reset nothing.
  useEffect(() => {
    let lastPath: string | null | undefined
    return onVaultStatusChanged((status) => {
      if (lastPath !== undefined && lastPath !== status.path) {
        dispatch({ type: 'RESET' })
      }
      lastPath = status.path
    })
  }, [])

  const triggerSync = useCallback(async (): Promise<void> => {
    if (authState.status !== 'authenticated') return
    try {
      await window.api.syncOps.triggerSync()
    } catch (err) {
      dispatch({ type: 'SET_ERROR', error: extractErrorMessage(err, t('sync.triggerFailed')) })
    }
  }, [authState.status, t])

  const pause = useCallback(async (): Promise<void> => {
    if (authState.status !== 'authenticated') return
    try {
      await window.api.syncOps.pause()
    } catch (err) {
      dispatch({ type: 'SET_ERROR', error: extractErrorMessage(err, t('sync.pauseFailed')) })
    }
  }, [authState.status, t])

  const resume = useCallback(async (): Promise<void> => {
    if (authState.status !== 'authenticated') return
    try {
      await window.api.syncOps.resume()
    } catch (err) {
      dispatch({ type: 'SET_ERROR', error: extractErrorMessage(err, t('sync.resumeFailed')) })
    }
  }, [authState.status, t])

  const clearError = useCallback(() => {
    dispatch({ type: 'CLEAR_ERROR' })
  }, [])

  const clearConflicts = useCallback(() => {
    dispatch({ type: 'CLEAR_CONFLICTS' })
  }, [])

  const clearLinkingRequest = useCallback(() => {
    setLinkingRequest(null)
  }, [])

  const dismissDeviceRevoked = useCallback(() => {
    dispatch({ type: 'RESET' })
  }, [])

  const clearVaultRecovery = useCallback(() => {
    setVaultRecovery(null)
  }, [])

  const value = useMemo<SyncContextValue>(
    () => ({
      state,
      triggerSync,
      pause,
      resume,
      clearError,
      clearConflicts,
      linkingRequest,
      clearLinkingRequest,
      dismissDeviceRevoked,
      vaultRecovery,
      clearVaultRecovery
    }),
    [
      state,
      triggerSync,
      pause,
      resume,
      clearError,
      clearConflicts,
      linkingRequest,
      clearLinkingRequest,
      dismissDeviceRevoked,
      vaultRecovery,
      clearVaultRecovery
    ]
  )

  const handleDeviceRevokedExport = useCallback(async () => {
    toast.info(tSettings('toast.exportNotImplemented'), { duration: 5000 })
  }, [tSettings])

  const handleDeviceRevokedSignOut = useCallback(() => {
    void logout()
  }, [logout])

  const handleVaultRecovered = useCallback(() => {
    setVaultRecovery(null)
    toast.success(t('sync.vaultRecovered'), { duration: 6000 })
    void window.api.syncOps.triggerSync().catch(() => {})
  }, [t])

  return (
    <SyncContext.Provider value={value}>
      {children}
      <DeviceRevokedDialog
        open={state.deviceRevoked !== null}
        unsyncedCount={state.deviceRevoked?.unsyncedCount ?? 0}
        onExport={handleDeviceRevokedExport}
        onSignOut={handleDeviceRevokedSignOut}
      />
      <VaultRecoveryDialog
        open={vaultRecovery !== null}
        onRecovered={handleVaultRecovered}
        onDismiss={clearVaultRecovery}
        onSignOut={handleDeviceRevokedSignOut}
      />
      <SessionExpiredDialog open={reauthRequired} onSignOut={handleDeviceRevokedSignOut} />
    </SyncContext.Provider>
  )
}
