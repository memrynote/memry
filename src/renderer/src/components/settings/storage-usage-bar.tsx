import { useStorageUsage } from '@/hooks/use-storage-usage'
import { formatBytes } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { RefreshCw } from 'lucide-react'

const CATEGORIES = [
  { key: 'notes' as const, label: 'Notes', color: 'hsl(var(--primary))' },
  { key: 'attachments' as const, label: 'Attachments', color: 'hsl(var(--chart-2, 160 60% 45%))' },
  { key: 'crdt' as const, label: 'CRDT', color: 'hsl(var(--chart-3, 30 80% 55%))' },
  { key: 'other' as const, label: 'Other', color: 'hsl(var(--muted-foreground))' }
]

export function StorageUsageBar() {
  const { data, loading, error, refresh } = useStorageUsage()

  if (loading) {
    return <StorageSkeleton />
  }

  if (error || !data) {
    return (
      <div className="rounded-lg border p-4">
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            {error || 'Sign in to view storage usage'}
          </p>
          {error && (
            <Button variant="ghost" size="sm" onClick={refresh}>
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>
    )
  }

  const { used, limit, breakdown } = data
  const usageRatio = limit > 0 ? used / limit : 0
  const available = Math.max(0, limit - used)
  const showWarning = usageRatio > 0.8

  return (
    <div className="space-y-4">
      <div className="rounded-lg border p-4 space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-medium">Storage</h4>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">
              {formatBytes(used)} / {formatBytes(limit)}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={refresh}
              aria-label="Refresh storage usage"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        {/* Segmented Bar */}
        <div
          className="h-2.5 w-full rounded-full overflow-hidden bg-muted flex"
          role="progressbar"
          aria-valuenow={used}
          aria-valuemax={limit}
          aria-label={`Storage usage: ${formatBytes(used)} of ${formatBytes(limit)}`}
        >
          {CATEGORIES.map(({ key, color }) => {
            const pct = limit > 0 ? (breakdown[key] / limit) * 100 : 0
            if (pct < 0.5) return null
            return (
              <div
                key={key}
                className="h-full transition-all duration-300"
                style={{ width: `${pct}%`, backgroundColor: color }}
              />
            )
          })}
        </div>

        {/* Legend */}
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {CATEGORIES.map(({ key, label, color }) => (
            <div key={key} className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: color }}
              />
              {label} {formatBytes(breakdown[key])}
            </div>
          ))}
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-muted border" />
            Available {formatBytes(available)}
          </div>
        </div>
      </div>

      {/* Warning Banner */}
      {showWarning && (
        <div className="rounded-lg bg-amber-500/10 border border-amber-500/20 p-3" role="alert">
          <p className="text-sm font-medium text-amber-600 dark:text-amber-400">
            Storage almost full
          </p>
          <p className="text-xs text-amber-600/80 dark:text-amber-400/80 mt-0.5">
            Free up space or upgrade your plan to avoid sync issues.
          </p>
        </div>
      )}
    </div>
  )
}

function StorageSkeleton() {
  return (
    <div className="rounded-lg border p-4 space-y-4 animate-pulse">
      <div className="flex items-center justify-between">
        <div className="h-4 w-16 rounded bg-muted" />
        <div className="h-4 w-24 rounded bg-muted" />
      </div>
      <div className="h-2.5 w-full rounded-full bg-muted" />
      <div className="flex gap-4">
        <div className="h-3 w-20 rounded bg-muted" />
        <div className="h-3 w-24 rounded bg-muted" />
        <div className="h-3 w-16 rounded bg-muted" />
      </div>
    </div>
  )
}
