import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { formatDistanceToNow } from 'date-fns'
import {
  ArrowUpFromLine,
  CloudSavingDone,
  Loader2,
  Pause,
  CloudOff,
  AlertCircle,
  Cloud,
  type AppIcon
} from '@/lib/icons'
import { useSync } from '@/contexts/sync-context'
import { notesService } from '@/services/notes-service'
import { useT } from '@memry/i18n/renderer'

type SyncStatusType = 'idle' | 'syncing' | 'paused' | 'error' | 'offline' | 'local_only' | 'unknown'

interface SyncStatusDisplay {
  label: string
  dotColor: string
  IconComponent: AppIcon
  isAnimating: boolean
}

interface SyncActivityInfo {
  pushCount: number
  pullCount: number
}

interface SyncStatusResult extends SyncStatusDisplay {
  status: SyncStatusType
  lastSyncAt: number | null
  pendingCount: number
  localOnlyCount: number
  error: string | null
  conflicts: Array<{ itemId: string; itemType: string; detectedAt: number }>
  sessionExpired: boolean
  clockSkewDetected: boolean
  initialSyncProgress: { current: number; total: number } | null
  syncActivity: SyncActivityInfo
  lastSyncLabel: string
  hasIssues: boolean
  triggerSync: () => Promise<void>
  pause: () => Promise<void>
  resume: () => Promise<void>
  clearError: () => void
  clearConflicts: () => void
}

const STATUS_MAP: Record<string, Omit<SyncStatusDisplay, 'label'> & { labelKey: string }> = {
  idle: {
    labelKey: 'account.sync.statuses.synced',
    dotColor: 'bg-green-500',
    IconComponent: CloudSavingDone,
    isAnimating: false
  },
  syncing: {
    labelKey: 'account.sync.statuses.syncing',
    dotColor: 'bg-blue-500',
    IconComponent: Loader2,
    isAnimating: true
  },
  paused: {
    labelKey: 'account.sync.statuses.paused',
    dotColor: 'bg-yellow-500',
    IconComponent: Pause,
    isAnimating: false
  },
  error: {
    labelKey: 'account.sync.statuses.syncError',
    dotColor: 'bg-red-500',
    IconComponent: AlertCircle,
    isAnimating: false
  },
  offline: {
    labelKey: 'account.sync.statuses.offline',
    dotColor: 'bg-gray-400',
    IconComponent: CloudOff,
    isAnimating: false
  },
  // Free plan: main gates the sync runtime and reports `local_only`, a status
  // outside the renderer SyncStatus union (see use-home-seed-gate.ts).
  local_only: {
    labelKey: 'account.sync.statuses.localOnly',
    dotColor: 'bg-gray-400',
    IconComponent: CloudOff,
    isAnimating: false
  },
  unknown: {
    labelKey: 'account.sync.statuses.connecting',
    dotColor: 'bg-gray-400',
    IconComponent: Cloud,
    isAnimating: false
  }
}

const FALLBACK_DISPLAY = STATUS_MAP.unknown

export function useSyncStatus(): SyncStatusResult {
  const { t } = useT('settings')
  const { state, triggerSync, pause, resume, clearError, clearConflicts } = useSync()
  const {
    status,
    lastSyncAt,
    pendingCount,
    error,
    conflicts,
    sessionExpired,
    clockSkewDetected,
    initialSyncProgress,
    syncActivity
  } = state

  const { data: localOnlyData } = useQuery({
    queryKey: ['notes', 'localOnlyCount'],
    queryFn: () => notesService.getLocalOnlyCount(),
    staleTime: 30_000,
    refetchOnWindowFocus: true
  })
  const localOnlyCount = localOnlyData?.count ?? 0

  const display = useMemo((): SyncStatusDisplay => {
    if (status === 'syncing') {
      const { pushCount, pullCount } = syncActivity
      const hasActivity = pushCount > 0 || pullCount > 0
      const parts: string[] = []
      if (pushCount > 0) parts.push(t('account.sync.statuses.pushed', { count: pushCount }))
      if (pullCount > 0) parts.push(t('account.sync.statuses.pulled', { count: pullCount }))

      return {
        label: hasActivity
          ? t('account.sync.statuses.pushedPulled', { parts: parts.join(', ') })
          : t('account.sync.statuses.syncing'),
        dotColor: 'bg-blue-500',
        IconComponent: Loader2,
        isAnimating: true
      }
    }

    if (status === 'idle' && pendingCount > 0) {
      return {
        label: t('account.sync.statuses.changesPending', { count: pendingCount }),
        dotColor: 'bg-amber-500',
        IconComponent: ArrowUpFromLine,
        isAnimating: false
      }
    }

    if (status === 'offline' && pendingCount > 0) {
      return {
        label: t('account.sync.statuses.offlinePending', { count: pendingCount }),
        dotColor: 'bg-gray-400',
        IconComponent: CloudOff,
        isAnimating: false
      }
    }

    const nextDisplay = STATUS_MAP[status] ?? FALLBACK_DISPLAY
    return {
      ...nextDisplay,
      label: t(nextDisplay.labelKey)
    }
  }, [status, pendingCount, syncActivity, t])

  const lastSyncLabel = useMemo(
    () =>
      lastSyncAt
        ? formatDistanceToNow(lastSyncAt, { addSuffix: true })
        : t('account.sync.statuses.never'),
    [lastSyncAt, t]
  )

  const hasIssues = useMemo(
    () => !!error || conflicts.length > 0 || sessionExpired,
    [error, conflicts.length, sessionExpired]
  )

  return {
    status,
    lastSyncAt,
    pendingCount,
    localOnlyCount,
    error,
    conflicts,
    sessionExpired,
    clockSkewDetected,
    initialSyncProgress,
    syncActivity,
    ...display,
    lastSyncLabel,
    hasIssues,
    triggerSync,
    pause,
    resume,
    clearError,
    clearConflicts
  }
}
