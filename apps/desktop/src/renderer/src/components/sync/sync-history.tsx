import React, { useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { ArrowUpFromLine, ArrowDownToLine, AlertCircle, ChevronRight, Loader2 } from '@/lib/icons'
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
          <span className="text-xs text-muted-foreground ml-1.5">
            &{/* TODO(i18n): wrap in t() */}middot; {duration}
          </span>
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
        <h4 className="text-sm font-medium">{/* TODO(i18n): wrap in t() */}Activity</h4>
        <div className="flex items-center gap-2">
          <Select
            value={filter.type}
            onValueChange={(v) => setFilter({ type: v as HistoryTypeFilter })}
          >
            <SelectTrigger
              className="h-7 w-[120px] text-xs"
              aria-label={'Filter by sync type' /* TODO(i18n): wrap aria-label in t() */}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{/* TODO(i18n): wrap in t() */}All types</SelectItem>
              <SelectItem value="push">{/* TODO(i18n): wrap in t() */}Pushed</SelectItem>
              <SelectItem value="pull">{/* TODO(i18n): wrap in t() */}Pulled</SelectItem>
              <SelectItem value="error">{/* TODO(i18n): wrap in t() */}Errors</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={filter.period}
            onValueChange={(v) => setFilter({ period: v as HistoryPeriodFilter })}
          >
            <SelectTrigger
              className="h-7 w-[110px] text-xs"
              aria-label={'Filter by time period' /* TODO(i18n): wrap aria-label in t() */}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{/* TODO(i18n): wrap in t() */}All time</SelectItem>
              <SelectItem value="today">{/* TODO(i18n): wrap in t() */}Today</SelectItem>
              <SelectItem value="7d">{/* TODO(i18n): wrap in t() */}Last 7 days</SelectItem>
              <SelectItem value="30d">{/* TODO(i18n): wrap in t() */}Last 30 days</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {isLoading && entries.length === 0 ? (
        <div
          className="flex items-center justify-center py-8"
          role="status"
          aria-label={'Loading sync history' /* TODO(i18n): wrap aria-label in t() */}
        >
          <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" aria-hidden="true" />
        </div>
      ) : entries.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-8">
          {/* TODO(i18n): wrap in t() */}No sync activity yet
        </p>
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
            {/* TODO(i18n): wrap in t() */}
            Load more
          </Button>
        </div>
      )}
    </div>
  )
}
