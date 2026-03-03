import { Loader2 } from 'lucide-react'
import { useInboxStats, useInboxPatterns, useInboxFilingHistory } from '@/hooks/use-inbox'
import { cn } from '@/lib/utils'
import { InboxStatsCards } from './inbox-stats-cards'
import { InboxCaptureHeatmap } from './inbox-capture-heatmap'
import { InboxTypeDistribution } from './inbox-type-distribution'
import { InboxFilingHistoryList } from './inbox-filing-history'

export interface InboxInsightsViewProps {
  className?: string
}

export function InboxInsightsView({ className }: InboxInsightsViewProps): React.JSX.Element {
  const { stats, isLoading: statsLoading } = useInboxStats()
  const { data: patterns, isLoading: patternsLoading } = useInboxPatterns()
  const { data: historyData, isLoading: historyLoading } = useInboxFilingHistory()
  const filingHistory = historyData?.entries ?? []

  const isLoading = statsLoading || patternsLoading || historyLoading

  if (isLoading) {
    return (
      <div className={cn('flex items-center justify-center h-64', className)}>
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="size-8 text-muted-foreground animate-spin" />
          <p className="text-sm text-muted-foreground font-serif">Loading insights...</p>
        </div>
      </div>
    )
  }

  return (
    <div className={cn('space-y-8 pb-8', className)}>
      <InboxStatsCards stats={stats} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <InboxCaptureHeatmap patterns={patterns?.[0]} />
        <InboxTypeDistribution stats={stats} />
      </div>

      <InboxFilingHistoryList items={filingHistory} />
    </div>
  )
}
