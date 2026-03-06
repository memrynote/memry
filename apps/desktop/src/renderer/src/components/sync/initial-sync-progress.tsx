import type { InitialSyncPhase } from '@memry/contracts/ipc-events'
import { useSync } from '@/contexts/sync-context'

const PHASE_LABELS: Partial<Record<InitialSyncPhase, string>> = {
  notes: 'Downloading items',
  tasks: 'Uploading local changes',
  manifest: 'Verifying integrity',
  attachments: 'Syncing attachments'
}

export interface InitialSyncProgressProps {
  className?: string
}

export function InitialSyncProgress({ className }: InitialSyncProgressProps) {
  const { state } = useSync()
  const progress = state.initialSyncProgress

  if (!progress) return null

  const label = PHASE_LABELS[progress.phase] ?? 'Syncing'
  const hasTotal = progress.total > 0
  const percent = hasTotal
    ? Math.min(100, Math.round((progress.current / progress.total) * 100))
    : undefined

  return (
    <div
      className={className}
      role="status"
      aria-live="polite"
      aria-label={`${label}: ${hasTotal ? `${progress.current} of ${progress.total}` : 'in progress'}`}
    >
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span className="shrink-0">{label}</span>
        <div
          className="h-1.5 flex-1 rounded-full bg-muted overflow-hidden"
          role="progressbar"
          aria-valuenow={percent ?? undefined}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          {percent !== undefined ? (
            <div
              className="h-full rounded-full bg-primary transition-all duration-300"
              style={{ width: `${percent}%` }}
            />
          ) : (
            <div className="h-full w-1/3 rounded-full bg-primary/60 animate-pulse" />
          )}
        </div>
        {hasTotal && (
          <span className="tabular-nums whitespace-nowrap">
            {progress.current}/{progress.total}
          </span>
        )}
      </div>
    </div>
  )
}
