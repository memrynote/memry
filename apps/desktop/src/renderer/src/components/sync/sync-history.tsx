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
import { useT } from '@memry/i18n/renderer'
import type { TFunction } from 'i18next'

function formatDuration(ms: number | undefined): string | null {
  if (ms == null) return null
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function entrySummary(entry: SyncHistoryEntry, t: TFunction<'settings'>): string {
  if (entry.type === 'error') return t('phaseF.componentsSyncSyncHistory.summaryFailed')
  const count = entry.itemCount
  return entry.type === 'push'
    ? t('phaseF.componentsSyncSyncHistory.summaryPushed', { count })
    : t('phaseF.componentsSyncSyncHistory.summaryPulled', { count })
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
  const { t: tPhaseF } = useT('settings')
  const [open, setOpen] = useState(false)
  const Icon = TYPE_ICON[entry.type]
  const duration = formatDuration(entry.durationMs)
  const error = errorMessage(entry)
  const isError = entry.type === 'error'
  const summary = entrySummary(entry, tPhaseF)

  const row = (
    <div className="flex items-start gap-3 py-2.5 px-1 hover:bg-muted/50 rounded-md transition-colors">
      <Icon
        className={`w-4 h-4 mt-0.5 shrink-0 ${isError ? 'text-destructive' : 'text-muted-foreground'}`}
      />
      <div className="flex-1 min-w-0">
        <span className={`text-sm ${isError ? 'text-destructive' : ''}`}>{summary}</span>
        {duration && (
          <span className="text-xs text-muted-foreground ms-1.5">
            {tPhaseF('phaseF.componentsSyncSyncHistory.duration', { duration })}
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
        aria-label={tPhaseF('phaseF.componentsSyncSyncHistory.showErrorDetailsAria', { summary })}
      >
        {row}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="ms-7 mb-2 p-2 rounded bg-destructive/10 text-xs text-destructive break-all">
          {error}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

export function SyncHistoryPanel(): React.JSX.Element {
  const { t: tPhaseF } = useT('settings')
  const { entries, isLoading, hasMore, filter, setFilter, loadMore } = useSyncHistory()

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-medium">
          {tPhaseF('phaseF.componentsSyncSyncHistory.activity')}
        </h4>
        <div className="flex items-center gap-2">
          <Select
            value={filter.type}
            onValueChange={(v) => setFilter({ type: v as HistoryTypeFilter })}
          >
            <SelectTrigger
              className="h-7 w-[120px] text-xs"
              aria-label={tPhaseF('phaseF.componentsSyncSyncHistory.filterBySyncType')}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">
                {tPhaseF('phaseF.componentsSyncSyncHistory.allTypes')}
              </SelectItem>
              <SelectItem value="push">
                {tPhaseF('phaseF.componentsSyncSyncHistory.pushed')}
              </SelectItem>
              <SelectItem value="pull">
                {tPhaseF('phaseF.componentsSyncSyncHistory.pulled')}
              </SelectItem>
              <SelectItem value="error">
                {tPhaseF('phaseF.componentsSyncSyncHistory.errors')}
              </SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={filter.period}
            onValueChange={(v) => setFilter({ period: v as HistoryPeriodFilter })}
          >
            <SelectTrigger
              className="h-7 w-[110px] text-xs"
              aria-label={tPhaseF('phaseF.componentsSyncSyncHistory.filterByTimePeriod')}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">
                {tPhaseF('phaseF.componentsSyncSyncHistory.allTime')}
              </SelectItem>
              <SelectItem value="today">
                {tPhaseF('phaseF.componentsSyncSyncHistory.today')}
              </SelectItem>
              <SelectItem value="7d">
                {tPhaseF('phaseF.componentsSyncSyncHistory.last7Days')}
              </SelectItem>
              <SelectItem value="30d">
                {tPhaseF('phaseF.componentsSyncSyncHistory.last30Days')}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {isLoading && entries.length === 0 ? (
        <output
          className="flex items-center justify-center py-8"
          aria-label={tPhaseF('phaseF.componentsSyncSyncHistory.loadingSyncHistory')}
        >
          <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" aria-hidden="true" />
        </output>
      ) : entries.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-8">
          {tPhaseF('phaseF.componentsSyncSyncHistory.noSyncActivityYet')}
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
            {isLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin me-1.5" /> : null}

            {tPhaseF('phaseF.componentsSyncSyncHistory.loadMore')}
          </Button>
        </div>
      )}
    </div>
  )
}
