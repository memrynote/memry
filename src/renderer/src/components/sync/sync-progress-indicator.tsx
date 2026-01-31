import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import { Loader2, CheckCircle } from 'lucide-react'
import type { SyncProgressUpdateEvent } from '@shared/contracts/ipc-sync'

const PHASE_LABELS = {
  pulling: 'Downloading notes...',
  pushing: 'Uploading changes...',
  resolving: 'Resolving conflicts...',
  indexing: 'Indexing notes...',
  complete: 'Sync complete'
} as const

export function SyncProgressIndicator({ className }: { className?: string }): JSX.Element | null {
  const [progress, setProgress] = useState<SyncProgressUpdateEvent | null>(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const unsubscribe = window.api.onSyncProgressUpdate((event) => {
      setProgress(event)
      setVisible(true)

      if (event.phase === 'complete') {
        const timer = setTimeout(() => setVisible(false), 2000)
        return () => clearTimeout(timer)
      }
    })
    return unsubscribe
  }, [])

  if (!visible || !progress) return null

  const percentage =
    progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0

  return (
    <div className={cn('flex items-center gap-2 px-3 py-1.5 text-sm', className)}>
      {progress.phase === 'complete' ? (
        <CheckCircle className="h-4 w-4 text-green-500" />
      ) : (
        <Loader2 className="h-4 w-4 animate-spin" />
      )}
      <span className="text-muted-foreground">
        {progress.message || PHASE_LABELS[progress.phase]}
      </span>
      {progress.phase !== 'complete' && progress.total > 0 && (
        <>
          <div className="w-20 h-1.5 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-primary transition-all"
              style={{ width: `${percentage}%` }}
            />
          </div>
          <span className="text-xs text-muted-foreground tabular-nums">
            {progress.current}/{progress.total}
          </span>
        </>
      )}
    </div>
  )
}
