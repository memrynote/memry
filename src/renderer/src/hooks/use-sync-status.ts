import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { formatDistanceToNow } from 'date-fns'
import { Check, Loader2, Pause, CloudOff, AlertCircle, Cloud, type LucideIcon } from 'lucide-react'
import { useSync } from '@/contexts/sync-context'
import { notesService } from '@/services/notes-service'

type SyncStatusType = 'idle' | 'syncing' | 'paused' | 'error' | 'offline' | 'unknown'

interface SyncStatusDisplay {
  label: string
  dotColor: string
  IconComponent: LucideIcon
  isAnimating: boolean
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
  lastSyncLabel: string
  hasIssues: boolean
  triggerSync: () => Promise<void>
  pause: () => Promise<void>
  resume: () => Promise<void>
  clearError: () => void
}

const STATUS_MAP: Record<string, SyncStatusDisplay> = {
  idle: { label: 'Synced', dotColor: 'bg-green-500', IconComponent: Check, isAnimating: false },
  syncing: {
    label: 'Syncing...',
    dotColor: 'bg-blue-500',
    IconComponent: Loader2,
    isAnimating: true
  },
  paused: { label: 'Paused', dotColor: 'bg-yellow-500', IconComponent: Pause, isAnimating: false },
  error: {
    label: 'Sync Error',
    dotColor: 'bg-red-500',
    IconComponent: AlertCircle,
    isAnimating: false
  },
  offline: {
    label: 'Offline',
    dotColor: 'bg-gray-400',
    IconComponent: CloudOff,
    isAnimating: false
  },
  unknown: {
    label: 'Connecting...',
    dotColor: 'bg-gray-400',
    IconComponent: Cloud,
    isAnimating: false
  }
}

const FALLBACK_DISPLAY: SyncStatusDisplay = STATUS_MAP.unknown

export function useSyncStatus(): SyncStatusResult {
  const { state, triggerSync, pause, resume, clearError } = useSync()
  const {
    status,
    lastSyncAt,
    pendingCount,
    error,
    conflicts,
    sessionExpired,
    clockSkewDetected,
    initialSyncProgress
  } = state

  const { data: localOnlyData } = useQuery({
    queryKey: ['notes', 'localOnlyCount'],
    queryFn: () => notesService.getLocalOnlyCount(),
    staleTime: 30_000,
    refetchOnWindowFocus: true
  })
  const localOnlyCount = localOnlyData?.count ?? 0

  const display = useMemo(() => STATUS_MAP[status] ?? FALLBACK_DISPLAY, [status])

  const lastSyncLabel = useMemo(
    () => (lastSyncAt ? formatDistanceToNow(lastSyncAt, { addSuffix: true }) : 'Never'),
    [lastSyncAt]
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
    ...display,
    lastSyncLabel,
    hasIssues,
    triggerSync,
    pause,
    resume,
    clearError
  }
}
