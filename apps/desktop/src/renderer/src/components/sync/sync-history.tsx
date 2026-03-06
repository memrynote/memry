import React, { useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { ArrowUpFromLine, ArrowDownToLine, AlertCircle, ChevronRight, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  useSyncHistory,
  type HistoryTypeFilter,
  type HistoryPeriodFilter
} from '@/hooks/use-sync-history'
import type { SyncHistoryEntry } from '@memry/contracts/ipc-sync-ops'

function formatDuration(ms: number | undefined): string | null {
  if (ms == null) return null
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function entrySummary(entry: SyncHistoryEntry): string {
  const n = entry.itemCount
  if (entry.type === 'error') return 'Sync failed'
  const verb = entry.type === 'push' ? 'pushed' : 'pulled'
  return `${n} ${n === 1 ? 'item' : 'items'} ${verb}`
}

function errorMessage(entry: SyncHistoryEntry): string | null {
  if (entry.type !== 'error' || !entry.details) return null
  const d = entry.details
  if (typeof d === 'object' && 'error' in d && typeof d.error === 'string') return d.error
  if (typeof d === 'string') return d
  return JSON.stringify(d)
}

const TYPE_ICON = {
  push: ArrowUpFromLine,
  pull: ArrowDownToLine,
  error: AlertCircle
} as const

function HistoryRow({ entry }: { entry: SyncHistoryEntry }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const Icon = TYPE_ICON[entry.type]
  const duration = formatDuration(entry.durationMs)
  const error = errorMessage(entry)
  const isError = entry.type === 'error'

  const row = (
    <div className="flex items-start gap-3 py-2.5 px-1 hover:bg-muted/50 rounded-md transition-colors">
      <Icon
        className={`w-4 h-4 mt-0.5 shrink-0 ${isError ? 'text-destructive' : 'text-muted-foreground'}`}
      />
      <div className="flex-1 min-w-0">
        <span className={`text-sm ${isError ? 'text-destructive' : ''}`}>
          {entrySummary(entry)}
        </span>
        {duration && (
          <span className="text-xs text-muted-foreground ml-1.5">&middot; {duration}</span>
        )}
      </div>
      <span className="text-xs text-muted-foreground shrink-0">
        {formatDistanceToNow(entry.createdAt, { addSuffix: true })}
      </span>
      {error && (
        <ChevronRight
          className={`w-3.5 h-3.5 mt-0.5 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`}
        />
      )}
    </div>
  )

  if (!error) return row

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        asChild
        className="w-full cursor-pointer"
        aria-expanded={open}
        aria-label={`${entrySummary(entry)}, show error details`}
      >
        {row}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="ml-7 mb-2 p-2 rounded bg-destructive/10 text-xs text-destructive break-all">
          {error}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

export function SyncHistoryPanel(): React.JSX.Element {
  const { entries, isLoading, hasMore, filter, setFilter, loadMore } = useSyncHistory()

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-medium">Activity</h4>
        <div className="flex items-center gap-2">
          <Select
            value={filter.type}
            onValueChange={(v) => setFilter({ type: v as HistoryTypeFilter })}
          >
            <SelectTrigger className="h-7 w-[120px] text-xs" aria-label="Filter by sync type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              <SelectItem value="push">Pushed</SelectItem>
              <SelectItem value="pull">Pulled</SelectItem>
              <SelectItem value="error">Errors</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={filter.period}
            onValueChange={(v) => setFilter({ period: v as HistoryPeriodFilter })}
          >
            <SelectTrigger className="h-7 w-[110px] text-xs" aria-label="Filter by time period">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All time</SelectItem>
              <SelectItem value="today">Today</SelectItem>
              <SelectItem value="7d">Last 7 days</SelectItem>
              <SelectItem value="30d">Last 30 days</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {isLoading && entries.length === 0 ? (
        <div
          className="flex items-center justify-center py-8"
          role="status"
          aria-label="Loading sync history"
        >
          <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" aria-hidden="true" />
        </div>
      ) : entries.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-8">No sync activity yet</p>
      ) : (
        <div className="space-y-0.5">
          {entries.map((entry) => (
            <HistoryRow key={entry.id} entry={entry} />
          ))}
        </div>
      )}

      {hasMore && entries.length > 0 && (
        <div className="flex justify-center">
          <Button variant="ghost" size="sm" onClick={loadMore} disabled={isLoading}>
            {isLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : null}
            Load more
          </Button>
        </div>
      )}
    </div>
  )
}
