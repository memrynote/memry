import { useSync } from '@/contexts/sync-context'

export interface InitialSyncProgressProps {
  className?: string
}

export function InitialSyncProgress({ className }: InitialSyncProgressProps) {
  const { state } = useSync()
  const progress = state.initialSyncProgress

  if (!progress || progress.total === 0) return null

  const percent = Math.min(100, Math.round((progress.current / progress.total) * 100))

  return (
    <div className={className}>
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <div className="h-1.5 flex-1 rounded-full bg-muted overflow-hidden">
          <div
            className="h-full rounded-full bg-primary transition-all duration-300"
            style={{ width: `${percent}%` }}
          />
        </div>
        <span className="tabular-nums whitespace-nowrap">
          {progress.current}/{progress.total}
        </span>
      </div>
    </div>
  )
}
